import { describe, expect, it } from 'vitest'

import { ValidationError } from '@/lib/errors'
import {
  assertGroupRulesAreCoherent,
  calculateComboDelta,
  calculateLineTotal,
  calculateModifierDelta,
  defaultSelectionsFor,
  resolveGroupRules,
  validateComboSelections,
  validateModifierSelections,
  type ComboSlotRules,
  type ModifierGroupRules,
} from './pricing'

function option(
  optionId: string,
  priceDeltaMinor = 0,
  overrides: Partial<{ maxQuantity: number; isAvailable: boolean }> = {},
) {
  return {
    optionId,
    name: optionId,
    priceDeltaMinor,
    maxQuantity: 1,
    isAvailable: true,
    ...overrides,
  }
}

const SIZE: ModifierGroupRules = {
  groupId: 'size',
  name: 'Size',
  minSelection: 1,
  maxSelection: 1,
  options: [option('small', -50), option('regular', 0), option('large', 150)],
}

const EXTRAS: ModifierGroupRules = {
  groupId: 'extras',
  name: 'Extras',
  minSelection: 0,
  maxSelection: 3,
  options: [
    option('shot', 100, { maxQuantity: 3 }),
    option('pearls', 80),
    option('gone', 50, { isAvailable: false }),
  ],
}

describe('resolveGroupRules', () => {
  it('uses the group defaults when there is no override', () => {
    expect(resolveGroupRules(SIZE, null)).toEqual({
      minSelection: 1,
      maxSelection: 1,
    })
  })

  it('applies per-item overrides', () => {
    expect(
      resolveGroupRules(SIZE, {
        minSelectionOverride: 0,
        maxSelectionOverride: 2,
      }),
    ).toEqual({ minSelection: 0, maxSelection: 2 })
  })

  it('honours an override of zero', () => {
    // `||` would discard this and silently keep the group's required rule,
    // making an item's "optional" override do nothing.
    expect(
      resolveGroupRules(SIZE, { minSelectionOverride: 0 }).minSelection,
    ).toBe(0)
  })

  it('treats null overrides as absent', () => {
    expect(
      resolveGroupRules(SIZE, {
        minSelectionOverride: null,
        maxSelectionOverride: null,
      }),
    ).toEqual({ minSelection: 1, maxSelection: 1 })
  })
})

describe('assertGroupRulesAreCoherent', () => {
  const base = {
    name: 'Size',
    minSelection: 1,
    maxSelection: 1,
    optionCount: 3,
    defaultCount: 1,
  }

  it('accepts a sane group', () => {
    expect(() => assertGroupRulesAreCoherent(base)).not.toThrow()
  })

  it('rejects min greater than max', () => {
    expect(() =>
      assertGroupRulesAreCoherent({ ...base, minSelection: 3, maxSelection: 2 }),
    ).toThrow(ValidationError)
  })

  it('rejects requiring more selections than there are options', () => {
    // Otherwise every order containing the item is unfulfillable, and the
    // failure surfaces at the till rather than at definition time.
    expect(() =>
      assertGroupRulesAreCoherent({
        ...base,
        minSelection: 5,
        maxSelection: null,
        optionCount: 3,
      }),
    ).toThrow(ValidationError)
  })

  it('rejects more defaults than the maximum allows', () => {
    expect(() =>
      assertGroupRulesAreCoherent({ ...base, defaultCount: 2, maxSelection: 1 }),
    ).toThrow(ValidationError)
  })

  it('rejects a negative minimum', () => {
    expect(() =>
      assertGroupRulesAreCoherent({ ...base, minSelection: -1 }),
    ).toThrow(ValidationError)
  })

  it('allows an unlimited maximum', () => {
    expect(() =>
      assertGroupRulesAreCoherent({
        ...base,
        minSelection: 0,
        maxSelection: null,
        defaultCount: 3,
      }),
    ).not.toThrow()
  })
})

describe('validateModifierSelections', () => {
  it('accepts a valid selection', () => {
    expect(() =>
      validateModifierSelections(
        [SIZE],
        [{ groupId: 'size', optionId: 'large', quantity: 1 }],
      ),
    ).not.toThrow()
  })

  /**
   * The important one. Validating only what was sent means a required group
   * omitted entirely from the payload passes — "you must choose a size"
   * becomes optional for anyone who edits the request.
   */
  it('rejects a required group missing from the payload entirely', () => {
    expect(() => validateModifierSelections([SIZE], [])).toThrow(
      ValidationError,
    )
  })

  it('rejects exceeding the maximum', () => {
    expect(() =>
      validateModifierSelections(
        [SIZE],
        [
          { groupId: 'size', optionId: 'small', quantity: 1 },
          { groupId: 'size', optionId: 'large', quantity: 1 },
        ],
      ),
    ).toThrow(ValidationError)
  })

  it('counts quantity toward the maximum, not just distinct options', () => {
    // "Pick at most 3" must mean 3 things, so 3× one option is at the limit
    // and a 4th is over it.
    expect(() =>
      validateModifierSelections(
        [EXTRAS],
        [{ groupId: 'extras', optionId: 'shot', quantity: 3 }],
      ),
    ).not.toThrow()

    expect(() =>
      validateModifierSelections(
        [{ ...EXTRAS, maxSelection: 2 }],
        [{ groupId: 'extras', optionId: 'shot', quantity: 3 }],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects a quantity above the option limit', () => {
    expect(() =>
      validateModifierSelections(
        [EXTRAS],
        [{ groupId: 'extras', optionId: 'pearls', quantity: 2 }],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects duplicate entries for the same option', () => {
    // Two entries of one and one entry of two price identically but compare
    // differently, which breaks any later attempt to merge order lines.
    expect(() =>
      validateModifierSelections(
        [EXTRAS],
        [
          { groupId: 'extras', optionId: 'shot', quantity: 1 },
          { groupId: 'extras', optionId: 'shot', quantity: 1 },
        ],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects an unavailable option', () => {
    expect(() =>
      validateModifierSelections(
        [EXTRAS],
        [{ groupId: 'extras', optionId: 'gone', quantity: 1 }],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects an option from another group', () => {
    expect(() =>
      validateModifierSelections(
        [SIZE],
        [{ groupId: 'size', optionId: 'pearls', quantity: 1 }],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects a group that does not apply to this item', () => {
    expect(() =>
      validateModifierSelections(
        [SIZE],
        [
          { groupId: 'size', optionId: 'large', quantity: 1 },
          { groupId: 'secret', optionId: 'x', quantity: 1 },
        ],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects zero and fractional quantities', () => {
    expect(() =>
      validateModifierSelections(
        [EXTRAS],
        [{ groupId: 'extras', optionId: 'pearls', quantity: 0 }],
      ),
    ).toThrow(ValidationError)

    expect(() =>
      validateModifierSelections(
        [EXTRAS],
        [{ groupId: 'extras', optionId: 'pearls', quantity: 1.5 }],
      ),
    ).toThrow(ValidationError)
  })

  it('allows an optional group to be skipped', () => {
    expect(() => validateModifierSelections([EXTRAS], [])).not.toThrow()
  })
})

describe('calculateModifierDelta', () => {
  it('sums signed deltas', () => {
    expect(
      calculateModifierDelta(
        [SIZE],
        [{ groupId: 'size', optionId: 'small', quantity: 1 }],
      ),
    ).toBe(-50)
  })

  it('multiplies by quantity', () => {
    expect(
      calculateModifierDelta(
        [EXTRAS],
        [{ groupId: 'extras', optionId: 'shot', quantity: 3 }],
      ),
    ).toBe(300)
  })

  it('is zero with no selections', () => {
    expect(calculateModifierDelta([SIZE, EXTRAS], [])).toBe(0)
  })
})

const MAIN: ComboSlotRules = {
  slotId: 'main',
  name: 'Choose your main',
  minSelection: 1,
  maxSelection: 1,
  items: [
    { comboGroupItemId: 'nasi', menuItemId: 'i1', priceDeltaMinor: 0 },
    { comboGroupItemId: 'steak', menuItemId: 'i2', priceDeltaMinor: 800 },
  ],
}

const SIDES: ComboSlotRules = {
  slotId: 'sides',
  name: 'Pick two sides',
  minSelection: 2,
  maxSelection: 2,
  items: [
    { comboGroupItemId: 'fries', menuItemId: 'i3', priceDeltaMinor: 0 },
    { comboGroupItemId: 'salad', menuItemId: 'i4', priceDeltaMinor: 100 },
  ],
}

describe('validateComboSelections', () => {
  it('accepts a valid combo', () => {
    expect(() =>
      validateComboSelections(
        [MAIN, SIDES],
        [
          { slotId: 'main', comboGroupItemId: 'steak', quantity: 1 },
          { slotId: 'sides', comboGroupItemId: 'fries', quantity: 2 },
        ],
      ),
    ).not.toThrow()
  })

  it('rejects an unfilled required slot', () => {
    expect(() =>
      validateComboSelections(
        [MAIN, SIDES],
        [{ slotId: 'main', comboGroupItemId: 'nasi', quantity: 1 }],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects too few in a pick-two slot', () => {
    expect(() =>
      validateComboSelections(
        [SIDES],
        [{ slotId: 'sides', comboGroupItemId: 'fries', quantity: 1 }],
      ),
    ).toThrow(ValidationError)
  })

  it('rejects an item not offered in that slot', () => {
    expect(() =>
      validateComboSelections(
        [MAIN],
        [{ slotId: 'main', comboGroupItemId: 'fries', quantity: 1 }],
      ),
    ).toThrow(ValidationError)
  })
})

describe('calculateComboDelta', () => {
  it('sums slot deltas with quantity', () => {
    expect(
      calculateComboDelta(
        [MAIN, SIDES],
        [
          { slotId: 'main', comboGroupItemId: 'steak', quantity: 1 },
          { slotId: 'sides', comboGroupItemId: 'salad', quantity: 2 },
        ],
      ),
    ).toBe(1000)
  })
})

describe('calculateLineTotal', () => {
  it('adds modifiers into the unit price before multiplying', () => {
    // Three drinks each upsized is 3 × (base + delta), never 3 × base + delta.
    const result = calculateLineTotal({
      basePriceMinor: 1000,
      quantity: 3,
      modifierGroups: [SIZE],
      modifierSelections: [{ groupId: 'size', optionId: 'large', quantity: 1 }],
    })

    expect(result.unitPriceMinor).toBe(1150)
    expect(result.lineTotalMinor).toBe(3450)
  })

  it('applies negative deltas', () => {
    const result = calculateLineTotal({
      basePriceMinor: 1000,
      quantity: 1,
      modifierGroups: [SIZE],
      modifierSelections: [{ groupId: 'size', optionId: 'small', quantity: 1 }],
    })

    expect(result.unitPriceMinor).toBe(950)
  })

  /**
   * A misconfigured stack of discounts must make an item free, never
   * negative — a negative line would silently offset other lines and turn a
   * configuration mistake into a refund.
   */
  it('floors the unit price at zero', () => {
    const result = calculateLineTotal({
      basePriceMinor: 30,
      quantity: 2,
      modifierGroups: [SIZE],
      modifierSelections: [{ groupId: 'size', optionId: 'small', quantity: 1 }],
    })

    expect(result.unitPriceMinor).toBe(0)
    expect(result.lineTotalMinor).toBe(0)
  })

  it('combines combo and modifier deltas', () => {
    const result = calculateLineTotal({
      basePriceMinor: 2500,
      quantity: 2,
      comboSlots: [MAIN],
      comboSelections: [
        { slotId: 'main', comboGroupItemId: 'steak', quantity: 1 },
      ],
      modifierGroups: [EXTRAS],
      modifierSelections: [
        { groupId: 'extras', optionId: 'shot', quantity: 2 },
      ],
    })

    expect(result.comboDeltaMinor).toBe(800)
    expect(result.modifierDeltaMinor).toBe(200)
    expect(result.unitPriceMinor).toBe(3500)
    expect(result.lineTotalMinor).toBe(7000)
  })

  it('rejects a zero or fractional line quantity', () => {
    expect(() =>
      calculateLineTotal({ basePriceMinor: 100, quantity: 0 }),
    ).toThrow(ValidationError)

    expect(() =>
      calculateLineTotal({ basePriceMinor: 100, quantity: 2.5 }),
    ).toThrow(ValidationError)
  })

  it('returns integers throughout', () => {
    const result = calculateLineTotal({
      basePriceMinor: 333,
      quantity: 7,
      modifierGroups: [EXTRAS],
      modifierSelections: [{ groupId: 'extras', optionId: 'shot', quantity: 3 }],
    })

    expect(Number.isInteger(result.unitPriceMinor)).toBe(true)
    expect(Number.isInteger(result.lineTotalMinor)).toBe(true)
    expect(result.lineTotalMinor).toBe((333 + 300) * 7)
  })
})

describe('defaultSelectionsFor', () => {
  it('pre-fills defaults', () => {
    expect(
      defaultSelectionsFor(SIZE, [{ optionId: 'regular' }]),
    ).toEqual([{ groupId: 'size', optionId: 'regular', quantity: 1 }])
  })

  it('trims defaults that exceed the maximum', () => {
    // A group with more defaults than its own maximum would otherwise hand
    // the customer a pre-filled selection that fails the moment they submit.
    const result = defaultSelectionsFor(SIZE, [
      { optionId: 'small' },
      { optionId: 'large' },
    ])

    expect(result).toHaveLength(1)
  })
})
