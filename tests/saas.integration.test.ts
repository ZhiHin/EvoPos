import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import {
  branches,
  restaurants,
  users,
  webhookDeliveries,
  webhookEndpoints,
} from '@/lib/db/schema'
import { ConflictError, PlanLimitError } from '@/lib/errors'
import {
  assertFeature,
  assertQuota,
  changePlan,
  previewPlanChange,
  readPlanStatus,
} from '@/modules/billing/billing.service'
import { createBranch } from '@/modules/branch/branch.service'
import {
  createApiKey,
  listApiKeys,
  resolveApiKey,
  revokeApiKey,
} from '@/modules/integration/api-key.service'
import { createItem } from '@/modules/menu/item.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { createEndpoint } from '@/modules/integration/webhook.service'
import { verifySignature } from '@/modules/integration/webhook'

/**
 * The SaaS surface against a real database.
 *
 * The plan arithmetic, the webhook signing and the group comparison are all
 * unit-tested — 73 tests across three pure engines. What needs a database is
 * that the limits actually bite at the create path, that a key authenticates
 * and stops when revoked, and that a downgrade does not destroy anything.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

const ITEM_BASE = {
  status: 'active' as const,
  isFeatured: false,
  isRecommended: false,
  displayOrder: 0,
  tagIds: [],
  unavailableBranchIds: [],
  availability: [],
  attributes: {},
}

describe.skipIf(!enabled)('plans and integrations', () => {
  let restaurantId: string
  let ownerId: string

  const ctx = () => ({ restaurantId, userId: ownerId })

  async function setPlan(plan: 'launch' | 'grow' | 'scale' | 'enterprise') {
    await withTenant(ctx(), (tx) =>
      tx.update(restaurants).set({ plan }).where(eq(restaurants.id, restaurantId)),
    )
  }

  async function clearBranches(): Promise<void> {
    await withTenant(ctx(), (tx) =>
      tx.delete(branches).where(eq(branches.restaurantId, restaurantId)),
    )
  }

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [owner] = await db
      .insert(users)
      .values({ email: `saas-${s}@test.local`, name: 'Owner' })
      .returning({ id: users.id })
    ownerId = owner.id

    restaurantId = (
      await db.transaction((tx) => provisionRestaurant(tx, ownerId, `SaaS ${s}`))
    ).restaurantId
  })

  afterAll(async () => {
    await withTenant(ctx(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, restaurantId)),
    )
    await db.delete(users).where(eq(users.id, ownerId))
  })

  describe('quotas', () => {
    it('allows the first branch on the smallest plan', async () => {
      await clearBranches()
      await setPlan('launch')

      await expect(
        createBranch(ctx(), { name: 'Main', code: 'M1' }),
      ).resolves.toHaveProperty('id')
    })

    it('refuses the second, and says which plan would allow it', async () => {
      await clearBranches()
      await setPlan('launch')
      await createBranch(ctx(), { name: 'Main', code: 'M1' })

      const error = await createBranch(ctx(), {
        name: 'Second',
        code: 'S1',
      }).catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(PlanLimitError)
      expect((error as PlanLimitError).upgradeTo).toBe('grow')
      // 402, not 403 — this is "change the plan", not "ask an administrator".
      expect((error as PlanLimitError).status).toBe(402)
    })

    it('enforces at the service, so every caller shares the limit', async () => {
      await clearBranches()
      await setPlan('launch')
      await createBranch(ctx(), { name: 'Main', code: 'M1' })

      /**
       * Called directly rather than through the route, which is the point: an
       * API key or an import script hits the same ceiling as the UI because
       * the check is not in the route at all.
       */
      await expect(assertQuota(ctx(), 'branches')).rejects.toBeInstanceOf(
        PlanLimitError,
      )
    })

    it('lifts the ceiling when the plan does', async () => {
      await clearBranches()
      await setPlan('grow')

      await createBranch(ctx(), { name: 'One', code: 'B1' })
      await createBranch(ctx(), { name: 'Two', code: 'B2' })
      await expect(
        createBranch(ctx(), { name: 'Three', code: 'B3' }),
      ).resolves.toHaveProperty('id')
    })

    it('counts menu items too', async () => {
      await setPlan('launch')
      const status = await readPlanStatus(restaurantId, ownerId)
      const items = status.quotas.find((q) => q.quota === 'menuItems')!

      expect(items.limit).toBe(100)

      await createItem(ctx(), { ...ITEM_BASE, name: `Item ${randomUUID()}`, price: 500 })

      const after = await readPlanStatus(restaurantId, ownerId)
      expect(after.usage.menuItems).toBe(items.used + 1)
    })
  })

  describe('downgrading', () => {
    it('never deletes anything', async () => {
      await clearBranches()
      await setPlan('scale')

      await createBranch(ctx(), { name: 'One', code: 'D1' })
      await createBranch(ctx(), { name: 'Two', code: 'D2' })
      await createBranch(ctx(), { name: 'Three', code: 'D3' })

      await changePlan(ctx(), 'launch')

      /**
       * The behaviour this whole design turns on. Three branches, a plan that
       * allows one, and all three still there — because the alternative is
       * software that destroys a customer's data when their card declines.
       */
      const remaining = await withTenant(ctx(), (tx) =>
        tx
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.restaurantId, restaurantId)),
      )

      expect(remaining).toHaveLength(3)

      const status = await readPlanStatus(restaurantId, ownerId)
      expect(status.overQuota.map((s) => s.quota)).toContain('branches')
    })

    it('refuses only the next create', async () => {
      await clearBranches()
      await setPlan('scale')
      await createBranch(ctx(), { name: 'One', code: 'E1' })
      await createBranch(ctx(), { name: 'Two', code: 'E2' })

      await changePlan(ctx(), 'launch')

      await expect(
        createBranch(ctx(), { name: 'Three', code: 'E3' }),
      ).rejects.toBeInstanceOf(PlanLimitError)
    })

    it('says what will happen before it happens', async () => {
      await clearBranches()
      await setPlan('scale')
      await createBranch(ctx(), { name: 'One', code: 'F1' })
      await createBranch(ctx(), { name: 'Two', code: 'F2' })

      const effect = await previewPlanChange(restaurantId, ownerId, 'launch')

      expect(effect.direction).toBe('downgrade')
      expect(effect.wouldExceed.map((s) => s.quota)).toContain('branches')
      expect(effect.wouldLose).toContain('apiKeys')

      // Nothing changed by asking.
      const status = await readPlanStatus(restaurantId, ownerId)
      expect(status.plan.key).toBe('scale')
    })
  })

  describe('feature gates', () => {
    it('refuses a capability the plan excludes', async () => {
      await setPlan('launch')

      await expect(assertFeature(ctx(), 'apiKeys')).rejects.toBeInstanceOf(
        PlanLimitError,
      )
    })

    it('allows it once the plan includes it', async () => {
      await setPlan('scale')
      await expect(assertFeature(ctx(), 'apiKeys')).resolves.toBeUndefined()
    })
  })

  describe('API keys', () => {
    it('authenticates, and carries only its own permissions', async () => {
      await setPlan('scale')

      const { token } = await createApiKey(ctx(), {
        name: 'Stock feed',
        permissions: ['stock.view', 'ingredient.view'],
      })

      const identity = await resolveApiKey(token)

      expect(identity).not.toBeNull()
      expect(identity!.restaurantId).toBe(restaurantId)
      expect(identity!.permissions.has('stock.view')).toBe(true)
      // Not the owner's permissions. A key acts on its own.
      expect(identity!.permissions.has('billing.manage')).toBe(false)
    })

    it('stores only the hash', async () => {
      await setPlan('scale')

      const { token, id } = await createApiKey(ctx(), {
        name: 'Hashed',
        permissions: [],
      })

      const keys = await listApiKeys(restaurantId, ownerId)
      const stored = keys.find((k) => k.id === id)!

      // A dump of the table yields nothing presentable back to the server.
      expect(JSON.stringify(stored)).not.toContain(token)
      expect(token.startsWith(stored.prefix)).toBe(true)
    })

    it('refuses a permission that does not exist', async () => {
      await setPlan('scale')

      await expect(
        createApiKey(ctx(), {
          name: 'Bogus',
          permissions: ['menu.superuser'],
        }),
      ).rejects.toThrow(/unknown permission/i)
    })

    it('stops working the moment it is revoked', async () => {
      await setPlan('scale')

      const { token, id } = await createApiKey(ctx(), {
        name: 'Temporary',
        permissions: ['stock.view'],
      })

      expect(await resolveApiKey(token)).not.toBeNull()

      await revokeApiKey(ctx(), id)

      expect(await resolveApiKey(token)).toBeNull()
      // Revoked, not deleted — the audit trail's referent survives.
      expect(
        (await listApiKeys(restaurantId, ownerId)).find((k) => k.id === id),
      ).toBeDefined()
    })

    it('refuses to revoke twice', async () => {
      await setPlan('scale')
      const { id } = await createApiKey(ctx(), { name: 'Once', permissions: [] })

      await revokeApiKey(ctx(), id)
      await expect(revokeApiKey(ctx(), id)).rejects.toBeInstanceOf(
        ConflictError,
      )
    })

    it('refuses an expired key', async () => {
      await setPlan('scale')

      const { token } = await createApiKey(
        ctx(),
        { name: 'Expiring', permissions: [], expiresInDays: 1 },
        // Created two days ago, so its one-day life is already over.
        new Date(Date.now() - 2 * 24 * 60 * 60_000),
      )

      expect(await resolveApiKey(token)).toBeNull()
    })

    it('is refused entirely on a plan without API access', async () => {
      await setPlan('launch')

      await expect(
        createApiKey(ctx(), { name: 'Nope', permissions: [] }),
      ).rejects.toBeInstanceOf(PlanLimitError)
    })
  })

  describe('webhooks', () => {
    it('signs a payload a receiver can verify', async () => {
      await setPlan('scale')

      const { secret } = await createEndpoint(ctx(), {
        url: 'https://hooks.example.com/ros',
        events: ['bill.settled'],
      })

      const body = JSON.stringify({ type: 'bill.settled' })
      const at = Math.floor(Date.now() / 1_000)

      /**
       * The signature is the only thing between a customer's endpoint and
       * anyone who knows its URL, so the reference implementation is exported
       * and exercised here exactly as a receiver would.
       */
      const { sign } = await import('@/modules/integration/webhook')
      expect(verifySignature(secret, body, at, sign(secret, body, at))).toBe(
        true,
      )
    })

    it('refuses a private address', async () => {
      await setPlan('scale')

      await expect(
        createEndpoint(ctx(), {
          url: 'https://169.254.169.254/latest/meta-data/',
          events: ['bill.settled'],
        }),
      ).rejects.toThrow(/https URL on a public host/i)
    })

    it('refuses an endpoint subscribed to nothing', async () => {
      await setPlan('scale')

      await expect(
        createEndpoint(ctx(), {
          url: 'https://hooks.example.com/quiet',
          events: [],
        }),
      ).rejects.toThrow(/at least one event/i)
    })

    it('queues a delivery per subscribed endpoint, and none otherwise', async () => {
      await setPlan('scale')

      await withTenant(ctx(), (tx) =>
        tx
          .delete(webhookEndpoints)
          .where(eq(webhookEndpoints.restaurantId, restaurantId)),
      )

      await createEndpoint(ctx(), {
        url: 'https://hooks.example.com/settled',
        events: ['bill.settled'],
      })
      await createEndpoint(ctx(), {
        url: 'https://hooks.example.com/bookings',
        events: ['reservation.created'],
      })

      const { enqueueEventIn } = await import(
        '@/modules/integration/webhook.service'
      )

      const queued = await withTenant(ctx(), (tx) =>
        enqueueEventIn(tx, restaurantId, 'bill.settled', { totalMinor: 1_000 }),
      )

      // Only the endpoint that asked for it.
      expect(queued).toBe(1)

      const rows = await withTenant(ctx(), (tx) =>
        tx
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.restaurantId, restaurantId)),
      )
      expect(rows).toHaveLength(1)
    })

    it('does not fail an operation when nobody is listening', async () => {
      await setPlan('scale')

      await withTenant(ctx(), (tx) =>
        tx
          .delete(webhookEndpoints)
          .where(eq(webhookEndpoints.restaurantId, restaurantId)),
      )

      const { enqueueEventIn } = await import(
        '@/modules/integration/webhook.service'
      )

      /**
       * Most restaurants have no endpoints at all. An ordering path that threw
       * because nobody was subscribed would be absurd.
       */
      await expect(
        withTenant(ctx(), (tx) =>
          enqueueEventIn(tx, restaurantId, 'order.placed', {}),
        ),
      ).resolves.toBe(0)
    })

    it('is refused entirely on a plan without webhooks', async () => {
      await setPlan('grow')

      await expect(
        createEndpoint(ctx(), {
          url: 'https://hooks.example.com/ros',
          events: ['bill.settled'],
        }),
      ).rejects.toBeInstanceOf(PlanLimitError)
    })
  })
})
