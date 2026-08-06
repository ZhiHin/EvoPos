import { sql, type SQL } from 'drizzle-orm'
import {
  pgPolicy,
  pgRole,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

/**
 * The runtime application role. Declared `.existing()` because roles are
 * provisioned once by scripts/bootstrap.sql (which needs superuser) rather
 * than by migrations (which must not).
 */
export const appRole = pgRole('ros_app').existing()

/**
 * Tenant and actor identity, read from the Postgres session.
 *
 * `current_setting(name, true)` returns NULL rather than erroring when the
 * setting was never assigned. The NULLIF guards the other failure mode: a
 * setting explicitly assigned the empty string, where a bare `''::uuid` would
 * raise instead of yielding NULL.
 *
 * Both failure modes therefore collapse to NULL, and `column = NULL` is NULL,
 * which filters the row out. Absent context means no rows -- fail closed.
 */
export const currentTenantId = (): SQL =>
  sql`nullif(current_setting('app.tenant_id', true), '')::uuid`

export const currentActorId = (): SQL =>
  sql`nullif(current_setting('app.user_id', true), '')::uuid`

/**
 * The QR token a public scan request is presenting.
 *
 * A third context alongside tenant and actor. Set only by `withQrToken`, read
 * only by the `*_qr_lookup` policies, and never set on an authenticated
 * request.
 *
 * Same NULLIF guard as the others: absent or empty collapses to NULL, and
 * `column = NULL` is NULL, so nothing matches. A scan with no token sees no
 * tables rather than all of them.
 *
 * Deliberately not cast to uuid — a QR token is opaque base64url text, and
 * casting would raise on malformed input instead of quietly matching nothing.
 */
export const currentQrToken = (): SQL =>
  sql`nullif(current_setting('app.qr_token', true), '')`

/**
 * Standard tenant isolation: a row is visible and writable only while the
 * session is operating inside the owning restaurant.
 *
 * `withCheck` matters as much as `using`. Without it a tenant could UPDATE a
 * row it can see and reassign it to a different `restaurant_id`, walking data
 * out of its own partition.
 */
export function tenantPolicy(name: string, tenantColumn: AnyPgColumn) {
  return pgPolicy(name, {
    as: 'permissive',
    for: 'all',
    to: appRole,
    using: sql`${tenantColumn} = ${currentTenantId()}`,
    withCheck: sql`${tenantColumn} = ${currentTenantId()}`,
  })
}

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}
