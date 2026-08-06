import { describe, expect, it } from 'vitest'

import { branchCodeSchema, createBranchSchema } from './branch.validation'

describe('branch code', () => {
  it('uppercases before validating', () => {
    // Normalise-then-validate: "kl01" must be accepted, not rejected for
    // failing an uppercase-only pattern it was never given a chance to meet.
    expect(branchCodeSchema.parse(' kl01 ')).toBe('KL01')
  })

  it('rejects punctuation', () => {
    expect(branchCodeSchema.safeParse('KL-01').success).toBe(false)
  })

  it('rejects an empty code', () => {
    expect(branchCodeSchema.safeParse('   ').success).toBe(false)
  })

  it('rejects a code longer than 12 characters', () => {
    expect(branchCodeSchema.safeParse('A'.repeat(13)).success).toBe(false)
  })
})

describe('createBranchSchema', () => {
  it('accepts a minimal branch', () => {
    const result = createBranchSchema.safeParse({
      name: '  Bangsar  ',
      code: 'bsr1',
    })

    expect(result.success).toBe(true)
    expect(result.data?.name).toBe('Bangsar')
    expect(result.data?.code).toBe('BSR1')
  })

  it('rejects a whitespace-only name', () => {
    expect(
      createBranchSchema.safeParse({ name: '   ', code: 'A1' }).success,
    ).toBe(false)
  })
})
