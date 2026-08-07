import { randomBytes } from 'node:crypto'

import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'

import { db, withTenant, type Transaction } from '@/lib/db'
import { webhookDeliveries, webhookEndpoints } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { assertFeature } from '@/modules/billing/billing.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  FAILURES_BEFORE_DISABLE,
  isDeliverableUrl,
  nextOutcome,
  SIGNATURE_HEADER,
  sign,
  TIMESTAMP_HEADER,
  type WebhookEvent,
} from './webhook'

/**
 * Outbound webhooks.
 *
 * Events are queued, never sent inline. A customer's slow endpoint must not be
 * able to make settling a bill slow, and it must certainly not be able to make
 * settling a bill fail — an integration that can take the till down is worse
 * than no integration.
 *
 * The payload is frozen when the event is queued, so a retry ninety minutes
 * later describes what was true when it happened rather than what is true now.
 */

export interface WebhookEndpointRow {
  id: string
  url: string
  description: string | null
  events: WebhookEvent[]
  isActive: boolean
  disabledAt: Date | null
  disabledReason: string | null
  createdAt: Date
}

export async function listEndpoints(
  restaurantId: string,
  userId: string,
): Promise<WebhookEndpointRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        description: webhookEndpoints.description,
        events: webhookEndpoints.events,
        isActive: webhookEndpoints.isActive,
        disabledAt: webhookEndpoints.disabledAt,
        disabledReason: webhookEndpoints.disabledReason,
        createdAt: webhookEndpoints.createdAt,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.restaurantId, restaurantId))
      .orderBy(desc(webhookEndpoints.createdAt)),
  )
}

export async function createEndpoint(
  ctx: BranchActorContext,
  input: { url: string; description?: string | null; events: WebhookEvent[] },
): Promise<{ id: string; secret: string }> {
  await assertFeature(ctx, 'webhooks')

  if (!isDeliverableUrl(input.url)) {
    throw new ValidationError(
      'Use an https URL on a public host. Loopback and private addresses are refused, because this server would be the one making the request.',
      { url: ['Must be a public https URL.'] },
    )
  }

  if (input.events.length === 0) {
    throw new ValidationError(
      'Choose at least one event. An endpoint subscribed to nothing is never called.',
      { events: ['Choose at least one event.'] },
    )
  }

  /**
   * A shared secret, not a hash. Both ends must compute the same HMAC over the
   * same body, so this one genuinely cannot be stored one-way — it is shown
   * once and treated as a credential everywhere else.
   */
  const secret = `whsec_${randomBytes(24).toString('base64url')}`

  const id = await withTenant(ctx, async (tx) => {
    const [created] = await tx
      .insert(webhookEndpoints)
      .values({
        restaurantId: ctx.restaurantId,
        url: input.url,
        description: input.description ?? null,
        secret,
        events: input.events,
      })
      .returning({ id: webhookEndpoints.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'webhook.endpoint_created',
      entityType: 'webhook_endpoint',
      entityId: created.id,
      after: { url: input.url, events: input.events },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return created.id
  })

  return { id, secret }
}

export async function deleteEndpoint(
  ctx: BranchActorContext,
  endpointId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const deleted = await tx
      .delete(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, endpointId),
          eq(webhookEndpoints.restaurantId, ctx.restaurantId),
        ),
      )
      .returning({ url: webhookEndpoints.url })

    if (deleted.length === 0) {
      throw new NotFoundError('That endpoint was not found.')
    }

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'webhook.endpoint_deleted',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      before: { url: deleted[0].url },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/** Brings a disabled endpoint back, after its owner has fixed it. */
export async function reactivateEndpoint(
  ctx: BranchActorContext,
  endpointId: string,
): Promise<void> {
  await withTenant(ctx, (tx) =>
    tx
      .update(webhookEndpoints)
      .set({ isActive: true, disabledAt: null, disabledReason: null })
      .where(
        and(
          eq(webhookEndpoints.id, endpointId),
          eq(webhookEndpoints.restaurantId, ctx.restaurantId),
        ),
      ),
  )
}

/**
 * Queues an event for every endpoint that wants it.
 *
 * Takes a transaction so it can be called inside the operation that caused the
 * event — the delivery row and the bill it describes commit together, and
 * there is no window in which one exists without the other.
 *
 * Never throws for want of a subscriber. Most restaurants have no endpoints at
 * all, and an ordering path that failed because nobody was listening would be
 * absurd.
 */
export async function enqueueEventIn(
  tx: Transaction,
  restaurantId: string,
  eventType: WebhookEvent,
  payload: Record<string, unknown>,
  now: Date = new Date(),
): Promise<number> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.restaurantId, restaurantId),
        eq(webhookEndpoints.isActive, true),
        sql`${eventType} = any(${webhookEndpoints.events})`,
      ),
    )

  if (endpoints.length === 0) return 0

  await tx.insert(webhookDeliveries).values(
    endpoints.map((endpoint) => ({
      restaurantId,
      endpointId: endpoint.id,
      eventType,
      payload,
      // Due immediately; the drain worker decides when it actually runs.
      nextAttemptAt: now,
    })),
  )

  return endpoints.length
}

export interface DrainResult {
  attempted: number
  delivered: number
  retrying: number
  abandoned: number
}

/**
 * Sends what is due.
 *
 * A pull-based worker rather than a background thread, because Next.js has no
 * process to own one — a serverless deployment has no long-lived runtime at
 * all. This is invoked by a scheduler hitting `/api/webhooks/drain`, which is
 * a real deployment requirement and named as one in the docs rather than
 * assumed away.
 *
 * Runs on `db` rather than a tenant context: it drains across every
 * restaurant, and there is no single tenant it belongs to. That is the same
 * position the session lookup occupies, and the reason these rows are read
 * here by their own primary key and nothing else.
 */
export async function drainWebhookQueue(
  batchSize = 25,
  now: Date = new Date(),
): Promise<DrainResult> {
  /**
   * Claimed with `for update skip locked`, so two workers running at once
   * cannot both take the same delivery. Without it, a scheduler that
   * overlapped with a slow batch would send everything twice.
   */
  const due = await db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      eventType: webhookDeliveries.eventType,
      eventId: webhookDeliveries.eventId,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
      url: webhookEndpoints.url,
      secret: webhookEndpoints.secret,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookEndpoints.id, webhookDeliveries.endpointId),
    )
    .where(
      and(
        eq(webhookDeliveries.status, 'pending'),
        or(
          isNull(webhookDeliveries.nextAttemptAt),
          lte(webhookDeliveries.nextAttemptAt, now),
        ),
        eq(webhookEndpoints.isActive, true),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(batchSize)
    .for('update', { skipLocked: true })

  const result: DrainResult = {
    attempted: due.length,
    delivered: 0,
    retrying: 0,
    abandoned: 0,
  }

  for (const delivery of due) {
    const attempt = delivery.attempts + 1
    const body = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      createdAt: now.toISOString(),
      data: delivery.payload,
    })
    const timestamp = Math.floor(now.getTime() / 1_000)

    let statusCode: number | null = null
    let error: string | null = null

    try {
      const response = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [EVENT_HEADER]: delivery.eventType,
          [DELIVERY_HEADER]: delivery.eventId,
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: sign(delivery.secret, body, timestamp),
        },
        body,
        /**
         * Ten seconds. A receiver slower than that is not going to become
         * faster on the retry, and a worker blocked on one endpoint is a
         * worker not draining anybody else's.
         */
        signal: AbortSignal.timeout(10_000),
      })

      statusCode = response.status
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Request failed'
    }

    const outcome = nextOutcome(attempt, statusCode, now)

    await db
      .update(webhookDeliveries)
      .set({
        status: outcome.status,
        attempts: attempt,
        nextAttemptAt: outcome.nextAttemptAt,
        lastAttemptAt: now,
        lastStatusCode: statusCode,
        lastError: error,
      })
      .where(eq(webhookDeliveries.id, delivery.id))

    if (outcome.status === 'delivered') result.delivered += 1
    else if (outcome.status === 'pending') result.retrying += 1
    else {
      result.abandoned += 1
      await disableIfPersistentlyFailing(delivery.endpointId, now)
    }
  }

  return result
}

/**
 * Switches off an endpoint that has stopped answering.
 *
 * Counted over the last few deliveries rather than all time, so an endpoint
 * that failed three times last year and has worked since is not disabled by
 * ancient history.
 */
async function disableIfPersistentlyFailing(
  endpointId: string,
  now: Date,
): Promise<void> {
  const recent = await db
    .select({ status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(desc(webhookDeliveries.lastAttemptAt))
    .limit(FAILURES_BEFORE_DISABLE)

  if (recent.length < FAILURES_BEFORE_DISABLE) return
  if (!recent.every((row) => row.status === 'abandoned')) return

  await db
    .update(webhookEndpoints)
    .set({
      isActive: false,
      disabledAt: now,
      /**
       * A reason, because an integration that quietly stopped working with
       * nothing to explain it is the worst version of this failure.
       */
      disabledReason: `Disabled automatically after ${String(FAILURES_BEFORE_DISABLE)} deliveries in a row were abandoned.`,
    })
    .where(eq(webhookEndpoints.id, endpointId))
}

export interface DeliveryRow {
  id: string
  eventType: WebhookEvent
  status: 'pending' | 'delivered' | 'failed' | 'abandoned'
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
  lastAttemptAt: Date | null
  createdAt: Date
}

/** Recent attempts, so a customer can see why their endpoint is not firing. */
export async function listDeliveries(
  restaurantId: string,
  userId: string,
  endpointId: string,
  limit = 20,
): Promise<DeliveryRow[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        id: webhookDeliveries.id,
        eventType: webhookDeliveries.eventType,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastStatusCode: webhookDeliveries.lastStatusCode,
        lastError: webhookDeliveries.lastError,
        lastAttemptAt: webhookDeliveries.lastAttemptAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.restaurantId, restaurantId),
          eq(webhookDeliveries.endpointId, endpointId),
        ),
      )
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit),
  )
}
