import { sql, type ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import {
  drizzle,
  type PostgresJsQueryResultHKT,
} from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { env, isProduction } from '@/lib/env'
import * as schema from './schema'

/**
 * Runtime database access.
 *
 * Connects as `ros_app`, which is not the table owner and has no BYPASSRLS.
 * Every statement issued through this client is subject to row-level
 * security. Migrations use a different role and a different entry point
 * (src/lib/db/migrate.ts).
 */

// Next.js recreates modules on hot reload; without this the dev server leaks
// a new connection pool on every edit until Postgres refuses connections.
const globalForDb = globalThis as unknown as {
  rosClient?: postgres.Sql
}

const client =
  globalForDb.rosClient ??
  postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })

if (!isProduction) globalForDb.rosClient = client

export const db = drizzle(client, { schema, casing: 'snake_case' })

export type Database = typeof db

export type Transaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

/** Either a pooled connection or an open transaction. */
export type Executor = Database | Transaction

export interface TenantContext {
  /** Becomes `app.tenant_id`. Every tenant policy compares against this. */
  restaurantId: string
  /** Becomes `app.user_id`. Drives self-scoped policies and audit attribution. */
  userId?: string | null
}

/**
 * Why `set_config(..., true)` and not `SET LOCAL app.tenant_id = $1`:
 *
 * SET LOCAL is utility syntax and cannot take a bind parameter, so using it
 * would mean interpolating the tenant id into SQL text -- an injection point
 * on the single value the entire isolation model depends on. `set_config` is
 * an ordinary function call, so the id travels as a parameter and is never
 * parsed as SQL. The `true` argument gives it SET LOCAL semantics: the value
 * is scoped to this transaction and is discarded when it ends, so a pooled
 * connection handed to the next request never carries stale tenant context.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.tenant_id', ${ctx.restaurantId}, true),
        set_config('app.user_id', ${ctx.userId ?? ''}, true)
    `)
    return fn(tx)
  })
}

/**
 * Actor context with no active tenant.
 *
 * Needed for the window between authentication and tenant selection, where
 * the user is known but has not chosen a restaurant yet. Only the explicit
 * self-read policies (`memberships_self_read`, `restaurants_member_read`)
 * match here; every tenant policy evaluates against a NULL tenant id and
 * filters everything out.
 */
export async function withActor<T>(
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.tenant_id', '', true),
        set_config('app.user_id', ${userId}, true)
    `)
    return fn(tx)
  })
}

/**
 * Public QR scan context.
 *
 * Sets neither tenant nor actor — a person scanning a table is not signed in
 * and belongs to no tenant. Only the three `*_qr_lookup` policies match here,
 * and each is scoped to the single table bearing this token.
 *
 * Both other contexts are explicitly cleared rather than left alone. On a
 * pooled connection they would otherwise be whatever the previous transaction
 * set, which would silently widen what an unauthenticated scan can see.
 *
 * The token travels as a bind parameter through `set_config`, never
 * interpolated into SQL, exactly as tenant ids do.
 */
export async function withQrToken<T>(
  token: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.tenant_id', '', true),
        set_config('app.user_id', '', true),
        set_config('app.qr_token', ${token}, true)
    `)
    return fn(tx)
  })
}

export interface DinerContext {
  memberId: string
  sessionId: string
  restaurantId: string
  displayName: string
}

/**
 * Diner context — an anonymous person at a table.
 *
 * Note what is deliberately NOT set: `app.tenant_id`. Every tenant policy in
 * the system compares against that variable, so setting it for someone who
 * scanned a QR code would hand an anonymous stranger the entire restaurant.
 * A diner's reach comes solely from the member and diner-read policies, which
 * scope them to one session's bill and one restaurant's menu.
 *
 * Bootstrapping happens in two steps inside one transaction, because the
 * member row must be read before member context can exist:
 *
 *   1. Set `app.member_token`. The `..._token_lookup` policy now reveals
 *      exactly the one member row bearing that token, and nothing else.
 *   2. Read it, then set the identity variables the remaining policies use.
 *
 * Every other context variable is explicitly blanked first. On a pooled
 * connection they would otherwise hold whatever the previous transaction set,
 * which is precisely how an anonymous request would inherit staff access.
 *
 * Returns null when the token is unknown, expired, or belongs to someone who
 * has left — the caller treats all three identically.
 */
export async function withDiner<T>(
  memberTokenHash: string,
  fn: (tx: Transaction, diner: DinerContext) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.tenant_id', '', true),
        set_config('app.user_id', '', true),
        set_config('app.qr_token', '', true),
        set_config('app.member_id', '', true),
        set_config('app.session_id', '', true),
        set_config('app.diner_tenant_id', '', true),
        set_config('app.member_token', ${memberTokenHash}, true)
    `)

    const [member] = await tx.execute<{
      id: string
      session_id: string
      restaurant_id: string
      display_name: string
    }>(sql`
      select id, session_id, restaurant_id, display_name
      from dining_session_members
      where token_hash = ${memberTokenHash}
        and expires_at > now()
        and left_at is null
      limit 1
    `)

    if (!member) return null

    await tx.execute(sql`
      select
        set_config('app.member_id', ${member.id}, true),
        set_config('app.session_id', ${member.session_id}, true),
        set_config('app.diner_tenant_id', ${member.restaurant_id}, true)
    `)

    return fn(tx, {
      memberId: member.id,
      sessionId: member.session_id,
      restaurantId: member.restaurant_id,
      displayName: member.display_name,
    })
  })
}

/**
 * Fails loudly if the application is connected with a role that can see
 * through RLS.
 *
 * Pointing DATABASE_URL at the owner or a superuser does not raise an error
 * or change any observable behaviour -- policies simply stop filtering, and
 * every tenant silently gains access to every other tenant's data. That is
 * the worst possible failure mode for a multi-tenant system: invisible,
 * total, and indistinguishable from working correctly. Checked at boot in
 * instrumentation.ts and by `npm run db:verify`.
 */
export async function assertRuntimeRoleIsSafe(): Promise<void> {
  const [row] = await db.execute<{
    role_name: string
    is_superuser: boolean
    bypasses_rls: boolean
    owned_tables: number
  }>(sql`
    select
      current_user                                    as role_name,
      r.rolsuper                                      as is_superuser,
      r.rolbypassrls                                  as bypasses_rls,
      (
        select count(*)::int
        from pg_tables
        where schemaname = 'public'
          and tableowner = current_user
      )                                               as owned_tables
    from pg_roles r
    where r.rolname = current_user
  `)

  if (!row) throw new Error('Could not resolve the current database role.')

  const faults: string[] = []
  if (row.is_superuser) faults.push('it is a superuser')
  if (row.bypasses_rls) faults.push('it has the BYPASSRLS attribute')
  if (row.owned_tables > 0)
    faults.push(
      `it owns ${row.owned_tables} table(s) in public (owners are exempt from their own policies)`,
    )

  if (faults.length > 0) {
    throw new Error(
      `Refusing to start: DATABASE_URL connects as "${row.role_name}", which bypasses row-level security because ${faults.join(', ')}.\n` +
        'Tenant isolation would be silently disabled. Point DATABASE_URL at the ros_app role and keep the owner role for DATABASE_URL_MIGRATOR only.',
    )
  }
}
