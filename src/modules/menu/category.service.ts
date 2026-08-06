import { and, asc, eq, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import { menuCategories } from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
} from './menu.validation'

/**
 * Nested menu categories.
 *
 * Two invariants the database cannot express on its own, both enforced here:
 * a category may not become its own ancestor, and the tree may not exceed
 * MAX_DEPTH levels.
 */

/**
 * Root › group › subgroup. Three is enough for "Food › Mains › Curries" and
 * shallow enough that a POS can render the whole tree without pagination.
 * Deeper menus are almost always a modelling mistake that would be better
 * served by tags.
 */
export const MAX_CATEGORY_DEPTH = 3

export interface CategoryRow {
  id: string
  parentId: string | null
  name: string
  description: string | null
  displayOrder: number
  status: 'active' | 'hidden'
}

export interface CategoryNode extends CategoryRow {
  depth: number
  children: CategoryNode[]
}

const COLUMNS = {
  id: menuCategories.id,
  parentId: menuCategories.parentId,
  name: menuCategories.name,
  description: menuCategories.description,
  displayOrder: menuCategories.displayOrder,
  status: menuCategories.status,
} as const

export async function listCategories(
  restaurantId: string,
  userId: string,
): Promise<CategoryRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(COLUMNS)
      .from(menuCategories)
      .where(eq(menuCategories.restaurantId, restaurantId))
      .orderBy(asc(menuCategories.displayOrder), asc(menuCategories.name)),
  )
}

/**
 * Assembles a flat list into a tree.
 *
 * Done in memory rather than SQL because the whole category set is small
 * (tens of rows) and already fetched. A recursive query per render would cost
 * more than the sort.
 *
 * Rows whose parent is missing from the list are treated as roots, so a
 * partial or filtered fetch degrades into a flatter tree instead of silently
 * dropping items.
 */
export function buildCategoryTree(rows: CategoryRow[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>(
    rows.map((row) => [row.id, { ...row, depth: 0, children: [] }]),
  )

  const roots: CategoryNode[] = []

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const assignDepth = (node: CategoryNode, depth: number): void => {
    node.depth = depth
    for (const child of node.children) assignDepth(child, depth + 1)
  }
  for (const root of roots) assignDepth(root, 1)

  return roots
}

/**
 * Ancestor chain of a category, nearest first, via a recursive CTE.
 *
 * `cycle ... set` is not merely defensive: if corrupt data ever produced a
 * loop, an unguarded recursive query would spin until the connection died.
 * The guard makes it terminate so the caller can reject the row instead.
 */
async function ancestorIdsOf(
  tx: Transaction,
  categoryId: string,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive chain as (
      select id, parent_id, 1 as depth
      from menu_categories
      where id = ${categoryId}
      union all
      select c.id, c.parent_id, chain.depth + 1
      from menu_categories c
      join chain on c.id = chain.parent_id
      where chain.depth < ${MAX_CATEGORY_DEPTH + 2}
    )
    select id from chain where id <> ${categoryId}
  `)

  return rows.map((r) => r.id)
}

/** Height of the subtree rooted at a category. A leaf has height 1. */
async function subtreeHeightOf(
  tx: Transaction,
  categoryId: string,
): Promise<number> {
  const rows = await tx.execute<{ height: number }>(sql`
    with recursive descendants as (
      select id, 1 as depth
      from menu_categories
      where id = ${categoryId}
      union all
      select c.id, d.depth + 1
      from menu_categories c
      join descendants d on c.parent_id = d.id
      where d.depth < ${MAX_CATEGORY_DEPTH + 2}
    )
    select coalesce(max(depth), 1)::int as height from descendants
  `)

  return rows[0]?.height ?? 1
}

/** Depth of a category counting from the root, where a root is 1. */
async function depthOf(tx: Transaction, categoryId: string): Promise<number> {
  const ancestors = await ancestorIdsOf(tx, categoryId)
  return ancestors.length + 1
}

/**
 * Validates a proposed parent for a category.
 *
 * `movingId` is null when creating. When moving an existing category the
 * check has two halves: the new parent must not sit inside the moving
 * category's own subtree (that is the cycle), and the combined depth must
 * stay within the cap — moving a two-level branch under a level-two parent
 * would push its leaves to level four.
 */
async function assertParentIsUsable(
  tx: Transaction,
  restaurantId: string,
  parentId: string | null,
  movingId: string | null,
): Promise<void> {
  if (!parentId) return

  if (movingId && parentId === movingId) {
    throw new ValidationError('A category cannot be its own parent.', {
      parentId: ['A category cannot be its own parent.'],
    })
  }

  const [parent] = await tx
    .select({ id: menuCategories.id })
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.id, parentId),
        eq(menuCategories.restaurantId, restaurantId),
      ),
    )
    .limit(1)

  if (!parent) throw new NotFoundError('Parent category not found.')

  if (movingId) {
    const parentAncestors = await ancestorIdsOf(tx, parentId)
    if (parentAncestors.includes(movingId)) {
      throw new ValidationError(
        'That would move a category inside one of its own subcategories.',
        {
          parentId: [
            'That would move a category inside one of its own subcategories.',
          ],
        },
      )
    }
  }

  const parentDepth = await depthOf(tx, parentId)
  const movingHeight = movingId ? await subtreeHeightOf(tx, movingId) : 1

  if (parentDepth + movingHeight > MAX_CATEGORY_DEPTH) {
    throw new ValidationError(
      `Menu categories can be nested ${MAX_CATEGORY_DEPTH} levels deep at most.`,
      {
        parentId: [
          `Menu categories can be nested ${MAX_CATEGORY_DEPTH} levels deep at most.`,
        ],
      },
    )
  }
}

export async function createCategory(
  ctx: BranchActorContext,
  input: CreateCategoryInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const parentId = input.parentId ?? null
    await assertParentIsUsable(tx, ctx.restaurantId, parentId, null)

    const [clash] = await tx
      .select({ id: menuCategories.id })
      .from(menuCategories)
      .where(
        and(
          eq(menuCategories.restaurantId, ctx.restaurantId),
          parentId
            ? eq(menuCategories.parentId, parentId)
            : sql`${menuCategories.parentId} is null`,
          eq(menuCategories.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `A category called "${input.name}" already exists here.`,
      )
    }

    const [created] = await tx
      .insert(menuCategories)
      .values({
        restaurantId: ctx.restaurantId,
        parentId,
        name: input.name,
        description: input.description ?? null,
        displayOrder: input.displayOrder,
        status: input.status,
      })
      .returning({ id: menuCategories.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.category.created',
      entityType: 'menu_category',
      entityId: created.id,
      after: { name: input.name, parentId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateCategory(
  ctx: BranchActorContext,
  categoryId: string,
  input: UpdateCategoryInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COLUMNS)
      .from(menuCategories)
      .where(
        and(
          eq(menuCategories.id, categoryId),
          eq(menuCategories.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Category not found.')

    if (input.parentId !== undefined) {
      await assertParentIsUsable(
        tx,
        ctx.restaurantId,
        input.parentId,
        categoryId,
      )
    }

    await tx
      .update(menuCategories)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description || null }
          : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.displayOrder !== undefined
          ? { displayOrder: input.displayOrder }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      })
      .where(
        and(
          eq(menuCategories.id, categoryId),
          eq(menuCategories.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.category.updated',
      entityType: 'menu_category',
      entityId: categoryId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Deletes a category.
 *
 * Child categories and items are not deleted — both reference this row with
 * `ON DELETE SET NULL`, so children are promoted to roots and items become
 * uncategorised. Removing a grouping label should never destroy the things
 * that were grouped by it; a menu silently losing forty items because someone
 * tidied up a category is not a recoverable mistake.
 */
export async function deleteCategory(
  ctx: BranchActorContext,
  categoryId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COLUMNS)
      .from(menuCategories)
      .where(
        and(
          eq(menuCategories.id, categoryId),
          eq(menuCategories.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Category not found.')

    await tx
      .delete(menuCategories)
      .where(
        and(
          eq(menuCategories.id, categoryId),
          eq(menuCategories.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.category.deleted',
      entityType: 'menu_category',
      entityId: categoryId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
