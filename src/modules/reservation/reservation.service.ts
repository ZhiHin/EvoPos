import { and, asc, eq, gte, inArray, lt, lte } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  diningSessions,
  diningTables,
  reservations,
  waitlistEntries,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { openSessionForTable } from '@/modules/session/session.service'
import {
  checkBooking,
  DEFAULT_TURN_MINUTES,
  intervalFor,
  quoteWaitMinutes,
  suggestAlternatives,
  type BookedTable,
  type BookingRefusal,
  type TableCapacity,
} from './booking'

/**
 * Reservations and the waiting list.
 *
 * The engine in `booking.ts` decides whether a slot works; this module
 * supplies the tables and the bookings already in them, and persists the
 * outcome.
 */

/** How far ahead bookings are accepted. A constant until anyone asks. */
export const MAX_DAYS_AHEAD = 90

/** Statuses that still hold a table. */
const LIVE_STATUSES = ['pending', 'confirmed', 'seated'] as const

function rules(turnMinutes = DEFAULT_TURN_MINUTES) {
  return { maxDaysAhead: MAX_DAYS_AHEAD, turnMinutes }
}

async function loadTablesIn(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
): Promise<TableCapacity[]> {
  const rows = await tx
    .select({
      tableId: diningTables.id,
      name: diningTables.code,
      seats: diningTables.capacity,
    })
    .from(diningTables)
    .where(
      and(
        eq(diningTables.restaurantId, restaurantId),
        eq(diningTables.branchId, branchId),
      ),
    )

  return rows
}

/**
 * Bookings that could clash with a window.
 *
 * Bounded to a day either side rather than loading the whole book. A turn is
 * at most a few hours, so anything further out cannot overlap, and scanning
 * every booking a restaurant has ever taken to place one on Tuesday would get
 * slower every month it operated.
 */
async function loadBookedIn(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
  around: Date,
): Promise<BookedTable[]> {
  const from = new Date(around.getTime() - 24 * 60 * 60_000)
  const to = new Date(around.getTime() + 24 * 60 * 60_000)

  const rows = await tx
    .select({
      reservationId: reservations.id,
      tableId: reservations.tableId,
      startsAt: reservations.startsAt,
      endsAt: reservations.endsAt,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.restaurantId, restaurantId),
        eq(reservations.branchId, branchId),
        inArray(reservations.status, [...LIVE_STATUSES]),
        gte(reservations.startsAt, from),
        lte(reservations.startsAt, to),
      ),
    )

  return rows
    .filter((row): row is typeof row & { tableId: string } =>
      Boolean(row.tableId),
    )
    .map((row) => ({
      reservationId: row.reservationId,
      tableId: row.tableId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    }))
}

/** Turns an engine refusal into something a person can read aloud. */
function describeRefusal(refusal: BookingRefusal): string {
  switch (refusal.reason) {
    case 'in_the_past':
      return 'That time has already passed.'
    case 'party_too_large':
      return `The largest table seats ${refusal.largestSeats}. A party this size needs to be arranged with the restaurant.`
    case 'outside_lead_time':
      return `Bookings are taken up to ${refusal.maxDaysAhead} days ahead.`
    case 'no_table_free':
      return 'Nothing is free at that time.'
  }
}

export interface AvailabilityResult {
  available: boolean
  tableId: string | null
  message: string | null
  alternatives: Date[]
}

export async function checkAvailability(
  restaurantId: string,
  userId: string,
  branchId: string,
  startsAt: Date,
  partySize: number,
  turnMinutes = DEFAULT_TURN_MINUTES,
  ignoreReservationId?: string,
): Promise<AvailabilityResult> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const now = new Date()
    const tables = await loadTablesIn(tx, restaurantId, branchId)
    const booked = await loadBookedIn(tx, restaurantId, branchId, startsAt)

    const check = checkBooking(
      tables,
      booked,
      startsAt,
      partySize,
      rules(turnMinutes),
      now,
      ignoreReservationId,
    )

    if (check.ok) {
      return {
        available: true,
        tableId: check.table!.tableId,
        message: null,
        alternatives: [],
      }
    }

    return {
      available: false,
      tableId: null,
      message: describeRefusal(check.refusal!),
      /**
       * Only worth offering when the time is the problem. A party too large
       * for any table will be too large at every other time too, and
       * suggesting four of them is a worse answer than none.
       */
      alternatives:
        check.refusal!.reason === 'no_table_free'
          ? suggestAlternatives(
              tables,
              booked,
              startsAt,
              partySize,
              rules(turnMinutes),
              now,
            )
          : [],
    }
  })
}

export interface CreateReservationInput {
  branchId: string
  guestName: string
  guestPhone?: string | null
  guestEmail?: string | null
  customerId?: string | null
  partySize: number
  startsAt: Date
  turnMinutes?: number
  notes?: string | null
  occasion?: string | null
  /** Overrides the table the engine would pick. */
  tableId?: string | null
}

export async function createReservation(
  ctx: BranchActorContext,
  input: CreateReservationInput,
): Promise<{ id: string; tableId: string; startsAt: Date; endsAt: Date }> {
  if (input.partySize < 1) {
    throw new ValidationError('A booking needs at least one guest.', {
      partySize: ['A booking needs at least one guest.'],
    })
  }

  const turnMinutes = input.turnMinutes ?? DEFAULT_TURN_MINUTES

  return withTenant(ctx, async (tx) => {
    const now = new Date()
    const tables = await loadTablesIn(tx, ctx.restaurantId, input.branchId)
    const booked = await loadBookedIn(
      tx,
      ctx.restaurantId,
      input.branchId,
      input.startsAt,
    )

    /**
     * Re-checked here inside the transaction, not trusted from whatever the
     * booking form was told a moment ago. Two people on two phones taking the
     * last table at 19:00 is the entire failure mode this guards.
     */
    const check = checkBooking(
      tables,
      booked,
      input.startsAt,
      input.partySize,
      rules(turnMinutes),
      now,
    )

    if (!check.ok) throw new ConflictError(describeRefusal(check.refusal!))

    let tableId = check.table!.tableId

    if (input.tableId) {
      const chosen = tables.find((t) => t.tableId === input.tableId)
      if (!chosen) throw new NotFoundError('Table not found.')

      const wanted = intervalFor(input.startsAt, turnMinutes)
      const taken = booked.some(
        (b) =>
          b.tableId === input.tableId &&
          b.startsAt < wanted.endsAt &&
          wanted.startsAt < b.endsAt,
      )

      if (taken) {
        throw new ConflictError(
          `${chosen.name} is already booked at that time.`,
        )
      }

      /**
       * An explicit table may be smaller than the party. Allowed: a manager
       * pulling two tables together knows something the seat count does not.
       */
      tableId = chosen.tableId
    }

    const interval = intervalFor(input.startsAt, turnMinutes)

    const [created] = await tx
      .insert(reservations)
      .values({
        restaurantId: ctx.restaurantId,
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        guestName: input.guestName,
        guestPhone: input.guestPhone ?? null,
        guestEmail: input.guestEmail ?? null,
        partySize: input.partySize,
        startsAt: interval.startsAt,
        endsAt: interval.endsAt,
        tableId,
        status: 'confirmed',
        notes: input.notes ?? null,
        occasion: input.occasion ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: reservations.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'reservation.created',
      entityType: 'reservation',
      entityId: created.id,
      after: {
        guestName: input.guestName,
        partySize: input.partySize,
        startsAt: interval.startsAt,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return {
      id: created.id,
      tableId,
      startsAt: interval.startsAt,
      endsAt: interval.endsAt,
    }
  })
}

/**
 * Moves a booking to a different time, size or table.
 *
 * Excludes itself from the clash check — otherwise nudging a booking by
 * fifteen minutes would collide with where it currently sits and no booking
 * could ever be moved.
 */
export async function rescheduleReservation(
  ctx: BranchActorContext,
  reservationId: string,
  input: { startsAt?: Date; partySize?: number; tableId?: string | null },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.id, reservationId),
          eq(reservations.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Booking not found.')

    if (existing.status === 'seated' || existing.status === 'completed') {
      throw new ConflictError(
        'That party has already been seated. Change the bill, not the booking.',
      )
    }
    if (existing.status === 'cancelled' || existing.status === 'no_show') {
      throw new ConflictError('That booking is no longer live.')
    }

    const startsAt = input.startsAt ?? existing.startsAt
    const partySize = input.partySize ?? existing.partySize
    const turnMinutes = Math.round(
      (existing.endsAt.getTime() - existing.startsAt.getTime()) / 60_000,
    )

    const tables = await loadTablesIn(tx, ctx.restaurantId, existing.branchId)
    const booked = await loadBookedIn(
      tx,
      ctx.restaurantId,
      existing.branchId,
      startsAt,
    )

    const check = checkBooking(
      tables,
      booked,
      startsAt,
      partySize,
      rules(turnMinutes),
      new Date(),
      reservationId,
    )

    if (!check.ok) throw new ConflictError(describeRefusal(check.refusal!))

    const tableId =
      input.tableId === undefined
        ? (existing.tableId ?? check.table!.tableId)
        : (input.tableId ?? check.table!.tableId)

    const interval = intervalFor(startsAt, turnMinutes)

    await tx
      .update(reservations)
      .set({
        startsAt: interval.startsAt,
        endsAt: interval.endsAt,
        partySize,
        tableId,
      })
      .where(eq(reservations.id, reservationId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'reservation.rescheduled',
      entityType: 'reservation',
      entityId: reservationId,
      before: {
        startsAt: existing.startsAt,
        partySize: existing.partySize,
        tableId: existing.tableId,
      },
      after: { startsAt: interval.startsAt, partySize, tableId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Seats a booking, opening the bill it becomes.
 *
 * The session is opened through `openSessionForTable`, the same path a walk-in
 * takes, so a booked table and a walk-in table behave identically from here
 * on. A separate opening path would be a second set of rules about occupied
 * tables, and the two would disagree.
 */
export async function seatReservation(
  ctx: BranchActorContext,
  reservationId: string,
): Promise<{ sessionId: string }> {
  const [reservation] = await withTenant(ctx, (tx) =>
    tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.id, reservationId),
          eq(reservations.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1),
  )

  if (!reservation) throw new NotFoundError('Booking not found.')

  if (reservation.status === 'seated') {
    throw new ConflictError('That party is already seated.')
  }
  if (reservation.status !== 'pending' && reservation.status !== 'confirmed') {
    throw new ConflictError(
      `That booking is ${reservation.status.replace('_', ' ')} and cannot be seated.`,
    )
  }
  if (!reservation.tableId) {
    throw new ConflictError('That booking has no table assigned.')
  }

  const { sessionId } = await openSessionForTable(
    ctx,
    reservation.tableId,
    reservation.partySize,
  )

  await withTenant(ctx, async (tx) => {
    await tx
      .update(reservations)
      .set({ status: 'seated', seatedAt: new Date(), sessionId })
      .where(eq(reservations.id, reservationId))

    /**
     * Carries the member onto the bill, which is what makes loyalty accrue
     * at settlement. A regular who books under their membership should not
     * have to be asked again at the till.
     */
    if (reservation.customerId) {
      await tx
        .update(diningSessions)
        .set({ customerId: reservation.customerId })
        .where(eq(diningSessions.id, sessionId))
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'reservation.seated',
      entityType: 'reservation',
      entityId: reservationId,
      after: { sessionId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })

  return { sessionId }
}

export async function cancelReservation(
  ctx: BranchActorContext,
  reservationId: string,
  outcome: 'cancelled' | 'no_show',
  reason?: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        status: reservations.status,
        guestName: reservations.guestName,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.id, reservationId),
          eq(reservations.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Booking not found.')

    if (existing.status === 'seated' || existing.status === 'completed') {
      throw new ConflictError(
        'That party was seated, so it cannot be marked a no-show.',
      )
    }

    await tx
      .update(reservations)
      .set({
        status: outcome,
        cancelledAt: new Date(),
        cancellationReason: reason ?? null,
      })
      .where(eq(reservations.id, reservationId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: `reservation.${outcome}`,
      entityType: 'reservation',
      entityId: reservationId,
      after: { guestName: existing.guestName, reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export interface ReservationRow {
  id: string
  guestName: string
  guestPhone: string | null
  partySize: number
  startsAt: Date
  endsAt: Date
  status: 'pending' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show'
  tableCode: string | null
  tableId: string | null
  occasion: string | null
  notes: string | null
  customerId: string | null
  sessionId: string | null
}

export async function listReservations(
  restaurantId: string,
  userId: string,
  branchId: string,
  from: Date,
  to: Date,
): Promise<ReservationRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: reservations.id,
        guestName: reservations.guestName,
        guestPhone: reservations.guestPhone,
        partySize: reservations.partySize,
        startsAt: reservations.startsAt,
        endsAt: reservations.endsAt,
        status: reservations.status,
        tableCode: diningTables.code,
        tableId: reservations.tableId,
        occasion: reservations.occasion,
        notes: reservations.notes,
        customerId: reservations.customerId,
        sessionId: reservations.sessionId,
      })
      .from(reservations)
      .leftJoin(diningTables, eq(diningTables.id, reservations.tableId))
      .where(
        and(
          eq(reservations.restaurantId, restaurantId),
          eq(reservations.branchId, branchId),
          gte(reservations.startsAt, from),
          lt(reservations.startsAt, to),
        ),
      )
      .orderBy(asc(reservations.startsAt)),
  )
}

// --- waiting list ---

export interface WaitlistRow {
  id: string
  guestName: string
  guestPhone: string | null
  partySize: number
  quotedWaitMinutes: number
  status: 'waiting' | 'notified' | 'seated' | 'left'
  joinedAt: Date
  notifiedAt: Date | null
  position: number
}

export async function listWaitlist(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<WaitlistRow[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const rows = await tx
      .select({
        id: waitlistEntries.id,
        guestName: waitlistEntries.guestName,
        guestPhone: waitlistEntries.guestPhone,
        partySize: waitlistEntries.partySize,
        quotedWaitMinutes: waitlistEntries.quotedWaitMinutes,
        status: waitlistEntries.status,
        joinedAt: waitlistEntries.joinedAt,
        notifiedAt: waitlistEntries.notifiedAt,
      })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.restaurantId, restaurantId),
          eq(waitlistEntries.branchId, branchId),
          inArray(waitlistEntries.status, ['waiting', 'notified']),
        ),
      )
      .orderBy(asc(waitlistEntries.joinedAt))

    /**
     * Position is derived from arrival order, never stored. A stored position
     * has to be renumbered every time anyone is seated or leaves, and the one
     * time that renumbering is missed the queue silently reorders itself.
     */
    return rows.map((row, index) => ({ ...row, position: index + 1 }))
  })
}

export async function joinWaitlist(
  ctx: BranchActorContext,
  input: {
    branchId: string
    guestName: string
    guestPhone?: string | null
    partySize: number
    customerId?: string | null
    notes?: string | null
  },
): Promise<{ id: string; quotedWaitMinutes: number; position: number }> {
  if (input.partySize < 1) {
    throw new ValidationError('A party needs at least one person.')
  }

  return withTenant(ctx, async (tx) => {
    const tables = await loadTablesIn(tx, ctx.restaurantId, input.branchId)
    const suitable = tables.filter((t) => t.seats >= input.partySize)

    if (suitable.length === 0) {
      throw new ConflictError(
        `The largest table seats ${tables.reduce((m, t) => Math.max(m, t.seats), 0)}. A party this size needs to be arranged with the restaurant.`,
      )
    }

    const occupied = await tx
      .select({ tableId: diningSessions.tableId })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.restaurantId, ctx.restaurantId),
          eq(diningSessions.branchId, input.branchId),
          inArray(diningSessions.status, ['open', 'bill_requested']),
        ),
      )

    const occupiedSuitable = suitable.filter((table) =>
      occupied.some((session) => session.tableId === table.tableId),
    ).length

    const ahead = await tx
      .select({
        id: waitlistEntries.id,
        partySize: waitlistEntries.partySize,
        joinedAt: waitlistEntries.joinedAt,
      })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.restaurantId, ctx.restaurantId),
          eq(waitlistEntries.branchId, input.branchId),
          inArray(waitlistEntries.status, ['waiting', 'notified']),
        ),
      )
      .orderBy(asc(waitlistEntries.joinedAt))

    const quotedWaitMinutes = quoteWaitMinutes(
      ahead,
      input.partySize,
      suitable.length,
      occupiedSuitable,
    )

    const [created] = await tx
      .insert(waitlistEntries)
      .values({
        restaurantId: ctx.restaurantId,
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        guestName: input.guestName,
        guestPhone: input.guestPhone ?? null,
        partySize: input.partySize,
        quotedWaitMinutes,
        notes: input.notes ?? null,
      })
      .returning({ id: waitlistEntries.id })

    return {
      id: created.id,
      quotedWaitMinutes,
      position: ahead.length + 1,
    }
  })
}

export async function updateWaitlistStatus(
  ctx: BranchActorContext,
  entryId: string,
  status: 'notified' | 'left',
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const updated = await tx
      .update(waitlistEntries)
      .set({
        status,
        ...(status === 'notified'
          ? { notifiedAt: new Date() }
          : { leftAt: new Date() }),
      })
      .where(
        and(
          eq(waitlistEntries.id, entryId),
          eq(waitlistEntries.restaurantId, ctx.restaurantId),
          inArray(waitlistEntries.status, ['waiting', 'notified']),
        ),
      )
      .returning({ id: waitlistEntries.id })

    if (updated.length === 0) {
      throw new ConflictError(
        'That party is no longer waiting — they have already been seated or left.',
      )
    }
  })
}

export async function seatFromWaitlist(
  ctx: BranchActorContext,
  entryId: string,
  tableId: string,
): Promise<{ sessionId: string }> {
  const [entry] = await withTenant(ctx, (tx) =>
    tx
      .select()
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.id, entryId),
          eq(waitlistEntries.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1),
  )

  if (!entry) throw new NotFoundError('Waiting list entry not found.')
  if (entry.status === 'seated') {
    throw new ConflictError('That party has already been seated.')
  }
  if (entry.status === 'left') {
    throw new ConflictError('That party left.')
  }

  const { sessionId } = await openSessionForTable(ctx, tableId, entry.partySize)

  await withTenant(ctx, async (tx) => {
    await tx
      .update(waitlistEntries)
      .set({ status: 'seated', seatedAt: new Date(), sessionId })
      .where(eq(waitlistEntries.id, entryId))

    if (entry.customerId) {
      await tx
        .update(diningSessions)
        .set({ customerId: entry.customerId })
        .where(eq(diningSessions.id, sessionId))
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'waitlist.seated',
      entityType: 'waitlist_entry',
      entityId: entryId,
      after: { sessionId, tableId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })

  return { sessionId }
}
