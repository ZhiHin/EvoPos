import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertRuntimeRoleIsSafe, db, withTenant } from '@/lib/db'
import {
  branches,
  memberships,
  restaurants,
  users,
} from '@/lib/db/schema'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { loadMembershipContext, listTenantsForUser } from '@/modules/rbac/rbac.repository'

/**
 * Tenant isolation, verified against a real database.
 *
 * Everything else in this suite tests code. This tests the security boundary
 * the whole product rests on, and it can only be tested for real -- an RLS
 * policy that fails to isolate looks exactly like one that works until two
 * tenants exist at once.
 *
 * Requires a migrated, seeded database:
 *   npm run db:migrate && npm run db:seed
 *   RUN_DB_TESTS=1 npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

/**
 * Asserts a write was refused *by a policy*, not merely that it threw.
 *
 * Drizzle wraps driver errors, so its `.message` is only "Failed query:
 * insert into ...". Matching on that would pass for any failure at all -- a
 * typo in a column name, a dead connection, a unique-key clash -- while
 * appearing to prove tenant isolation. The real reason is on `.cause`, so
 * that is what gets asserted: SQLSTATE 42501 with an explicit row-level
 * security message.
 */
async function expectRlsViolation(promise: Promise<unknown>): Promise<void> {
  let error: unknown
  try {
    await promise
  } catch (caught) {
    error = caught
  }

  expect(error, 'expected the write to be refused, but it succeeded').toBeDefined()

  const cause = (error as { cause?: { message?: string; code?: string } }).cause

  // 42501 = insufficient_privilege, which is what a policy violation raises.
  expect(cause?.code, `unexpected SQLSTATE: ${cause?.message}`).toBe('42501')
  expect(cause?.message).toMatch(/row-level security/i)
}

describe.skipIf(!enabled)('row-level security', () => {
  let alphaId: string
  let betaId: string
  let alphaOwnerId: string
  let betaOwnerId: string

  beforeAll(async () => {
    await syncPermissionRegistry()

    const suffix = randomUUID().slice(0, 8)

    const [alphaOwner] = await db
      .insert(users)
      .values({ email: `alpha-${suffix}@test.local`, name: 'Alpha Owner' })
      .returning({ id: users.id })

    const [betaOwner] = await db
      .insert(users)
      .values({ email: `beta-${suffix}@test.local`, name: 'Beta Owner' })
      .returning({ id: users.id })

    alphaOwnerId = alphaOwner.id
    betaOwnerId = betaOwner.id

    alphaId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, alphaOwnerId, `Alpha ${suffix}`),
      )
    ).restaurantId

    betaId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, betaOwnerId, `Beta ${suffix}`),
      )
    ).restaurantId

    await withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId: alphaId, name: 'Alpha Main', code: 'A1' }),
    )

    await withTenant({ restaurantId: betaId, userId: betaOwnerId }, (tx) =>
      tx
        .insert(branches)
        .values({ restaurantId: betaId, name: 'Beta Main', code: 'B1' }),
    )
  })

  afterAll(async () => {
    // Cleanup runs as the app role, so it is itself subject to RLS.
    await withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, alphaId)),
    )
    await withTenant({ restaurantId: betaId, userId: betaOwnerId }, (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, betaId)),
    )
    await db.delete(users).where(eq(users.id, alphaOwnerId))
    await db.delete(users).where(eq(users.id, betaOwnerId))
  })

  it('connects as a role that cannot bypass RLS', async () => {
    // If this fails, every other assertion below is meaningless.
    await expect(assertRuntimeRoleIsSafe()).resolves.toBeUndefined()
  })

  it('shows a tenant only its own branches', async () => {
    const rows = await withTenant(
      { restaurantId: alphaId, userId: alphaOwnerId },
      (tx) => tx.select().from(branches),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Alpha Main')
  })

  /**
   * The important one. The query explicitly asks for the other tenant's row
   * by primary key -- exactly what an IDOR bug in application code looks
   * like -- and the database returns nothing anyway.
   */
  it('returns nothing when one tenant asks for another tenant’s row by id', async () => {
    const rows = await withTenant(
      { restaurantId: alphaId, userId: alphaOwnerId },
      (tx) =>
        tx.select().from(branches).where(eq(branches.restaurantId, betaId)),
    )

    expect(rows).toHaveLength(0)
  })

  it('hides another tenant’s restaurant row', async () => {
    const rows = await withTenant(
      { restaurantId: alphaId, userId: alphaOwnerId },
      (tx) => tx.select().from(restaurants).where(eq(restaurants.id, betaId)),
    )

    expect(rows).toHaveLength(0)
  })

  /**
   * WITH CHECK, not USING. Without it a tenant could take a row it legitimately
   * owns and reassign it to someone else's restaurant, walking data across the
   * boundary through an UPDATE rather than a SELECT.
   */
  it('refuses to move a row into another tenant', async () => {
    await expectRlsViolation(
      withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, (tx) =>
        tx
          .update(branches)
          .set({ restaurantId: betaId })
          .where(eq(branches.restaurantId, alphaId)),
      ),
    )
  })

  it('refuses to insert a row belonging to another tenant', async () => {
    await expectRlsViolation(
      withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, (tx) =>
        tx
          .insert(branches)
          .values({ restaurantId: betaId, name: 'Smuggled', code: 'X1' }),
      ),
    )
  })

  it('deletes nothing when targeting another tenant', async () => {
    await withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, (tx) =>
      tx.delete(branches).where(eq(branches.restaurantId, betaId)),
    )

    // Beta's branch must still be there.
    const rows = await withTenant(
      { restaurantId: betaId, userId: betaOwnerId },
      (tx) => tx.select().from(branches),
    )
    expect(rows).toHaveLength(1)
  })

  /**
   * Fail closed. With no tenant context the policies compare against NULL,
   * which is never true, so nothing is visible -- rather than everything.
   */
  it('exposes no tenant data when no tenant context is set', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', '', true)`)
      return tx.select().from(branches)
    })

    expect(rows).toHaveLength(0)
  })

  it('is not fooled by an empty-string tenant id', async () => {
    // `''::uuid` would raise rather than yield NULL; the NULLIF in the policy
    // is what turns this into "no rows" instead of a 500.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', '', true)`)
      return tx.select().from(restaurants)
    })

    expect(rows).toHaveLength(0)
  })

  it('discards tenant context when the transaction ends', async () => {
    // set_config(..., true) is transaction-local. If it leaked, a pooled
    // connection would hand one tenant's context to the next request.
    await withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, async (tx) => {
      await tx.select().from(branches)
    })

    const leaked = await db.execute<{ tenant: string | null }>(
      sql`select nullif(current_setting('app.tenant_id', true), '') as tenant`,
    )

    expect(leaked[0]?.tenant ?? null).toBeNull()
  })

  it('lets a user list their own restaurants with no tenant selected', async () => {
    // Exercises memberships_self_read, restaurants_member_read and
    // roles_member_read together -- the path the tenant switcher depends on.
    const tenants = await listTenantsForUser(alphaOwnerId)

    expect(tenants).toHaveLength(1)
    expect(tenants[0].id).toBe(alphaId)
    expect(tenants[0].roleName).toBe('Owner')
  })

  it('does not list restaurants the user has no membership in', async () => {
    const tenants = await listTenantsForUser(alphaOwnerId)
    expect(tenants.map((t) => t.id)).not.toContain(betaId)
  })

  it('refuses to resolve a membership in a tenant the user does not belong to', async () => {
    const context = await loadMembershipContext(alphaOwnerId, betaId)
    expect(context).toBeNull()
  })

  it('grants the owner the full permission set', async () => {
    const context = await loadMembershipContext(alphaOwnerId, alphaId)
    expect(context).not.toBeNull()
    expect(context!.roleKey).toBe('owner')
    expect(context!.permissions.size).toBeGreaterThan(0)
    expect(context!.permissions.has('staff.invite')).toBe(true)
  })

  it('sees no memberships from another tenant', async () => {
    const rows = await withTenant(
      { restaurantId: alphaId, userId: alphaOwnerId },
      (tx) =>
        tx
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.restaurantId, betaId),
              eq(memberships.userId, betaOwnerId),
            ),
          ),
    )

    expect(rows).toHaveLength(0)
  })
})
