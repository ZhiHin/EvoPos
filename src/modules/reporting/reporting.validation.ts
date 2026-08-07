import { z } from 'zod'

import { businessDayOf, businessDayRange } from './report'
import { addCalendarDays, formatCalendarDate, parseIsoDate } from '@/lib/time'
import { ValidationError } from '@/lib/errors'
import { getSettings } from '@/modules/settings/settings.service'
import type { ReportContext, ReportFilters } from './report.service'

/**
 * Turning a URL into a report request.
 *
 * The dates arrive as `YYYY-MM-DD` in the restaurant's own calendar, never as
 * instants. A picker that sent an ISO timestamp would be sending the browser's
 * idea of midnight, and a manager in one zone pulling a report for a branch in
 * another would silently get someone else's day.
 */

export const REPORT_KEYS = ['sales', 'items', 'tax', 'loss'] as const
export type ReportKey = (typeof REPORT_KEYS)[number]

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form')

export const reportQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Empty string is what an unset `<select>` submits; treat it as all. */
  branchId: z
    .string()
    .transform((value) => (value === '' ? null : value))
    .pipe(z.uuid('Not a valid branch').nullable())
    .nullish(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
})

export type ReportQuery = z.infer<typeof reportQuerySchema>

/**
 * A period longer than this is refused.
 *
 * Not an arbitrary limit: every report loads its records into memory to
 * summarise them, and two years of a busy restaurant is a query that ties up
 * a connection and returns a page nobody can read. Someone who genuinely
 * wants five years wants an export pipeline, not a web page, and should be
 * told so rather than left watching a spinner.
 */
export const MAX_REPORT_DAYS = 400

export interface ResolvedReportRequest {
  ctx: ReportContext
  filters: ReportFilters
  granularity: 'day' | 'week' | 'month'
  /** Echoed back so the picker can show what it actually resolved to. */
  fromIsoDate: string
  toIsoDate: string
  currency: string
  timeZone: string
}

/**
 * Resolves a query into a range, defaulting to the last seven trading days.
 *
 * Seven rather than one: a single day has no shape, and the comparison
 * against the previous period — which every report carries — is meaningless
 * against yesterday alone if yesterday was a Monday and today is a Saturday.
 */
export async function resolveReportRequest(
  restaurantId: string,
  userId: string,
  query: ReportQuery,
  now: Date = new Date(),
): Promise<ResolvedReportRequest> {
  const settings = await getSettings(restaurantId, userId)
  const timeZone = settings.timezone
  const startMinutes = settings.businessDayStartMinutes

  const today = businessDayOf(now, timeZone, startMinutes)
  const toIsoDate = query.to ?? today

  const defaultFrom = (): string => {
    const parsed = parseIsoDate(toIsoDate)
    if (!parsed) return toIsoDate
    return formatCalendarDate(addCalendarDays(parsed, -6))
  }

  const fromIsoDate = query.from ?? defaultFrom()

  const range = businessDayRange(
    fromIsoDate,
    toIsoDate,
    timeZone,
    startMinutes,
  )

  if (!range) {
    throw new ValidationError('That is not a valid date range.', {
      from: ['The start date must be on or before the end date.'],
    })
  }

  const days = Math.round(
    (range.to.getTime() - range.from.getTime()) / (24 * 60 * 60_000),
  )

  if (days > MAX_REPORT_DAYS) {
    throw new ValidationError(
      `That range covers ${days} days. Reports are limited to ${MAX_REPORT_DAYS}.`,
      { from: [`Choose a range of ${MAX_REPORT_DAYS} days or fewer.`] },
    )
  }

  return {
    ctx: {
      restaurantId,
      userId,
      timeZone,
      businessDayStartMinutes: startMinutes,
    },
    filters: { range, branchId: query.branchId ?? null },
    granularity: query.granularity,
    fromIsoDate,
    toIsoDate,
    currency: settings.currency,
    timeZone,
  }
}

/** Reads a report query straight off a URL. */
export function parseReportQuery(url: string): ReportQuery {
  const params = new URL(url).searchParams
  return reportQuerySchema.parse({
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    branchId: params.get('branchId') ?? undefined,
    granularity: params.get('granularity') ?? undefined,
  })
}
