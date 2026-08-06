import 'dotenv/config'

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '@/lib/db/schema'
import { repinOwnerRoles } from '@/modules/rbac/rbac.service'

/**
 * Grants every owner role any permission it is missing.
 *
 * Run after `npm run db:seed` on any deploy that adds permission codes.
 * Without it, restaurants created before a new permission existed keep an
 * owner who cannot use the feature that shipped with it — nominally the
 * owner, missing capability, with no in-app way to grant it back to
 * themselves.
 *
 * Idempotent: only absent rows are inserted, so running it twice is a no-op.
 *
 * IMPORTANT — it opens its own connection as `ros_owner` rather than reusing
 * `db` from `@/lib/db`. This is the one operation that must legitimately span
 * every tenant at once, and the application role is deliberately incapable of
 * that: through `ros_app` the query is filtered to nothing by row-level
 * security, `repinOwnerRoles` finds zero roles, and the script reports
 * success while having done nothing at all.
 */
async function main() {
  const url = process.env.DATABASE_URL_MIGRATOR
  if (!url) {
    throw new Error(
      'DATABASE_URL_MIGRATOR is not set. This maintenance script must run as the owner role.',
    )
  }

  const client = postgres(url, { max: 1 })
  const db = drizzle(client, { schema, casing: 'snake_case' })

  const countOwnerGrants = async () => {
    const rows = await db.execute<{ count: number }>(
      sql`select count(*)::int as count
          from role_permissions rp
          join roles r on r.id = rp.role_id
          where r.key = 'owner'`,
    )
    return rows[0]?.count ?? 0
  }

  const before = await countOwnerGrants()
  await db.transaction((tx) => repinOwnerRoles(tx as never))
  const after = await countOwnerGrants()

  const added = after - before
  console.log(
    added === 0
      ? 'Owner roles already hold every permission. Nothing to do.'
      : `Granted ${added} missing permission(s) across owner roles.`,
  )

  await client.end()
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error('Re-pin failed:')
  console.error(error)
  process.exit(1)
})
