import { and, eq } from 'drizzle-orm'

import { withActor, withTenant } from '@/lib/db'
import {
  membershipBranches,
  memberships,
  restaurants,
  rolePermissions,
  roles,
} from '@/lib/db/schema'

export interface MembershipContext {
  membershipId: string
  restaurantId: string
  restaurantName: string
  restaurantSlug: string
  roleId: string
  roleKey: string
  roleName: string
  /** Empty means restaurant-wide access, not "no access". */
  branchIds: string[]
  permissions: Set<string>
}

export interface TenantSummary {
  id: string
  name: string
  slug: string
  roleName: string
}

/**
 * Loads everything needed to authorise a request inside one tenant.
 *
 * Runs inside `withTenant`, so all three reads are additionally filtered by
 * row-level security. The explicit WHERE clauses and the policies are
 * redundant with each other by design -- that redundancy is the point. A
 * mistake in this query cannot leak another tenant's roles, because the
 * database would refuse to return them regardless of what the SQL asked for.
 *
 * Returns null when the user holds no active membership, which the caller
 * treats as "not a member of this restaurant".
 */
export async function loadMembershipContext(
  userId: string,
  restaurantId: string,
): Promise<MembershipContext | null> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const [row] = await tx
      .select({
        membershipId: memberships.id,
        restaurantId: memberships.restaurantId,
        restaurantName: restaurants.name,
        restaurantSlug: restaurants.slug,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
      })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .innerJoin(restaurants, eq(restaurants.id, memberships.restaurantId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.restaurantId, restaurantId),
          eq(memberships.status, 'active'),
          eq(restaurants.status, 'active'),
        ),
      )
      .limit(1)

    if (!row) return null

    const [permissionRows, branchRows] = await Promise.all([
      tx
        .select({ code: rolePermissions.permissionCode })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, row.roleId)),
      tx
        .select({ branchId: membershipBranches.branchId })
        .from(membershipBranches)
        .where(eq(membershipBranches.membershipId, row.membershipId)),
    ])

    return {
      ...row,
      branchIds: branchRows.map((b) => b.branchId),
      permissions: new Set(permissionRows.map((p) => p.code)),
    }
  })
}

/**
 * Restaurants the user can switch into.
 *
 * Uses `withActor` rather than `withTenant` because this is the one query
 * that must work with no tenant selected -- immediately after login, or after
 * the active restaurant was suspended. It is satisfied by the two self-scoped
 * policies (`memberships_self_read`, `restaurants_member_read`) and nothing
 * else; the tenant policies all evaluate against a NULL tenant id here and
 * contribute no rows.
 */
export async function listTenantsForUser(
  userId: string,
): Promise<TenantSummary[]> {
  return withActor(userId, async (tx) =>
    tx
      .select({
        id: restaurants.id,
        name: restaurants.name,
        slug: restaurants.slug,
        roleName: roles.name,
      })
      .from(memberships)
      .innerJoin(restaurants, eq(restaurants.id, memberships.restaurantId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          eq(restaurants.status, 'active'),
        ),
      ),
  )
}
