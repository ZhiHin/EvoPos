import 'dotenv/config'

import { assertRuntimeRoleIsSafe } from '@/lib/db'

/**
 * Confirms the runtime connection cannot see through row-level security.
 * Run with `npm run db:verify`, and in CI before any deploy.
 */
async function main() {
  await assertRuntimeRoleIsSafe()
  console.log('OK: DATABASE_URL connects as a role that is subject to RLS.')
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
