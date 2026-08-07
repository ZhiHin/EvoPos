import { and, eq, gt, isNull } from 'drizzle-orm'

import { db, withTenant } from '@/lib/db'
import { sessions, users, verificationTokens } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { sendEmail } from '@/lib/email'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '@/lib/errors'
import { consume, RATE_LIMITS, reset } from '@/lib/rate-limit'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { equaliseTiming, hashPassword, verifyPassword } from './password'
import {
  createSession,
  invalidateAllUserSessions,
  setActiveTenant,
  type SessionRequestMetadata,
} from './session'
import { generateToken, hashToken } from './tokens'
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
} from './auth.validation'

const HOUR_MS = 60 * 60 * 1000
const PASSWORD_RESET_TTL_MS = HOUR_MS

export interface AuthResult {
  token: string
  expiresAt: Date
  userId: string
  restaurantId: string | null
}

/**
 * Registers an owner and their first restaurant in one atomic transaction.
 *
 * `users` carries no RLS policy, so it is inserted before any tenant context
 * exists; `provisionRestaurant` then establishes that context and creates the
 * tenant within it. Keeping both in one transaction matters: a failure
 * partway through must not leave an orphaned user account sitting on an email
 * address the person can then never register again.
 */
export async function registerOwner(
  input: RegisterInput,
  metadata: SessionRequestMetadata = {},
): Promise<AuthResult> {
  await consume({
    key: `register:${metadata.ipAddress ?? 'unknown'}`,
    ...RATE_LIMITS.registerByIp,
  })

  const passwordHash = await hashPassword(input.password)

  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)

    if (existing.length > 0) {
      throw new ConflictError(
        'An account with that email already exists. Try signing in instead.',
      )
    }

    const [user] = await tx
      .insert(users)
      .values({
        email: input.email,
        name: input.name,
        passwordHash,
      })
      .returning({ id: users.id })

    const { restaurantId } = await provisionRestaurant(
      tx,
      user.id,
      input.restaurantName,
      metadata,
    )

    return { userId: user.id, restaurantId }
  })

  const session = await createSession(result.userId, metadata)
  await setActiveTenant(hashToken(session.token), result.restaurantId)

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    userId: result.userId,
    restaurantId: result.restaurantId,
  }
}

/**
 * Authenticates an email and password.
 *
 * Every failure path returns the same message and burns comparable CPU. The
 * three distinguishable cases -- no such account, Google-only account, wrong
 * password -- must not be separable by an attacker, because any one of them
 * confirms whether an address is registered.
 */
export async function login(
  input: LoginInput,
  metadata: SessionRequestMetadata = {},
): Promise<AuthResult> {
  const ipKey = `login:ip:${metadata.ipAddress ?? 'unknown'}`
  const emailKey = `login:email:${input.email}`

  await consume({ key: ipKey, ...RATE_LIMITS.loginByIp })
  await consume({ key: emailKey, ...RATE_LIMITS.loginByEmail })

  const invalid = new UnauthenticatedError('Incorrect email or password.')

  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)

  // No account, or an account that has only ever used Google sign-in and so
  // has no hash to compare against.
  if (!user?.passwordHash) {
    await equaliseTiming()
    throw invalid
  }

  const ok = await verifyPassword(user.passwordHash, input.password)
  if (!ok) throw invalid

  if (user.status !== 'active') {
    throw new ForbiddenError(
      'This account has been suspended. Contact your restaurant owner.',
    )
  }

  await reset(emailKey)

  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id))

  const session = await createSession(user.id, metadata)
  const restaurantId = await selectDefaultTenant(user.id, session.token)

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    userId: user.id,
    restaurantId,
  }
}

/**
 * Picks the tenant to land in after login.
 *
 * With exactly one membership there is nothing to choose, so selecting it
 * automatically skips a pointless interstitial. With several, the session
 * stays tenant-less and the UI presents a picker -- guessing would risk
 * opening the wrong restaurant's till.
 */
async function selectDefaultTenant(
  userId: string,
  token: string,
): Promise<string | null> {
  const { listTenantsForUser } = await import('@/modules/rbac/rbac.repository')
  const tenants = await listTenantsForUser(userId)

  if (tenants.length !== 1) return null

  await setActiveTenant(hashToken(token), tenants[0].id)
  return tenants[0].id
}

/** Switches the active restaurant, re-verifying membership server-side. */
export async function switchTenant(
  userId: string,
  tokenHash: string,
  restaurantId: string,
): Promise<void> {
  const { loadMembershipContext } = await import(
    '@/modules/rbac/rbac.repository'
  )

  const membership = await loadMembershipContext(userId, restaurantId)
  if (!membership) {
    // 404 rather than 403: a 403 would confirm the restaurant exists.
    throw new NotFoundError('Restaurant not found.')
  }

  await setActiveTenant(tokenHash, restaurantId)
}

/**
 * Starts a password reset.
 *
 * Always resolves successfully, whether or not the address is registered. The
 * response is the same either way, so this endpoint cannot be used to test
 * which addresses have accounts.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await consume({
    key: `reset:${email}`,
    ...RATE_LIMITS.passwordResetByEmail,
  })

  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.email, email), eq(users.status, 'active')))
    .limit(1)

  if (!user) return

  const token = generateToken()

  await db.insert(verificationTokens).values({
    tokenHash: hashToken(token),
    userId: user.id,
    purpose: 'password_reset',
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
  })

  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`

  await sendEmail({
    to: email,
    subject: 'Reset your password',
    text: [
      `Hi ${user.name},`,
      '',
      'Use the link below to choose a new password. It expires in one hour and can only be used once.',
      '',
      link,
      '',
      'If you did not ask for this, you can ignore this email — your password has not changed.',
    ].join('\n'),
  })
}

/**
 * Completes a password reset.
 *
 * The token is claimed with a conditional UPDATE rather than a read followed
 * by a write. Two requests arriving with the same token race in the read-then-
 * write shape and can both succeed; here the database decides exactly one
 * winner, because only one UPDATE can find the row still unused.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword)

  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(verificationTokens.tokenHash, hashToken(token)),
          eq(verificationTokens.purpose, 'password_reset'),
          isNull(verificationTokens.usedAt),
          gt(verificationTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: verificationTokens.userId })

    if (claimed.length === 0) {
      throw new ValidationError(
        'That reset link is invalid or has expired. Request a new one.',
      )
    }

    await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, claimed[0].userId))

    /**
     * Deleted through `tx`, not through the module-level helper. The helper
     * issues its statement on a different pooled connection, so it would
     * commit independently of this transaction -- meaning a rollback after
     * the token was claimed would still have destroyed the user's sessions,
     * logging them out of a password change that never took effect.
     */
    await tx.delete(sessions).where(eq(sessions.userId, claimed[0].userId))
  })
}

/**
 * Changes the password of a signed-in user.
 *
 * Requires the current password even though the caller is authenticated: it
 * is what stops someone at an unattended terminal from taking the account
 * over. All sessions are then revoked, including any the attacker holds.
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
): Promise<void> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) throw new NotFoundError('Account not found.')

  if (!user.passwordHash) {
    throw new ConflictError(
      'This account signs in with Google and has no password to change.',
    )
  }

  const ok = await verifyPassword(user.passwordHash, input.currentPassword)
  if (!ok) {
    throw new ValidationError('Your current password is not correct.', {
      currentPassword: ['Your current password is not correct.'],
    })
  }

  const passwordHash = await hashPassword(input.newPassword)

  await db.update(users).set({ passwordHash }).where(eq(users.id, userId))
  await invalidateAllUserSessions(userId)
}

/** Audit helper for sign-in events, once a tenant is known. */
export async function recordSignIn(
  restaurantId: string,
  userId: string,
  metadata: SessionRequestMetadata,
): Promise<void> {
  await withTenant({ restaurantId, userId }, (tx) =>
    recordAuditIn(tx, {
      restaurantId,
      actorUserId: userId,
      action: 'auth.signed_in',
      entityType: 'user',
      entityId: userId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    }),
  )
}
