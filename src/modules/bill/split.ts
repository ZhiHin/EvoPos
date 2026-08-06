import { ValidationError } from '@/lib/errors'
import type { BillTotals } from '@/modules/pos/bill'

/**
 * The Smart Bill splitting engine.
 *
 * Pure, and the most arithmetically delicate code in the system. Everything
 * here obeys one invariant, and every test exists to defend it:
 *
 *     the shares must sum to EXACTLY the bill total —
 *     never a cent over, never a cent under.
 *
 * That is harder than it sounds in integer minor units. RM 10.00 split three
 * ways is 333.33 cents each; three lots of 333 is 999, and the missing cent
 * has to go somewhere deterministic. A till that is one cent out at the end
 * of service is a till nobody trusts.
 */

/**
 * Distributes `totalMinor` across `weights` so the parts sum to exactly the
 * total — the largest-remainder method.
 *
 * Each recipient gets the floor of their exact share, then the leftover cents
 * go one each to whoever was cut hardest by that flooring. Ties break by
 * index, so the same input always produces the same output: a split shown on
 * screen and a split recorded a second later must agree, or a customer will
 * see one number and be charged another.
 *
 * With all-zero weights the total is spread evenly rather than discarded —
 * losing money silently is the one outcome worse than an arbitrary one.
 */
export function allocate(
  totalMinor: number,
  weights: readonly number[],
): number[] {
  if (weights.length === 0) return []

  if (!Number.isInteger(totalMinor)) {
    throw new ValidationError('Amounts must be whole cents.', {
      total: ['Amounts must be whole cents.'],
    })
  }

  if (weights.some((w) => w < 0)) {
    throw new ValidationError('Split weights cannot be negative.', {
      weights: ['Split weights cannot be negative.'],
    })
  }

  const effective = weights.some((w) => w > 0) ? weights : weights.map(() => 1)
  const weightSum = effective.reduce((sum, w) => sum + w, 0)

  const floors = effective.map((w) =>
    Math.floor((totalMinor * w) / weightSum),
  )
  const distributed = floors.reduce((sum, f) => sum + f, 0)
  let remainder = totalMinor - distributed

  /**
   * The remainder is at most weights.length - 1 cents for a positive total,
   * so one pass suffices. Negative totals are not expected — a bill share is
   * never negative — but the loop below handles the sign correctly rather
   * than spinning.
   */
  const order = effective
    .map((w, index) => ({
      index,
      fraction: (totalMinor * w) / weightSum - floors[index],
    }))
    .sort((a, b) =>
      b.fraction === a.fraction ? a.index - b.index : b.fraction - a.fraction,
    )

  const result = [...floors]
  const step = remainder >= 0 ? 1 : -1

  for (let i = 0; remainder !== 0; i = (i + 1) % order.length) {
    result[order[i].index] += step
    remainder -= step
  }

  return result
}

export interface SplitLine {
  lineId: string
  /** Null means the dish belongs to the table rather than one person. */
  memberId: string | null
  nameSnapshot: string
  quantity: number
  lineTotalMinor: number
}

export interface SplitParticipant {
  memberId: string
  displayName: string
}

/** Assigns a line, or part of one, to a specific person. */
export interface ItemAssignment {
  lineId: string
  memberId: string
  /** Portion of the line's quantity. Omit for the whole line. */
  quantity?: number
}

export type SplitStrategy =
  /** Everyone pays for what they ordered; shared dishes divide evenly. */
  | { kind: 'by_owner' }
  /** The whole bill divides evenly, regardless of who ordered what. */
  | { kind: 'even' }
  /** Fixed proportions, in basis points, which must total 100%. */
  | { kind: 'by_percentage'; weights: Record<string, number> }
  /**
   * Explicit line assignments — "pay selected items". A line may be split by
   * quantity across several people. Anything unassigned divides evenly, so a
   * forgotten dish is shared rather than silently unpaid.
   */
  | { kind: 'by_item'; assignments: ItemAssignment[] }

export interface ShareLine {
  lineId: string
  nameSnapshot: string
  amountMinor: number
  isShared: boolean
}

export interface SplitShare {
  memberId: string
  displayName: string
  subtotalMinor: number
  discountMinor: number
  serviceChargeMinor: number
  taxMinor: number
  totalMinor: number
  lines: ShareLine[]
}

export interface SplitResult {
  strategy: SplitStrategy['kind']
  shares: SplitShare[]
  /** Convenience mirror of the bill being split, for display. */
  billTotalMinor: number
}

/**
 * Weight vector for one line across the participants.
 *
 * Allocating line by line rather than allocating the grand total once buys
 * two things: every share can show exactly which dishes it came from, and
 * exactness still holds — if each line divides exactly, so does their sum.
 */
function weightsForLine(
  line: SplitLine,
  participants: readonly SplitParticipant[],
  strategy: SplitStrategy,
): number[] {
  const equal = participants.map(() => 1)

  switch (strategy.kind) {
    case 'even':
      return equal

    case 'by_percentage':
      return participants.map((p) => strategy.weights[p.memberId] ?? 0)

    case 'by_owner': {
      if (line.memberId === null) return equal

      const weights = participants.map((p) =>
        p.memberId === line.memberId ? 1 : 0,
      )

      /**
       * The owner has left the table and is no longer a participant. Their
       * dish still has to be paid for, so it falls back to the table rather
       * than vanishing from the bill.
       */
      return weights.some((w) => w > 0) ? weights : equal
    }

    case 'by_item': {
      const assignments = strategy.assignments.filter(
        (a) => a.lineId === line.lineId,
      )

      if (assignments.length === 0) return equal

      return participants.map((p) =>
        assignments
          .filter((a) => a.memberId === p.memberId)
          .reduce((sum, a) => sum + (a.quantity ?? line.quantity), 0),
      )
    }
  }
}

function assertStrategyIsUsable(
  strategy: SplitStrategy,
  participants: readonly SplitParticipant[],
  lines: readonly SplitLine[],
): void {
  const known = new Set(participants.map((p) => p.memberId))

  if (strategy.kind === 'by_percentage') {
    const entries = Object.entries(strategy.weights)

    for (const [memberId] of entries) {
      if (!known.has(memberId)) {
        throw new ValidationError('That person is not at this table.', {
          weights: [`Unknown participant "${memberId}".`],
        })
      }
    }

    const sum = entries.reduce((total, [, bp]) => total + bp, 0)
    if (sum !== 10_000) {
      throw new ValidationError('Percentages must add up to 100%.', {
        weights: [
          `Percentages currently total ${(sum / 100).toFixed(2)}%, not 100%.`,
        ],
      })
    }
  }

  if (strategy.kind === 'by_item') {
    const lineIds = new Set(lines.map((l) => l.lineId))
    const byLine = new Map<string, number>()

    for (const assignment of strategy.assignments) {
      if (!known.has(assignment.memberId)) {
        throw new ValidationError('That person is not at this table.', {
          assignments: [`Unknown participant "${assignment.memberId}".`],
        })
      }
      if (!lineIds.has(assignment.lineId)) {
        throw new ValidationError('That item is not on this bill.', {
          assignments: [`Unknown item "${assignment.lineId}".`],
        })
      }
      if (assignment.quantity !== undefined) {
        if (
          !Number.isInteger(assignment.quantity) ||
          assignment.quantity < 1
        ) {
          throw new ValidationError('Portions must be whole numbers.', {
            assignments: ['Portions must be whole numbers of at least 1.'],
          })
        }
        byLine.set(
          assignment.lineId,
          (byLine.get(assignment.lineId) ?? 0) + assignment.quantity,
        )
      }
    }

    /**
     * Assigning 3 of a quantity-2 dish would not break the arithmetic — the
     * weights still divide exactly — but it means someone has claimed a
     * portion that does not exist, and the resulting amounts would be
     * indefensible if questioned.
     */
    for (const line of lines) {
      const claimed = byLine.get(line.lineId)
      if (claimed !== undefined && claimed > line.quantity) {
        throw new ValidationError(
          `More portions of "${line.nameSnapshot}" were assigned than were ordered.`,
          {
            assignments: [
              `"${line.nameSnapshot}" has ${line.quantity} portion(s) but ${claimed} were assigned.`,
            ],
          },
        )
      }
    }
  }
}

/**
 * Splits a bill between the people at a table.
 *
 * Takes the totals already computed by the Phase 5 bill engine rather than
 * recomputing them, so a split can never disagree with the bill it came
 * from — the discount, service charge and tax being divided are exactly the
 * ones printed at the bottom of the receipt.
 *
 * Discount, service charge and tax are allocated in proportion to each
 * person's share of the subtotal, using the same exact-remainder method. In
 * tax-inclusive mode the tax is informational only and is not added to
 * anyone's total, matching how the bill engine treats it.
 */
export function computeSplit(
  lines: readonly SplitLine[],
  participants: readonly SplitParticipant[],
  totals: BillTotals,
  strategy: SplitStrategy,
): SplitResult {
  if (participants.length === 0) {
    throw new ValidationError('There is nobody at this table to split between.', {
      participants: ['Add at least one person before splitting.'],
    })
  }

  assertStrategyIsUsable(strategy, participants, lines)

  const subtotals = participants.map(() => 0)
  const shareLines: ShareLine[][] = participants.map(() => [])

  for (const line of lines) {
    const allocated = allocate(
      line.lineTotalMinor,
      weightsForLine(line, participants, strategy),
    )

    allocated.forEach((amountMinor, index) => {
      subtotals[index] += amountMinor

      // Zero-value rows would clutter a receipt with dishes someone is not
      // paying for at all.
      if (amountMinor !== 0) {
        shareLines[index].push({
          lineId: line.lineId,
          nameSnapshot: line.nameSnapshot,
          amountMinor,
          isShared: line.memberId === null,
        })
      }
    })
  }

  const discounts = allocate(totals.discountMinor, subtotals)
  const serviceCharges = allocate(totals.serviceChargeMinor, subtotals)
  const taxes = allocate(totals.taxMinor, subtotals)

  const shares: SplitShare[] = participants.map((participant, index) => {
    const subtotalMinor = subtotals[index]
    const discountMinor = discounts[index]
    const serviceChargeMinor = serviceCharges[index]
    const taxMinor = taxes[index]

    /**
     * Inclusive tax is already inside the line prices, so adding it again
     * would charge it twice. The bill engine makes the same distinction; the
     * split has to mirror it or the shares will not sum to the bill.
     */
    const totalMinor = totals.taxIsIncluded
      ? subtotalMinor - discountMinor + serviceChargeMinor
      : subtotalMinor - discountMinor + serviceChargeMinor + taxMinor

    return {
      memberId: participant.memberId,
      displayName: participant.displayName,
      subtotalMinor,
      discountMinor,
      serviceChargeMinor,
      taxMinor,
      totalMinor,
      lines: shareLines[index],
    }
  })

  return {
    strategy: strategy.kind,
    shares,
    billTotalMinor: totals.totalMinor,
  }
}

/**
 * Confirms a computed split actually adds up.
 *
 * Belt and braces over the allocation maths: cheap to run, and the one thing
 * that must never be wrong. Called by the service before a split is
 * persisted, so an arithmetic regression fails loudly at the till rather than
 * quietly on a customer's card.
 */
export function assertSplitBalances(
  result: SplitResult,
  totals: BillTotals,
): void {
  const sum = result.shares.reduce((total, s) => total + s.totalMinor, 0)

  if (sum !== totals.totalMinor) {
    throw new ValidationError(
      'The split does not add up to the bill. Nothing has been changed.',
      {
        split: [
          `Shares total ${sum} but the bill is ${totals.totalMinor}. This is a bug — please report it.`,
        ],
      },
    )
  }
}
