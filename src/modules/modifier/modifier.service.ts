import { and, asc, eq, inArray } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifierOptions,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  assertGroupRulesAreCoherent,
  resolveGroupRules,
  type ModifierGroupRules,
} from './pricing'
import type {
  AttachModifierGroupInput,
  CreateModifierGroupInput,
  CreateModifierOptionInput,
  UpdateModifierGroupInput,
  UpdateModifierOptionInput,
} from './modifier.validation'

export interface ModifierGroupRow {
  id: string
  name: string
  description: string | null
  minSelection: number
  maxSelection: number | null
  displayOrder: number
  status: 'active' | 'hidden'
}

export interface ModifierOptionRow {
  id: string
  groupId: string
  name: string
  priceDeltaMinor: number
  isDefault: boolean
  maxQuantity: number
  displayOrder: number
  isAvailable: boolean
}

const GROUP_COLUMNS = {
  id: modifierGroups.id,
  name: modifierGroups.name,
  description: modifierGroups.description,
  minSelection: modifierGroups.minSelection,
  maxSelection: modifierGroups.maxSelection,
  displayOrder: modifierGroups.displayOrder,
  status: modifierGroups.status,
} as const

const OPTION_COLUMNS = {
  id: modifierOptions.id,
  groupId: modifierOptions.groupId,
  name: modifierOptions.name,
  priceDeltaMinor: modifierOptions.priceDeltaMinor,
  isDefault: modifierOptions.isDefault,
  maxQuantity: modifierOptions.maxQuantity,
  displayOrder: modifierOptions.displayOrder,
  isAvailable: modifierOptions.isAvailable,
} as const

export async function listModifierGroups(
  restaurantId: string,
  userId: string,
): Promise<(ModifierGroupRow & { options: ModifierOptionRow[] })[]> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const groups = await tx
      .select(GROUP_COLUMNS)
      .from(modifierGroups)
      .where(eq(modifierGroups.restaurantId, restaurantId))
      .orderBy(asc(modifierGroups.displayOrder), asc(modifierGroups.name))

    if (groups.length === 0) return []

    const options = await tx
      .select(OPTION_COLUMNS)
      .from(modifierOptions)
      .where(
        inArray(
          modifierOptions.groupId,
          groups.map((g) => g.id),
        ),
      )
      .orderBy(asc(modifierOptions.displayOrder), asc(modifierOptions.name))

    const byGroup = new Map<string, ModifierOptionRow[]>()
    for (const option of options) {
      const list = byGroup.get(option.groupId) ?? []
      list.push(option)
      byGroup.set(option.groupId, list)
    }

    return groups.map((group) => ({
      ...group,
      options: byGroup.get(group.id) ?? [],
    }))
  })
}

/**
 * Re-checks a group's rules against its current options.
 *
 * Called after every change to either the rules or the option set, because
 * the two can be made incoherent from both directions: raising `minSelection`
 * above the option count, or deleting options until it exceeds them.
 */
async function assertGroupIsSatisfiable(
  tx: Transaction,
  restaurantId: string,
  groupId: string,
): Promise<void> {
  const [group] = await tx
    .select(GROUP_COLUMNS)
    .from(modifierGroups)
    .where(
      and(
        eq(modifierGroups.id, groupId),
        eq(modifierGroups.restaurantId, restaurantId),
      ),
    )
    .limit(1)

  if (!group) throw new NotFoundError('Modifier group not found.')

  const options = await tx
    .select({
      id: modifierOptions.id,
      isDefault: modifierOptions.isDefault,
    })
    .from(modifierOptions)
    .where(eq(modifierOptions.groupId, groupId))

  assertGroupRulesAreCoherent({
    name: group.name,
    minSelection: group.minSelection,
    maxSelection: group.maxSelection,
    optionCount: options.length,
    defaultCount: options.filter((o) => o.isDefault).length,
  })
}

export async function createModifierGroup(
  ctx: BranchActorContext,
  input: CreateModifierGroupInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: modifierGroups.id })
      .from(modifierGroups)
      .where(
        and(
          eq(modifierGroups.restaurantId, ctx.restaurantId),
          eq(modifierGroups.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `A modifier group called "${input.name}" already exists.`,
      )
    }

    /**
     * A brand new group has no options yet, so requiring a selection now
     * would fail its own coherence check. The rule is enforced on every
     * subsequent change instead, by which point options exist.
     */
    const [created] = await tx
      .insert(modifierGroups)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        description: input.description ?? null,
        minSelection: input.minSelection,
        maxSelection: input.maxSelection ?? null,
        displayOrder: input.displayOrder,
        status: input.status,
      })
      .returning({ id: modifierGroups.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_group.created',
      entityType: 'modifier_group',
      entityId: created.id,
      after: { name: input.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateModifierGroup(
  ctx: BranchActorContext,
  groupId: string,
  input: UpdateModifierGroupInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(GROUP_COLUMNS)
      .from(modifierGroups)
      .where(
        and(
          eq(modifierGroups.id, groupId),
          eq(modifierGroups.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Modifier group not found.')

    await tx
      .update(modifierGroups)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description || null }
          : {}),
        ...(input.minSelection !== undefined
          ? { minSelection: input.minSelection }
          : {}),
        ...(input.maxSelection !== undefined
          ? { maxSelection: input.maxSelection }
          : {}),
        ...(input.displayOrder !== undefined
          ? { displayOrder: input.displayOrder }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      })
      .where(eq(modifierGroups.id, groupId))

    await assertGroupIsSatisfiable(tx, ctx.restaurantId, groupId)

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_group.updated',
      entityType: 'modifier_group',
      entityId: groupId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function deleteModifierGroup(
  ctx: BranchActorContext,
  groupId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(GROUP_COLUMNS)
      .from(modifierGroups)
      .where(
        and(
          eq(modifierGroups.id, groupId),
          eq(modifierGroups.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Modifier group not found.')

    // Options and item attachments cascade — removing the question removes
    // its answers and its use on every item that asked it.
    await tx.delete(modifierGroups).where(eq(modifierGroups.id, groupId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_group.deleted',
      entityType: 'modifier_group',
      entityId: groupId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function createModifierOption(
  ctx: BranchActorContext,
  groupId: string,
  input: CreateModifierOptionInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [group] = await tx
      .select({ id: modifierGroups.id })
      .from(modifierGroups)
      .where(
        and(
          eq(modifierGroups.id, groupId),
          eq(modifierGroups.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!group) throw new NotFoundError('Modifier group not found.')

    const [clash] = await tx
      .select({ id: modifierOptions.id })
      .from(modifierOptions)
      .where(
        and(
          eq(modifierOptions.groupId, groupId),
          eq(modifierOptions.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `This group already has an option called "${input.name}".`,
      )
    }

    const [created] = await tx
      .insert(modifierOptions)
      .values({
        restaurantId: ctx.restaurantId,
        groupId,
        name: input.name,
        priceDeltaMinor: input.priceDelta,
        isDefault: input.isDefault,
        maxQuantity: input.maxQuantity,
        displayOrder: input.displayOrder,
        isAvailable: input.isAvailable,
      })
      .returning({ id: modifierOptions.id })

    await assertGroupIsSatisfiable(tx, ctx.restaurantId, groupId)

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_option.created',
      entityType: 'modifier_option',
      entityId: created.id,
      after: { groupId, name: input.name, priceDelta: input.priceDelta },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateModifierOption(
  ctx: BranchActorContext,
  optionId: string,
  input: UpdateModifierOptionInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(OPTION_COLUMNS)
      .from(modifierOptions)
      .where(
        and(
          eq(modifierOptions.id, optionId),
          eq(modifierOptions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Modifier option not found.')

    await tx
      .update(modifierOptions)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.priceDelta !== undefined
          ? { priceDeltaMinor: input.priceDelta }
          : {}),
        ...(input.isDefault !== undefined
          ? { isDefault: input.isDefault }
          : {}),
        ...(input.maxQuantity !== undefined
          ? { maxQuantity: input.maxQuantity }
          : {}),
        ...(input.displayOrder !== undefined
          ? { displayOrder: input.displayOrder }
          : {}),
        ...(input.isAvailable !== undefined
          ? { isAvailable: input.isAvailable }
          : {}),
      })
      .where(eq(modifierOptions.id, optionId))

    await assertGroupIsSatisfiable(tx, ctx.restaurantId, existing.groupId)

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_option.updated',
      entityType: 'modifier_option',
      entityId: optionId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function deleteModifierOption(
  ctx: BranchActorContext,
  optionId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(OPTION_COLUMNS)
      .from(modifierOptions)
      .where(
        and(
          eq(modifierOptions.id, optionId),
          eq(modifierOptions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Modifier option not found.')

    await tx.delete(modifierOptions).where(eq(modifierOptions.id, optionId))

    /**
     * Deleting an option can make a required group unsatisfiable — the
     * transaction rolls back rather than leaving a group that no order can
     * ever fulfil.
     */
    await assertGroupIsSatisfiable(tx, ctx.restaurantId, existing.groupId)

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_option.deleted',
      entityType: 'modifier_option',
      entityId: optionId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function attachModifierGroupToItem(
  ctx: BranchActorContext,
  menuItemId: string,
  input: AttachModifierGroupInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [item] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.id, menuItemId),
          eq(menuItems.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)
    if (!item) throw new NotFoundError('Menu item not found.')

    const [group] = await tx
      .select({ id: modifierGroups.id })
      .from(modifierGroups)
      .where(
        and(
          eq(modifierGroups.id, input.modifierGroupId),
          eq(modifierGroups.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)
    if (!group) throw new NotFoundError('Modifier group not found.')

    await tx
      .insert(menuItemModifierGroups)
      .values({
        menuItemId,
        modifierGroupId: input.modifierGroupId,
        restaurantId: ctx.restaurantId,
        minSelectionOverride: input.minSelectionOverride ?? null,
        maxSelectionOverride: input.maxSelectionOverride ?? null,
        displayOrder: input.displayOrder,
      })
      .onConflictDoUpdate({
        target: [
          menuItemModifierGroups.menuItemId,
          menuItemModifierGroups.modifierGroupId,
        ],
        set: {
          minSelectionOverride: input.minSelectionOverride ?? null,
          maxSelectionOverride: input.maxSelectionOverride ?? null,
          displayOrder: input.displayOrder,
        },
      })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_group.attached',
      entityType: 'menu_item',
      entityId: menuItemId,
      after: { modifierGroupId: input.modifierGroupId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function detachModifierGroupFromItem(
  ctx: BranchActorContext,
  menuItemId: string,
  modifierGroupId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx
      .delete(menuItemModifierGroups)
      .where(
        and(
          eq(menuItemModifierGroups.menuItemId, menuItemId),
          eq(menuItemModifierGroups.modifierGroupId, modifierGroupId),
          eq(menuItemModifierGroups.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.modifier_group.detached',
      entityType: 'menu_item',
      entityId: menuItemId,
      before: { modifierGroupId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Loads the effective modifier rules for one item, ready to hand to the
 * pricing engine.
 *
 * This is the bridge between storage and `validateModifierSelections` — the
 * per-item overrides are resolved here so nothing downstream has to know they
 * exist.
 */
export async function loadItemModifierRules(
  restaurantId: string,
  userId: string,
  menuItemId: string,
): Promise<ModifierGroupRules[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    loadItemModifierRulesIn(tx, restaurantId, menuItemId),
  )
}

/**
 * Same, but inside a caller-supplied transaction.
 *
 * Exists because the diner ordering path runs under `withDiner`, which has no
 * tenant context and therefore cannot call the wrapper above. The queries are
 * identical; only the surrounding context differs, and the diner-read
 * policies grant exactly the SELECT access these need.
 */
export async function loadItemModifierRulesIn(
  tx: Transaction,
  restaurantId: string,
  menuItemId: string,
): Promise<ModifierGroupRules[]> {
  {
    const attached = await tx
      .select({
        groupId: modifierGroups.id,
        name: modifierGroups.name,
        minSelection: modifierGroups.minSelection,
        maxSelection: modifierGroups.maxSelection,
        minSelectionOverride: menuItemModifierGroups.minSelectionOverride,
        maxSelectionOverride: menuItemModifierGroups.maxSelectionOverride,
        displayOrder: menuItemModifierGroups.displayOrder,
      })
      .from(menuItemModifierGroups)
      .innerJoin(
        modifierGroups,
        eq(modifierGroups.id, menuItemModifierGroups.modifierGroupId),
      )
      .where(
        and(
          eq(menuItemModifierGroups.menuItemId, menuItemId),
          eq(menuItemModifierGroups.restaurantId, restaurantId),
          eq(modifierGroups.status, 'active'),
        ),
      )
      .orderBy(asc(menuItemModifierGroups.displayOrder))

    if (attached.length === 0) return []

    const options = await tx
      .select(OPTION_COLUMNS)
      .from(modifierOptions)
      .where(
        inArray(
          modifierOptions.groupId,
          attached.map((a) => a.groupId),
        ),
      )
      .orderBy(asc(modifierOptions.displayOrder))

    return attached.map((group) => {
      const rules = resolveGroupRules(group, group)

      return {
        groupId: group.groupId,
        name: group.name,
        minSelection: rules.minSelection,
        maxSelection: rules.maxSelection,
        options: options
          .filter((o) => o.groupId === group.groupId)
          .map((o) => ({
            optionId: o.id,
            name: o.name,
            priceDeltaMinor: o.priceDeltaMinor,
            maxQuantity: o.maxQuantity,
            isAvailable: o.isAvailable,
          })),
      }
    })
  }
}
