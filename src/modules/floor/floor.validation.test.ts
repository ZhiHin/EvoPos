import { describe, expect, it } from 'vitest'

import { createFloorSchema, updateFloorSchema } from './floor.validation'

describe('createFloorSchema', () => {
  it('trims the name and defaults the order', () => {
    const result = createFloorSchema.parse({ name: '  Rooftop  ' })
    expect(result.name).toBe('Rooftop')
    expect(result.displayOrder).toBe(0)
  })

  it('rejects a whitespace-only name', () => {
    expect(createFloorSchema.safeParse({ name: '  ' }).success).toBe(false)
  })

  it('rejects a fractional display order', () => {
    expect(
      createFloorSchema.safeParse({ name: 'Ground', displayOrder: 1.5 })
        .success,
    ).toBe(false)
  })

  it('rejects a negative display order', () => {
    expect(
      createFloorSchema.safeParse({ name: 'Ground', displayOrder: -1 }).success,
    ).toBe(false)
  })
})

describe('updateFloorSchema', () => {
  it('accepts a partial update', () => {
    expect(updateFloorSchema.safeParse({ name: 'Mezzanine' }).success).toBe(
      true,
    )
  })

  it('accepts an empty object', () => {
    expect(updateFloorSchema.safeParse({}).success).toBe(true)
  })
})
