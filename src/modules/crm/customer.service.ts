import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  customers,
  diningSessions,
  loyaltyTiers,
  loyaltyTransactions,
  payments,
  reservations,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { readBalanceIn } from '@/modules/promotion/loyalty.service'

/**
 * Customer records, and what attaching one to a bill means.
 *
 * The loyalty ledger lives in `promotion/loyalty.service.ts` — this module is
 * about who the customer is and what they have done, not about their points.
 */

/**
 * Attaches a member to an open bill.
 *
 * This is the piece Phase 9 could not complete: the accrual was written and
 * tested but had no customer to award points to. Attaching one here is what
 * makes settlement award them.
 *
 * Refused once the bill is closed. Attaching a member after the fact would
 * mean either awarding points for a visit that has already been reconciled or
 * quietly awarding none, and both are worse than saying no.
 */
export async function attachCustomerToSession(
  ctx: BranchActorContext,
  sessionId: string,
  customerId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [session] = await tx
      .select({
        id: diningSessions.id,
        status: diningSessions.status,
        customerId: diningSessions.customerId,
      })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.id, sessionId),
          eq(diningSessions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!session) throw new NotFoundError('Bill not found.')

    if (session.status === 'closed' || session.status === 'abandoned') {
      throw new ConflictError(
        'That bill has already been settled, so a member cannot be added to it now.',
      )
    }

    const [customer] = await tx
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!customer) throw new NotFoundError('Customer not found.')

    await tx
      .update(diningSessions)
      .set({ customerId })
      .where(eq(diningSessions.id, sessionId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'session.customer_attached',
      entityType: 'dining_session',
      entityId: sessionId,
      before: { customerId: session.customerId },
      after: { customerId, name: customer.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function detachCustomerFromSession(
  ctx: BranchActorContext,
  sessionId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx
      .update(diningSessions)
      .set({ customerId: null })
      .where(
        and(
          eq(diningSessions.id, sessionId),
          eq(diningSessions.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'session.customer_detached',
      entityType: 'dining_session',
      entityId: sessionId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export interface CustomerSearchRow {
  id: string
  name: string
  phone: string | null
  tierName: string | null
  pointsBalance: number
}

/**
 * Finds members by name or phone.
 *
 * Both, because a till and a phone are different situations: someone standing
 * at the counter gives a name, someone booking gives a number. Requiring the
 * right one would make the search useless half the time.
 */
export async function searchCustomers(
  restaurantId: string,
  userId: string,
  query: string,
  limit = 20,
): Promise<CustomerSearchRow[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  return withTenant({ restaurantId, userId }, async (tx) => {
    const pattern = `%${trimmed}%`

    const rows = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        tierName: loyaltyTiers.name,
      })
      .from(customers)
      .leftJoin(loyaltyTiers, eq(loyaltyTiers.id, customers.tierId))
      .where(
        and(
          eq(customers.restaurantId, restaurantId),
          sql`(${customers.name} ilike ${pattern} or ${customers.phone} ilike ${pattern})`,
        ),
      )
      .orderBy(asc(customers.name))
      .limit(limit)

    const aggregates = await loadAggregatesIn(
      tx,
      rows.map((row) => row.id),
    )

    return rows.map((row) => ({
      ...row,
      pointsBalance: aggregates.get(row.id)?.points ?? 0,
    }))
  })
}

export interface CustomerProfile {
  id: string
  name: string
  phone: string | null
  email: string | null
  tierName: string | null
  pointsBalance: number
  lifetimePoints: number
  visitCount: number
  totalSpendMinor: number
  averageSpendMinor: number
  lastVisitAt: Date | null
  recentVisits: {
    sessionId: string
    closedAt: Date | null
    totalMinor: number
  }[]
  upcomingReservations: {
    id: string
    startsAt: Date
    partySize: number
    status: string
  }[]
}

/**
 * Everything known about one customer.
 *
 * Spend is summed from captured payments rather than from bill totals: a bill
 * that was voided, comped or never settled is not money the customer spent,
 * and counting it would inflate every regular's value.
 */
export async function readCustomerProfile(
  restaurantId: string,
  userId: string,
  customerId: string,
): Promise<CustomerProfile> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const [customer] = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        tierName: loyaltyTiers.name,
      })
      .from(customers)
      .leftJoin(loyaltyTiers, eq(loyaltyTiers.id, customers.tierId))
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.restaurantId, restaurantId),
        ),
      )
      .limit(1)

    if (!customer) throw new NotFoundError('Customer not found.')

    const { balance, lifetime } = await readBalanceIn(tx, customerId)

    /**
     * A left join and a group-by, not a correlated subquery.
     *
     * Drizzle inlines a subquery's columns unaliased, so an unqualified `id`
     * inside it resolves against the subquery's own FROM — `payments.id`, not
     * the session being counted. The correlation silently matches nothing and
     * every customer looks like they have never spent a penny.
     */
    const visits = await tx
      .select({
        sessionId: diningSessions.id,
        closedAt: diningSessions.closedAt,
        totalMinor: sql<number>`coalesce(sum(
          case when ${payments.status} = 'succeeded'
            then ${payments.amountMinor} else 0 end
        ), 0)::int`,
      })
      .from(diningSessions)
      .leftJoin(payments, eq(payments.sessionId, diningSessions.id))
      .where(
        and(
          eq(diningSessions.restaurantId, restaurantId),
          eq(diningSessions.customerId, customerId),
          eq(diningSessions.status, 'closed'),
        ),
      )
      .groupBy(diningSessions.id, diningSessions.closedAt)
      .orderBy(desc(diningSessions.closedAt))

    const totalSpendMinor = visits.reduce((sum, v) => sum + v.totalMinor, 0)

    const upcoming = await tx
      .select({
        id: reservations.id,
        startsAt: reservations.startsAt,
        partySize: reservations.partySize,
        status: reservations.status,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.restaurantId, restaurantId),
          eq(reservations.customerId, customerId),
          sql`${reservations.startsAt} >= now()`,
          sql`${reservations.status} in ('pending', 'confirmed')`,
        ),
      )
      .orderBy(asc(reservations.startsAt))
      .limit(5)

    return {
      ...customer,
      pointsBalance: balance,
      lifetimePoints: lifetime,
      visitCount: visits.length,
      totalSpendMinor,
      averageSpendMinor:
        visits.length === 0
          ? 0
          : Math.round(totalSpendMinor / visits.length),
      lastVisitAt: visits[0]?.closedAt ?? null,
      recentVisits: visits.slice(0, 10),
      upcomingReservations: upcoming,
    }
  })
}

export interface CustomerListRow extends CustomerSearchRow {
  visitCount: number
  lastVisitAt: Date | null
}

/**
 * Aggregates for a set of customers, keyed by id.
 *
 * Two separate queries rather than one with both joins. Joining the points
 * ledger and the visit history in a single statement fans the rows out —
 * a customer with three ledger entries and two visits produces six rows, and
 * `sum(points)` silently doubles. `count(distinct)` survives that; a sum
 * does not, and the inflation is invisible because the number still looks
 * plausible.
 */
async function loadAggregatesIn(
  tx: Transaction,
  customerIds: string[],
): Promise<Map<string, { points: number; visits: number; lastVisitAt: Date | null }>> {
  const aggregates = new Map<
    string,
    { points: number; visits: number; lastVisitAt: Date | null }
  >()

  if (customerIds.length === 0) return aggregates

  const entry = (id: string) => {
    const existing = aggregates.get(id)
    if (existing) return existing
    const created = { points: 0, visits: 0, lastVisitAt: null as Date | null }
    aggregates.set(id, created)
    return created
  }

  const points = await tx
    .select({
      customerId: loyaltyTransactions.customerId,
      total: sql<number>`coalesce(sum(${loyaltyTransactions.points}), 0)::int`,
    })
    .from(loyaltyTransactions)
    .where(inArray(loyaltyTransactions.customerId, customerIds))
    .groupBy(loyaltyTransactions.customerId)

  for (const row of points) entry(row.customerId).points = row.total

  const visits = await tx
    .select({
      customerId: diningSessions.customerId,
      count: sql<number>`count(*)::int`,
      /**
       * `.mapWith` is doing real work here, and its absence was a latent bug
       * from Phase 11.
       *
       * `sql<Date | null>` is a type ASSERTION, not a conversion — it tells
       * TypeScript what to believe and does nothing at runtime. Drizzle turns
       * a timestamp into a `Date` in its column mapper, which a raw fragment
       * never reaches, so this arrived as a string while claiming to be a
       * Date. It rendered correctly only because the page happened to wrap it
       * in `new Date(...)`; anything calling `.getTime()` would have thrown.
       */
      lastVisitAt: sql<Date | null>`max(${diningSessions.closedAt})`.mapWith(
        diningSessions.closedAt,
      ),
    })
    .from(diningSessions)
    .where(
      and(
        inArray(diningSessions.customerId, customerIds),
        eq(diningSessions.status, 'closed'),
      ),
    )
    .groupBy(diningSessions.customerId)

  for (const row of visits) {
    if (!row.customerId) continue
    const target = entry(row.customerId)
    target.visits = row.count
    target.lastVisitAt = row.lastVisitAt
  }

  return aggregates
}

export async function listCustomers(
  restaurantId: string,
  userId: string,
  limit = 100,
): Promise<CustomerListRow[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const rows = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        tierName: loyaltyTiers.name,
      })
      .from(customers)
      .leftJoin(loyaltyTiers, eq(loyaltyTiers.id, customers.tierId))
      .where(eq(customers.restaurantId, restaurantId))
      .orderBy(asc(customers.name))
      .limit(limit)

    const aggregates = await loadAggregatesIn(
      tx,
      rows.map((row) => row.id),
    )

    return rows.map((row) => {
      const aggregate = aggregates.get(row.id)
      return {
        ...row,
        pointsBalance: aggregate?.points ?? 0,
        visitCount: aggregate?.visits ?? 0,
        lastVisitAt: aggregate?.lastVisitAt ?? null,
      }
    })
  })
}


