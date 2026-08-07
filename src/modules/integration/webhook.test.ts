import { describe, expect, it } from 'vitest'

import {
  backoffSeconds,
  isDeliverableUrl,
  MAX_ATTEMPTS,
  nextOutcome,
  REPLAY_TOLERANCE_SECONDS,
  shouldDisableEndpoint,
  sign,
  verifySignature,
} from './webhook'

const SECRET = 'whsec_test_secret'
const BODY = JSON.stringify({ event: 'bill.settled', totalMinor: 4500 })

describe('signing', () => {
  it('verifies a signature it produced', () => {
    const now = 1_800_000_000
    const signature = sign(SECRET, BODY, now)

    expect(verifySignature(SECRET, BODY, now, signature, now)).toBe(true)
  })

  it('rejects a changed body', () => {
    const now = 1_800_000_000
    const signature = sign(SECRET, BODY, now)

    expect(
      verifySignature(SECRET, `${BODY} `, now, signature, now),
    ).toBe(false)
  })

  it('rejects the wrong secret', () => {
    const now = 1_800_000_000
    const signature = sign('whsec_other', BODY, now)

    expect(verifySignature(SECRET, BODY, now, signature, now)).toBe(false)
  })

  it('binds the timestamp into the signature', () => {
    /**
     * A signature over the body alone could be replayed with any timestamp the
     * attacker liked, which defeats the freshness window entirely.
     */
    const signature = sign(SECRET, BODY, 1_800_000_000)

    expect(
      verifySignature(SECRET, BODY, 1_800_000_001, signature, 1_800_000_001),
    ).toBe(false)
  })

  it('rejects a delivery older than the tolerance', () => {
    const signedAt = 1_800_000_000
    const signature = sign(SECRET, BODY, signedAt)

    const justInside = signedAt + REPLAY_TOLERANCE_SECONDS - 1
    const justOutside = signedAt + REPLAY_TOLERANCE_SECONDS + 1

    expect(verifySignature(SECRET, BODY, signedAt, signature, justInside)).toBe(
      true,
    )
    // Captured once, replayable forever without this.
    expect(
      verifySignature(SECRET, BODY, signedAt, signature, justOutside),
    ).toBe(false)
  })

  it('rejects a timestamp from the future beyond tolerance', () => {
    // Clock skew cuts both ways; a far-future timestamp is as suspect as a
    // stale one.
    const signature = sign(SECRET, BODY, 1_800_001_000)

    expect(
      verifySignature(SECRET, BODY, 1_800_001_000, signature, 1_800_000_000),
    ).toBe(false)
  })

  it('rejects a malformed signature without throwing', () => {
    const now = 1_800_000_000

    // `timingSafeEqual` throws on a length mismatch — the length check has to
    // come first or a short signature crashes the receiver instead of failing.
    expect(verifySignature(SECRET, BODY, now, 'short', now)).toBe(false)
    expect(verifySignature(SECRET, BODY, now, '', now)).toBe(false)
  })

  it('rejects a non-numeric timestamp', () => {
    const now = 1_800_000_000
    expect(
      verifySignature(SECRET, BODY, Number.NaN, sign(SECRET, BODY, now), now),
    ).toBe(false)
  })
})

describe('retry policy', () => {
  const now = new Date('2026-08-07T12:00:00Z')

  it('treats any 2xx as delivered', () => {
    for (const code of [200, 201, 202, 204]) {
      expect(nextOutcome(1, code, now).status).toBe('delivered')
    }
  })

  it('retries a 500 with backoff', () => {
    const outcome = nextOutcome(1, 500, now)

    expect(outcome.status).toBe('pending')
    expect(outcome.nextAttemptAt).toEqual(new Date('2026-08-07T12:00:10Z'))
  })

  it('retries a 4xx too', () => {
    /**
     * A receiver returning 400 because it was mid-deploy is indistinguishable
     * from one rejecting the payload permanently. Giving up on the first 400
     * loses real events to transient misconfiguration.
     */
    expect(nextOutcome(1, 400, now).status).toBe('pending')
    expect(nextOutcome(1, 404, now).status).toBe('pending')
  })

  it('gives up immediately on 410 Gone', () => {
    // The one status HTTP defines as permanent, so a receiver can say so on
    // purpose rather than being retried for an hour and a half.
    expect(nextOutcome(1, 410, now).status).toBe('abandoned')
  })

  it('retries a connection failure', () => {
    expect(nextOutcome(1, null, now).status).toBe('pending')
  })

  it('abandons once the attempt budget is spent', () => {
    expect(nextOutcome(MAX_ATTEMPTS - 1, 500, now).status).toBe('pending')
    expect(nextOutcome(MAX_ATTEMPTS, 500, now).status).toBe('abandoned')
    expect(nextOutcome(MAX_ATTEMPTS, 500, now).nextAttemptAt).toBeNull()
  })

  it('backs off exponentially, then stops growing', () => {
    expect(backoffSeconds(1)).toBe(10)
    expect(backoffSeconds(2)).toBe(20)
    expect(backoffSeconds(3)).toBe(40)
    // Capped, so the last gaps do not stretch to hours.
    expect(backoffSeconds(20)).toBe(1_800)
  })
})

describe('disabling a dead endpoint', () => {
  it('tolerates one failure', () => {
    // A single bad payload or a five-minute outage should not switch off an
    // integration somebody depends on.
    expect(shouldDisableEndpoint(1)).toBe(false)
    expect(shouldDisableEndpoint(2)).toBe(false)
  })

  it('gives up after three in a row', () => {
    expect(shouldDisableEndpoint(3)).toBe(true)
  })
})

describe('which URLs may be registered', () => {
  it('accepts an ordinary https endpoint', () => {
    expect(isDeliverableUrl('https://hooks.example.com/ros')).toBe(true)
  })

  it('refuses plain http', () => {
    // A webhook carries order values, customer names and payment outcomes.
    expect(isDeliverableUrl('http://hooks.example.com/ros')).toBe(false)
  })

  it('refuses loopback and private ranges', () => {
    /**
     * Without this an endpoint is a server-side request forgery primitive:
     * point it at the cloud metadata address and the server fetches
     * credentials on the attacker's behalf.
     */
    expect(isDeliverableUrl('https://169.254.169.254/latest/meta-data/')).toBe(
      false,
    )
    expect(isDeliverableUrl('https://localhost/hook')).toBe(false)
    expect(isDeliverableUrl('https://127.0.0.1/hook')).toBe(false)
    expect(isDeliverableUrl('https://10.0.0.5/hook')).toBe(false)
    expect(isDeliverableUrl('https://192.168.1.1/hook')).toBe(false)
    expect(isDeliverableUrl('https://172.16.0.1/hook')).toBe(false)
    expect(isDeliverableUrl('https://api.internal/hook')).toBe(false)
  })

  it('leaves 172.32 alone, which is public', () => {
    // The private range is 172.16–172.31. A regex matching all of 172. would
    // refuse legitimate endpoints.
    expect(isDeliverableUrl('https://172.32.0.1/hook')).toBe(true)
  })

  it('refuses anything that is not a URL', () => {
    expect(isDeliverableUrl('not a url')).toBe(false)
    expect(isDeliverableUrl('')).toBe(false)
  })
})
