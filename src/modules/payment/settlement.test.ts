import { describe, expect, it } from 'vitest'

import { ConflictError, ValidationError } from '@/lib/errors'
import {
  assertPaymentIsAcceptable,
  assertRefundIsAcceptable,
  calculateCashTender,
  calculateRefundable,
  calculateSettlement,
  isSelfConfirming,
  netOf,
  summariseTakings,
  type PaymentMethod,
  type SettlementPayment,
} from './settlement'

function payment(
  amountMinor: number,
  overrides: Partial<SettlementPayment> = {},
): SettlementPayment {
  return {
    amountMinor,
    status: 'succeeded',
    refundedMinor: 0,
    method: 'cash',
    ...overrides,
  }
}

describe('netOf', () => {
  it('counts a succeeded payment', () => {
    expect(netOf(payment(1000))).toBe(1000)
  })

  it('subtracts refunds', () => {
    expect(netOf(payment(1000, { refundedMinor: 400 }))).toBe(600)
  })

  /**
   * A pending gateway payment is a promise, not money. Counting promises is
   * how a restaurant serves food it never gets paid for.
   */
  it('ignores anything not succeeded', () => {
    for (const status of ['pending', 'failed', 'voided'] as const) {
      expect(netOf(payment(1000, { status }))).toBe(0)
    }
  })
})

describe('calculateSettlement', () => {
  it('reports what is still owed', () => {
    const state = calculateSettlement(5000, [payment(2000)])

    expect(state.paidMinor).toBe(2000)
    expect(state.outstandingMinor).toBe(3000)
    expect(state.isSettled).toBe(false)
  })

  it('marks a bill settled when fully paid', () => {
    const state = calculateSettlement(5000, [payment(5000)])

    expect(state.outstandingMinor).toBe(0)
    expect(state.isSettled).toBe(true)
  })

  it('handles mixed payment across several methods', () => {
    const state = calculateSettlement(5000, [
      payment(2000, { method: 'cash' }),
      payment(3000, { method: 'card_terminal' }),
    ])

    expect(state.isSettled).toBe(true)
    expect(state.outstandingMinor).toBe(0)
  })

  it('surfaces overpayment rather than hiding it in a negative', () => {
    const state = calculateSettlement(1000, [payment(1500)])

    expect(state.outstandingMinor).toBe(0)
    expect(state.overpaidMinor).toBe(500)
  })

  it('treats a refunded payment as reducing what was paid', () => {
    const state = calculateSettlement(5000, [
      payment(5000, { refundedMinor: 2000 }),
    ])

    expect(state.paidMinor).toBe(3000)
    expect(state.outstandingMinor).toBe(2000)
    expect(state.isSettled).toBe(false)
  })

  it('settles a zero bill with no payments', () => {
    expect(calculateSettlement(0, []).isSettled).toBe(true)
  })
})

describe('calculateCashTender', () => {
  it('rounds the amount due to the nearest 5 sen', () => {
    // 10.02 rounds down to 10.00, so a 20.00 note gives 10.00 change.
    const tender = calculateCashTender(1002, 2000)

    expect(tender.payableMinor).toBe(1000)
    expect(tender.roundingAdjustmentMinor).toBe(-2)
    expect(tender.changeMinor).toBe(1000)
  })

  it('rounds up when nearer the higher increment', () => {
    const tender = calculateCashTender(1003, 2000)

    expect(tender.payableMinor).toBe(1005)
    expect(tender.roundingAdjustmentMinor).toBe(2)
  })

  it('gives no change on an exact tender', () => {
    expect(calculateCashTender(1000, 1000).changeMinor).toBe(0)
  })

  it('accepts a tender that only covers the rounded-down amount', () => {
    // Owed 10.02, rounds to 10.00 — a 10.00 note is enough.
    expect(() => calculateCashTender(1002, 1000)).not.toThrow()
  })

  it('refuses a tender below the amount due', () => {
    expect(() => calculateCashTender(1000, 900)).toThrow(ValidationError)
  })

  it('refuses a negative or fractional tender', () => {
    expect(() => calculateCashTender(1000, -1)).toThrow(ValidationError)
    expect(() => calculateCashTender(1000, 10.5)).toThrow(ValidationError)
  })

  it('can be told not to round at all', () => {
    const tender = calculateCashTender(1003, 2000, 1)

    expect(tender.payableMinor).toBe(1003)
    expect(tender.roundingAdjustmentMinor).toBe(0)
    expect(tender.changeMinor).toBe(997)
  })
})

describe('assertPaymentIsAcceptable', () => {
  const outstanding = calculateSettlement(5000, [])

  it('accepts a payment within the balance', () => {
    expect(() =>
      assertPaymentIsAcceptable('card_terminal', 5000, outstanding),
    ).not.toThrow()
  })

  /**
   * The asymmetry that matters. Cash may exceed what is owed — that is what
   * change is for. A card cannot: there is no way to hand back the
   * difference, so an over-amount becomes a refund the customer has to chase.
   */
  it('allows cash to exceed the balance', () => {
    expect(() =>
      assertPaymentIsAcceptable('cash', 10_000, outstanding),
    ).not.toThrow()
  })

  it('refuses a card payment above the balance', () => {
    expect(() =>
      assertPaymentIsAcceptable('card_terminal', 5001, outstanding),
    ).toThrow(ValidationError)
  })

  it('refuses any payment on a settled bill', () => {
    const settled = calculateSettlement(5000, [payment(5000)])

    expect(() => assertPaymentIsAcceptable('cash', 100, settled)).toThrow(
      ConflictError,
    )
  })

  it('refuses zero, negative and fractional amounts', () => {
    for (const amount of [0, -100, 10.5]) {
      expect(() =>
        assertPaymentIsAcceptable('cash', amount, outstanding),
      ).toThrow(ValidationError)
    }
  })
})

describe('refunds', () => {
  it('reports what is still refundable', () => {
    const state = calculateRefundable(payment(1000, { refundedMinor: 300 }))
    expect(state.refundableMinor).toBe(700)
  })

  it('reports nothing refundable on a voided payment', () => {
    expect(calculateRefundable(payment(1000, { status: 'voided' })).refundableMinor).toBe(0)
  })

  it('accepts a partial refund', () => {
    expect(() =>
      assertRefundIsAcceptable(payment(1000), 400),
    ).not.toThrow()
  })

  /**
   * Refunding more than was taken creates money out of nothing, and is also
   * exactly the shape a fraudulent refund takes. Hard stop.
   */
  it('refuses a refund larger than the payment', () => {
    expect(() => assertRefundIsAcceptable(payment(1000), 1001)).toThrow(
      ValidationError,
    )
  })

  it('refuses a refund that would exceed what remains', () => {
    expect(() =>
      assertRefundIsAcceptable(payment(1000, { refundedMinor: 800 }), 300),
    ).toThrow(ValidationError)
  })

  it('refuses to refund a payment that never succeeded', () => {
    expect(() =>
      assertRefundIsAcceptable(payment(1000, { status: 'pending' }), 100),
    ).toThrow(ConflictError)
  })
})

describe('isSelfConfirming', () => {
  it('treats offline methods as confirmed when recorded', () => {
    for (const method of [
      'cash',
      'card_terminal',
      'ewallet_terminal',
    ] as PaymentMethod[]) {
      expect(isSelfConfirming(method)).toBe(true)
    }
  })

  /**
   * A gateway payment is only real once its webhook says so. If this ever
   * returns true, an online payment would be recorded as succeeded on the
   * customer's word alone.
   */
  it('does not treat a gateway payment as confirmed', () => {
    expect(isSelfConfirming('gateway')).toBe(false)
  })
})

describe('summariseTakings', () => {
  const payments: SettlementPayment[] = [
    payment(5000, { method: 'cash' }),
    payment(2000, { method: 'cash', refundedMinor: 500 }),
    payment(8000, { method: 'card_terminal' }),
    payment(1000, { method: 'ewallet_terminal', status: 'voided' }),
    payment(3000, { method: 'gateway', status: 'pending' }),
  ]

  it('groups by method and nets off refunds', () => {
    const summary = summariseTakings(payments)
    const cash = summary.byMethod.find((m) => m.method === 'cash')!

    expect(cash.count).toBe(2)
    expect(cash.grossMinor).toBe(7000)
    expect(cash.refundedMinor).toBe(500)
    expect(cash.netMinor).toBe(6500)
  })

  it('excludes voided and pending payments entirely', () => {
    const summary = summariseTakings(payments)

    expect(summary.byMethod.map((m) => m.method)).toEqual([
      'card_terminal',
      'cash',
    ])
  })

  it('reports the expected cash drawer separately', () => {
    // The only figure that can be checked against something physical.
    expect(summariseTakings(payments).expectedCashMinor).toBe(6500)
  })

  it('totals net across every method', () => {
    expect(summariseTakings(payments).netMinor).toBe(6500 + 8000)
  })

  it('handles a day with no takings', () => {
    const summary = summariseTakings([])

    expect(summary.netMinor).toBe(0)
    expect(summary.expectedCashMinor).toBe(0)
    expect(summary.byMethod).toEqual([])
  })
})
