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
export const appRole = pgRole('evoapp').existing()

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
 * Diner context — the fourth and last way into this database.
 *
 * A diner scanning a QR is not a user and belongs to no tenant. They must
 * NEVER be given `app.tenant_id`: that variable is what every tenant policy
 * compares against, so setting it for an anonymous scanner would hand them
 * the whole restaurant. `withDiner` therefore clears tenant and actor context
 * and sets these instead, and every diner-facing policy is written against
 * them alone.
 *
 * Four variables, each doing one job:
 *
 *   app.member_token    proves who you are; reveals exactly your member row
 *   app.member_id       your identity, once proven
 *   app.session_id      scopes you to one table's bill
 *   app.diner_tenant_id read-only menu access, and nothing else
 *
 * The token variable exists for the same reason `app.qr_token` does: the
 * lookup that authenticates a member has to read the member row before any
 * member context exists, so a policy keyed on the token bootstraps it without
 * ever opening the table to enumeration.
 */
export const currentMemberToken = (): SQL =>
  sql`nullif(current_setting('app.member_token', true), '')`

export const currentMemberId = (): SQL =>
  sql`nullif(current_setting('app.member_id', true), '')::uuid`

export const currentSessionId = (): SQL =>
  sql`nullif(current_setting('app.session_id', true), '')::uuid`

export const currentDinerTenantId = (): SQL =>
  sql`nullif(current_setting('app.diner_tenant_id', true), '')::uuid`

/**
 * Read-only menu visibility for a diner.
 *
 * SELECT only, and scoped to the one restaurant whose table they are sitting
 * at. This is what lets the ordering screen show a menu without the diner
 * request ever acquiring tenant context.
 */
export function dinerMenuReadPolicy(
  name: string,
  tenantColumn: AnyPgColumn,
) {
  return pgPolicy(name, {
    as: 'permissive',
    for: 'select',
    to: appRole,
    using: sql`${tenantColumn} = ${currentDinerTenantId()}`,
  })
}

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
