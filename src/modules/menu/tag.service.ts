import { and, asc, eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { menuTags } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import type { CreateTagInput, UpdateTagInput } from './menu.validation'

/**
 * Tags, allergens and dietary labels.
 *
 * One table, one service, discriminated by `kind`. See the note on
 * `menuTags` in the schema for why they are not three subsystems.
 */

export interface TagRow {
  id: string
  kind: 'label' | 'allergen' | 'dietary'
  name: string
  color: string | null
}

const COLUMNS = {
  id: menuTags.id,
  kind: menuTags.kind,
  name: menuTags.name,
  color: menuTags.color,
} as const

export async function listTags(
  restaurantId: string,
  userId: string,
): Promise<TagRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(COLUMNS)
      .from(menuTags)
      .where(eq(menuTags.restaurantId, restaurantId))
      .orderBy(asc(menuTags.kind), asc(menuTags.name)),
  )
}

export async function createTag(
  ctx: BranchActorContext,
  input: CreateTagInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: menuTags.id })
      .from(menuTags)
      .where(
        and(
          eq(menuTags.restaurantId, ctx.restaurantId),
          eq(menuTags.kind, input.kind),
          eq(menuTags.name, input.name),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `A ${input.kind} called "${input.name}" already exists.`,
      )
    }

    const [created] = await tx
      .insert(menuTags)
      .values({
        restaurantId: ctx.restaurantId,
        kind: input.kind,
        name: input.name,
        color: input.color ?? null,
      })
      .returning({ id: menuTags.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.tag.created',
      entityType: 'menu_tag',
      entityId: created.id,
      after: { kind: input.kind, name: input.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateTag(
  ctx: BranchActorContext,
  tagId: string,
  input: UpdateTagInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COLUMNS)
      .from(menuTags)
      .where(
        and(
          eq(menuTags.id, tagId),
          eq(menuTags.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Tag not found.')

    await tx
      .update(menuTags)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.color !== undefined ? { color: input.color || null } : {}),
      })
      .where(
        and(
          eq(menuTags.id, tagId),
          eq(menuTags.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.tag.updated',
      entityType: 'menu_tag',
      entityId: tagId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Deletes a tag. The join rows cascade, so the tag simply disappears from
 * every item that carried it — which is what removing a label means.
 */
export async function deleteTag(
  ctx: BranchActorContext,
  tagId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COLUMNS)
      .from(menuTags)
      .where(
        and(
          eq(menuTags.id, tagId),
          eq(menuTags.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Tag not found.')

    await tx
      .delete(menuTags)
      .where(
        and(
          eq(menuTags.id, tagId),
          eq(menuTags.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.tag.deleted',
      entityType: 'menu_tag',
      entityId: tagId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
