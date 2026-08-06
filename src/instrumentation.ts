/**
 * Next.js boot hook.
 *
 * Runs the RLS safety assertion once at server start. Connecting with a role
 * that bypasses row-level security produces no error and no visible symptom
 * -- the application works perfectly while every tenant boundary is silently
 * gone. Failing at boot is the only point where that mistake is cheap.
 */
export async function register() {
  // Guard on the runtime: the assertion opens a Postgres connection, which
  // the edge runtime cannot do.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { assertRuntimeRoleIsSafe } = await import('@/lib/db')

  try {
    await assertRuntimeRoleIsSafe()
  } catch (error) {
    console.error('\n' + (error instanceof Error ? error.message : String(error)) + '\n')

    /**
     * Development gets a loud warning rather than a hard stop, so a
     * half-configured local database does not block someone from starting the
     * app and reading the setup docs. Production refuses to serve.
     */
    if (process.env.NODE_ENV === 'production') throw error
  }
}
