import { ConflictError, ValidationError } from '@/lib/errors'
import { roundForCash } from '@/modules/pos/bill'

/**
 * Payment settlement arithmetic.
 *
 * Pure, like the bill and split engines before it. This decides how much is
 * still owed, how much change to hand back, and whether a payment may be
 * accepted at all — the three questions a cashier's hands are moving on while
 * a queue builds behind them.
 *
 * Integer minor units throughout.
 */

export type PaymentMethod =
  | 'cash'
  | 'card_terminal'
  | 'ewallet_terminal'
  | 'bank_transfer'
  | 'gateway'
  | 'other'

export type PaymentStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'voided'

export interface SettlementPayment {
  amountMinor: number
  status: PaymentStatus
  /** Total refunded against this payment so far. */
  refundedMinor: number
  method: PaymentMethod
}

/**
 * Cash is physically in the drawer the moment it is handed over. A card or
 * e-wallet terminal has already printed an approval slip. A gateway payment
 * is only real once its webhook says so — which is why it is absent here.
 */
const SELF_CONFIRMING: readonly PaymentMethod[] = [
  'cash',
  'card_terminal',
  'ewallet_terminal',
  'bank_transfer',
  'other',
]

export function isSelfConfirming(method: PaymentMethod): boolean {
  return SELF_CONFIRMING.includes(method)
}

/**
 * Net value of a payment: what was taken, less anything refunded.
 *
 * Only succeeded payments count. A pending gateway payment is a promise, and
 * treating promises as money is how a restaurant serves food it never gets
 * paid for.
 */
export function netOf(payment: SettlementPayment): number {
  if (payment.status !== 'succeeded') return 0
  return payment.amountMinor - payment.refundedMinor
}

export interface SettlementState {
  dueMinor: number
  paidMinor: number
  outstandingMinor: number
  /** Negative outstanding, surfaced separately so it cannot be ignored. */
  overpaidMinor: number
  isSettled: boolean
}

export function calculateSettlement(
  dueMinor: number,
  payments: readonly SettlementPayment[],
): SettlementState {
  const paidMinor = payments.reduce((sum, p) => sum + netOf(p), 0)
  const difference = dueMinor - paidMinor

  return {
    dueMinor,
    paidMinor,
    outstandingMinor: Math.max(0, difference),
    overpaidMinor: Math.max(0, -difference),
    isSettled: difference <= 0,
  }
}

export interface CashTender {
  /** What is actually payable after cash rounding. */
  payableMinor: number
  /** The 5-sen rounding adjustment, shown on the receipt as its own line. */
  roundingAdjustmentMinor: number
  changeMinor: number
}

/**
 * Works out what to charge in cash and what change to give.
 *
 * Malaysia withdrew the 1 and 5 sen coins, so a cash total rounds to the
 * nearest 5 sen while card payments are charged exactly. The adjustment is
 * returned separately because it must appear on the receipt — a total that
 * silently differs from the sum of its parts is noticed at the counter.
 *
 * Rounding applies to the amount being settled in cash, not to the whole
 * bill: in a mixed payment the card leg is charged to the cent and only the
 * cash leg rounds.
 */
export function calculateCashTender(
  outstandingMinor: number,
  tenderedMinor: number,
  roundingIncrementMinor = 5,
): CashTender {
  if (!Number.isInteger(tenderedMinor) || tenderedMinor < 0) {
    throw new ValidationError('Enter a valid amount tendered.', {
      tendered: ['Enter a valid amount tendered.'],
    })
  }

  const { roundedMinor, adjustmentMinor } = roundForCash(
    outstandingMinor,
    roundingIncrementMinor,
  )

  if (tenderedMinor < roundedMinor) {
    throw new ValidationError(
      'The amount tendered is less than the amount due.',
      { tendered: ['The amount tendered is less than the amount due.'] },
    )
  }

  return {
    payableMinor: roundedMinor,
    roundingAdjustmentMinor: adjustmentMinor,
    changeMinor: tenderedMinor - roundedMinor,
  }
}

/**
 * Decides whether a payment may be accepted.
 *
 * The asymmetry is deliberate and matters. Cash may exceed what is owed —
 * that is what change is for. A card, e-wallet or transfer may not: there is
 * no mechanism to hand back the difference, so an over-amount becomes a
 * refund the customer has to chase. Refusing it at the counter, where a
 * cashier can simply retype the figure, is far kinder than discovering it
 * days later.
 */
export function assertPaymentIsAcceptable(
  method: PaymentMethod,
  amountMinor: number,
  settlement: SettlementState,
): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError('Enter an amount greater than zero.', {
      amount: ['Enter an amount greater than zero.'],
    })
  }

  if (settlement.isSettled) {
    throw new ConflictError('This bill has already been settled in full.')
  }

  if (method !== 'cash' && amountMinor > settlement.outstandingMinor) {
    throw new ValidationError(
      `That is more than the ${(settlement.outstandingMinor / 100).toFixed(2)} still owed, and change cannot be given on a card or e-wallet payment.`,
      {
        amount: [
          'Amount exceeds the outstanding balance for a non-cash payment.',
        ],
      },
    )
  }
}

export interface RefundableState {
  paymentAmountMinor: number
  alreadyRefundedMinor: number
  refundableMinor: number
}

export function calculateRefundable(
  payment: SettlementPayment,
): RefundableState {
  const refundable =
    payment.status === 'succeeded'
      ? payment.amountMinor - payment.refundedMinor
      : 0

  return {
    paymentAmountMinor: payment.amountMinor,
    alreadyRefundedMinor: payment.refundedMinor,
    refundableMinor: Math.max(0, refundable),
  }
}

export function assertRefundIsAcceptable(
  payment: SettlementPayment,
  amountMinor: number,
): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError('Enter a refund amount greater than zero.', {
      amount: ['Enter a refund amount greater than zero.'],
    })
  }

  if (payment.status !== 'succeeded') {
    throw new ConflictError(
      'Only a completed payment can be refunded.',
    )
  }

  const { refundableMinor } = calculateRefundable(payment)

  /**
   * Refunding more than was taken would create money. It is also the shape a
   * fraudulent refund takes, which is why this is a hard stop rather than a
   * warning.
   */
  if (amountMinor > refundableMinor) {
    throw new ValidationError(
      `Only ${(refundableMinor / 100).toFixed(2)} of this payment can still be refunded.`,
      { amount: ['Refund exceeds the refundable amount.'] },
    )
  }
}

export interface MethodTotal {
  method: PaymentMethod
  count: number
  grossMinor: number
  refundedMinor: number
  netMinor: number
}

export interface TakingsSummary {
  byMethod: MethodTotal[]
  grossMinor: number
  refundedMinor: number
  netMinor: number
  /** What should physically be in the drawer, cash only. */
  expectedCashMinor: number
}

/**
 * Summarises takings for reconciliation.
 *
 * `expectedCashMinor` is broken out because it is the only figure that can be
 * checked against something physical. Card and e-wallet totals are reconciled
 * against the terminal's own settlement report; cash is reconciled against
 * counting the drawer, and a discrepancy there is the one a manager needs to
 * see the same night.
 */
export function summariseTakings(
  payments: readonly SettlementPayment[],
): TakingsSummary {
  const byMethod = new Map<PaymentMethod, MethodTotal>()

  for (const payment of payments) {
    if (payment.status !== 'succeeded') continue

    const existing = byMethod.get(payment.method) ?? {
      method: payment.method,
      count: 0,
      grossMinor: 0,
      refundedMinor: 0,
      netMinor: 0,
    }

    existing.count += 1
    existing.grossMinor += payment.amountMinor
    existing.refundedMinor += payment.refundedMinor
    existing.netMinor += netOf(payment)

    byMethod.set(payment.method, existing)
  }

  const totals = [...byMethod.values()].sort((a, b) =>
    a.method.localeCompare(b.method),
  )

  return {
    byMethod: totals,
    grossMinor: totals.reduce((sum, t) => sum + t.grossMinor, 0),
    refundedMinor: totals.reduce((sum, t) => sum + t.refundedMinor, 0),
    netMinor: totals.reduce((sum, t) => sum + t.netMinor, 0),
    expectedCashMinor:
      byMethod.get('cash')?.netMinor ?? 0,
  }
}
