import { cookies } from 'next/headers'

import { withDiner, type DinerContext, type Transaction } from '@/lib/db'
import { isProduction } from '@/lib/env'
import { UnauthenticatedError } from '@/lib/errors'
import { generateToken, hashToken } from '@/modules/auth/tokens'

/**
 * Diner identity — the cookie side of the member context.
 *
 * A diner is not a user and gets no staff session. Their cookie holds a token
 * scoped to one dining session, and its lifetime is measured in hours rather
 * than the 30 days a staff session gets: it is a credential for one meal.
 */

const HOUR_MS = 60 * 60 * 1000

/**
 * Six hours. Long enough for the slowest imaginable dinner including a long
 * wait for the bill, short enough that a phone left on a bus cannot be used
 * to order to a table the next morning.
 */
export const DINER_SESSION_TTL_MS = 6 * HOUR_MS

/**
 * Path is `/`, not `/t`.
 *
 * Scoping it to the scan pages was the first instinct — a diner cookie has no
 * business travelling with staff requests. It does not work: the ordering
 * endpoints live under `/api/diner/*`, so a `/t`-scoped cookie is simply
 * never sent with them and every order fails as "session ended". Serving the
 * API from under `/t` purely to narrow a cookie would contort the routing to
 * chase a small benefit.
 *
 * What actually protects this token is unchanged: it is httpOnly so script
 * cannot read it, SameSite=Lax so other sites cannot drive it, it expires in
 * hours, and — most importantly — presenting it grants only member context,
 * which reaches exactly one session's rows and one restaurant's menu.
 */
export const DINER_COOKIE_NAME = 'ros_diner'
const DINER_COOKIE_PATH = '/'

export interface IssuedDinerToken {
  token: string
  tokenHash: string
  expiresAt: Date
}

export function issueDinerToken(): IssuedDinerToken {
  const token = generateToken()
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + DINER_SESSION_TTL_MS),
  }
}

export async function setDinerCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies()
  store.set(DINER_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: DINER_COOKIE_PATH,
    expires: expiresAt,
  })
}

export async function clearDinerCookie(): Promise<void> {
  const store = await cookies()
  store.delete({ name: DINER_COOKIE_NAME, path: DINER_COOKIE_PATH })
}

export async function readDinerCookie(): Promise<string | null> {
  const store = await cookies()
  return store.get(DINER_COOKIE_NAME)?.value ?? null
}

/**
 * Runs `fn` inside the diner's database context.
 *
 * Returns null when there is no cookie or it no longer resolves — expired,
 * unknown, or the member left. Callers that require a diner should use
 * `requireDiner`.
 */
export async function withCurrentDiner<T>(
  fn: (tx: Transaction, diner: DinerContext) => Promise<T>,
): Promise<T | null> {
  const token = await readDinerCookie()
  if (!token) return null

  // The stored value is the HMAC, never the token itself.
  return withDiner(hashToken(token), fn)
}

export async function requireDiner<T>(
  fn: (tx: Transaction, diner: DinerContext) => Promise<T>,
): Promise<T> {
  const result = await withCurrentDiner(fn)

  if (result === null) {
    throw new UnauthenticatedError(
      'Your table session has ended. Scan the QR code again to rejoin.',
    )
  }

  return result
}

/** Resolves the current diner's identity without running a query of your own. */
export async function getDinerContext(): Promise<DinerContext | null> {
  return withCurrentDiner(async (_tx, diner) => diner)
}
