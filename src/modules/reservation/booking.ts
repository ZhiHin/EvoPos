/**
 * Booking arithmetic. Pure — no database, no clock, no I/O.
 *
 * Every time in this module is a `Date` supplied by the caller. Nothing here
 * reads the current time, so "is this booking in the past?" is a question the
 * caller answers by passing a `now` rather than one this module guesses.
 */

export const MINUTE_MS = 60_000

/** Default time a table is held for a booking, in minutes. */
export const DEFAULT_TURN_MINUTES = 90

export interface Interval {
  startsAt: Date
  endsAt: Date
}

/**
 * True when two intervals share any time.
 *
 * Touching endpoints do not overlap: a table freed at 19:00 is available to a
 * booking starting at 19:00. Treating that as a clash would lose a full turn
 * every evening on every table.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

export function intervalFor(startsAt: Date, turnMinutes: number): Interval {
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + turnMinutes * MINUTE_MS),
  }
}

export interface TableCapacity {
  tableId: string
  name: string
  seats: number
}

export interface BookedTable extends Interval {
  tableId: string
  /** Excluded from clash checks when re-timing an existing booking. */
  reservationId: string
}

/**
 * Tables that fit the party and are free for the whole interval.
 *
 * Sorted by how little space is wasted, so a party of two is offered the
 * two-top before the eight-top. Seating small parties on large tables is how
 * a restaurant runs out of capacity at 60% occupancy.
 */
export function findFreeTables(
  tables: TableCapacity[],
  booked: BookedTable[],
  wanted: Interval,
  partySize: number,
  ignoreReservationId?: string,
): TableCapacity[] {
  const clashing = new Set(
    booked
      .filter((b) => b.reservationId !== ignoreReservationId)
      .filter((b) => overlaps(b, wanted))
      .map((b) => b.tableId),
  )

  return tables
    .filter((table) => table.seats >= partySize && !clashing.has(table.tableId))
    .sort((a, b) => {
      if (a.seats !== b.seats) return a.seats - b.seats
      return a.name < b.name ? -1 : 1
    })
}

export type BookingRefusal =
  | { reason: 'in_the_past' }
  | { reason: 'party_too_large'; largestSeats: number }
  | { reason: 'no_table_free' }
  | { reason: 'outside_lead_time'; maxDaysAhead: number }

export interface BookingCheck {
  ok: boolean
  table: TableCapacity | null
  refusal: BookingRefusal | null
}

export interface BookingRules {
  /** How far ahead bookings are accepted. */
  maxDaysAhead: number
  turnMinutes: number
}

/**
 * Decides whether a booking can be taken, and on which table.
 *
 * Returns a *reason* rather than a boolean. "We cannot seat you" is a
 * conversation someone has on the phone, and "the largest table seats six"
 * lets them have it — a bare `false` leaves them guessing.
 */
export function checkBooking(
  tables: TableCapacity[],
  booked: BookedTable[],
  startsAt: Date,
  partySize: number,
  rules: BookingRules,
  now: Date,
  ignoreReservationId?: string,
): BookingCheck {
  const refuse = (refusal: BookingRefusal): BookingCheck => ({
    ok: false,
    table: null,
    refusal,
  })

  if (startsAt <= now) return refuse({ reason: 'in_the_past' })

  const daysAhead =
    (startsAt.getTime() - now.getTime()) / (24 * 60 * MINUTE_MS)

  if (daysAhead > rules.maxDaysAhead) {
    return refuse({
      reason: 'outside_lead_time',
      maxDaysAhead: rules.maxDaysAhead,
    })
  }

  const largestSeats = tables.reduce((max, t) => Math.max(max, t.seats), 0)

  /**
   * Checked before availability, because "no table free at 19:00" and "no
   * table this size exists at all" are different problems. Offering an
   * alternative time for a party the restaurant can never seat wastes
   * everyone's evening.
   */
  if (partySize > largestSeats) {
    return refuse({ reason: 'party_too_large', largestSeats })
  }

  const wanted = intervalFor(startsAt, rules.turnMinutes)
  const free = findFreeTables(
    tables,
    booked,
    wanted,
    partySize,
    ignoreReservationId,
  )

  if (free.length === 0) return refuse({ reason: 'no_table_free' })

  return { ok: true, table: free[0], refusal: null }
}

/**
 * Alternative times near a requested one that could be seated.
 *
 * Offered in order of closeness to what was asked for, because someone who
 * wanted 19:00 would rather hear 19:30 than 21:00 even though both are free.
 */
export function suggestAlternatives(
  tables: TableCapacity[],
  booked: BookedTable[],
  wantedAt: Date,
  partySize: number,
  rules: BookingRules,
  now: Date,
  stepMinutes = 30,
  maxSuggestions = 4,
): Date[] {
  const found: { at: Date; distance: number }[] = []

  for (let step = 1; step <= 8; step += 1) {
    for (const direction of [-1, 1]) {
      const at = new Date(
        wantedAt.getTime() + direction * step * stepMinutes * MINUTE_MS,
      )

      const check = checkBooking(tables, booked, at, partySize, rules, now)
      if (check.ok) found.push({ at, distance: step })
    }
  }

  return found
    .sort((a, b) => a.distance - b.distance || a.at.getTime() - b.at.getTime())
    .slice(0, maxSuggestions)
    .map((f) => f.at)
}

export interface WaitingParty {
  id: string
  partySize: number
  joinedAt: Date
}

/**
 * Estimated wait, in minutes, for a party joining the back of the queue.
 *
 * Counts only the parties ahead that this party would actually compete with —
 * a queue of six two-tops does not delay a party of eight if the large tables
 * are turning. Modelling one undifferentiated queue is why quoted waits are
 * usually wrong in both directions at once.
 *
 * `occupiedSuitable` is how many suitable tables are currently in use, and
 * `suitableTables` how many exist. When some are free the wait is zero, which
 * is the honest answer even if it feels too good to say out loud.
 */
export function quoteWaitMinutes(
  ahead: WaitingParty[],
  partySize: number,
  suitableTables: number,
  occupiedSuitable: number,
  turnMinutes = DEFAULT_TURN_MINUTES,
): number {
  if (suitableTables === 0) return 0

  const competing = ahead.filter((party) => party.partySize <= partySize).length
  const freeNow = Math.max(0, suitableTables - occupiedSuitable)

  if (competing < freeNow) return 0

  /**
   * Each round of turns clears `suitableTables` parties. Rounded up, because
   * quoting 20 minutes when the answer is 30 produces an angry customer and
   * quoting 30 when it is 20 produces a pleased one.
   */
  const rounds = Math.ceil((competing - freeNow + 1) / suitableTables)

  return rounds * turnMinutes
}
