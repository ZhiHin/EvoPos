import { describe, expect, it } from 'vitest'

import { generateToken, hashToken } from './tokens'

describe('opaque tokens', () => {
  it('generates unique, URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateToken))
    expect(tokens.size).toBe(500)

    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('generates at least 256 bits of entropy', () => {
    // 32 bytes base64url-encoded is 43 characters.
    expect(generateToken()).toHaveLength(43)
  })

  it('hashes deterministically, so the digest can be the lookup key', () => {
    const token = generateToken()
    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('produces different digests for different tokens', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()))
  })

  it('never returns the plaintext token as its own hash', () => {
    // Guards against a refactor that accidentally makes hashing an identity
    // function, which would put usable session tokens in the database.
    const token = generateToken()
    expect(hashToken(token)).not.toBe(token)
  })
})
