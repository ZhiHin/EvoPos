import { describe, expect, it } from 'vitest'

import { redact } from './audit.service'

describe('audit redaction', () => {
  it('redacts secret-bearing keys regardless of case', () => {
    const result = redact({
      email: 'owner@cafe.com',
      passwordHash: '$argon2id$v=19$...',
      TOKEN: 'abc123',
      client_secret: 'shh',
    }) as Record<string, unknown>

    expect(result.email).toBe('owner@cafe.com')
    expect(result.passwordHash).toBe('[redacted]')
    expect(result.TOKEN).toBe('[redacted]')
    expect(result.client_secret).toBe('[redacted]')
  })

  it('redacts nested values', () => {
    // Audit payloads are built from whole entity objects, so the secret is
    // usually several levels down rather than at the top.
    const result = redact({
      membership: { user: { name: 'Ali', password: 'hunter2' } },
    }) as { membership: { user: { name: string; password: string } } }

    expect(result.membership.user.name).toBe('Ali')
    expect(result.membership.user.password).toBe('[redacted]')
  })

  it('redacts inside arrays', () => {
    const result = redact([{ token: 'a' }, { token: 'b' }]) as Array<{
      token: string
    }>
    expect(result.map((r) => r.token)).toEqual(['[redacted]', '[redacted]'])
  })

  it('passes primitives and null through untouched', () => {
    expect(redact('plain')).toBe('plain')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
  })

  it('stops recursing at the depth cap', () => {
    // A cyclic or pathologically deep object must not hang the request that
    // is trying to write an audit row.
    let deep: Record<string, unknown> = { password: 'leaf' }
    for (let i = 0; i < 20; i++) deep = { nested: deep }

    expect(() => redact(deep)).not.toThrow()
  })
})
