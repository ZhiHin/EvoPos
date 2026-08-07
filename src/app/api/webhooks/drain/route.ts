import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { env } from '@/lib/env'
import { ForbiddenError } from '@/lib/errors'
import { drainWebhookQueue } from '@/modules/integration/webhook.service'

/**
 * Sends whatever webhook deliveries are due.
 *
 * A pull-based worker rather than a background thread, because Next.js has no
 * process to own one — and on a serverless deployment there is no long-lived
 * runtime at all. Something outside the application has to call this on a
 * schedule. That is a real deployment requirement, and it is written down in
 * `docs/phase-14/README.md` rather than assumed away.
 *
 * Not tenant-scoped: it drains across every restaurant, so it cannot be behind
 * a member's permission. It is behind a shared secret instead.
 */

/**
 * Compared against `WEBHOOK_DRAIN_SECRET`.
 *
 * `AUTH_SECRET` is deliberately not reused. This value has to be handed to a
 * scheduler — a cron service, a Kubernetes job, someone's Zapier — and a
 * secret that also signs every session token is not a secret to spread around.
 */
function assertSchedulerSecret(request: Request): void {
  const configured = env.WEBHOOK_DRAIN_SECRET

  if (!configured) {
    throw new ForbiddenError(
      'No WEBHOOK_DRAIN_SECRET is configured, so this endpoint is closed.',
    )
  }

  const header = request.headers.get('authorization') ?? ''
  const [scheme, value] = header.split(' ')

  if (scheme?.toLowerCase() !== 'bearer' || value !== configured) {
    throw new ForbiddenError('Invalid scheduler credentials.')
  }
}

export const POST = withRoute(async (request: Request) => {
  assertSchedulerSecret(request)

  const result = await drainWebhookQueue()

  return NextResponse.json(result, {
    headers: { 'cache-control': 'no-store' },
  })
})
