import 'dotenv/config'

import { db } from '@/lib/db'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'

/**
 * Idempotent seed. Run with `npm run db:seed` after every migration.
 *
 * Currently syncs the permission registry from code into the `permissions`
 * table. This must run before the first registration: `role_permissions` has
 * a foreign key to `permissions.code`, so seeding roles for a new restaurant
 * fails outright against an empty registry.
 */
async function main() {
  console.log('Syncing permission registry...')
  const count = await syncPermissionRegistry()
  console.log(`  ${count} permissions in registry.`)

  console.log('Seed complete.')
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error('Seed failed:')
  console.error(error)
  process.exit(1)
})

export { db }
