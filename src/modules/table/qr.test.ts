import { describe, expect, it } from 'vitest'

import { generateQrToken, isWellFormedQrToken, qrPayloadUrl } from './qr'

describe('QR token generation', () => {
  it('produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateQrToken))
    expect(tokens.size).toBe(1000)
  })

  it('produces 32 URL-safe characters', () => {
    // 24 bytes base64url-encoded. Long enough to be unguessable, short enough
    // to keep the printed QR low-density and easy to scan.
    const token = generateQrToken()
    expect(token).toHaveLength(32)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('accepts its own tokens as well-formed', () => {
    for (let i = 0; i < 50; i++) {
      expect(isWellFormedQrToken(generateQrToken())).toBe(true)
    }
  })

  it('rejects malformed tokens without touching the database', () => {
    expect(isWellFormedQrToken('')).toBe(false)
    expect(isWellFormedQrToken('short')).toBe(false)
    expect(isWellFormedQrToken('a'.repeat(31))).toBe(false)
    expect(isWellFormedQrToken('a'.repeat(33))).toBe(false)
    expect(isWellFormedQrToken('has spaces in it aaaaaaaaaaaaaaa')).toBe(false)
    expect(isWellFormedQrToken("'; drop table dining_tables;--")).toBe(false)
  })
})

describe('QR payload URL', () => {
  it('embeds only the token', () => {
    const token = generateQrToken()
    expect(qrPayloadUrl(token)).toBe(`http://localhost:3000/t/${token}`)
  })

  it('leaks no identifier', () => {
    // The spec requires a QR never expose restaurant or table ids. The whole
    // payload is one opaque token and a fixed path.
    const url = qrPayloadUrl(generateQrToken())
    expect(url).not.toMatch(/restaurant|branch|table|id=/i)
  })
})
