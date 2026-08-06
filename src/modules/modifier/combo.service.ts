import { and, asc, eq, inArray } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import {
  comboGroupItems,
  comboGroups,
  combos,
  menuItems,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import type { ComboSlotRules } from './pricing'
import type {
  CreateComboGroupInput,
  CreateComboGroupItemInput,
  CreateComboInput,
  UpdateComboInput,
} from './modifier.validation'

export interface ComboRow {
  id: string
  name: string
  description: string | null
  basePriceMinor: number
  status: 'active' | 'hidden' | 'archived'
  isFeatured: boolean
  displayOrder: number
}

const COMBO_COLUMNS = {
  id: combos.id,
  name: combos.name,
  description: combos.description,
  basePriceMinor: combos.basePriceMinor,
  status: combos.status,
  isFeatured: combos.isFeatured,
  displayOrder: combos.displayOrder,
} as const

export async function listCombos(
  restaurantId: string,
  userId: string,
): Promise<ComboRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(COMBO_COLUMNS)
      .from(combos)
      .where(eq(combos.restaurantId, restaurantId))
      .orderBy(asc(combos.displayOrder), asc(combos.name)),
  )
}

export async function createCombo(
  ctx: BranchActorContext,
  input: CreateComboInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: combos.id })
      .from(combos)
      .where(
        and(
          eq(combos.restaurantId, ctx.restaurantId),
          eq(combos.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(`A combo called "${input.name}" already exists.`)
    }

    const [created] = await tx
      .insert(combos)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        description: input.description ?? null,
        basePriceMinor: input.basePrice,
        status: input.status,
        isFeatured: input.isFeatured,
        displayOrder: input.displayOrder,
      })
      .returning({ id: combos.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.combo.created',
      entityType: 'combo',
      entityId: created.id,
      after: { name: input.name, basePriceMinor: input.basePrice },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateCombo(
  ctx: BranchActorContext,
  comboId: string,
  input: UpdateComboInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COMBO_COLUMNS)
      .from(combos)
      .where(
        and(
          eq(combos.id, comboId),
          eq(combos.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Combo not found.')

    await tx
      .update(combos)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description || null }
          : {}),
        ...(input.basePrice !== undefined
          ? { basePriceMinor: input.basePrice }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.isFeatured !== undefined
          ? { isFeatured: input.isFeatured }
          : {}),
        ...(input.displayOrder !== undefined
          ? { displayOrder: input.displayOrder }
          : {}),
      })
      .where(eq(combos.id, comboId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.combo.updated',
      entityType: 'combo',
      entityId: comboId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function deleteCombo(
  ctx: BranchActorContext,
  comboId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COMBO_COLUMNS)
      .from(combos)
      .where(
        and(
          eq(combos.id, comboId),
          eq(combos.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Combo not found.')

    /**
     * Slots and their offered items cascade. The referenced menu items are
     * untouched — a combo is an arrangement of items, and dismantling the
     * arrangement must not delete the food.
     */
    await tx.delete(combos).where(eq(combos.id, comboId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.combo.deleted',
      entityType: 'combo',
      entityId: comboId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function createComboGroup(
  ctx: BranchActorContext,
  comboId: string,
  input: CreateComboGroupInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [combo] = await tx
      .select({ id: combos.id })
      .from(combos)
      .where(
        and(
          eq(combos.id, comboId),
          eq(combos.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!combo) throw new NotFoundError('Combo not found.')

    if (
      input.maxSelection !== null &&
      input.maxSelection !== undefined &&
      input.minSelection > input.maxSelection
    ) {
      throw new ValidationError('Slot rules cannot be satisfied.', {
        minSelection: ['Minimum cannot exceed maximum.'],
      })
    }

    const [clash] = await tx
      .select({ id: comboGroups.id })
      .from(comboGroups)
      .where(
        and(
          eq(comboGroups.comboId, comboId),
          eq(comboGroups.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `This combo already has a slot called "${input.name}".`,
      )
    }

    const [created] = await tx
      .insert(comboGroups)
      .values({
        restaurantId: ctx.restaurantId,
        comboId,
        name: input.name,
        minSelection: input.minSelection,
        maxSelection: input.maxSelection ?? null,
        displayOrder: input.displayOrder,
      })
      .returning({ id: comboGroups.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.combo_slot.created',
      entityType: 'combo_group',
      entityId: created.id,
      after: { comboId, name: input.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function addComboGroupItem(
  ctx: BranchActorContext,
  comboGroupId: string,
  input: CreateComboGroupItemInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [slot] = await tx
      .select({ id: comboGroups.id })
      .from(comboGroups)
      .where(
        and(
          eq(comboGroups.id, comboGroupId),
          eq(comboGroups.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!slot) throw new NotFoundError('Combo slot not found.')

    // Confirms the menu item is this tenant's. RLS already prevents reading
    // another tenant's item, so a foreign id simply is not found.
    const [item] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.id, input.menuItemId),
          eq(menuItems.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!item) throw new NotFoundError('Menu item not found.')

    const [clash] = await tx
      .select({ id: comboGroupItems.id })
      .from(comboGroupItems)
      .where(
        and(
          eq(comboGroupItems.comboGroupId, comboGroupId),
          eq(comboGroupItems.menuItemId, input.menuItemId),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError('That item is already offered in this slot.')
    }

    const [created] = await tx
      .insert(comboGroupItems)
      .values({
        restaurantId: ctx.restaurantId,
        comboGroupId,
        menuItemId: input.menuItemId,
        priceDeltaMinor: input.priceDelta,
        isDefault: input.isDefault,
        displayOrder: input.displayOrder,
      })
      .returning({ id: comboGroupItems.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.combo_slot_item.added',
      entityType: 'combo_group_item',
      entityId: created.id,
      after: {
        comboGroupId,
        menuItemId: input.menuItemId,
        priceDelta: input.priceDelta,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function removeComboGroupItem(
  ctx: BranchActorContext,
  comboGroupItemId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: comboGroupItems.id,
        comboGroupId: comboGroupItems.comboGroupId,
        menuItemId: comboGroupItems.menuItemId,
      })
      .from(comboGroupItems)
      .where(
        and(
          eq(comboGroupItems.id, comboGroupItemId),
          eq(comboGroupItems.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Combo item not found.')

    await tx
      .delete(comboGroupItems)
      .where(eq(comboGroupItems.id, comboGroupItemId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.combo_slot_item.removed',
      entityType: 'combo_group_item',
      entityId: comboGroupItemId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Loads a combo's slots ready for the pricing engine.
 *
 * Note what this does NOT return: the modifier groups of the items inside
 * each slot. Those are fetched per chosen item via `loadItemModifierRules`,
 * because a combo with six options across three slots would otherwise load
 * eighteen items' worth of modifier rules to price one that the customer
 * picked.
 */
export async function loadComboSlotRules(
  restaurantId: string,
  userId: string,
  comboId: string,
): Promise<ComboSlotRules[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const slots = await tx
      .select({
        slotId: comboGroups.id,
        name: comboGroups.name,
        minSelection: comboGroups.minSelection,
        maxSelection: comboGroups.maxSelection,
      })
      .from(comboGroups)
      .where(
        and(
          eq(comboGroups.comboId, comboId),
          eq(comboGroups.restaurantId, restaurantId),
        ),
      )
      .orderBy(asc(comboGroups.displayOrder), asc(comboGroups.name))

    if (slots.length === 0) return []

    const items = await tx
      .select({
        comboGroupItemId: comboGroupItems.id,
        comboGroupId: comboGroupItems.comboGroupId,
        menuItemId: comboGroupItems.menuItemId,
        priceDeltaMinor: comboGroupItems.priceDeltaMinor,
      })
      .from(comboGroupItems)
      .where(
        inArray(
          comboGroupItems.comboGroupId,
          slots.map((s) => s.slotId),
        ),
      )
      .orderBy(asc(comboGroupItems.displayOrder))

    return slots.map((slot) => ({
      ...slot,
      items: items
        .filter((i) => i.comboGroupId === slot.slotId)
        .map(({ comboGroupItemId, menuItemId, priceDeltaMinor }) => ({
          comboGroupItemId,
          menuItemId,
          priceDeltaMinor,
        })),
    }))
  })
}
