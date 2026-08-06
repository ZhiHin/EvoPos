import { describe, expect, it } from 'vitest'

import { hashPassword, verifyPassword } from './password'

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    await expect(
      verifyPassword(hash, 'correct horse battery staple'),
    ).resolves.toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(
      false,
    )
  })

  it('produces a different hash each time for the same password', async () => {
    // Different salts. Identical hashes would let an attacker with the table
    // see which accounts share a password.
    const a = await hashPassword('same-password-twice')
    const b = await hashPassword('same-password-twice')
    expect(a).not.toBe(b)
  })

  it('emits an argon2id hash', async () => {
    const hash = await hashPassword('whatever-goes-here')
    expect(hash.startsWith('$argon2id$')).toBe(true)
  })

  it('returns false instead of throwing on a corrupt hash', async () => {
    // A damaged row must read as a failed login, not a 500 that tells an
    // attacker something about the account.
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false)
    await expect(verifyPassword('', 'anything')).resolves.toBe(false)
  })
})
