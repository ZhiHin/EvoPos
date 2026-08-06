import { cache } from 'react'

import { ForbiddenError, UnauthenticatedError } from '@/lib/errors'
import {
  readSessionCookie,
  setActiveTenant,
  validateSession,
  type AuthenticatedSession,
} from '@/modules/auth/session'
import {
  loadMembershipContext,
  type MembershipContext,
} from '@/modules/rbac/rbac.repository'

/**
 * Request-scoped authentication and authorisation context.
 *
 * This is the single place the rest of the application asks "who is this, and
 * what may they do". Nothing downstream reads the session cookie directly.
 */

export interface AuthContext {
  session: AuthenticatedSession
  user: AuthenticatedSession['user']
  /** Null when signed in but not yet operating inside a restaurant. */
  tenant: MembershipContext | null
}

export interface TenantAuthContext extends AuthContext {
  tenant: MembershipContext
}

/**
 * `cache()` memoises for the lifetime of one request, so a page that renders
 * six server components which each call this performs one session lookup
 * rather than six. It does not cache across requests.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const token = await readSessionCookie()
  if (!token) return null

  const session = await validateSession(token)
  if (!session) return null

  if (!session.activeRestaurantId) {
    return { session, user: session.user, tenant: null }
  }

  const tenant = await loadMembershipContext(
    session.userId,
    session.activeRestaurantId,
  )

  /**
   * The session names a restaurant the user is no longer an active member of
   * -- fired, suspended, or the restaurant itself was suspended. Clear the
   * stale pointer rather than trusting it, and let them fall back to the
   * tenant picker. Re-checking membership on every request instead of
   * trusting the cookie is what makes access revocation immediate.
   */
  if (!tenant) {
    await setActiveTenant(session.tokenHash, null)
    return {
      session: { ...session, activeRestaurantId: null, activeBranchId: null },
      user: session.user,
      tenant: null,
    }
  }

  return { session, user: session.user, tenant }
})

export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext()
  if (!ctx) throw new UnauthenticatedError()
  return ctx
}

/** For anything that touches tenant-scoped data. */
export async function requireTenant(): Promise<TenantAuthContext> {
  const ctx = await requireAuth()
  if (!ctx.tenant) {
    throw new ForbiddenError('Select a restaurant before continuing.')
  }
  return ctx as TenantAuthContext
}

/**
 * The authorisation gate. Every mutating route handler and server action that
 * touches tenant data should open with this.
 *
 * Returns the context so the caller does not need a second lookup, which
 * keeps the guard from being something people skip for convenience.
 */
export async function requirePermission(
  permission: string,
): Promise<TenantAuthContext> {
  const ctx = await requireTenant()
  if (!ctx.tenant.permissions.has(permission)) {
    throw new ForbiddenError(
      `This action requires the "${permission}" permission, which your role (${ctx.tenant.roleName}) does not have.`,
    )
  }
  return ctx
}

export async function requireAnyPermission(
  permissions: readonly string[],
): Promise<TenantAuthContext> {
  const ctx = await requireTenant()
  if (!permissions.some((p) => ctx.tenant.permissions.has(p))) {
    throw new ForbiddenError()
  }
  return ctx
}

/**
 * Non-throwing check, for deciding whether to render a button.
 *
 * Hiding a control is a usability affordance, never an access control --
 * the server-side guard on the corresponding action is what actually
 * enforces the rule.
 */
export async function can(permission: string): Promise<boolean> {
  const ctx = await getAuthContext()
  return ctx?.tenant?.permissions.has(permission) ?? false
}

/**
 * Confirms a member may act on a specific branch.
 *
 * An empty `branchIds` means restaurant-wide access. Branch scoping is not
 * expressible as an RLS policy the way tenant scoping is, because it depends
 * on the membership rather than on a column of the row being read -- so it is
 * enforced here, in the application layer.
 */
export function assertBranchAccess(
  ctx: TenantAuthContext,
  branchId: string,
): void {
  const { branchIds } = ctx.tenant
  if (branchIds.length === 0) return
  if (!branchIds.includes(branchId)) {
    throw new ForbiddenError('You do not have access to that branch.')
  }
}
