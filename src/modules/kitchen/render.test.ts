import { describe, expect, it } from 'vitest'

import {
  centre,
  divider,
  labelledAmount,
  renderKitchenTicket,
  renderReceipt,
  wrapText,
  type ReceiptData,
  type ReceiptTemplateOptions,
} from './render'

describe('wrapText', () => {
  it('keeps short text on one line', () => {
    expect(wrapText('Nasi Lemak', 20)).toEqual(['Nasi Lemak'])
  })

  it('breaks on spaces', () => {
    expect(wrapText('Nasi Lemak with extra sambal', 15)).toEqual([
      'Nasi Lemak with',
      'extra sambal',
    ])
  })

  /**
   * A single over-long word would otherwise run past the edge and be chopped
   * by the printer at an arbitrary point. Breaking it here is at least
   * predictable.
   */
  it('hard-breaks a word longer than the line', () => {
    expect(wrapText('Supercalifragilistic', 8)).toEqual([
      'Supercal',
      'ifragili',
      'stic',
    ])
  })

  it('never exceeds the width', () => {
    const text = 'The quick brown fox jumps over the lazy dog repeatedly'
    for (const width of [8, 12, 20, 42]) {
      for (const line of wrapText(text, width)) {
        expect(line.length).toBeLessThanOrEqual(width)
      }
    }
  })

  it('handles empty input', () => {
    expect(wrapText('   ', 20)).toEqual([''])
  })
})

describe('centre', () => {
  it('centres within the width', () => {
    expect(centre('abc', 9)).toBe('   abc')
  })

  it('truncates rather than overflowing', () => {
    expect(centre('abcdefgh', 4)).toBe('abcd')
  })
})

describe('labelledAmount', () => {
  it('fills the width exactly', () => {
    const line = labelledAmount('Subtotal', '32.00', 30)
    expect(line).toHaveLength(30)
    expect(line.endsWith('32.00')).toBe(true)
    expect(line.startsWith('Subtotal')).toBe(true)
  })

  /**
   * A receipt with a shortened dish name is readable. One with a shortened
   * price is a complaint at the counter.
   */
  it('truncates the label, never the amount', () => {
    const line = labelledAmount(
      'An extremely long menu item name that will not fit',
      '999.00',
      20,
    )

    expect(line).toHaveLength(20)
    expect(line.endsWith('999.00')).toBe(true)
  })

  it('keeps amounts right-aligned across varied labels', () => {
    const lines = [
      labelledAmount('A', '1.00', 24),
      labelledAmount('A much longer label', '123.45', 24),
    ]

    for (const line of lines) expect(line).toHaveLength(24)
  })
})

describe('divider', () => {
  it('fills the width with the given character', () => {
    expect(divider(5)).toBe('-----')
    expect(divider(3, '=')).toBe('===')
  })
})

describe('renderKitchenTicket', () => {
  const ticket = {
    stationName: 'Hot Kitchen',
    destination: 'Table T12',
    orderReference: '#1042',
    placedAt: new Date(2026, 7, 6, 19, 42),
    lines: [
      {
        quantity: 2,
        name: 'Nasi Lemak',
        modifiers: ['Spice: Extra hot'],
        notes: 'no peanuts',
      },
      { quantity: 1, name: 'Teh Tarik', modifiers: [], notes: null },
    ],
  }

  it('leads every line with the quantity', () => {
    const text = renderKitchenTicket(ticket, 32)

    expect(text).toContain('2x Nasi Lemak')
    expect(text).toContain('1x Teh Tarik')
  })

  it('indents modifiers under their item', () => {
    expect(renderKitchenTicket(ticket, 32)).toContain('   - Spice: Extra hot')
  })

  /**
   * A skimmed-past special request is how an allergy becomes an incident.
   * The asterisks exist to be impossible to miss across a hot kitchen.
   */
  it('flags a special request unmissably', () => {
    expect(renderKitchenTicket(ticket, 32)).toContain('** no peanuts **')
  })

  it('shows the station and destination in the header', () => {
    const text = renderKitchenTicket(ticket, 32)

    expect(text).toContain('HOT KITCHEN')
    expect(text).toContain('Table T12')
    expect(text).toContain('19:42')
  })

  it('never exceeds the printer width', () => {
    for (const width of [32, 42]) {
      for (const line of renderKitchenTicket(ticket, width).split('\n')) {
        expect(line.length).toBeLessThanOrEqual(width)
      }
    }
  })

  it('renders an empty ticket without crashing', () => {
    const text = renderKitchenTicket({ ...ticket, lines: [] }, 32)
    expect(text).toContain('HOT KITCHEN')
  })
})

const TEMPLATE: ReceiptTemplateOptions = {
  headerLines: ['12 Jalan Test, Bangsar', '012-3456789'],
  footerLines: ['Thank you, come again'],
  showTaxNumber: true,
  showQrCode: false,
  qrCaption: null,
  charactersPerLine: 42,
}

const RECEIPT: ReceiptData = {
  restaurantName: 'Kopi Corner',
  taxNumber: 'W10-1234-5678',
  destination: 'Table T12',
  orderReference: '#1042',
  issuedAt: new Date(2026, 7, 6, 19, 42),
  currency: 'MYR',
  lines: [
    {
      quantity: 2,
      name: 'Nasi Lemak',
      modifiers: [{ label: 'Extra sambal', amountMinor: 200 }],
      lineTotalMinor: 2800,
    },
  ],
  subtotalMinor: 2800,
  discountMinor: 0,
  serviceChargeMinor: 280,
  taxMinor: 185,
  taxIsIncluded: false,
  roundingAdjustmentMinor: 0,
  totalMinor: 3265,
  payments: [{ label: 'Cash', amountMinor: 3265 }],
  changeMinor: 1735,
}

describe('renderReceipt', () => {
  it('prints the restaurant and header lines', () => {
    const text = renderReceipt(RECEIPT, TEMPLATE)

    expect(text).toContain('Kopi Corner')
    expect(text).toContain('12 Jalan Test, Bangsar')
    expect(text).toContain('Tax Reg: W10-1234-5678')
  })

  it('omits the tax number when the template says not to show it', () => {
    const text = renderReceipt(RECEIPT, { ...TEMPLATE, showTaxNumber: false })
    expect(text).not.toContain('Tax Reg')
  })

  it('prints items with their modifiers and totals', () => {
    const text = renderReceipt(RECEIPT, TEMPLATE)

    expect(text).toContain('2x Nasi Lemak')
    expect(text).toContain('28.00')
    expect(text).toContain('Extra sambal')
  })

  /**
   * A receipt padded with 0.00 lines is harder to check at a glance, and
   * checking it is the entire purpose of the document.
   */
  it('omits lines that carry no information', () => {
    const text = renderReceipt(RECEIPT, TEMPLATE)

    expect(text).not.toContain('Discount')
    expect(text).not.toContain('Rounding')
  })

  it('shows a discount and rounding when they exist', () => {
    const text = renderReceipt(
      {
        ...RECEIPT,
        discountMinor: 320,
        roundingAdjustmentMinor: -2,
      },
      TEMPLATE,
    )

    expect(text).toContain('Discount')
    expect(text).toContain('-3.20')
    expect(text).toContain('Rounding')
  })

  /**
   * "Inclusive of 6% SST" and a separate tax line mean different things to a
   * customer and to an auditor.
   */
  it('states inclusive tax rather than adding a tax line', () => {
    const inclusive = renderReceipt(
      { ...RECEIPT, taxIsIncluded: true },
      TEMPLATE,
    )

    expect(inclusive).toContain('Inclusive of')
    // The separate "Tax" charge line must not appear.
    expect(inclusive.split('\n').some((l) => l.startsWith('Tax '))).toBe(false)
  })

  it('prints payments and change', () => {
    const text = renderReceipt(RECEIPT, TEMPLATE)

    expect(text).toContain('Cash')
    expect(text).toContain('Change')
    expect(text).toContain('17.35')
  })

  it('prints the footer', () => {
    expect(renderReceipt(RECEIPT, TEMPLATE)).toContain('Thank you, come again')
  })

  it('never exceeds the configured width', () => {
    for (const charactersPerLine of [32, 42, 48]) {
      const text = renderReceipt(RECEIPT, { ...TEMPLATE, charactersPerLine })
      for (const line of text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(charactersPerLine)
      }
    }
  })

  it('renders a zero-total comped bill coherently', () => {
    const text = renderReceipt(
      {
        ...RECEIPT,
        discountMinor: 2800,
        serviceChargeMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
        payments: [],
        changeMinor: 0,
      },
      TEMPLATE,
    )

    expect(text).toContain('TOTAL MYR')
    expect(text).toContain('0.00')
  })
})
