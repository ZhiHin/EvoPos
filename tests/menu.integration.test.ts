import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import { menuCategories, menuItems, restaurants, users } from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '@/modules/menu/category.service'
import { createItem, listItems } from '@/modules/menu/item.service'
import { createTag } from '@/modules/menu/tag.service'
import { createAttributeDefinition } from '@/modules/menu/attribute.service'

/**
 * Menu engine against a real database.
 *
 * Covers the invariants that cannot be unit-tested because they depend on
 * SQL: tenant isolation across the seven new tables, recursive cycle
 * detection, the depth cap, and the NULLS NOT DISTINCT constraint on root
 * category names.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

describe.skipIf(!enabled)('menu engine', () => {
  let alphaId: string
  let betaId: string
  let alphaUser: string
  let betaUser: string

  const alpha = () => ({ restaurantId: alphaId, userId: alphaUser })
  const beta = () => ({ restaurantId: betaId, userId: betaUser })

  beforeAll(async () => {
    await syncPermissionRegistry()
    const s = randomUUID().slice(0, 8)

    const [a] = await db
      .insert(users)
      .values({ email: `menu-a-${s}@test.local`, name: 'A' })
      .returning({ id: users.id })
    const [b] = await db
      .insert(users)
      .values({ email: `menu-b-${s}@test.local`, name: 'B' })
      .returning({ id: users.id })

    alphaUser = a.id
    betaUser = b.id

    alphaId = (
      await db.transaction((tx) => provisionRestaurant(tx, alphaUser, `MA ${s}`))
    ).restaurantId
    betaId = (
      await db.transaction((tx) => provisionRestaurant(tx, betaUser, `MB ${s}`))
    ).restaurantId
  })

  afterAll(async () => {
    await withTenant(alpha(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, alphaId)),
    )
    await withTenant(beta(), (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, betaId)),
    )
    await db.delete(users).where(eq(users.id, alphaUser))
    await db.delete(users).where(eq(users.id, betaUser))
  })

  describe('tenant isolation', () => {
    it('does not leak categories between restaurants', async () => {
      await createCategory(alpha(), {
        name: 'Alpha Drinks',
        displayOrder: 0,
        status: 'active',
      })

      const betaCategories = await listCategories(betaId, betaUser)
      expect(betaCategories.map((c) => c.name)).not.toContain('Alpha Drinks')
    })

    it('does not leak items between restaurants', async () => {
      await createItem(alpha(), {
        name: 'Alpha Kopi',
        price: 350,
        status: 'active',
        isFeatured: false,
        isRecommended: false,
        displayOrder: 0,
        tagIds: [],
        unavailableBranchIds: [],
        availability: [],
        attributes: {},
      })

      const betaItems = await listItems(betaId, betaUser)
      expect(betaItems.map((i) => i.name)).not.toContain('Alpha Kopi')
    })

    it('refuses to attach an item to another tenant’s category', async () => {
      const foreign = await createCategory(beta(), {
        name: 'Beta Only',
        displayOrder: 0,
        status: 'active',
      })

      // 404 rather than 403 — a 403 would confirm the id is real.
      await expect(
        createItem(alpha(), {
          name: 'Smuggled',
          categoryId: foreign.id,
          price: 100,
          status: 'active',
          isFeatured: false,
          isRecommended: false,
          displayOrder: 0,
          tagIds: [],
          unavailableBranchIds: [],
          availability: [],
          attributes: {},
        }),
      ).rejects.toThrow(NotFoundError)
    })

    it('refuses to attach another tenant’s tag', async () => {
      const foreignTag = await createTag(beta(), {
        name: 'Beta Tag',
        kind: 'label',
      })

      await expect(
        createItem(alpha(), {
          name: 'Tagged',
          price: 100,
          status: 'active',
          isFeatured: false,
          isRecommended: false,
          displayOrder: 0,
          tagIds: [foreignTag.id],
          unavailableBranchIds: [],
          availability: [],
          attributes: {},
        }),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('nested categories', () => {
    it('rejects two root categories with the same name', async () => {
      // NULLS NOT DISTINCT. Without it Postgres treats each NULL parent as
      // unique and both roots would be allowed.
      await createCategory(alpha(), {
        name: 'Duplicate Root',
        displayOrder: 0,
        status: 'active',
      })

      await expect(
        createCategory(alpha(), {
          name: 'Duplicate Root',
          displayOrder: 0,
          status: 'active',
        }),
      ).rejects.toThrow(ConflictError)
    })

    it('allows the same name under different parents', async () => {
      const food = await createCategory(alpha(), {
        name: 'Food X',
        displayOrder: 0,
        status: 'active',
      })
      const drinks = await createCategory(alpha(), {
        name: 'Drinks X',
        displayOrder: 0,
        status: 'active',
      })

      await createCategory(alpha(), {
        name: 'Specials',
        parentId: food.id,
        displayOrder: 0,
        status: 'active',
      })

      await expect(
        createCategory(alpha(), {
          name: 'Specials',
          parentId: drinks.id,
          displayOrder: 0,
          status: 'active',
        }),
      ).resolves.toBeDefined()
    })

    it('rejects making a category its own parent', async () => {
      const c = await createCategory(alpha(), {
        name: 'Self Parent',
        displayOrder: 0,
        status: 'active',
      })

      await expect(
        updateCategory(alpha(), c.id, { parentId: c.id }),
      ).rejects.toThrow(ValidationError)
    })

    /**
     * The cycle case the recursive CTE exists for: moving a parent underneath
     * its own child. Without the check this creates a detached ring that no
     * tree walk can reach and no recursive query can terminate on.
     */
    it('rejects moving a category inside its own subtree', async () => {
      const parent = await createCategory(alpha(), {
        name: 'Cycle Parent',
        displayOrder: 0,
        status: 'active',
      })
      const child = await createCategory(alpha(), {
        name: 'Cycle Child',
        parentId: parent.id,
        displayOrder: 0,
        status: 'active',
      })

      await expect(
        updateCategory(alpha(), parent.id, { parentId: child.id }),
      ).rejects.toThrow(ValidationError)
    })

    it('enforces the depth cap', async () => {
      const l1 = await createCategory(alpha(), {
        name: 'D1',
        displayOrder: 0,
        status: 'active',
      })
      const l2 = await createCategory(alpha(), {
        name: 'D2',
        parentId: l1.id,
        displayOrder: 0,
        status: 'active',
      })
      const l3 = await createCategory(alpha(), {
        name: 'D3',
        parentId: l2.id,
        displayOrder: 0,
        status: 'active',
      })

      await expect(
        createCategory(alpha(), {
          name: 'D4',
          parentId: l3.id,
          displayOrder: 0,
          status: 'active',
        }),
      ).rejects.toThrow(ValidationError)
    })

    /**
     * Deleting a grouping label must not destroy what it grouped. A menu
     * silently losing its items because someone tidied a category is not a
     * recoverable mistake.
     */
    it('orphans items instead of deleting them when a category goes', async () => {
      const category = await createCategory(alpha(), {
        name: 'Doomed',
        displayOrder: 0,
        status: 'active',
      })

      const item = await createItem(alpha(), {
        name: 'Survivor',
        categoryId: category.id,
        price: 500,
        status: 'active',
        isFeatured: false,
        isRecommended: false,
        displayOrder: 0,
        tagIds: [],
        unavailableBranchIds: [],
        availability: [],
        attributes: {},
      })

      await deleteCategory(alpha(), category.id)

      const [survivor] = await withTenant(alpha(), (tx) =>
        tx
          .select({ id: menuItems.id, categoryId: menuItems.categoryId })
          .from(menuItems)
          .where(eq(menuItems.id, item.id)),
      )

      expect(survivor).toBeDefined()
      expect(survivor.categoryId).toBeNull()
    })

    it('promotes child categories to roots when their parent goes', async () => {
      const parent = await createCategory(alpha(), {
        name: 'Going',
        displayOrder: 0,
        status: 'active',
      })
      const child = await createCategory(alpha(), {
        name: 'Staying',
        parentId: parent.id,
        displayOrder: 0,
        status: 'active',
      })

      await deleteCategory(alpha(), parent.id)

      const [row] = await withTenant(alpha(), (tx) =>
        tx
          .select({ parentId: menuCategories.parentId })
          .from(menuCategories)
          .where(eq(menuCategories.id, child.id)),
      )

      expect(row).toBeDefined()
      expect(row.parentId).toBeNull()
    })
  })

  describe('items', () => {
    it('scopes SKU uniqueness to the restaurant, not globally', async () => {
      const sku = `SKU-${randomUUID().slice(0, 6)}`

      const base = {
        price: 100,
        status: 'active' as const,
        isFeatured: false,
        isRecommended: false,
        displayOrder: 0,
        tagIds: [],
        unavailableBranchIds: [],
        availability: [],
        attributes: {},
      }

      await createItem(alpha(), { ...base, name: 'A item', sku })

      // The same SKU in a different restaurant must be allowed — two
      // businesses have no reason to coordinate their product codes.
      await expect(
        createItem(beta(), { ...base, name: 'B item', sku }),
      ).resolves.toBeDefined()

      // But a second time inside the same restaurant must not.
      await expect(
        createItem(alpha(), { ...base, name: 'A dupe', sku }),
      ).rejects.toThrow(ConflictError)
    })

    it('rejects overlapping availability windows on the same day', async () => {
      await expect(
        createItem(alpha(), {
          name: 'Overlapping',
          price: 100,
          status: 'active',
          isFeatured: false,
          isRecommended: false,
          displayOrder: 0,
          tagIds: [],
          unavailableBranchIds: [],
          availability: [
            { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
            { dayOfWeek: 1, startTime: '11:00', endTime: '14:00' },
          ],
          attributes: {},
        }),
      ).rejects.toThrow(ValidationError)
    })

    it('allows non-overlapping windows on the same day', async () => {
      await expect(
        createItem(alpha(), {
          name: 'Breakfast and supper',
          price: 100,
          status: 'active',
          isFeatured: false,
          isRecommended: false,
          displayOrder: 0,
          tagIds: [],
          unavailableBranchIds: [],
          availability: [
            { dayOfWeek: 1, startTime: '07:00', endTime: '11:00' },
            { dayOfWeek: 1, startTime: '18:00', endTime: '22:00' },
          ],
          attributes: {},
        }),
      ).resolves.toBeDefined()
    })

    it('validates custom attributes against this tenant’s definitions', async () => {
      await createAttributeDefinition(alpha(), {
        key: 'spice_level',
        label: 'Spice level',
        type: 'select',
        options: ['mild', 'hot'],
        required: false,
        displayOrder: 0,
      })

      const base = {
        price: 100,
        status: 'active' as const,
        isFeatured: false,
        isRecommended: false,
        displayOrder: 0,
        tagIds: [],
        unavailableBranchIds: [],
        availability: [],
      }

      await expect(
        createItem(alpha(), {
          ...base,
          name: 'Too hot',
          attributes: { spice_level: 'nuclear' },
        }),
      ).rejects.toThrow(ValidationError)

      await expect(
        createItem(alpha(), {
          ...base,
          name: 'Just right',
          attributes: { spice_level: 'hot' },
        }),
      ).resolves.toBeDefined()
    })

    it('does not apply one tenant’s attribute definitions to another', async () => {
      // Beta never defined spice_level, so for Beta it is an unknown key.
      await expect(
        createItem(beta(), {
          name: 'Beta spicy',
          price: 100,
          status: 'active',
          isFeatured: false,
          isRecommended: false,
          displayOrder: 0,
          tagIds: [],
          unavailableBranchIds: [],
          availability: [],
          attributes: { spice_level: 'hot' },
        }),
      ).rejects.toThrow(ValidationError)
    })
  })
})
