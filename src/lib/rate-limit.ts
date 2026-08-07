import { lt, sql } from 'drizzle-orm'

import { db } from './db'
import { rateLimitBuckets } from './db/schema'
import { RateLimitError } from './errors'

/**
 * Fixed-window rate limiter, with the counter in Postgres.
 *
 * Phase 0 counted attempts in process memory and said plainly what that cost:
 * behind more than one instance the effective limit multiplies by the instance
 * count, and a deploy resets every window. This closes that. The signature is
 * unchanged, which is the whole reason it was kept behind a function.
 *
 * Postgres rather than Redis, because the database is already here, already
 * backed up, and already the thing that goes down if anything does. A second
 * piece of infrastructure whose failure mode is "authentication stops being
 * rate limited" is not obviously an improvement on none.
 *
 * The counter is incremented by a single `insert ... on conflict do update`,
 * so two instances racing on the same key cannot both read 4 and write 5.
 * Postgres serialises the conflicting update; the losing statement re-reads
 * the row it collided with.
 */

export interface RateLimitOptions {
  /** Stable identifier, e.g. `login:ip:203.0.113.4`. */
  key: string
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

/**
 * How often expired rows are swept.
 *
 * Amortised on write rather than scheduled, because there is no scheduler.
 * One in every few hundred consumes pays for a bounded delete, which keeps the
 * table proportional to live windows rather than to all traffic ever.
 */
const SWEEP_PROBABILITY = 0.005

async function sweepExpired(now: Date): Promise<void> {
  if (Math.random() > SWEEP_PROBABILITY) return

  try {
    await db.delete(rateLimitBuckets).where(lt(rateLimitBuckets.resetAt, now))
  } catch {
    // Housekeeping. A failure here must never turn into a failed login.
  }
}

export async function check(
  options: RateLimitOptions,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const resetAt = new Date(now.getTime() + options.windowMs)

  /**
   * One statement does all of it: start a window, or increment the live one,
   * or replace an expired one.
   *
   * The `case` in the update is what makes the window fixed rather than
   * sliding — once `reset_at` has passed, the count restarts at 1 with a fresh
   * expiry instead of accumulating forever.
   */
  /**
   * The timestamps are interpolated as ISO strings with an explicit cast.
   *
   * A raw `sql` fragment bypasses Drizzle's column mapper — the same seam that
   * made `sql<Date>` return a string in Phase 12, seen from the other side.
   * Passing a `Date` straight in reaches the driver unmapped and throws.
   */
  const nowSql = sql`${now.toISOString()}::timestamptz`
  const resetSql = sql`${resetAt.toISOString()}::timestamptz`

  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ key: options.key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimitBuckets.key,
      set: {
        count: sql`case
          when ${rateLimitBuckets.resetAt} <= ${nowSql} then 1
          else ${rateLimitBuckets.count} + 1
        end`,
        resetAt: sql`case
          when ${rateLimitBuckets.resetAt} <= ${nowSql} then ${resetSql}
          else ${rateLimitBuckets.resetAt}
        end`,
      },
    })
    .returning({
      count: rateLimitBuckets.count,
      resetAt: rateLimitBuckets.resetAt,
    })

  void sweepExpired(now)

  const count = row?.count ?? 1
  const windowEnd = row?.resetAt ?? resetAt

  if (count > options.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, windowEnd.getTime() - now.getTime()),
    }
  }

  return {
    allowed: true,
    remaining: options.limit - count,
    retryAfterMs: 0,
  }
}

/** Throws RateLimitError when the budget is exhausted. */
export async function consume(options: RateLimitOptions): Promise<void> {
  const result = await check(options)

  if (!result.allowed) {
    const seconds = Math.ceil(result.retryAfterMs / 1000)
    throw new RateLimitError(
      `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    )
  }
}

/** Called after a success, so a legitimate login clears the failure budget. */
export async function reset(key: string): Promise<void> {
  await db.delete(rateLimitBuckets).where(sql`${rateLimitBuckets.key} = ${key}`)
}

export const RATE_LIMITS = {
  /** Per IP. Blunt guard against distributed guessing from one source. */
  loginByIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  /** Per account. Stops one targeted account being ground down. */
  loginByEmail: { limit: 8, windowMs: 15 * 60 * 1000 },
  registerByIp: { limit: 5, windowMs: 60 * 60 * 1000 },
  passwordResetByEmail: { limit: 5, windowMs: 60 * 60 * 1000 },
  /**
   * Per key, per minute. Generous — this exists to stop a runaway integration
   * saturating the database, not to meter usage. Metering is the plan's job.
   */
  apiKeyPerMinute: { limit: 600, windowMs: 60 * 1000 },
} as const
