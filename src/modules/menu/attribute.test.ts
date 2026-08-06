import { describe, expect, it } from 'vitest'

import { ValidationError } from '@/lib/errors'
import {
  validateAttributeValues,
  type AttributeDefinition,
} from './attribute.service'

function def(
  overrides: Partial<AttributeDefinition> & Pick<AttributeDefinition, 'key' | 'type'>,
): AttributeDefinition {
  return {
    id: `id-${overrides.key}`,
    label: overrides.key,
    options: null,
    required: false,
    displayOrder: 0,
    ...overrides,
  }
}

describe('custom attribute validation', () => {
  it('accepts and trims text', () => {
    const result = validateAttributeValues(
      [def({ key: 'origin', type: 'text' })],
      { origin: '  Penang  ' },
    )
    expect(result).toEqual({ origin: 'Penang' })
  })

  it('coerces a numeric string', () => {
    // Form fields post strings; requiring the client to convert would put a
    // parsing rule in two places.
    const result = validateAttributeValues(
      [def({ key: 'spice', type: 'number' })],
      { spice: '3' },
    )
    expect(result).toEqual({ spice: 3 })
  })

  it('rejects a non-numeric value for a number field', () => {
    expect(() =>
      validateAttributeValues([def({ key: 'spice', type: 'number' })], {
        spice: 'very hot',
      }),
    ).toThrow(ValidationError)
  })

  it('coerces boolean strings', () => {
    const result = validateAttributeValues(
      [def({ key: 'halal', type: 'boolean' })],
      { halal: 'true' },
    )
    expect(result).toEqual({ halal: true })
  })

  it('accepts a valid select option', () => {
    const result = validateAttributeValues(
      [def({ key: 'size', type: 'select', options: ['S', 'M', 'L'] })],
      { size: 'M' },
    )
    expect(result).toEqual({ size: 'M' })
  })

  it('rejects a select value that is not an option', () => {
    expect(() =>
      validateAttributeValues(
        [def({ key: 'size', type: 'select', options: ['S', 'M', 'L'] })],
        { size: 'XXL' },
      ),
    ).toThrow(ValidationError)
  })

  it('deduplicates multiselect values', () => {
    // The same value twice carries no extra meaning, and leaving duplicates
    // would make equality checks on the stored JSONB depend on input order.
    const result = validateAttributeValues(
      [def({ key: 'diet', type: 'multiselect', options: ['veg', 'gf'] })],
      { diet: ['veg', 'gf', 'veg'] },
    )
    expect(result).toEqual({ diet: ['veg', 'gf'] })
  })

  it('rejects a multiselect containing an undefined option', () => {
    expect(() =>
      validateAttributeValues(
        [def({ key: 'diet', type: 'multiselect', options: ['veg'] })],
        { diet: ['veg', 'nuclear'] },
      ),
    ).toThrow(ValidationError)
  })

  it('rejects an unknown key rather than dropping it', () => {
    // Silently discarding a typo'd key looks to the user like the field just
    // did not work, with nothing on screen to explain why.
    expect(() =>
      validateAttributeValues([def({ key: 'origin', type: 'text' })], {
        orgin: 'Penang',
      }),
    ).toThrow(ValidationError)
  })

  it('reports the offending key in the error details', () => {
    try {
      validateAttributeValues([def({ key: 'origin', type: 'text' })], {
        orgin: 'Penang',
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).details).toHaveProperty(
        'attributes.orgin',
      )
    }
  })

  it('enforces required fields', () => {
    expect(() =>
      validateAttributeValues(
        [def({ key: 'origin', type: 'text', required: true })],
        {},
      ),
    ).toThrow(ValidationError)
  })

  it('treats an empty string as absent for a required field', () => {
    expect(() =>
      validateAttributeValues(
        [def({ key: 'origin', type: 'text', required: true })],
        { origin: '' },
      ),
    ).toThrow(ValidationError)
  })

  it('omits absent optional fields instead of storing null', () => {
    const result = validateAttributeValues(
      [
        def({ key: 'origin', type: 'text' }),
        def({ key: 'spice', type: 'number' }),
      ],
      { spice: 2 },
    )
    expect(result).toEqual({ spice: 2 })
    expect(result).not.toHaveProperty('origin')
  })

  it('accepts an empty definition set with empty values', () => {
    expect(validateAttributeValues([], {})).toEqual({})
  })

  it('collects every error in one pass', () => {
    // One round trip should tell the user everything that is wrong, not the
    // first thing that is wrong.
    try {
      validateAttributeValues(
        [
          def({ key: 'a', type: 'number', required: true }),
          def({ key: 'b', type: 'select', options: ['x'] }),
        ],
        { b: 'y', c: 1 },
      )
      expect.unreachable('should have thrown')
    } catch (error) {
      const details = (error as ValidationError).details!
      expect(Object.keys(details).sort()).toEqual([
        'attributes.a',
        'attributes.b',
        'attributes.c',
      ])
    }
  })
})
