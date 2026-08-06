import { and, eq, gt, lt } from 'drizzle-orm'
import { cookies } from 'next/headers'

import { db } from '@/lib/db'
import { sessions, users } from '@/lib/db/schema'
import { isProduction } from '@/lib/env'
import { generateToken, hashToken } from './tokens'

/**
 * Server-side session management.
 *
 * Sessions are database rows, not signed stateless tokens. The cost is one
 * indexed read per request; the benefit is that revocation is immediate and
 * total -- an owner firing a cashier, or a user reacting to a stolen laptop,
 * needs the session dead now, not whenever a JWT happens to expire.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_TTL_MS = 30 * DAY_MS

/**
 * Sliding expiry. Once a session is past its halfway point, activity extends
 * it. Refreshing on every request instead would mean a database write on
 * every page load for no additional security.
 */
const SESSION_REFRESH_AFTER_MS = SESSION_TTL_MS / 2

/**
 * The `__Host-` prefix is enforced by the browser: it refuses to accept the
 * cookie unless it is Secure, Path=/, and has no Domain attribute -- which
 * means a subdomain cannot overwrite the session cookie of the parent site.
 * It cannot be used over plain http, so development falls back to an
 * unprefixed name.
 */
export const SESSION_COOKIE_NAME = isProduction
  ? '__Host-ros_session'
  : 'ros_session'

export interface SessionRequestMetadata {
  ipAddress?: string | null
  userAgent?: string | null
}

export interface AuthenticatedSession {
  tokenHash: string
  userId: string
  activeRestaurantId: string | null
  activeBranchId: string | null
  expiresAt: Date
  user: {
    id: string
    email: string
    name: string
    avatarUrl: string | null
    status: 'active' | 'suspended' | 'deleted'
    emailVerifiedAt: Date | null
  }
}

/**
 * Issues a session and returns the plaintext token for the caller to place in
 * a cookie. The plaintext is never persisted -- only its HMAC.
 */
export async function createSession(
  userId: string,
  metadata: SessionRequestMetadata = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    ipAddress: metadata.ipAddress ?? null,
    userAgent: metadata.userAgent ?? null,
  })

  return { token, expiresAt }
}

/**
 * Resolves a token to its session and user, or null.
 *
 * Expiry is filtered in SQL rather than compared in JavaScript so that a
 * clock difference between the app server and the database cannot widen the
 * window in which a dead session still authenticates.
 *
 * A suspended or deleted user is rejected here, which is what makes account
 * suspension take effect on the next request rather than at next login.
 */
export async function validateSession(
  token: string,
): Promise<AuthenticatedSession | null> {
  const tokenHash = hashToken(token)

  const [row] = await db
    .select({
      tokenHash: sessions.tokenHash,
      userId: sessions.userId,
      activeRestaurantId: sessions.activeRestaurantId,
      activeBranchId: sessions.activeBranchId,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        status: users.status,
        emailVerifiedAt: users.emailVerifiedAt,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())),
    )
    .limit(1)

  if (!row) return null

  if (row.user.status !== 'active') {
    await invalidateSession(token)
    return null
  }

  const remaining = row.expiresAt.getTime() - Date.now()
  if (remaining < SESSION_REFRESH_AFTER_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    await db
      .update(sessions)
      .set({ expiresAt, lastUsedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash))
    row.expiresAt = expiresAt
  }

  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    activeRestaurantId: row.activeRestaurantId,
    activeBranchId: row.activeBranchId,
    expiresAt: row.expiresAt,
    user: row.user,
  }
}

/**
 * Records which restaurant the session is operating in.
 *
 * The caller is responsible for having verified an active membership first.
 * This function does not check, because it is also used to *clear* the active
 * tenant (restaurantId = null) when a membership is revoked mid-session.
 */
export async function setActiveTenant(
  tokenHash: string,
  restaurantId: string | null,
  branchId: string | null = null,
): Promise<void> {
  await db
    .update(sessions)
    .set({ activeRestaurantId: restaurantId, activeBranchId: branchId })
    .where(eq(sessions.tokenHash, tokenHash))
}

export async function invalidateSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

/**
 * Revokes every session belonging to a user.
 *
 * Called on password change and password reset. Skipping this is a common and
 * serious bug: without it, an attacker who already has a live session keeps
 * it after the victim changes their password to lock them out.
 */
export async function invalidateAllUserSessions(
  userId: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}

/** Housekeeping for a scheduled job; expired rows are never served anyway. */
export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
}

export async function setSessionCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE_NAME, token, {
    // Unreadable from JavaScript, so an XSS bug cannot exfiltrate the session.
    httpOnly: true,
    secure: isProduction,
    // 'lax' still sends the cookie on top-level navigation back from the
    // Google OAuth redirect, which 'strict' would drop -- breaking the
    // callback. CSRF on state-changing routes is handled by origin checks.
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE_NAME)
}

export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies()
  return store.get(SESSION_COOKIE_NAME)?.value ?? null
}
