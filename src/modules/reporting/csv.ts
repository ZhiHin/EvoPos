import type { CellValue, Sheet } from './sheet'

/**
 * CSV export.
 *
 * RFC 4180 quoting, CRLF line endings, and one security measure that is not
 * cosmetic — see `neutralise` below.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * A customer called `=cmd|'/c calc'!A1` is a valid name to type into a
 * booking form. Exported to CSV and opened in Excel, it is a command the
 * finance manager's machine runs. This is CSV injection, and the export is
 * exactly where it lands, because the app itself never interprets the value.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * A leading `-` is only dangerous when it is not a number.
 *
 * Prefixing every negative figure would fill a refunds column with text that
 * cannot be summed — trading a real injection risk for a spreadsheet that
 * silently reports zero. Numeric cells are emitted as numbers and never reach
 * this function; a string that happens to parse as a number is left alone.
 */
function looksNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value)
}

export function neutralise(value: string): string {
  if (!FORMULA_LEAD.test(value)) return value
  if (looksNumeric(value)) return value
  /**
   * A leading apostrophe is the documented mitigation: Excel and Sheets both
   * read it as "the rest of this cell is text". It is visible in the cell,
   * which is the trade — a slightly odd-looking name beats a spreadsheet that
   * executes it.
   */
  return `'${value}`
}

function escapeCell(value: CellValue): string {
  if (value === null) return ''
  if (typeof value === 'number') {
    // Not `toLocaleString`: a thousands separator makes the file unparseable
    // in any locale that uses a comma for it.
    return Number.isFinite(value) ? String(value) : ''
  }

  const safe = neutralise(value)
  // Quote anything containing a delimiter, a quote or a newline. Doubling the
  // quote is how RFC 4180 escapes one.
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export function toCsv(sheet: Sheet, { bom = true } = {}): string {
  const lines = [
    sheet.columns.map(escapeCell).join(','),
    ...sheet.rows.map((row) => row.map(escapeCell).join(',')),
  ]

  /**
   * A UTF-8 byte order mark, because Excel on Windows otherwise reads a CSV
   * as the system code page and turns every non-ASCII character into mojibake
   * — which for a menu of local dish names is most of the file.
   */
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n'
}

/**
 * A filename that survives Content-Disposition and every filesystem.
 *
 * The report name reaches this from a range and a report key, neither of
 * which a user types — but a header assembled from application data is
 * exactly the assumption that stops holding the day someone adds a
 * customer-named export. Separators are collapsed, and leading dots go with
 * them: `.bashrc` is a hidden file on one platform and a puzzle on the rest.
 */
export function safeFilename(base: string, extension: string): string {
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)

  return `${cleaned || 'report'}.${extension}`
}
