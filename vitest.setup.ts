import 'dotenv/config'

/**
 * `src/lib/env.ts` validates and throws at import time, which is correct for a
 * server but means any test that transitively imports it needs a complete
 * environment. Filling in placeholders keeps pure unit tests runnable with no
 * .env and no database.
 *
 * Assigned through a loop with a computed key: `process.env.NODE_ENV` is typed
 * read-only, and only a direct property write trips that.
 *
 * Only absent values are defaulted, so a real .env still drives the
 * integration tests.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  AUTH_SECRET: 'test-only-secret-value-that-is-long-enough-to-pass-validation',
  DATABASE_URL: 'postgresql://ros_app:change_me_app@localhost:5432/ros',
  DATABASE_URL_MIGRATOR:
    'postgresql://ros_owner:change_me_owner@localhost:5432/ros',
}

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value
}
