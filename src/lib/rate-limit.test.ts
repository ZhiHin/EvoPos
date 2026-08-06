import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RateLimitError } from './errors'
import { check, consume, reset } from './rate-limit'

describe('rate limiter', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('allows requests up to the limit', () => {
    const key = `allow-${Math.random()}`
    for (let i = 0; i < 3; i++) {
      expect(check({ key, limit: 3, windowMs: 60_000 }).allowed).toBe(true)
    }
  })

  it('blocks the request after the limit', () => {
    const key = `block-${Math.random()}`
    const options = { key, limit: 2, windowMs: 60_000 }

    check(options)
    check(options)

    const result = check(options)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('reports the remaining budget', () => {
    const key = `remaining-${Math.random()}`
    expect(check({ key, limit: 3, windowMs: 60_000 }).remaining).toBe(2)
    expect(check({ key, limit: 3, windowMs: 60_000 }).remaining).toBe(1)
  })

  it('throws RateLimitError once exhausted', () => {
    const key = `throw-${Math.random()}`
    const options = { key, limit: 1, windowMs: 60_000 }

    expect(() => consume(options)).not.toThrow()
    expect(() => consume(options)).toThrow(RateLimitError)
  })

  it('reset clears the budget, so a successful login is not penalised', () => {
    const key = `reset-${Math.random()}`
    const options = { key, limit: 1, windowMs: 60_000 }

    consume(options)
    reset(key)
    expect(() => consume(options)).not.toThrow()
  })

  it('starts a fresh window once the old one lapses', () => {
    vi.useFakeTimers()
    const key = `window-${Math.random()}`
    const options = { key, limit: 1, windowMs: 1_000 }

    consume(options)
    expect(() => consume(options)).toThrow(RateLimitError)

    vi.advanceTimersByTime(1_001)
    expect(() => consume(options)).not.toThrow()
  })

  it('keeps separate budgets per key', () => {
    // Otherwise one account being attacked would lock out every other user.
    const a = `iso-a-${Math.random()}`
    const b = `iso-b-${Math.random()}`

    consume({ key: a, limit: 1, windowMs: 60_000 })
    expect(() => consume({ key: b, limit: 1, windowMs: 60_000 })).not.toThrow()
  })
})
