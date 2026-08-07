import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Webhook signing and retry policy.
 *
 * Pure, and for a reason particular to this module: the signature is the only
 * thing standing between a customer's endpoint and anyone on the internet who
 * knows its URL. A receiver has to be able to verify it from a description,
 * and a description that cannot be tested against a reference implementation
 * is a description nobody will implement correctly.
 *
 * `verifySignature` is exported for exactly that: it is the same function a
 * receiver would write, and the tests are the specification.
 */

export type WebhookEvent =
  | 'order.placed'
  | 'bill.settled'
  | 'payment.refunded'
  | 'reservation.created'
  | 'stock.low'

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  'order.placed',
  'bill.settled',
  'payment.refunded',
  'reservation.created',
  'stock.low',
]

export const WEBHOOK_EVENT_LABEL: Record<WebhookEvent, string> = {
  'order.placed': 'An order is placed',
  'bill.settled': 'A bill is settled',
  'payment.refunded': 'A payment is refunded',
  'reservation.created': 'A booking is taken',
  'stock.low': 'An ingredient reaches its reorder point',
}

/** Headers a receiver reads. Prefixed so they cannot collide with anything. */
export const SIGNATURE_HEADER = 'x-ros-signature'
export const TIMESTAMP_HEADER = 'x-ros-timestamp'
export const EVENT_HEADER = 'x-ros-event'
export const DELIVERY_HEADER = 'x-ros-delivery'

/**
 * The signed string.
 *
 * The timestamp is inside the signature, not merely alongside it. Signing the
 * body alone would let anyone who captured one delivery replay it forever;
 * binding the time means a receiver can reject anything older than its
 * tolerance and know the timestamp was not edited on the way.
 *
 * A literal dot separator rather than concatenation, so a body beginning with
 * digits cannot be reinterpreted as part of the timestamp.
 */
function signedPayload(timestamp: number, body: string): string {
  return `${String(timestamp)}.${body}`
}

export function sign(
  secret: string,
  body: string,
  timestamp: number,
): string {
  return createHmac('sha256', secret)
    .update(signedPayload(timestamp, body))
    .digest('hex')
}

/** How stale a delivery may be before a receiver should reject it. */
export const REPLAY_TOLERANCE_SECONDS = 300

/**
 * Verifies a signature the way a receiver should.
 *
 * Two things here are load-bearing and routinely got wrong:
 *
 * The comparison is constant-time. `a === b` on a hex digest leaks, through
 * timing, how many leading characters were right — enough to forge a signature
 * one character at a time given sufficient attempts.
 *
 * The timestamp is checked. A signature with no freshness window is valid
 * forever, so a delivery captured once can be replayed indefinitely — and for
 * an endpoint that, say, marks an order paid, that matters.
 */
export function verifySignature(
  secret: string,
  body: string,
  timestamp: number,
  signature: string,
  now: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = REPLAY_TOLERANCE_SECONDS,
): boolean {
  if (!Number.isFinite(timestamp)) return false
  if (Math.abs(now - timestamp) > toleranceSeconds) return false

  const expected = sign(secret, body, timestamp)

  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // the throw would itself be an observable difference.
  if (expected.length !== signature.length) return false

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

/**
 * How many times a delivery is attempted before it is abandoned.
 *
 * Six attempts spread over roughly an hour and a half. Long enough to ride out
 * a deploy or a brief outage at the far end; short enough that a permanently
 * dead endpoint is not retried for days.
 */
export const MAX_ATTEMPTS = 6

/**
 * Backoff, in seconds, before attempt N.
 *
 * Exponential from ten seconds, capped so the last gaps do not stretch to
 * hours. No jitter is applied here and that is deliberate — the schedule has
 * to be reproducible for the tests to mean anything, and the drain worker
 * spreads load by claiming a bounded batch rather than by scattering times.
 */
export function backoffSeconds(attempt: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempt - 1), 1_800)
}

export interface DeliveryOutcome {
  status: 'delivered' | 'pending' | 'abandoned'
  nextAttemptAt: Date | null
}

/**
 * Decides what happens after an attempt.
 *
 * A 2xx is success. Everything else is retried until the attempt budget runs
 * out — including 4xx, which is worth stating: a receiver returning 400
 * because it was mid-deploy is indistinguishable from one rejecting the
 * payload permanently, and giving up on the first 400 loses real events to
 * transient misconfiguration.
 *
 * The one exception is 410 Gone, which HTTP defines as permanent and which a
 * receiver can use to say so deliberately.
 */
export function nextOutcome(
  attempt: number,
  statusCode: number | null,
  now: Date,
): DeliveryOutcome {
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    return { status: 'delivered', nextAttemptAt: null }
  }

  if (statusCode === 410) {
    return { status: 'abandoned', nextAttemptAt: null }
  }

  if (attempt >= MAX_ATTEMPTS) {
    return { status: 'abandoned', nextAttemptAt: null }
  }

  return {
    status: 'pending',
    nextAttemptAt: new Date(now.getTime() + backoffSeconds(attempt) * 1_000),
  }
}

/**
 * Whether an endpoint should be switched off.
 *
 * Not after one abandoned delivery — a single bad payload or a five-minute
 * outage should not disable an integration. After three in a row, the endpoint
 * is not coming back on its own, and continuing to queue for it wastes work
 * and hides the failure.
 */
export const FAILURES_BEFORE_DISABLE = 3

export function shouldDisableEndpoint(
  consecutiveAbandoned: number,
): boolean {
  return consecutiveAbandoned >= FAILURES_BEFORE_DISABLE
}

/** A URL an endpoint may point at. */
export function isDeliverableUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  /**
   * HTTPS only. A webhook carries order values, customer names and payment
   * outcomes; sending them over plain HTTP would publish them to every hop in
   * between, and there is no version of that a customer would agree to if
   * asked plainly.
   */
  if (url.protocol !== 'https:') return false

  /**
   * Not localhost, and not a private range.
   *
   * Without this an endpoint is a server-side request forgery primitive: a
   * customer — or anyone who compromises one account — could point a webhook
   * at `http://169.254.169.254/` and have this server fetch cloud credentials
   * on their behalf. Refused by hostname here; a deployment should also
   * restrict egress, because DNS can be made to resolve a public name to a
   * private address after this check has run.
   */
  const host = url.hostname.toLowerCase()

  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return false
  }

  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host)
  ) {
    return false
  }

  return true
}
