import type { Transaction } from '@/lib/db'
import { withTenant } from '@/lib/db'
import { auditLog } from '@/lib/db/schema'

/**
 * Audit trail writer.
 *
 * The table grants evoapp INSERT and SELECT but no UPDATE or DELETE, so
 * entries written here cannot later be edited or erased through the
 * application, only appended to.
 */

/** Never let these reach the audit table, at any nesting depth. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'newpassword',
  'currentpassword',
  'token',
  'tokenhash',
  'token_hash',
  'secret',
  'clientsecret',
  'client_secret',
  'authorization',
  'cookie',
])

/**
 * Strips secrets from an audited snapshot.
 *
 * Audit payloads are assembled from whole entity objects, which is exactly
 * how a password hash or a session token ends up permanently recorded in a
 * table that is designed to be undeletable. Redacting on the way in is the
 * only reliable point to catch it.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase())
      ? '[redacted]'
      : redact(v, depth + 1)
  }
  return out
}

export interface AuditEntry {
  restaurantId: string
  actorUserId?: string | null
  /** Dotted past-tense verb, e.g. "membership.role_changed". */
  action: string
  entityType: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Writes an entry using an existing transaction.
 *
 * Prefer this inside a service that is already mutating data: the audit row
 * commits or rolls back together with the change it describes, so the trail
 * can never claim something happened that was actually rolled back.
 */
export async function recordAuditIn(
  tx: Transaction,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLog).values({
    restaurantId: entry.restaurantId,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  })
}

/** Standalone write, for events with no surrounding transaction. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  await withTenant(
    { restaurantId: entry.restaurantId, userId: entry.actorUserId },
    (tx) => recordAuditIn(tx, entry),
  )
}
