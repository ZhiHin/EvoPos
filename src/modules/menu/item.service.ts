import { and, asc, eq, inArray } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  branches,
  menuCategories,
  menuItemAvailability,
  menuItemBranches,
  menuItemTags,
  menuItems,
  menuTags,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { assertQuota } from '@/modules/billing/billing.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  listAttributeDefinitionsIn,
  validateAttributeValues,
} from './attribute.service'
import type { CreateItemInput, UpdateItemInput } from './menu.validation'

export interface MenuItemRow {
  id: string
  categoryId: string | null
  name: string
  description: string | null
  priceMinor: number
  costPriceMinor: number | null
  taxRateBasisPoints: number | null
  serviceChargeBasisPoints: number | null
  sku: string | null
  barcode: string | null
  calories: number | null
  prepTimeMinutes: number | null
  status: 'active' | 'hidden' | 'archived'
  isFeatured: boolean
  isRecommended: boolean
  displayOrder: number
  attributes: Record<string, unknown>
}

export interface MenuItemDetail extends MenuItemRow {
  tagIds: string[]
  unavailableBranchIds: string[]
  availability: {
    dayOfWeek: number
    startTime: string
    endTime: string
  }[]
}

const COLUMNS = {
  id: menuItems.id,
  categoryId: menuItems.categoryId,
  name: menuItems.name,
  description: menuItems.description,
  priceMinor: menuItems.priceMinor,
  costPriceMinor: menuItems.costPriceMinor,
  taxRateBasisPoints: menuItems.taxRateBasisPoints,
  serviceChargeBasisPoints: menuItems.serviceChargeBasisPoints,
  sku: menuItems.sku,
  barcode: menuItems.barcode,
  calories: menuItems.calories,
  prepTimeMinutes: menuItems.prepTimeMinutes,
  status: menuItems.status,
  isFeatured: menuItems.isFeatured,
  isRecommended: menuItems.isRecommended,
  displayOrder: menuItems.displayOrder,
  attributes: menuItems.attributes,
} as const

export async function listItems(
  restaurantId: string,
  userId: string,
): Promise<MenuItemRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(COLUMNS)
      .from(menuItems)
      .where(eq(menuItems.restaurantId, restaurantId))
      .orderBy(asc(menuItems.displayOrder), asc(menuItems.name)),
  )
}

/**
 * Confirms every referenced id belongs to this tenant.
 *
 * RLS already guarantees a foreign row cannot be *read*, but an insert
 * naming another tenant's tag id would fail on the foreign key with an opaque
 * 500 rather than a message anyone can act on. Checking first turns that into
 * a 404, and — because the lookups run under the tenant policy — an id from
 * another restaurant is simply not found.
 */
async function assertReferencesBelongToTenant(
  tx: Transaction,
  restaurantId: string,
  refs: {
    categoryId?: string | null
    tagIds?: string[]
    branchIds?: string[]
  },
): Promise<void> {
  if (refs.categoryId) {
    const [category] = await tx
      .select({ id: menuCategories.id })
      .from(menuCategories)
      .where(
        and(
          eq(menuCategories.id, refs.categoryId),
          eq(menuCategories.restaurantId, restaurantId),
        ),
      )
      .limit(1)
    if (!category) throw new NotFoundError('Category not found.')
  }

  if (refs.tagIds?.length) {
    const found = await tx
      .select({ id: menuTags.id })
      .from(menuTags)
      .where(
        and(
          eq(menuTags.restaurantId, restaurantId),
          inArray(menuTags.id, refs.tagIds),
        ),
      )
    if (found.length !== new Set(refs.tagIds).size) {
      throw new NotFoundError('One or more tags were not found.')
    }
  }

  if (refs.branchIds?.length) {
    const found = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.restaurantId, restaurantId),
          inArray(branches.id, refs.branchIds),
        ),
      )
    if (found.length !== new Set(refs.branchIds).size) {
      throw new NotFoundError('One or more branches were not found.')
    }
  }
}

/**
 * Rejects overlapping availability windows on the same weekday.
 *
 * Overlaps are not merely untidy: "is this available now" becomes ambiguous,
 * and any later attempt to compute a single active window per day has to pick
 * arbitrarily between them.
 */
function assertWindowsDoNotOverlap(
  windows: CreateItemInput['availability'],
): void {
  const byDay = new Map<number, { startTime: string; endTime: string }[]>()

  for (const window of windows) {
    const day = byDay.get(window.dayOfWeek) ?? []
    day.push(window)
    byDay.set(window.dayOfWeek, day)
  }

  for (const [day, list] of byDay) {
    const sorted = [...list].sort((a, b) =>
      a.startTime.localeCompare(b.startTime),
    )
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startTime < sorted[i - 1].endTime) {
        throw new ValidationError(
          'Availability windows on the same day cannot overlap.',
          {
            availability: [
              `Two windows overlap on day ${day} (${sorted[i - 1].startTime}–${sorted[i - 1].endTime} and ${sorted[i].startTime}–${sorted[i].endTime}).`,
            ],
          },
        )
      }
    }
  }
}

async function replaceItemRelations(
  tx: Transaction,
  restaurantId: string,
  itemId: string,
  input: {
    tagIds?: string[]
    unavailableBranchIds?: string[]
    availability?: CreateItemInput['availability']
  },
): Promise<void> {
  if (input.tagIds) {
    await tx.delete(menuItemTags).where(eq(menuItemTags.menuItemId, itemId))
    if (input.tagIds.length > 0) {
      await tx.insert(menuItemTags).values(
        [...new Set(input.tagIds)].map((tagId) => ({
          menuItemId: itemId,
          tagId,
          restaurantId,
        })),
      )
    }
  }

  if (input.unavailableBranchIds) {
    await tx
      .delete(menuItemBranches)
      .where(eq(menuItemBranches.menuItemId, itemId))
    if (input.unavailableBranchIds.length > 0) {
      // Only exceptions are stored; absence of a row means available.
      await tx.insert(menuItemBranches).values(
        [...new Set(input.unavailableBranchIds)].map((branchId) => ({
          menuItemId: itemId,
          branchId,
          restaurantId,
          isAvailable: false,
        })),
      )
    }
  }

  if (input.availability) {
    await tx
      .delete(menuItemAvailability)
      .where(eq(menuItemAvailability.menuItemId, itemId))
    if (input.availability.length > 0) {
      await tx.insert(menuItemAvailability).values(
        input.availability.map((window) => ({
          menuItemId: itemId,
          restaurantId,
          dayOfWeek: window.dayOfWeek,
          startTime: window.startTime,
          endTime: window.endTime,
        })),
      )
    }
  }
}

export async function createItem(
  ctx: BranchActorContext,
  input: CreateItemInput,
): Promise<{ id: string }> {
  // The plan's ceiling, in the service so every create path shares it.
  await assertQuota(ctx, 'menuItems')

  return withTenant(ctx, async (tx) => {
    await assertReferencesBelongToTenant(tx, ctx.restaurantId, {
      categoryId: input.categoryId,
      tagIds: input.tagIds,
      branchIds: input.unavailableBranchIds,
    })

    assertWindowsDoNotOverlap(input.availability)

    const definitions = await listAttributeDefinitionsIn(tx, ctx.restaurantId)
    const attributes = validateAttributeValues(definitions, input.attributes)

    if (input.sku) {
      const [clash] = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.restaurantId, ctx.restaurantId),
            eq(menuItems.sku, input.sku),
          ),
        )
        .limit(1)
      if (clash) {
        throw new ConflictError(`SKU "${input.sku}" is already in use.`)
      }
    }

    const [created] = await tx
      .insert(menuItems)
      .values({
        restaurantId: ctx.restaurantId,
        categoryId: input.categoryId ?? null,
        name: input.name,
        description: input.description ?? null,
        priceMinor: input.price,
        costPriceMinor: input.costPrice ?? null,
        taxRateBasisPoints: input.taxRatePercent ?? null,
        serviceChargeBasisPoints: input.serviceChargePercent ?? null,
        sku: input.sku || null,
        barcode: input.barcode || null,
        calories: input.calories ?? null,
        prepTimeMinutes: input.prepTimeMinutes ?? null,
        ingredientsText: input.ingredientsText ?? null,
        status: input.status,
        isFeatured: input.isFeatured,
        isRecommended: input.isRecommended,
        displayOrder: input.displayOrder,
        attributes,
      })
      .returning({ id: menuItems.id })

    await replaceItemRelations(tx, ctx.restaurantId, created.id, input)

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.item.created',
      entityType: 'menu_item',
      entityId: created.id,
      after: { name: input.name, priceMinor: input.price },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateItem(
  ctx: BranchActorContext,
  itemId: string,
  input: UpdateItemInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COLUMNS)
      .from(menuItems)
      .where(
        and(
          eq(menuItems.id, itemId),
          eq(menuItems.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Menu item not found.')

    await assertReferencesBelongToTenant(tx, ctx.restaurantId, {
      categoryId: input.categoryId,
      tagIds: input.tagIds,
      branchIds: input.unavailableBranchIds,
    })

    if (input.availability) assertWindowsDoNotOverlap(input.availability)

    /**
     * Attributes are validated as a whole replacement, not merged. A partial
     * merge would make it impossible to clear a field, and would let a
     * previously-valid value survive a change to its definition.
     */
    let attributes: Record<string, unknown> | undefined
    if (input.attributes) {
      const definitions = await listAttributeDefinitionsIn(tx, ctx.restaurantId)
      attributes = validateAttributeValues(definitions, input.attributes)
    }

    if (input.sku && input.sku !== existing.sku) {
      const [clash] = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.restaurantId, ctx.restaurantId),
            eq(menuItems.sku, input.sku),
          ),
        )
        .limit(1)
      if (clash) {
        throw new ConflictError(`SKU "${input.sku}" is already in use.`)
      }
    }

    await tx
      .update(menuItems)
      .set({
        ...(input.categoryId !== undefined
          ? { categoryId: input.categoryId }
          : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description || null }
          : {}),
        ...(input.price !== undefined ? { priceMinor: input.price } : {}),
        ...(input.costPrice !== undefined
          ? { costPriceMinor: input.costPrice }
          : {}),
        ...(input.taxRatePercent !== undefined
          ? { taxRateBasisPoints: input.taxRatePercent }
          : {}),
        ...(input.serviceChargePercent !== undefined
          ? { serviceChargeBasisPoints: input.serviceChargePercent }
          : {}),
        ...(input.sku !== undefined ? { sku: input.sku || null } : {}),
        ...(input.barcode !== undefined
          ? { barcode: input.barcode || null }
          : {}),
        ...(input.calories !== undefined ? { calories: input.calories } : {}),
        ...(input.prepTimeMinutes !== undefined
          ? { prepTimeMinutes: input.prepTimeMinutes }
          : {}),
        ...(input.ingredientsText !== undefined
          ? { ingredientsText: input.ingredientsText || null }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.isFeatured !== undefined
          ? { isFeatured: input.isFeatured }
          : {}),
        ...(input.isRecommended !== undefined
          ? { isRecommended: input.isRecommended }
          : {}),
        ...(input.displayOrder !== undefined
          ? { displayOrder: input.displayOrder }
          : {}),
        ...(attributes !== undefined ? { attributes } : {}),
      })
      .where(
        and(
          eq(menuItems.id, itemId),
          eq(menuItems.restaurantId, ctx.restaurantId),
        ),
      )

    await replaceItemRelations(tx, ctx.restaurantId, itemId, input)

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.item.updated',
      entityType: 'menu_item',
      entityId: itemId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function deleteItem(
  ctx: BranchActorContext,
  itemId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COLUMNS)
      .from(menuItems)
      .where(
        and(
          eq(menuItems.id, itemId),
          eq(menuItems.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Menu item not found.')

    await tx
      .delete(menuItems)
      .where(
        and(
          eq(menuItems.id, itemId),
          eq(menuItems.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.item.deleted',
      entityType: 'menu_item',
      entityId: itemId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
