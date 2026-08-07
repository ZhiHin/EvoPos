import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm'

import { db, withApiKeyLookup, withTenant } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { assertFeature } from '@/modules/billing/billing.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { generateToken, hashToken } from '@/modules/auth/tokens'
import { isKnownPermission } from '@/modules/rbac/permissions'

/**
 * Keys for machine access.
 *
 * The same construction as sessions: 256 bits from a CSPRNG, only the HMAC
 * stored, so a dump of `api_keys` yields nothing presentable back to the
 * server. The plaintext is shown exactly once.
 *
 * A key carries its own permission set rather than impersonating a member.
 * Tying an integration to a person means it dies the day they leave and
 * silently inherits every permission they are later granted — neither of which
 * is what anybody intended when they set up a stock feed.
 */

/** Identifies which key a log line refers to, without being usable. */
const PREFIX_LENGTH = 8

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  permissions: string[]
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export async function listApiKeys(
  restaurantId: string,
  userId: string,
): Promise<ApiKeyRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        permissions: apiKeys.permissions,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.restaurantId, restaurantId))
      .orderBy(desc(apiKeys.createdAt)),
  )
}

export interface CreateApiKeyInput {
  name: string
  permissions: string[]
  expiresInDays?: number | null
}

export async function createApiKey(
  ctx: BranchActorContext,
  input: CreateApiKeyInput,
  now: Date = new Date(),
): Promise<{ id: string; token: string; prefix: string }> {
  await assertFeature(ctx, 'apiKeys')

  /**
   * Every code must exist in the registry, for the same reason a role's
   * permissions must: a key granted `menu.superuser` would carry a permission
   * nothing enforces, which is worse than no permission at all.
   */
  const unknown = input.permissions.filter((code) => !isKnownPermission(code))
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown permission${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`,
      { permissions: ['One or more permissions are not recognised.'] },
    )
  }

  const token = `ros_${generateToken()}`
  const prefix = token.slice(0, PREFIX_LENGTH)

  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60_000)
      : null

  const id = await withTenant(ctx, async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        prefix,
        tokenHash: hashToken(token),
        permissions: input.permissions,
        expiresAt,
        createdByUserId: ctx.userId,
      })
      .returning({ id: apiKeys.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: created.id,
      /**
       * The permissions are recorded, not the token. What matters six months
       * later is what this key was allowed to do and who decided that.
       */
      after: {
        name: input.name,
        prefix,
        permissions: input.permissions,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return created.id
  })

  // The only time the plaintext exists outside the caller's request.
  return { id, token, prefix }
}

export async function revokeApiKey(
  ctx: BranchActorContext,
  keyId: string,
  now: Date = new Date(),
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [key] = await tx
      .select({ id: apiKeys.id, name: apiKeys.name, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!key) throw new NotFoundError('That key was not found.')
    if (key.revokedAt) {
      throw new ConflictError('That key has already been revoked.')
    }

    /**
     * Revoked, never deleted. The row is what lets a later question — "what
     * was pulling our menu in March?" — be answered at all, and deleting it
     * would take the audit trail's referent with it.
     */
    await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(eq(apiKeys.id, keyId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: keyId,
      before: { name: key.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export interface ApiKeyIdentity {
  keyId: string
  restaurantId: string
  permissions: Set<string>
}

/**
 * How coarse the last-used timestamp is.
 *
 * A busy integration polling every second would otherwise turn every read into
 * a write. A minute is precise enough to answer "is this key still in use?",
 * which is the only question it exists for.
 */
const LAST_USED_RESOLUTION_MS = 60_000

/**
 * Resolves a bearer token to a key, or null.
 *
 * Runs under `withApiKeyLookup` rather than a tenant context, because there is
 * no tenant yet — the key is what establishes one. That bootstrap is the same
 * one a QR scan performs, and it is served by a policy matching on the hash:
 * presenting one token reveals one row, so the table cannot be enumerated.
 */
export async function resolveApiKey(
  token: string,
  now: Date = new Date(),
): Promise<ApiKeyIdentity | null> {
  if (!token.startsWith('ros_')) return null

  const tokenHash = hashToken(token)

  const key = await withApiKeyLookup(tokenHash, async (tx) => {
    const [row] = await tx
      .select({
        id: apiKeys.id,
        restaurantId: apiKeys.restaurantId,
        permissions: apiKeys.permissions,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tokenHash, tokenHash),
          isNull(apiKeys.revokedAt),
          /**
           * `gt` rather than a raw `sql` fragment. The operator goes through
           * Drizzle's column mapper; a raw fragment does not, and a `Date`
           * interpolated into one reaches the driver unmapped and throws —
           * the same seam as the Phase 12 `sql<Date>` bug, from the other
           * side.
           */
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
        ),
      )
      .limit(1)

    return row ?? null
  })

  if (!key) return null

  if (
    !key.lastUsedAt ||
    now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
  ) {
    /**
     * Written under the tenant the key just established, not under the lookup
     * context — the lookup policy is SELECT only, so a key cannot write even
     * to its own row while it is still merely a token.
     */
    await withTenant(
      { restaurantId: key.restaurantId, userId: key.id },
      (tx) =>
        tx
          .update(apiKeys)
          .set({ lastUsedAt: now })
          .where(eq(apiKeys.id, key.id)),
    )
  }

  return {
    keyId: key.id,
    restaurantId: key.restaurantId,
    permissions: new Set(key.permissions),
  }
}

/** Sweeps expired keys out of the way. Safe to run on a schedule. */
export async function purgeExpiredApiKeys(
  now: Date = new Date(),
): Promise<number> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(isNull(apiKeys.revokedAt), lt(apiKeys.expiresAt, now)))
    .returning({ id: apiKeys.id })

  return revoked.length
}
