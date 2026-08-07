/**
 * Time zone primitives.
 *
 * Every report in this system answers a question of the form "what happened
 * today", and "today" is a fact about the restaurant, not about the machine
 * the code is running on. `new Date('2026-08-07T00:00:00')` parses in the
 * *server's* local zone: on a UTC host that is 08:00 Kuala Lumpur, so a day's
 * takings would silently run from breakfast to breakfast and every daily
 * figure would be wrong by one morning's trade.
 *
 * There is no dependency here on purpose. `Intl` already carries the IANA
 * database the runtime ships with, and it stays current with the runtime
 * rather than with whenever a package was last published.
 */

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/**
 * `hourCycle: 'h23'` rather than `hour12: false`.
 *
 * They are not synonyms: `hour12: false` renders midnight as hour 24 in some
 * engines, which turns a date into the previous day plus a day's worth of
 * minutes. `h23` is the cycle that actually means 00–23.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Wall-clock reading of an instant, as seen in the given zone. */
export function zonedPartsOf(at: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(at)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : 0
  }

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/**
 * The zone's offset from UTC, in minutes, at a particular instant.
 *
 * Takes an instant rather than a zone alone because the answer changes: a zone
 * with daylight saving has two offsets, and which one applies depends on when
 * you ask.
 */
export function offsetMinutesAt(at: Date, timeZone: string): number {
  const parts = zonedPartsOf(at, timeZone)
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  // Drop sub-second precision on both sides so the difference is a whole
  // number of minutes rather than a fraction that rounds unpredictably.
  return (asIfUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000
}

/**
 * The instant at which a given wall-clock time occurs in a zone.
 *
 * Solved by iteration rather than by lookup. The offset we need is the offset
 * *at the answer*, which we do not have yet, so the first pass guesses using
 * the offset at the naive instant and the second pass corrects it. One
 * correction is enough: zone shifts are at most an hour or two, far smaller
 * than the distance between transitions.
 *
 * Times that do not exist (the hour skipped when clocks spring forward)
 * resolve to the instant the clock jumps to, and times that occur twice
 * resolve to the first. Both are the conventional choices, and neither is
 * reachable from a business-day boundary in a zone without daylight saving —
 * which is every zone this product currently targets.
 */
export function zonedTimeToInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  minutesIntoDay = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day) + minutesIntoDay * 60_000

  const firstGuess = naive - offsetMinutesAt(new Date(naive), timeZone) * 60_000
  const corrected =
    naive - offsetMinutesAt(new Date(firstGuess), timeZone) * 60_000

  return new Date(corrected)
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `YYYY-MM-DD` as read in the given zone. */
export function formatZonedDate(at: Date, timeZone: string): string {
  const { year, month, day } = zonedPartsOf(at, timeZone)
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** `HH:MM` as read in the given zone. */
export function formatZonedTime(at: Date, timeZone: string): string {
  const { hour, minute } = zonedPartsOf(at, timeZone)
  return `${pad(hour)}:${pad(minute)}`
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export interface CalendarDate {
  year: number
  month: number
  day: number
}

/** Parses `YYYY-MM-DD`, returning null rather than an Invalid Date. */
export function parseIsoDate(value: string): CalendarDate | null {
  const match = ISO_DATE.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  // Round-trip through UTC to reject 2026-02-31, which Date would otherwise
  // roll silently into March.
  const asUtc = new Date(Date.UTC(year, month - 1, day))
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day }
}

/** Calendar arithmetic on the date alone, with no zone or instant involved. */
export function addCalendarDays(
  date: CalendarDate,
  days: number,
): CalendarDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  )
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

export function formatCalendarDate(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`
}

/** True when the runtime recognises the zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}
