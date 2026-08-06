import 'dotenv/config'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'

/**
 * Reports what the APPLICATION's own connection is talking to.
 *
 * Deliberately uses `@/lib/db` — the exact client every page, route handler
 * and service uses — rather than opening a connection of its own. A check
 * that made its own connection would prove only that the check works.
 */
async function main() {
  const [row] = await db.execute<{
    database: string
    role: string
    server: string
    tables: number
  }>(sql`
    select
      current_database()                              as database,
      current_user                                    as role,
      inet_server_addr()::text || ':' ||
        inet_server_port()::text                      as server,
      (select count(*)::int from pg_tables
        where schemaname = 'public')                  as tables
  `)

  console.log('  database :', row.database)
  console.log('  role     :', row.role)
  console.log('  server   :', row.server)
  console.log('  tables   :', row.tables)

  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
