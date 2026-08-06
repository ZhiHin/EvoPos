import { ValidationError } from '@/lib/errors'

/**
 * Selection validation and line pricing.
 *
 * Every function here is pure. That is deliberate and load-bearing: this is
 * the arithmetic that decides what a customer is charged, it will be called
 * from the POS (Phase 5), from QR ordering (Phase 4) and from the Smart Bill
 * engine (Phase 6), and it must be exhaustively testable without a database,
 * a session or a tenant.
 *
 * Everything is in integer minor units. No floats appear anywhere in this
 * file, and none should ever be introduced.
 */

export interface ModifierOptionRules {
  optionId: string
  name: string
  /** Signed. Negative is legitimate — "small" may cost less. */
  priceDeltaMinor: number
  /** How many times this single option may be taken. */
  maxQuantity: number
  isAvailable: boolean
}

export interface ModifierGroupRules {
  groupId: string
  name: string
  minSelection: number
  /** Null means unlimited. */
  maxSelection: number | null
  options: ModifierOptionRules[]
}

export interface ModifierSelection {
  groupId: string
  optionId: string
  quantity: number
}

export interface ComboSlotItemRules {
  comboGroupItemId: string
  menuItemId: string
  priceDeltaMinor: number
}

export interface ComboSlotRules {
  slotId: string
  name: string
  minSelection: number
  maxSelection: number | null
  items: ComboSlotItemRules[]
}

export interface ComboSelection {
  slotId: string
  comboGroupItemId: string
  quantity: number
}

/**
 * Resolves a group's effective rules for one item.
 *
 * A group carries default rules; attaching it to an item may override them,
 * because the same "Sauce" group is genuinely optional on a burger and
 * mandatory on plain rice.
 */
export function resolveGroupRules(
  group: Pick<ModifierGroupRules, 'minSelection' | 'maxSelection'>,
  override?: {
    minSelectionOverride?: number | null
    maxSelectionOverride?: number | null
  } | null,
): { minSelection: number; maxSelection: number | null } {
  return {
    minSelection: override?.minSelectionOverride ?? group.minSelection,
    // `??` and not `||`: an explicit override of 0 is meaningful, and `||`
    // would discard it in favour of the group default.
    maxSelection:
      override?.maxSelectionOverride !== undefined &&
      override?.maxSelectionOverride !== null
        ? override.maxSelectionOverride
        : group.maxSelection,
  }
}

/**
 * Checks that a group's own configuration is coherent, independent of any
 * selection. Called when saving a group, so a nonsensical rule is rejected at
 * definition time rather than discovered by a customer at the till.
 */
export function assertGroupRulesAreCoherent(group: {
  name: string
  minSelection: number
  maxSelection: number | null
  optionCount: number
  defaultCount: number
}): void {
  const errors: string[] = []

  if (group.minSelection < 0) {
    errors.push('Minimum selection cannot be negative.')
  }
  if (group.maxSelection !== null && group.maxSelection < 1) {
    errors.push('Maximum selection must be at least 1, or blank for no limit.')
  }
  if (group.maxSelection !== null && group.minSelection > group.maxSelection) {
    errors.push('Minimum selection cannot exceed maximum selection.')
  }
  /**
   * A required group with fewer options than its minimum can never be
   * satisfied — every order containing the item would be unfulfillable, and
   * the failure would surface at the till rather than here.
   */
  if (group.minSelection > group.optionCount) {
    errors.push(
      `This group requires ${group.minSelection} selection(s) but only has ${group.optionCount} option(s).`,
    )
  }
  if (
    group.maxSelection !== null &&
    group.defaultCount > group.maxSelection
  ) {
    errors.push(
      `${group.defaultCount} options are marked as default, which is more than the maximum of ${group.maxSelection}.`,
    )
  }

  if (errors.length > 0) {
    throw new ValidationError('These modifier rules cannot be satisfied.', {
      rules: errors,
    })
  }
}

/**
 * Validates a customer's modifier selections against the item's groups.
 *
 * Iterates the *groups*, not the selections, so a required group that is
 * missing from the payload entirely is caught. Validating only what was sent
 * is how "you must choose a size" becomes optional for anyone who edits the
 * request.
 */
export function validateModifierSelections(
  groups: readonly ModifierGroupRules[],
  selections: readonly ModifierSelection[],
): void {
  const errors: Record<string, string[]> = {}
  const groupById = new Map(groups.map((g) => [g.groupId, g]))

  for (const selection of selections) {
    if (!groupById.has(selection.groupId)) {
      ;(errors.modifiers ??= []).push(
        'A selection refers to a modifier group that does not apply to this item.',
      )
    }
  }

  for (const group of groups) {
    const path = `modifiers.${group.groupId}`
    const optionById = new Map(group.options.map((o) => [o.optionId, o]))
    const chosen = selections.filter((s) => s.groupId === group.groupId)

    const seen = new Set<string>()
    let totalQuantity = 0

    for (const selection of chosen) {
      const option = optionById.get(selection.optionId)

      if (!option) {
        ;(errors[path] ??= []).push(
          `An option was chosen that is not part of "${group.name}".`,
        )
        continue
      }

      /**
       * Repeats must be expressed as quantity, not as duplicate entries.
       * Allowing both would make "two entries of one" and "one entry of two"
       * price identically but compare differently, which breaks any later
       * attempt to match or merge order lines.
       */
      if (seen.has(selection.optionId)) {
        ;(errors[path] ??= []).push(
          `"${option.name}" was chosen more than once. Use a quantity instead.`,
        )
        continue
      }
      seen.add(selection.optionId)

      if (!Number.isInteger(selection.quantity) || selection.quantity < 1) {
        ;(errors[path] ??= []).push(
          `Quantity for "${option.name}" must be a whole number of at least 1.`,
        )
        continue
      }

      if (selection.quantity > option.maxQuantity) {
        ;(errors[path] ??= []).push(
          `"${option.name}" can be chosen at most ${option.maxQuantity} time(s).`,
        )
        continue
      }

      if (!option.isAvailable) {
        ;(errors[path] ??= []).push(`"${option.name}" is not available.`)
        continue
      }

      totalQuantity += selection.quantity
    }

    if (totalQuantity < group.minSelection) {
      ;(errors[path] ??= []).push(
        `Choose at least ${group.minSelection} from "${group.name}".`,
      )
    }

    if (group.maxSelection !== null && totalQuantity > group.maxSelection) {
      ;(errors[path] ??= []).push(
        `Choose at most ${group.maxSelection} from "${group.name}".`,
      )
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Those choices are not valid.', errors)
  }
}

/**
 * Sum of modifier price deltas, in minor units. Signed.
 *
 * Assumes the selections have already been validated — callers must run
 * `validateModifierSelections` first, and every service in this codebase
 * does. Pricing unvalidated input would let an unknown option id silently
 * contribute nothing instead of being rejected.
 */
export function calculateModifierDelta(
  groups: readonly ModifierGroupRules[],
  selections: readonly ModifierSelection[],
): number {
  const optionById = new Map(
    groups.flatMap((g) => g.options.map((o) => [o.optionId, o] as const)),
  )

  return selections.reduce((total, selection) => {
    const option = optionById.get(selection.optionId)
    return option ? total + option.priceDeltaMinor * selection.quantity : total
  }, 0)
}

/** Combo slot equivalent of `validateModifierSelections`. */
export function validateComboSelections(
  slots: readonly ComboSlotRules[],
  selections: readonly ComboSelection[],
): void {
  const errors: Record<string, string[]> = {}
  const slotById = new Map(slots.map((s) => [s.slotId, s]))

  for (const selection of selections) {
    if (!slotById.has(selection.slotId)) {
      ;(errors.combo ??= []).push(
        'A selection refers to a slot that is not part of this combo.',
      )
    }
  }

  for (const slot of slots) {
    const path = `combo.${slot.slotId}`
    const itemById = new Map(slot.items.map((i) => [i.comboGroupItemId, i]))
    const chosen = selections.filter((s) => s.slotId === slot.slotId)

    const seen = new Set<string>()
    let totalQuantity = 0

    for (const selection of chosen) {
      const item = itemById.get(selection.comboGroupItemId)

      if (!item) {
        ;(errors[path] ??= []).push(
          `A choice was made that is not offered in "${slot.name}".`,
        )
        continue
      }

      if (seen.has(selection.comboGroupItemId)) {
        ;(errors[path] ??= []).push(
          `The same choice was made twice in "${slot.name}". Use a quantity instead.`,
        )
        continue
      }
      seen.add(selection.comboGroupItemId)

      if (!Number.isInteger(selection.quantity) || selection.quantity < 1) {
        ;(errors[path] ??= []).push(
          `Quantity in "${slot.name}" must be a whole number of at least 1.`,
        )
        continue
      }

      totalQuantity += selection.quantity
    }

    if (totalQuantity < slot.minSelection) {
      ;(errors[path] ??= []).push(
        `Choose at least ${slot.minSelection} from "${slot.name}".`,
      )
    }

    if (slot.maxSelection !== null && totalQuantity > slot.maxSelection) {
      ;(errors[path] ??= []).push(
        `Choose at most ${slot.maxSelection} from "${slot.name}".`,
      )
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Those combo choices are not valid.', errors)
  }
}

export function calculateComboDelta(
  slots: readonly ComboSlotRules[],
  selections: readonly ComboSelection[],
): number {
  const itemById = new Map(
    slots.flatMap((s) => s.items.map((i) => [i.comboGroupItemId, i] as const)),
  )

  return selections.reduce((total, selection) => {
    const item = itemById.get(selection.comboGroupItemId)
    return item ? total + item.priceDeltaMinor * selection.quantity : total
  }, 0)
}

export interface LineTotalInput {
  /** The item's or combo's own price, in minor units. */
  basePriceMinor: number
  /** How many of this configured line. */
  quantity: number
  modifierGroups?: readonly ModifierGroupRules[]
  modifierSelections?: readonly ModifierSelection[]
  comboSlots?: readonly ComboSlotRules[]
  comboSelections?: readonly ComboSelection[]
}

export interface LineTotal {
  /** Price of one configured unit, before line quantity. */
  unitPriceMinor: number
  modifierDeltaMinor: number
  comboDeltaMinor: number
  lineTotalMinor: number
}

/**
 * The single place a line total is computed.
 *
 * Deltas are summed into the unit price *before* multiplying by line
 * quantity, which is the only correct order: three burgers each with extra
 * cheese is `3 × (base + cheese)`, not `3 × base + cheese`.
 *
 * The unit price is floored at zero. A stack of negative modifiers should
 * make an item free, never negative — a negative line would silently offset
 * other lines on the bill and turn a misconfigured discount into a refund.
 */
export function calculateLineTotal(input: LineTotalInput): LineTotal {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new ValidationError('Quantity must be a whole number of at least 1.', {
      quantity: ['Quantity must be a whole number of at least 1.'],
    })
  }

  const modifierDeltaMinor = calculateModifierDelta(
    input.modifierGroups ?? [],
    input.modifierSelections ?? [],
  )

  const comboDeltaMinor = calculateComboDelta(
    input.comboSlots ?? [],
    input.comboSelections ?? [],
  )

  const unitPriceMinor = Math.max(
    0,
    input.basePriceMinor + modifierDeltaMinor + comboDeltaMinor,
  )

  return {
    unitPriceMinor,
    modifierDeltaMinor,
    comboDeltaMinor,
    lineTotalMinor: unitPriceMinor * input.quantity,
  }
}

/**
 * Default selections for a group, used to pre-fill an ordering screen.
 *
 * Trimmed to `maxSelection` rather than trusted: a group configured with more
 * defaults than its own maximum would otherwise hand the customer a
 * pre-filled selection that fails validation the moment they submit it.
 */
export function defaultSelectionsFor(
  group: ModifierGroupRules,
  defaults: readonly { optionId: string }[],
): ModifierSelection[] {
  const allowed = group.maxSelection ?? defaults.length

  return defaults.slice(0, allowed).map((d) => ({
    groupId: group.groupId,
    optionId: d.optionId,
    quantity: 1,
  }))
}
