import { randomBytes, randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'

import { db, type Transaction } from '@/lib/db'
import { memberships, restaurants } from '@/lib/db/schema'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { seedRolesForRestaurant } from '@/modules/rbac/rbac.service'

/**
 * Tenant provisioning.
 *
 * Shared by the two paths that create a restaurant: email registration
 * (which creates the user in the same transaction) and onboarding for a
 * Google user who signed in before belonging to anywhere.
 */

/**
 * The random suffix is not only collision avoidance. Without it a slug is
 * derivable from the business name, which hands out valid tenant identifiers
 * to anyone who can read a signboard.
 */
export function buildSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      // Drop the combining marks NFKD just split off, so "Café" -> "cafe".
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'restaurant'

  return `${base}-${randomBytes(4).toString('hex')}`
}

export interface ProvisionResult {
  restaurantId: string
  ownerRoleId: string
}

/**
 * Creates a restaurant, its default roles, and an owner membership.
 *
 * Must be called inside a transaction. It sets the tenant context itself,
 * because of an ordering constraint imposed by RLS: `restaurants` carries a
 * WITH CHECK requiring `id = app.tenant_id`, so the row cannot be inserted
 * until the session already claims to be inside the tenant that the row
 * defines. The resolution is to mint the id in the application first and set
 * the context to it, after which the insert satisfies its own policy.
 *
 * Callers should be aware that the transaction's tenant context is changed as
 * a side effect and remains set for the rest of the transaction.
 */
export async function provisionRestaurant(
  tx: Transaction,
  userId: string,
  restaurantName: string,
  metadata: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<ProvisionResult> {
  const restaurantId = randomUUID()

  await tx.execute(sql`
    select
      set_config('app.tenant_id', ${restaurantId}, true),
      set_config('app.user_id', ${userId}, true)
  `)

  await tx.insert(restaurants).values({
    id: restaurantId,
    name: restaurantName,
    slug: buildSlug(restaurantName),
  })

  const { ownerRoleId } = await seedRolesForRestaurant(tx, restaurantId)

  await tx.insert(memberships).values({
    restaurantId,
    userId,
    roleId: ownerRoleId,
    status: 'active',
    acceptedAt: new Date(),
  })

  await recordAuditIn(tx, {
    restaurantId,
    actorUserId: userId,
    action: 'restaurant.created',
    entityType: 'restaurant',
    entityId: restaurantId,
    after: { name: restaurantName },
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
  })

  return { restaurantId, ownerRoleId }
}

/** Standalone provisioning for an already-authenticated user (onboarding). */
export async function createRestaurantForUser(
  userId: string,
  restaurantName: string,
  metadata: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const { restaurantId } = await db.transaction((tx) =>
    provisionRestaurant(tx, userId, restaurantName, metadata),
  )
  return restaurantId
}
