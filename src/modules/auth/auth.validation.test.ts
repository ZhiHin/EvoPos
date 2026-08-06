import { describe, expect, it } from 'vitest'

import {
  emailSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
} from './auth.validation'

describe('email normalisation', () => {
  it('lowercases and trims', () => {
    // The unique index on users.email is only meaningful if every write path
    // normalises identically.
    expect(emailSchema.parse('  Owner@Cafe.COM ')).toBe('owner@cafe.com')
  })

  it('rejects malformed addresses', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false)
    expect(emailSchema.safeParse('').success).toBe(false)
  })

  it('rejects addresses beyond the RFC length limit', () => {
    const long = `${'a'.repeat(250)}@example.com`
    expect(emailSchema.safeParse(long).success).toBe(false)
  })
})

describe('password policy', () => {
  it('requires at least 12 characters', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false)
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true)
  })

  it('caps length, so Argon2 cost cannot be driven up by a huge input', () => {
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false)
  })

  it('accepts a passphrase with no special characters', () => {
    // Deliberate: composition rules push people toward weaker passwords.
    expect(
      passwordSchema.safeParse('correct horse battery staple').success,
    ).toBe(true)
  })
})

describe('registerSchema', () => {
  it('accepts a complete registration', () => {
    const result = registerSchema.safeParse({
      name: '  Ali  ',
      email: 'ALI@kopi.com',
      password: 'a-long-enough-password',
      restaurantName: ' Kopi Corner ',
    })

    expect(result.success).toBe(true)
    expect(result.data?.name).toBe('Ali')
    expect(result.data?.email).toBe('ali@kopi.com')
    expect(result.data?.restaurantName).toBe('Kopi Corner')
  })

  it('rejects a whitespace-only restaurant name', () => {
    const result = registerSchema.safeParse({
      name: 'Ali',
      email: 'ali@kopi.com',
      password: 'a-long-enough-password',
      restaurantName: '   ',
    })
    expect(result.success).toBe(false)
  })
})

describe('loginSchema', () => {
  it('does not impose the length policy on sign-in', () => {
    // Enforcing the current policy at login would lock out anyone whose
    // password predates it.
    expect(
      loginSchema.safeParse({ email: 'a@b.com', password: 'old' }).success,
    ).toBe(true)
  })
})
