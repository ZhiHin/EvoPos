import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

/**
 * Migrations connect as `ros_owner` (the table owner), never as the runtime
 * `ros_app` role. See .env.example for why the two are separate.
 *
 * `entities.roles: false` tells drizzle-kit not to try to create or drop
 * Postgres roles. Roles are provisioned once by scripts/bootstrap.sql, which
 * requires superuser; keeping them out of the migration stream means a
 * migration never needs elevated privileges.
 */
export default defineConfig({
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATOR!,
  },
  casing: 'snake_case',
  entities: {
    roles: false,
  },
  verbose: true,
  strict: true,
})
