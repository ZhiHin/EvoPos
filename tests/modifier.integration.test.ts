import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import { restaurants, users } from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createItem } from '@/modules/menu/item.service'
import {
  attachModifierGroupToItem,
  createModifierGroup,
  createModifierOption,
  deleteModifierOption,
  listModifierGroups,
  loadItemModifierRules,
  updateModifierGroup,
} from '@/modules/modifier/modifier.service'
import {
  addComboGroupItem,
  createCombo,
  createComboGroup,
  loadComboSlotRules,
} from '@/modules/modifier/combo.service'
import {
  calculateLineTotal,
  validateModifierSelections,
} from '@/modules/modifier/pricing'

/**
 * Modifier and combo engine against a real database.
 *
 * The pricing arithmetic is unit-tested in pricing.test.ts. What needs a
 * database is everything the pure functions cannot see: tenant isolation
 * across the seven new tables, the group-coherence rule enforced inside a
 * transaction, and that the rules loaded from storage produce the same
 * answers the engine was tested against.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

const ITEM_BASE = {
  price: 1000,
  status: 'active' as const,
  isFeatured: false,
  isRecommended: false,
  displayOrder: 0,
  tagIds: [],
  unavailableBranchIds: [],
  availability: [],
  attributes: {},
}

describe.skipIf(!enabled)('modifier and combo engine', () => {
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
      .values({ email: `mod-a-${s}@test.local`, name: 'A' })
      .returning({ id: users.id })
    const [b] = await db
      .insert(users)
      .values({ email: `mod-b-${s}@test.local`, name: 'B' })
      .returning({ id: users.id })

    alphaUser = a.id
    betaUser = b.id

    alphaId = (
      await db.transaction((tx) => provisionRestaurant(tx, alphaUser, `MoA ${s}`))
    ).restaurantId
    betaId = (
      await db.transaction((tx) => provisionRestaurant(tx, betaUser, `MoB ${s}`))
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
    it('does not leak modifier groups between restaurants', async () => {
      await createModifierGroup(alpha(), {
        name: 'Alpha Size',
        minSelection: 0,
        displayOrder: 0,
        status: 'active',
      })

      const betaGroups = await listModifierGroups(betaId, betaUser)
      expect(betaGroups.map((g) => g.name)).not.toContain('Alpha Size')
    })

    it('refuses to attach another tenant’s group to an item', async () => {
      const foreignGroup = await createModifierGroup(beta(), {
        name: 'Beta Only',
        minSelection: 0,
        displayOrder: 0,
        status: 'active',
      })

      const item = await createItem(alpha(), {
        ...ITEM_BASE,
        name: 'Alpha item',
      })

      await expect(
        attachModifierGroupToItem(alpha(), item.id, {
          modifierGroupId: foreignGroup.id,
          displayOrder: 0,
        }),
      ).rejects.toThrow(NotFoundError)
    })

    it('refuses to put another tenant’s item into a combo slot', async () => {
      const foreignItem = await createItem(beta(), {
        ...ITEM_BASE,
        name: 'Beta dish',
      })

      const combo = await createCombo(alpha(), {
        name: 'Alpha Set',
        basePrice: 2000,
        status: 'active',
        isFeatured: false,
        displayOrder: 0,
      })
      const slot = await createComboGroup(alpha(), combo.id, {
        name: 'Main',
        minSelection: 1,
        displayOrder: 0,
      })

      await expect(
        addComboGroupItem(alpha(), slot.id, {
          menuItemId: foreignItem.id,
          priceDelta: 0,
          isDefault: false,
          displayOrder: 0,
        }),
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('group coherence', () => {
    it('rejects raising the minimum above the option count', async () => {
      const group = await createModifierGroup(alpha(), {
        name: 'Too Demanding',
        minSelection: 0,
        displayOrder: 0,
        status: 'active',
      })

      await createModifierOption(alpha(), group.id, {
        name: 'Only one',
        priceDelta: 0,
        isDefault: false,
        maxQuantity: 1,
        displayOrder: 0,
        isAvailable: true,
      })

      // Requiring 3 of 1 option makes every order unfulfillable.
      await expect(
        updateModifierGroup(alpha(), group.id, { minSelection: 3 }),
      ).rejects.toThrow(ValidationError)
    })

    /**
     * The rollback case. Deleting the last option of a required group would
     * leave it unsatisfiable, so the coherence check runs inside the same
     * transaction and the delete is undone.
     */
    it('rolls back a delete that would make a required group unsatisfiable', async () => {
      const group = await createModifierGroup(alpha(), {
        name: 'Must Pick One',
        minSelection: 0,
        displayOrder: 0,
        status: 'active',
      })

      const option = await createModifierOption(alpha(), group.id, {
        name: 'The only choice',
        priceDelta: 0,
        isDefault: false,
        maxQuantity: 1,
        displayOrder: 0,
        isAvailable: true,
      })

      await updateModifierGroup(alpha(), group.id, { minSelection: 1 })

      await expect(
        deleteModifierOption(alpha(), option.id),
      ).rejects.toThrow(ValidationError)

      // The option must still be there — the transaction rolled back.
      const groups = await listModifierGroups(alphaId, alphaUser)
      const reloaded = groups.find((g) => g.id === group.id)
      expect(reloaded?.options).toHaveLength(1)
    })

    it('rejects a duplicate option name within a group', async () => {
      const group = await createModifierGroup(alpha(), {
        name: 'Dupe Options',
        minSelection: 0,
        displayOrder: 0,
        status: 'active',
      })

      const option = {
        name: 'Same',
        priceDelta: 0,
        isDefault: false,
        maxQuantity: 1,
        displayOrder: 0,
        isAvailable: true,
      }

      await createModifierOption(alpha(), group.id, option)
      await expect(
        createModifierOption(alpha(), group.id, option),
      ).rejects.toThrow(ConflictError)
    })
  })

  describe('rules loaded from storage', () => {
    it('applies per-item overrides when loading rules', async () => {
      const group = await createModifierGroup(alpha(), {
        name: 'Sauce',
        minSelection: 1,
        maxSelection: 1,
        displayOrder: 0,
        status: 'active',
      })

      await createModifierOption(alpha(), group.id, {
        name: 'Chilli',
        priceDelta: 0,
        isDefault: false,
        maxQuantity: 1,
        displayOrder: 0,
        isAvailable: true,
      })

      const item = await createItem(alpha(), {
        ...ITEM_BASE,
        name: 'Optional sauce dish',
      })

      // The same group is required in general but optional on this item.
      await attachModifierGroupToItem(alpha(), item.id, {
        modifierGroupId: group.id,
        minSelectionOverride: 0,
        displayOrder: 0,
      })

      const rules = await loadItemModifierRules(alphaId, alphaUser, item.id)

      expect(rules).toHaveLength(1)
      expect(rules[0].minSelection).toBe(0)
      // Skipping it must now be valid, which it would not be without the
      // override being honoured.
      expect(() => validateModifierSelections(rules, [])).not.toThrow()
    })

    it('prices a real item end to end from stored rules', async () => {
      const group = await createModifierGroup(alpha(), {
        name: 'Upsize',
        minSelection: 1,
        maxSelection: 1,
        displayOrder: 0,
        status: 'active',
      })

      await createModifierOption(alpha(), group.id, {
        name: 'Regular',
        priceDelta: 0,
        isDefault: true,
        maxQuantity: 1,
        displayOrder: 0,
        isAvailable: true,
      })
      await createModifierOption(alpha(), group.id, {
        name: 'Large',
        priceDelta: 150,
        isDefault: false,
        maxQuantity: 1,
        displayOrder: 1,
        isAvailable: true,
      })

      const item = await createItem(alpha(), {
        ...ITEM_BASE,
        name: 'Priced drink',
        price: 1000,
      })

      await attachModifierGroupToItem(alpha(), item.id, {
        modifierGroupId: group.id,
        displayOrder: 0,
      })

      const rules = await loadItemModifierRules(alphaId, alphaUser, item.id)
      const large = rules[0].options.find((o) => o.name === 'Large')!

      const selections = [
        { groupId: rules[0].groupId, optionId: large.optionId, quantity: 1 },
      ]

      validateModifierSelections(rules, selections)

      const total = calculateLineTotal({
        basePriceMinor: 1000,
        quantity: 3,
        modifierGroups: rules,
        modifierSelections: selections,
      })

      // 3 × (1000 + 150), not 3 × 1000 + 150.
      expect(total.unitPriceMinor).toBe(1150)
      expect(total.lineTotalMinor).toBe(3450)
    })

    it('loads combo slots ready for the engine', async () => {
      const nasi = await createItem(alpha(), { ...ITEM_BASE, name: 'Nasi' })
      const steak = await createItem(alpha(), {
        ...ITEM_BASE,
        name: 'Steak',
        price: 3000,
      })

      const combo = await createCombo(alpha(), {
        name: 'Lunch Set',
        basePrice: 1800,
        status: 'active',
        isFeatured: false,
        displayOrder: 0,
      })

      const slot = await createComboGroup(alpha(), combo.id, {
        name: 'Choose your main',
        minSelection: 1,
        maxSelection: 1,
        displayOrder: 0,
      })

      await addComboGroupItem(alpha(), slot.id, {
        menuItemId: nasi.id,
        priceDelta: 0,
        isDefault: true,
        displayOrder: 0,
      })
      const steakChoice = await addComboGroupItem(alpha(), slot.id, {
        menuItemId: steak.id,
        priceDelta: 800,
        isDefault: false,
        displayOrder: 1,
      })

      const slots = await loadComboSlotRules(alphaId, alphaUser, combo.id)

      expect(slots).toHaveLength(1)
      expect(slots[0].items).toHaveLength(2)

      const total = calculateLineTotal({
        basePriceMinor: 1800,
        quantity: 1,
        comboSlots: slots,
        comboSelections: [
          {
            slotId: slots[0].slotId,
            comboGroupItemId: steakChoice.id,
            quantity: 1,
          },
        ],
      })

      expect(total.lineTotalMinor).toBe(2600)
    })

    it('rejects adding the same item to a slot twice', async () => {
      const item = await createItem(alpha(), { ...ITEM_BASE, name: 'Once' })

      const combo = await createCombo(alpha(), {
        name: 'Dupe Set',
        basePrice: 1000,
        status: 'active',
        isFeatured: false,
        displayOrder: 0,
      })
      const slot = await createComboGroup(alpha(), combo.id, {
        name: 'Slot',
        minSelection: 1,
        displayOrder: 0,
      })

      const payload = {
        menuItemId: item.id,
        priceDelta: 0,
        isDefault: false,
        displayOrder: 0,
      }

      await addComboGroupItem(alpha(), slot.id, payload)
      await expect(
        addComboGroupItem(alpha(), slot.id, payload),
      ).rejects.toThrow(ConflictError)
    })
  })
})
