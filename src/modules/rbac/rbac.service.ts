import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Transaction } from '@/lib/db'
import { db } from '@/lib/db'
import { permissions, rolePermissions, roles } from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import {
  isKnownPermission,
  PERMISSIONS,
  resolveTemplatePermissions,
  SYSTEM_ROLE_TEMPLATES,
} from './permissions'

/**
 * Mirrors the code-defined registry into the `permissions` table.
 *
 * Idempotent, and additive only: it never deletes rows. A permission that
 * disappears from the code but still exists in the table is harmless -- no
 * code path checks it, so it grants nothing. Deleting it would cascade to
 * role_permissions and silently strip capabilities from tenants' custom roles
 * during a deploy, which is a far worse outcome than a stale row.
 */
export async function syncPermissionRegistry(): Promise<number> {
  const rows = PERMISSIONS.map((p) => ({
    code: p.code,
    module: p.module,
    action: p.action,
    description: p.description,
  }))

  await db
    .insert(permissions)
    .values(rows)
    .onConflictDoUpdate({
      target: permissions.code,
      set: {
        module: sql`excluded.module`,
        action: sql`excluded.action`,
        description: sql`excluded.description`,
      },
    })

  return rows.length
}

/**
 * Creates the default role set for a newly registered restaurant.
 *
 * Must run inside a transaction that already carries the tenant context, as
 * `roles` and `role_permissions` are both RLS-protected and the WITH CHECK
 * clause would otherwise reject every insert.
 */
export async function seedRolesForRestaurant(
  tx: Transaction,
  restaurantId: string,
): Promise<{ ownerRoleId: string }> {
  const inserted = await tx
    .insert(roles)
    .values(
      SYSTEM_ROLE_TEMPLATES.map((t) => ({
        restaurantId,
        key: t.key,
        name: t.name,
        description: t.description,
        isSystem: true,
      })),
    )
    .returning({ id: roles.id, key: roles.key })

  const roleIdByKey = new Map(inserted.map((r) => [r.key, r.id]))

  const grants = SYSTEM_ROLE_TEMPLATES.flatMap((template) => {
    const roleId = roleIdByKey.get(template.key)!
    return resolveTemplatePermissions(template).map((permissionCode) => ({
      roleId,
      permissionCode,
      restaurantId,
    }))
  })

  if (grants.length > 0) {
    await tx.insert(rolePermissions).values(grants)
  }

  const ownerRoleId = roleIdByKey.get('owner')
  if (!ownerRoleId) {
    throw new Error('Role templates must include an "owner" role.')
  }

  return { ownerRoleId }
}

/**
 * Replaces the permission set attached to a role.
 *
 * The owner role is refused outright. Permissions are a per-tenant setting,
 * but "the owner can administer their own restaurant" is an invariant of the
 * product, not a preference -- allowing it to be edited means a single
 * mistaken save can lock a paying customer out of their own account with no
 * in-app way back.
 */
export async function setRolePermissions(
  restaurantId: string,
  roleId: string,
  permissionCodes: readonly string[],
  tx: Transaction,
): Promise<void> {
  const [role] = await tx
    .select({ id: roles.id, key: roles.key })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.restaurantId, restaurantId)))
    .limit(1)

  if (!role) throw new NotFoundError('Role not found.')

  if (role.key === 'owner') {
    throw new ConflictError(
      'The Owner role always holds every permission and cannot be edited.',
    )
  }

  const unknown = permissionCodes.filter((c) => !isKnownPermission(c))
  if (unknown.length > 0) {
    throw new ValidationError('Unrecognised permissions.', {
      permissions: unknown.map((c) => `"${c}" is not a known permission`),
    })
  }

  await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId))

  if (permissionCodes.length > 0) {
    await tx.insert(rolePermissions).values(
      permissionCodes.map((permissionCode) => ({
        roleId,
        permissionCode,
        restaurantId,
      })),
    )
  }
}

/**
 * Re-pins every owner role to the full registry.
 *
 * Run after a deploy that adds permissions. Without it, restaurants created
 * before the new permission existed would have owners who cannot use the
 * feature that shipped with it.
 */
export async function repinOwnerRoles(tx: Transaction): Promise<void> {
  const ownerRoles = await tx
    .select({ id: roles.id, restaurantId: roles.restaurantId })
    .from(roles)
    .where(eq(roles.key, 'owner'))

  for (const role of ownerRoles) {
    const existing = await tx
      .select({ code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, role.id))

    const have = new Set(existing.map((e) => e.code))
    const missing = PERMISSIONS.filter((p) => !have.has(p.code))

    if (missing.length > 0) {
      await tx.insert(rolePermissions).values(
        missing.map((p) => ({
          roleId: role.id,
          permissionCode: p.code,
          restaurantId: role.restaurantId,
        })),
      )
    }
  }
}

export async function listRolesWithPermissions(
  restaurantId: string,
  tx: Transaction,
) {
  const roleRows = await tx
    .select()
    .from(roles)
    .where(eq(roles.restaurantId, restaurantId))

  if (roleRows.length === 0) return []

  const grants = await tx
    .select({
      roleId: rolePermissions.roleId,
      code: rolePermissions.permissionCode,
    })
    .from(rolePermissions)
    .where(
      inArray(
        rolePermissions.roleId,
        roleRows.map((r) => r.id),
      ),
    )

  const byRole = new Map<string, string[]>()
  for (const g of grants) {
    const list = byRole.get(g.roleId) ?? []
    list.push(g.code)
    byRole.set(g.roleId, list)
  }

  return roleRows.map((role) => ({
    ...role,
    permissions: byRole.get(role.id) ?? [],
  }))
}
