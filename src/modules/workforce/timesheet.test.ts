import { describe, expect, it } from 'vitest'

import {
  findRosterConflicts,
  formatMinutes,
  latenessMinutes,
  matchShift,
  shiftMinutes,
  totalWorkedMinutes,
  workedMinutes,
  type Shift,
} from './timesheet'

const at = (iso: string) => new Date(`2026-08-10T${iso}:00+08:00`)

describe('workedMinutes', () => {
  it('counts the span less breaks', () => {
    expect(
      workedMinutes({
        clockInAt: at('09:00'),
        clockOutAt: at('17:00'),
        breakMinutes: 30,
      }),
    ).toBe(450)
  })

  it('returns zero for an open punch', () => {
    /**
     * Counting up to the present would make a timesheet grow while it is
     * read, and someone who forgot to clock out three days ago would show
     * four thousand minutes of work.
     */
    expect(
      workedMinutes({
        clockInAt: at('09:00'),
        clockOutAt: null,
        breakMinutes: 0,
      }),
    ).toBe(0)
  })

  it('floors at zero when the clock-out precedes the clock-in', () => {
    // A data error, not negative work — which would silently reduce pay.
    expect(
      workedMinutes({
        clockInAt: at('17:00'),
        clockOutAt: at('09:00'),
        breakMinutes: 0,
      }),
    ).toBe(0)
  })

  it('floors at zero when the break exceeds the shift', () => {
    expect(
      workedMinutes({
        clockInAt: at('09:00'),
        clockOutAt: at('09:30'),
        breakMinutes: 60,
      }),
    ).toBe(0)
  })

  it('ignores a negative break', () => {
    expect(
      workedMinutes({
        clockInAt: at('09:00'),
        clockOutAt: at('10:00'),
        breakMinutes: -30,
      }),
    ).toBe(60)
  })
})

describe('totalWorkedMinutes', () => {
  it('sums closed punches and ignores open ones', () => {
    expect(
      totalWorkedMinutes([
        { clockInAt: at('09:00'), clockOutAt: at('13:00'), breakMinutes: 0 },
        { clockInAt: at('14:00'), clockOutAt: at('18:00'), breakMinutes: 30 },
        { clockInAt: at('19:00'), clockOutAt: null, breakMinutes: 0 },
      ]),
    ).toBe(240 + 210)
  })

  it('is zero for no punches', () => {
    expect(totalWorkedMinutes([])).toBe(0)
  })
})

describe('formatMinutes', () => {
  it('formats hours and minutes', () => {
    expect(formatMinutes(450)).toBe('7h 30m')
  })

  it('formats whole hours without minutes', () => {
    expect(formatMinutes(480)).toBe('8h')
  })

  it('formats under an hour as minutes', () => {
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(0)).toBe('0m')
  })
})

describe('latenessMinutes', () => {
  it('reports minutes late beyond the grace period', () => {
    expect(latenessMinutes(at('09:00'), at('09:20'), 5)).toBe(20)
  })

  it('reports nothing within the grace period', () => {
    expect(latenessMinutes(at('09:00'), at('09:05'), 5)).toBe(0)
  })

  it('reports nothing for an early arrival', () => {
    /**
     * Not negative lateness. Turning up twenty minutes early is not credit
     * against a later day, and treating it as such is how a lateness figure
     * stops meaning anything.
     */
    expect(latenessMinutes(at('09:00'), at('08:40'), 5)).toBe(0)
  })

  it('reports nothing for an exactly punctual arrival', () => {
    expect(latenessMinutes(at('09:00'), at('09:00'), 5)).toBe(0)
  })
})

describe('matchShift', () => {
  const shifts: Shift[] = [
    { id: 's1', userId: 'u1', startsAt: at('09:00'), endsAt: at('17:00') },
    { id: 's2', userId: 'u1', startsAt: at('18:00'), endsAt: at('23:00') },
    { id: 's3', userId: 'u2', startsAt: at('09:00'), endsAt: at('17:00') },
  ]

  it('matches an early clock-in to the shift it starts', () => {
    expect(matchShift(shifts, 'u1', at('08:52'))?.id).toBe('s1')
  })

  it('matches the nearest of two shifts', () => {
    expect(matchShift(shifts, 'u1', at('17:50'))?.id).toBe('s2')
  })

  it('never matches another person’s shift', () => {
    expect(matchShift(shifts, 'u3', at('09:00'))).toBeNull()
  })

  it('returns null outside the window', () => {
    /**
     * A real answer, not a failure. Covering a sick colleague on a day off is
     * unrostered work, and the honest record is a punch with no shift rather
     * than one forced onto the nearest.
     */
    expect(matchShift(shifts, 'u1', at('13:00'), 120)).toBeNull()
  })
})

describe('shiftMinutes', () => {
  it('measures the rostered span', () => {
    expect(shiftMinutes({ startsAt: at('09:00'), endsAt: at('17:00') })).toBe(480)
  })

  it('floors an inverted shift at zero', () => {
    expect(shiftMinutes({ startsAt: at('17:00'), endsAt: at('09:00') })).toBe(0)
  })
})

describe('findRosterConflicts', () => {
  it('finds a person rostered twice at once', () => {
    const conflicts = findRosterConflicts([
      { id: 's1', userId: 'u1', startsAt: at('09:00'), endsAt: at('17:00') },
      { id: 's2', userId: 'u1', startsAt: at('16:00'), endsAt: at('22:00') },
    ])

    expect(conflicts).toEqual([
      { userId: 'u1', firstShiftId: 's1', secondShiftId: 's2' },
    ])
  })

  it('allows a back-to-back double', () => {
    // Gruelling, but not impossible, and not the software's call.
    expect(
      findRosterConflicts([
        { id: 's1', userId: 'u1', startsAt: at('09:00'), endsAt: at('17:00') },
        { id: 's2', userId: 'u1', startsAt: at('17:00'), endsAt: at('23:00') },
      ]),
    ).toEqual([])
  })

  it('does not confuse two people working the same hours', () => {
    expect(
      findRosterConflicts([
        { id: 's1', userId: 'u1', startsAt: at('09:00'), endsAt: at('17:00') },
        { id: 's2', userId: 'u2', startsAt: at('09:00'), endsAt: at('17:00') },
      ]),
    ).toEqual([])
  })

  it('finds conflicts regardless of the order given', () => {
    const conflicts = findRosterConflicts([
      { id: 's2', userId: 'u1', startsAt: at('16:00'), endsAt: at('22:00') },
      { id: 's1', userId: 'u1', startsAt: at('09:00'), endsAt: at('17:00') },
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].firstShiftId).toBe('s1')
  })
})
