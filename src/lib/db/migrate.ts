import 'dotenv/config'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/**
 * Migration entry point. Run with `npm run db:migrate`.
 *
 * Connects as `evoadmin` (DATABASE_URL_MIGRATOR), never as the runtime role.
 */
async function main() {
  const url = process.env.DATABASE_URL_MIGRATOR
  if (!url) {
    throw new Error(
      'DATABASE_URL_MIGRATOR is not set. Migrations must run as the owner role, not as evoapp.',
    )
  }

  /**
   * `max: 1` because migrations must run serially on one connection — DDL and
   * advisory locking across a pool is a good way to deadlock a deploy.
   *
   * Notices are swallowed because drizzle's own bookkeeping uses
   * `CREATE ... IF NOT EXISTS`, which emits a NOTICE on every run after the
   * first. Left on, each migration prints error-shaped objects that are
   * entirely benign — and the fastest way to make someone ignore a real
   * migration failure is to bury it in routine noise.
   */
  const client = postgres(url, { max: 1, onnotice: () => {} })
  const db = drizzle(client)

  console.log('Running migrations...')
  await migrate(db, { migrationsFolder: './drizzle' })
  console.log('Migrations complete.')

  await client.end()
}

main().catch((error) => {
  console.error('Migration failed:')
  console.error(error)
  process.exit(1)
})
