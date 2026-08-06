/**
 * Ticket and receipt rendering.
 *
 * Produces the plain text that a thermal printer prints, and that the
 * on-screen preview shows. Pure, so the exact bytes a customer will be handed
 * can be asserted in a test rather than discovered on paper.
 *
 * These printers are fixed-width character devices — 32 or 42 columns are the
 * common sizes — so every helper here is about fitting content into a known
 * number of columns without it wrapping unpredictably at the device.
 */

export const DEFAULT_WIDTH = 42

/** Splits text to fit a width, breaking on spaces where possible. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text]

  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']

  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (current.length === 0) {
      current = word
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }

    /**
     * A single word longer than the line — a very long dish name, a URL —
     * would otherwise sit past the edge and be chopped by the printer at an
     * arbitrary point. Breaking it here at least does so predictably.
     */
    while (current.length > width) {
      lines.push(current.slice(0, width))
      current = current.slice(width)
    }
  }

  if (current.length > 0) lines.push(current)
  return lines
}

export function centre(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  const left = Math.floor((width - text.length) / 2)
  return ' '.repeat(left) + text
}

export function divider(width: number, char = '-'): string {
  return char.repeat(width)
}

/**
 * A label on the left and an amount on the right, filling the width.
 *
 * When the two cannot both fit, the label is truncated rather than the
 * amount. A receipt with a shortened dish name is readable; one with a
 * shortened price is a complaint.
 */
export function labelledAmount(
  label: string,
  amount: string,
  width: number,
): string {
  const available = width - amount.length - 1

  if (available <= 0) return amount.slice(0, width)

  const trimmed =
    label.length > available ? label.slice(0, available) : label

  return trimmed + ' '.repeat(width - trimmed.length - amount.length) + amount
}

export interface TicketLine {
  quantity: number
  name: string
  /** "Size: Large", "No peanuts" — rendered indented under the item. */
  modifiers: string[]
  notes: string | null
}

export interface KitchenTicket {
  stationName: string
  /** Table code, or the customer name for takeaway. */
  destination: string
  orderReference: string
  placedAt: Date
  lines: TicketLine[]
}

/**
 * Renders a kitchen ticket.
 *
 * Optimised for being read at a glance across a hot, noisy kitchen: the
 * quantity leads every line, modifiers are indented beneath, and a special
 * request is wrapped in asterisks because missing one is how allergies become
 * incidents.
 */
export function renderKitchenTicket(
  ticket: KitchenTicket,
  width = DEFAULT_WIDTH,
): string {
  const out: string[] = []

  out.push(divider(width, '='))
  out.push(centre(ticket.stationName.toUpperCase(), width))
  out.push(centre(ticket.destination, width))
  out.push(
    centre(
      `${ticket.orderReference}  ${formatClock(ticket.placedAt)}`,
      width,
    ),
  )
  out.push(divider(width, '='))

  for (const line of ticket.lines) {
    for (const [index, text] of wrapText(line.name, width - 4).entries()) {
      out.push(index === 0 ? `${line.quantity}x ${text}` : `   ${text}`)
    }

    for (const modifier of line.modifiers) {
      for (const text of wrapText(modifier, width - 5)) {
        out.push(`   - ${text}`)
      }
    }

    if (line.notes) {
      // Asterisks so a special request cannot be skimmed past.
      for (const text of wrapText(line.notes, width - 8)) {
        out.push(`   ** ${text} **`)
      }
    }
  }

  out.push(divider(width, '='))
  return out.join('\n')
}

export interface ReceiptTemplateOptions {
  headerLines: string[]
  footerLines: string[]
  showTaxNumber: boolean
  showQrCode: boolean
  qrCaption: string | null
  charactersPerLine: number
}

export interface ReceiptLine {
  quantity: number
  name: string
  modifiers: { label: string; amountMinor: number }[]
  lineTotalMinor: number
}

export interface ReceiptPayment {
  label: string
  amountMinor: number
}

export interface ReceiptData {
  restaurantName: string
  taxNumber: string | null
  destination: string
  orderReference: string
  issuedAt: Date
  currency: string
  lines: ReceiptLine[]
  subtotalMinor: number
  discountMinor: number
  serviceChargeMinor: number
  taxMinor: number
  taxIsIncluded: boolean
  roundingAdjustmentMinor: number
  totalMinor: number
  payments: ReceiptPayment[]
  changeMinor: number
}

/** Formats minor units as a bare decimal — no symbol, so columns align. */
function amount(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatStamp(date: Date): string {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} ${formatClock(date)}`
}

/**
 * Renders a customer receipt.
 *
 * Only lines that carry information appear: a zero discount, an absent
 * service charge and a rounding adjustment of nothing are all omitted rather
 * than printed as 0.00. A receipt padded with zeroes is harder to check at a
 * glance, and the whole point of the document is that a customer can check
 * it.
 */
export function renderReceipt(
  data: ReceiptData,
  template: ReceiptTemplateOptions,
): string {
  const width = template.charactersPerLine
  const out: string[] = []

  out.push(centre(data.restaurantName, width))

  for (const line of template.headerLines) {
    for (const text of wrapText(line, width)) out.push(centre(text, width))
  }

  if (template.showTaxNumber && data.taxNumber) {
    out.push(centre(`Tax Reg: ${data.taxNumber}`, width))
  }

  out.push(divider(width))
  out.push(labelledAmount(data.destination, formatStamp(data.issuedAt), width))
  out.push(labelledAmount('Order', data.orderReference, width))
  out.push(divider(width))

  for (const line of data.lines) {
    out.push(
      labelledAmount(
        `${line.quantity}x ${line.name}`,
        amount(line.lineTotalMinor),
        width,
      ),
    )

    for (const modifier of line.modifiers) {
      out.push(
        labelledAmount(
          `   ${modifier.label}`,
          modifier.amountMinor === 0 ? '' : amount(modifier.amountMinor),
          width,
        ),
      )
    }
  }

  out.push(divider(width))
  out.push(labelledAmount('Subtotal', amount(data.subtotalMinor), width))

  if (data.discountMinor > 0) {
    out.push(labelledAmount('Discount', `-${amount(data.discountMinor)}`, width))
  }

  if (data.serviceChargeMinor > 0) {
    out.push(
      labelledAmount('Service charge', amount(data.serviceChargeMinor), width),
    )
  }

  if (data.taxMinor > 0 && !data.taxIsIncluded) {
    out.push(labelledAmount('Tax', amount(data.taxMinor), width))
  }

  if (data.roundingAdjustmentMinor !== 0) {
    out.push(
      labelledAmount(
        'Rounding',
        amount(data.roundingAdjustmentMinor),
        width,
      ),
    )
  }

  out.push(divider(width))
  out.push(
    labelledAmount(
      `TOTAL ${data.currency}`,
      amount(data.totalMinor),
      width,
    ),
  )

  /**
   * Inclusive tax is stated, not added. "Inclusive of 6% SST" and a separate
   * tax line mean different things to a customer and to an auditor.
   */
  if (data.taxMinor > 0 && data.taxIsIncluded) {
    out.push(centre(`Inclusive of ${amount(data.taxMinor)} tax`, width))
  }

  if (data.payments.length > 0) {
    out.push(divider(width))
    for (const payment of data.payments) {
      out.push(labelledAmount(payment.label, amount(payment.amountMinor), width))
    }
    if (data.changeMinor > 0) {
      out.push(labelledAmount('Change', amount(data.changeMinor), width))
    }
  }

  if (template.footerLines.length > 0 || template.showQrCode) {
    out.push(divider(width))
  }

  for (const line of template.footerLines) {
    for (const text of wrapText(line, width)) out.push(centre(text, width))
  }

  if (template.showQrCode && template.qrCaption) {
    out.push(centre(template.qrCaption, width))
  }

  return out.join('\n')
}
