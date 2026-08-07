import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { isProduction } from '@/lib/env'

/**
 * Readiness.
 *
 * Deliberately not a route that returns `{ ok: true }` and nothing else. A
 * health check that only proves the process is listening will report healthy
 * while every request 500s on a dead database connection — which is precisely
 * the outage it exists to catch, and precisely when a load balancer will keep
 * routing traffic to it.
 *
 * So it does one round trip, and it checks the thing Phase 0 built the whole
 * isolation model on: that the runtime role is subject to row-level security.
 * A deployment that pointed `DATABASE_URL` at the owner role would work
 * perfectly while every tenant boundary was silently gone, and this is the
 * check that refuses to call that healthy.
 */
export async function GET() {
  const startedAt = Date.now()

  try {
    const [row] = await db.execute<{
      role: string
      bypassrls: boolean
    }>(sql`
      select current_user as role,
             (select rolbypassrls from pg_roles where rolname = current_user)
               as bypassrls
    `)

    const bypassesRls = row?.bypassrls === true

    /**
     * A role that bypasses RLS is a failed health check, not a warning. The
     * application would appear to work; that is what makes it dangerous.
     */
    if (bypassesRls) {
      return NextResponse.json(
        {
          status: 'unhealthy',
          database: 'reachable',
          role: row?.role ?? 'unknown',
          error:
            'The runtime database role bypasses row-level security. Every tenant boundary is inactive. See README setup step 2.',
        },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    }

    return NextResponse.json(
      {
        status: 'healthy',
        database: 'reachable',
        role: row?.role ?? 'unknown',
        rlsEnforced: true,
        latencyMs: Date.now() - startedAt,
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (cause) {
    return NextResponse.json(
      {
        status: 'unhealthy',
        database: 'unreachable',
        /**
         * The reason is withheld in production. A connection error names the
         * host, the port and often the user, and an unauthenticated endpoint
         * is not the place to publish them.
         */
        error: isProduction
          ? 'The database could not be reached.'
          : cause instanceof Error
            ? cause.message
            : 'Unknown error',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
}
