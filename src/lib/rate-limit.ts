import { RateLimitError } from './errors'

/**
 * Fixed-window rate limiter, in process memory.
 *
 * LIMITATION, and it is a real one: this counts per Node process. Behind more
 * than one instance the effective limit multiplies by the instance count, and
 * a deploy resets every window. That is acceptable for Phase 0 on a single
 * container and NOT acceptable once the app scales horizontally -- at that
 * point this module should be swapped for Redis (INCR + EXPIRE) behind the
 * same `consume` signature, which is why the storage is kept behind a
 * function rather than inlined at the call sites.
 *
 * It is still worth having now: it turns unlimited online password guessing
 * into a bounded number of attempts, which is the attack it exists to stop.
 */

interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()

/** Cheap amortised cleanup, so the map cannot grow without bound. */
function evictExpired(now: number): void {
  if (windows.size < 1000) return
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key)
  }
}

export interface RateLimitOptions {
  /** Stable identifier, e.g. `login:${ip}` or `reset:${email}`. */
  key: string
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export function check(options: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  evictExpired(now)

  const existing = windows.get(options.key)

  if (!existing || existing.resetAt <= now) {
    windows.set(options.key, { count: 1, resetAt: now + options.windowMs })
    return { allowed: true, remaining: options.limit - 1, retryAfterMs: 0 }
  }

  existing.count += 1

  if (existing.count > options.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: existing.resetAt - now,
    }
  }

  return {
    allowed: true,
    remaining: options.limit - existing.count,
    retryAfterMs: 0,
  }
}

/** Throws RateLimitError when the budget is exhausted. */
export function consume(options: RateLimitOptions): void {
  const result = check(options)
  if (!result.allowed) {
    const seconds = Math.ceil(result.retryAfterMs / 1000)
    throw new RateLimitError(
      `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    )
  }
}

/** Called after a success, so a legitimate login clears the failure budget. */
export function reset(key: string): void {
  windows.delete(key)
}

export const RATE_LIMITS = {
  /** Per IP. Blunt guard against distributed guessing from one source. */
  loginByIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  /** Per account. Stops one targeted account being ground down. */
  loginByEmail: { limit: 8, windowMs: 15 * 60 * 1000 },
  registerByIp: { limit: 5, windowMs: 60 * 60 * 1000 },
  passwordResetByEmail: { limit: 5, windowMs: 60 * 60 * 1000 },
} as const
