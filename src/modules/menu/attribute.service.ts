import { and, asc, eq } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import { menuAttributeDefinitions } from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import type { CreateAttributeInput } from './menu.validation'

/**
 * The custom attribute engine.
 *
 * Owners define fields; items carry values for them in a JSONB column. This
 * module owns both halves — the definitions, and the validation of values
 * against them.
 */

export interface AttributeDefinition {
  id: string
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect'
  options: string[] | null
  required: boolean
  displayOrder: number
}

const COLUMNS = {
  id: menuAttributeDefinitions.id,
  key: menuAttributeDefinitions.key,
  label: menuAttributeDefinitions.label,
  type: menuAttributeDefinitions.type,
  options: menuAttributeDefinitions.options,
  required: menuAttributeDefinitions.required,
  displayOrder: menuAttributeDefinitions.displayOrder,
} as const

export async function listAttributeDefinitionsIn(
  tx: Transaction,
  restaurantId: string,
): Promise<AttributeDefinition[]> {
  return tx
    .select(COLUMNS)
    .from(menuAttributeDefinitions)
    .where(eq(menuAttributeDefinitions.restaurantId, restaurantId))
    .orderBy(
      asc(menuAttributeDefinitions.displayOrder),
      asc(menuAttributeDefinitions.label),
    )
}

export async function listAttributeDefinitions(
  restaurantId: string,
  userId: string,
): Promise<AttributeDefinition[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    listAttributeDefinitionsIn(tx, restaurantId),
  )
}

/**
 * Validates and normalises a set of attribute values against the tenant's
 * definitions.
 *
 * Pure, so it can be unit-tested without a database — which matters, because
 * this is the function standing between owner-defined schema and a JSONB
 * column that would otherwise accept literally anything.
 *
 * Returns the cleaned object to store. Unknown keys are **rejected**, not
 * dropped silently: a typo'd key that vanishes on save looks to the user like
 * the field simply didn't work, with nothing to explain why.
 */
export function validateAttributeValues(
  definitions: readonly AttributeDefinition[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const byKey = new Map(definitions.map((d) => [d.key, d]))
  const errors: Record<string, string[]> = {}
  const cleaned: Record<string, unknown> = {}

  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) {
      ;(errors[`attributes.${key}`] ??= []).push(
        `"${key}" is not a defined custom field.`,
      )
    }
  }

  for (const definition of definitions) {
    const raw = values[definition.key]
    const path = `attributes.${definition.key}`
    const absent = raw === undefined || raw === null || raw === ''

    if (absent) {
      if (definition.required) {
        ;(errors[path] ??= []).push(`${definition.label} is required.`)
      }
      // Absent optional values are omitted rather than stored as null, so the
      // JSONB holds only what was actually set.
      continue
    }

    switch (definition.type) {
      case 'text': {
        if (typeof raw !== 'string') {
          ;(errors[path] ??= []).push(`${definition.label} must be text.`)
          break
        }
        const trimmed = raw.trim()
        if (trimmed.length > 500) {
          ;(errors[path] ??= []).push(
            `${definition.label} must be 500 characters or fewer.`,
          )
          break
        }
        cleaned[definition.key] = trimmed
        break
      }

      case 'number': {
        // Accepts a numeric string so a form field can post "3" unconverted.
        const parsed = typeof raw === 'string' ? Number(raw.trim()) : raw
        if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
          ;(errors[path] ??= []).push(`${definition.label} must be a number.`)
          break
        }
        cleaned[definition.key] = parsed
        break
      }

      case 'boolean': {
        if (typeof raw === 'boolean') {
          cleaned[definition.key] = raw
        } else if (raw === 'true' || raw === 'false') {
          cleaned[definition.key] = raw === 'true'
        } else {
          ;(errors[path] ??= []).push(
            `${definition.label} must be true or false.`,
          )
        }
        break
      }

      case 'select': {
        if (typeof raw !== 'string' || !definition.options?.includes(raw)) {
          ;(errors[path] ??= []).push(
            `${definition.label} must be one of: ${definition.options?.join(', ') ?? ''}.`,
          )
          break
        }
        cleaned[definition.key] = raw
        break
      }

      case 'multiselect': {
        if (!Array.isArray(raw)) {
          ;(errors[path] ??= []).push(`${definition.label} must be a list.`)
          break
        }
        const invalid = raw.filter(
          (v) => typeof v !== 'string' || !definition.options?.includes(v),
        )
        if (invalid.length > 0) {
          ;(errors[path] ??= []).push(
            `${definition.label} contains values that are not options.`,
          )
          break
        }
        // Deduplicated: the same value twice carries no extra meaning and
        // would otherwise make equality comparisons on the stored JSONB
        // depend on insertion order.
        cleaned[definition.key] = [...new Set(raw as string[])]
        break
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Some custom fields are not valid.', errors)
  }

  return cleaned
}

export async function createAttributeDefinition(
  ctx: BranchActorContext,
  input: CreateAttributeInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [clash] = await tx
      .select({ id: menuAttributeDefinitions.id })
      .from(menuAttributeDefinitions)
      .where(
        and(
          eq(menuAttributeDefinitions.restaurantId, ctx.restaurantId),
          eq(menuAttributeDefinitions.key, input.key),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `A custom field with the key "${input.key}" already exists.`,
      )
    }

    const [created] = await tx
      .insert(menuAttributeDefinitions)
      .values({
        restaurantId: ctx.restaurantId,
        key: input.key,
        label: input.label,
        type: input.type,
        options: input.options ?? null,
        required: input.required,
        displayOrder: input.displayOrder,
      })
      .returning({ id: menuAttributeDefinitions.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.attribute.created',
      entityType: 'menu_attribute_definition',
      entityId: created.id,
      after: { key: input.key, type: input.type },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

/**
 * Deletes a definition.
 *
 * Values already stored under this key inside `menu_items.attributes` are
 * left in place rather than swept out of every item. Removing them would be a
 * large unbounded write triggered by a single click, and irreversible — where
 * an orphaned key is inert, since nothing reads a key that has no definition.
 * Re-creating the field with the same key restores the old values.
 */
export async function deleteAttributeDefinition(
  ctx: BranchActorContext,
  attributeId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select(COLUMNS)
      .from(menuAttributeDefinitions)
      .where(
        and(
          eq(menuAttributeDefinitions.id, attributeId),
          eq(menuAttributeDefinitions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!existing) throw new NotFoundError('Custom field not found.')

    await tx
      .delete(menuAttributeDefinitions)
      .where(
        and(
          eq(menuAttributeDefinitions.id, attributeId),
          eq(menuAttributeDefinitions.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'menu.attribute.deleted',
      entityType: 'menu_attribute_definition',
      entityId: attributeId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
