import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { RateLimitError } from './errors'
import { check, consume, reset } from './rate-limit'

/**
 * The rate limiter now needs a database.
 *
 * That is the cost of the Phase 14 change and worth stating: Phase 0's version
 * counted in process memory and was testable with no dependencies, but its
 * limit multiplied by the instance count behind a load balancer. Moving the
 * counter to Postgres is what makes the limit mean what it says, and it makes
 * these tests integration tests.
 *
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

describe.skipIf(!enabled)('rate limiter', () => {
  const key = (label: string): string => `test:${label}:${randomUUID()}`

  it('allows requests up to the limit', async () => {
    const k = key('allow')

    for (let i = 0; i < 3; i += 1) {
      const result = await check({ key: k, limit: 3, windowMs: 60_000 })
      expect(result.allowed).toBe(true)
    }
  })

  it('blocks the request after the limit', async () => {
    const options = { key: key('block'), limit: 2, windowMs: 60_000 }

    await check(options)
    await check(options)

    const result = await check(options)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('reports the remaining budget', async () => {
    const options = { key: key('remaining'), limit: 3, windowMs: 60_000 }

    expect((await check(options)).remaining).toBe(2)
    expect((await check(options)).remaining).toBe(1)
  })

  it('throws RateLimitError once exhausted', async () => {
    const options = { key: key('throw'), limit: 1, windowMs: 60_000 }

    await expect(consume(options)).resolves.toBeUndefined()
    await expect(consume(options)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('reset clears the budget, so a successful login is not penalised', async () => {
    const k = key('reset')
    const options = { key: k, limit: 1, windowMs: 60_000 }

    await consume(options)
    await reset(k)
    await expect(consume(options)).resolves.toBeUndefined()
  })

  it('starts a fresh window once the old one lapses', async () => {
    const options = { key: key('window'), limit: 1, windowMs: 1_000 }
    const start = new Date()

    expect((await check(options, start)).allowed).toBe(true)
    expect(
      (await check(options, new Date(start.getTime() + 500))).allowed,
    ).toBe(false)

    // Past the window: the count restarts rather than accumulating forever,
    // which is what makes this fixed-window rather than a permanent ban.
    const after = new Date(start.getTime() + 1_500)
    expect((await check(options, after)).allowed).toBe(true)
  })

  it('keeps separate budgets per key', async () => {
    // Otherwise one account being attacked would lock out every other user.
    const a = key('iso-a')
    const b = key('iso-b')

    await consume({ key: a, limit: 1, windowMs: 60_000 })
    await expect(
      consume({ key: b, limit: 1, windowMs: 60_000 }),
    ).resolves.toBeUndefined()
  })

  it('counts across callers, not per process', async () => {
    /**
     * The whole point of the change. Two concurrent consumes against one key
     * must land on one counter — the in-process version would have given each
     * worker its own, and the effective limit would be the configured one
     * multiplied by the instance count.
     */
    const options = { key: key('shared'), limit: 5, windowMs: 60_000 }

    const results = await Promise.all(
      Array.from({ length: 8 }, () => check(options)),
    )

    expect(results.filter((r) => r.allowed)).toHaveLength(5)
    expect(results.filter((r) => !r.allowed)).toHaveLength(3)
  })
})
