import { describe, expect, it } from 'vitest'

import {
  checkBooking,
  findFreeTables,
  intervalFor,
  overlaps,
  quoteWaitMinutes,
  suggestAlternatives,
  type BookedTable,
  type TableCapacity,
} from './booking'

const at = (iso: string) => new Date(`2026-08-10T${iso}:00+08:00`)

const RULES = { maxDaysAhead: 60, turnMinutes: 90 }
const NOW = at('10:00')

const TABLES: TableCapacity[] = [
  { tableId: 't2', name: 'T2', seats: 2 },
  { tableId: 't4', name: 'T4', seats: 4 },
  { tableId: 't6', name: 'T6', seats: 6 },
]

function booking(
  tableId: string,
  from: string,
  to: string,
  reservationId = `r-${tableId}-${from}`,
): BookedTable {
  return { tableId, reservationId, startsAt: at(from), endsAt: at(to) }
}

describe('overlaps', () => {
  it('detects a genuine clash', () => {
    expect(
      overlaps(
        { startsAt: at('19:00'), endsAt: at('20:30') },
        { startsAt: at('20:00'), endsAt: at('21:30') },
      ),
    ).toBe(true)
  })

  it('does not treat touching endpoints as a clash', () => {
    // A table freed at 20:30 is available at 20:30. Calling this a clash
    // loses a full turn every evening on every table.
    expect(
      overlaps(
        { startsAt: at('19:00'), endsAt: at('20:30') },
        { startsAt: at('20:30'), endsAt: at('22:00') },
      ),
    ).toBe(false)
  })

  it('detects containment in either direction', () => {
    const outer = { startsAt: at('18:00'), endsAt: at('22:00') }
    const inner = { startsAt: at('19:00'), endsAt: at('20:00') }

    expect(overlaps(outer, inner)).toBe(true)
    expect(overlaps(inner, outer)).toBe(true)
  })
})

describe('intervalFor', () => {
  it('extends the start by the turn time', () => {
    const interval = intervalFor(at('19:00'), 90)
    expect(interval.endsAt.toISOString()).toBe(at('20:30').toISOString())
  })
})

describe('findFreeTables', () => {
  it('offers the smallest table that fits', () => {
    const free = findFreeTables(
      TABLES,
      [],
      { startsAt: at('19:00'), endsAt: at('20:30') },
      2,
    )

    // Seating a two on the six-top is how a restaurant runs out of capacity
    // at 60% occupancy.
    expect(free[0].tableId).toBe('t2')
    expect(free.map((t) => t.tableId)).toEqual(['t2', 't4', 't6'])
  })

  it('excludes tables too small for the party', () => {
    const free = findFreeTables(
      TABLES,
      [],
      { startsAt: at('19:00'), endsAt: at('20:30') },
      5,
    )

    expect(free.map((t) => t.tableId)).toEqual(['t6'])
  })

  it('excludes tables booked across the interval', () => {
    const free = findFreeTables(
      TABLES,
      [booking('t2', '19:00', '20:30')],
      { startsAt: at('19:30'), endsAt: at('21:00') },
      2,
    )

    expect(free.map((t) => t.tableId)).toEqual(['t4', 't6'])
  })

  it('ignores the booking being re-timed', () => {
    const existing = booking('t2', '19:00', '20:30', 'r-1')

    const free = findFreeTables(
      TABLES,
      [existing],
      { startsAt: at('19:30'), endsAt: at('21:00') },
      2,
      'r-1',
    )

    // Moving a booking half an hour must not clash with where it currently
    // is, or no booking could ever be nudged.
    expect(free.map((t) => t.tableId)).toContain('t2')
  })
})

describe('checkBooking', () => {
  it('accepts a booking and picks a table', () => {
    const result = checkBooking(TABLES, [], at('19:00'), 4, RULES, NOW)

    expect(result.ok).toBe(true)
    expect(result.table?.tableId).toBe('t4')
  })

  it('refuses a booking in the past', () => {
    const result = checkBooking(TABLES, [], at('09:00'), 2, RULES, NOW)

    expect(result.refusal).toEqual({ reason: 'in_the_past' })
  })

  it('refuses a party larger than any table, and says how large', () => {
    const result = checkBooking(TABLES, [], at('19:00'), 10, RULES, NOW)

    // "We cannot seat you" is a phone conversation. The largest size lets the
    // person on the phone have it rather than guess.
    expect(result.refusal).toEqual({
      reason: 'party_too_large',
      largestSeats: 6,
    })
  })

  it('reports party size before availability', () => {
    const fullyBooked = TABLES.map((t) => booking(t.tableId, '18:00', '22:00'))

    const result = checkBooking(
      TABLES,
      fullyBooked,
      at('19:00'),
      10,
      RULES,
      NOW,
    )

    // Offering an alternative time for a party that can never be seated
    // wastes everyone's evening.
    expect(result.refusal?.reason).toBe('party_too_large')
  })

  it('refuses when every suitable table is taken', () => {
    const fullyBooked = TABLES.map((t) => booking(t.tableId, '18:00', '22:00'))

    const result = checkBooking(TABLES, fullyBooked, at('19:00'), 2, RULES, NOW)

    expect(result.refusal).toEqual({ reason: 'no_table_free' })
  })

  it('refuses a booking beyond the lead time', () => {
    const farOff = new Date(NOW.getTime() + 90 * 24 * 60 * 60_000)

    const result = checkBooking(TABLES, [], farOff, 2, RULES, NOW)

    expect(result.refusal).toEqual({
      reason: 'outside_lead_time',
      maxDaysAhead: 60,
    })
  })

  it('allows a booking that starts as another ends', () => {
    const result = checkBooking(
      TABLES,
      [booking('t2', '17:30', '19:00')],
      at('19:00'),
      2,
      RULES,
      NOW,
    )

    expect(result.ok).toBe(true)
    expect(result.table?.tableId).toBe('t2')
  })
})

describe('suggestAlternatives', () => {
  it('offers the nearest free times first', () => {
    const busy = TABLES.map((t) => booking(t.tableId, '19:00', '20:30'))

    const suggestions = suggestAlternatives(
      TABLES,
      busy,
      at('19:00'),
      2,
      RULES,
      NOW,
    )

    expect(suggestions.length).toBeGreaterThan(0)

    // Someone who wanted 19:00 would rather hear 20:30 than 23:00, even
    // though both are free.
    const distances = suggestions.map((s) =>
      Math.abs(s.getTime() - at('19:00').getTime()),
    )
    expect(distances).toEqual([...distances].sort((a, b) => a - b))
  })

  it('never suggests a time in the past', () => {
    const suggestions = suggestAlternatives(
      TABLES,
      [],
      at('10:30'),
      2,
      RULES,
      NOW,
    )

    for (const suggestion of suggestions) {
      expect(suggestion.getTime()).toBeGreaterThan(NOW.getTime())
    }
  })

  it('offers nothing when the party can never be seated', () => {
    expect(
      suggestAlternatives(TABLES, [], at('19:00'), 20, RULES, NOW),
    ).toEqual([])
  })
})

describe('quoteWaitMinutes', () => {
  const party = (id: string, partySize: number): { id: string; partySize: number; joinedAt: Date } => ({
    id,
    partySize,
    joinedAt: NOW,
  })

  it('quotes nothing when a suitable table is free', () => {
    expect(quoteWaitMinutes([], 2, 4, 2)).toBe(0)
  })

  it('quotes a turn when everything is full', () => {
    expect(quoteWaitMinutes([], 2, 4, 4, 90)).toBe(90)
  })

  it('ignores parties ahead that want a bigger table', () => {
    const ahead = [party('a', 8), party('b', 8)]

    // Two eights waiting do not delay a two-top if the small tables turn.
    expect(quoteWaitMinutes(ahead, 2, 4, 2, 90)).toBe(0)
  })

  it('counts parties ahead that compete for the same tables', () => {
    const ahead = [party('a', 2), party('b', 2), party('c', 2), party('d', 2)]

    /**
     * Four twos ahead, two suitable tables, all occupied. The first turn
     * seats parties one and two, the second seats three and four, and this
     * party — fifth in line — waits a third. Counting only the parties ahead
     * and forgetting to seat ourselves would quote 180 and be a turn short.
     */
    expect(quoteWaitMinutes(ahead, 2, 2, 2, 90)).toBe(270)
  })

  it('quotes nothing when no suitable table exists', () => {
    // Not a wait — it is a refusal, and the caller decides how to say so.
    expect(quoteWaitMinutes([], 12, 0, 0)).toBe(0)
  })

  it('rounds a partial round up', () => {
    const ahead = [party('a', 2)]

    // Quoting 20 minutes when it is 30 makes an angry customer; quoting 30
    // when it is 20 makes a pleased one.
    expect(quoteWaitMinutes(ahead, 2, 3, 3, 90)).toBe(90)
  })
})
