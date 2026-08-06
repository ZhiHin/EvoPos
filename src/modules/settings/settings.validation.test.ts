import { describe, expect, it } from 'vitest'

import {
  basisPointsToPercent,
  percentToBasisPoints,
  updateSettingsSchema,
} from './settings.validation'

describe('percent / basis point conversion', () => {
  it('converts whole percentages', () => {
    expect(percentToBasisPoints(6)).toBe(600)
    expect(percentToBasisPoints(10)).toBe(1000)
    expect(percentToBasisPoints(0)).toBe(0)
  })

  it('converts fractional percentages exactly', () => {
    // 8.25% is a real rate. It must not land on 824 or 826.
    expect(percentToBasisPoints(8.25)).toBe(825)
    expect(percentToBasisPoints(0.5)).toBe(50)
  })

  it('round-trips', () => {
    for (const percent of [0, 0.5, 6, 8.25, 10, 100]) {
      expect(basisPointsToPercent(percentToBasisPoints(percent))).toBe(percent)
    }
  })

  it('rounds rather than truncating', () => {
    // 6.005% cannot be represented exactly; rounding loses less than
    // truncating, and consistently.
    expect(percentToBasisPoints(6.005)).toBe(601)
  })
})

const VALID = {
  name: 'Kopi Corner',
  currency: 'myr',
  timezone: 'Asia/Kuala_Lumpur',
  locale: 'en',
  taxRatePercent: 6,
  serviceChargePercent: 10,
  taxInclusive: true,
}

describe('updateSettingsSchema', () => {
  it('uppercases the currency and converts the rates', () => {
    const result = updateSettingsSchema.parse(VALID)

    expect(result.currency).toBe('MYR')
    expect(result.taxRatePercent).toBe(600)
    expect(result.serviceChargePercent).toBe(1000)
  })

  it('rejects a malformed currency code', () => {
    expect(
      updateSettingsSchema.safeParse({ ...VALID, currency: 'RINGGIT' }).success,
    ).toBe(false)
  })

  it('rejects a rate above 100%', () => {
    // Guards the commonest typo: entering 600 while thinking in basis points.
    expect(
      updateSettingsSchema.safeParse({ ...VALID, taxRatePercent: 600 }).success,
    ).toBe(false)
  })

  it('rejects a negative rate', () => {
    expect(
      updateSettingsSchema.safeParse({ ...VALID, taxRatePercent: -1 }).success,
    ).toBe(false)
  })

  it('accepts zero for both rates', () => {
    expect(
      updateSettingsSchema.safeParse({
        ...VALID,
        taxRatePercent: 0,
        serviceChargePercent: 0,
      }).success,
    ).toBe(true)
  })
})
