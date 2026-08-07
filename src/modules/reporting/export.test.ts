import { describe, expect, it } from 'vitest'

import { neutralise, safeFilename, toCsv } from './csv'
import type { Sheet } from './sheet'
import { moneyCell, percentCell } from './sheet'
import { columnName, crc32, safeSheetName, toXlsx } from './xlsx'

const sheet: Sheet = {
  name: 'Sales',
  columns: ['Day', 'Bills', 'Net sales'],
  rows: [
    ['2026-08-07', 12, 1_166.5],
    ['2026-08-08', 4, 402],
  ],
}

describe('CSV', () => {
  it('writes a header and CRLF rows', () => {
    const csv = toCsv(sheet, { bom: false })

    expect(csv).toBe(
      'Day,Bills,Net sales\r\n' +
        '2026-08-07,12,1166.5\r\n' +
        '2026-08-08,4,402\r\n',
    )
  })

  it('leads with a byte order mark by default', () => {
    // Without it, Excel on Windows reads the file as the system code page and
    // turns every non-ASCII character in a menu into mojibake.
    expect(toCsv(sheet).startsWith('﻿')).toBe(true)
  })

  it('quotes commas, quotes and newlines', () => {
    const csv = toCsv(
      {
        name: 'x',
        columns: ['Item'],
        rows: [['Nasi lemak, extra'], ['He said "yes"'], ['two\nlines']],
      },
      { bom: false },
    )

    expect(csv).toContain('"Nasi lemak, extra"')
    expect(csv).toContain('"He said ""yes"""')
    expect(csv).toContain('"two\nlines"')
  })

  it('writes an empty cell for null', () => {
    const csv = toCsv(
      { name: 'x', columns: ['A', 'B'], rows: [[null, 5]] },
      { bom: false },
    )
    expect(csv).toBe('A,B\r\n,5\r\n')
  })

  it('defuses a cell that a spreadsheet would run as a formula', () => {
    /**
     * CSV injection. A customer name is free text typed by a stranger, and
     * the application never interprets it — the spreadsheet on the finance
     * manager's machine does.
     */
    expect(neutralise('=cmd|\'/c calc\'!A1')).toBe("'=cmd|'/c calc'!A1")
    expect(neutralise('+1-555-0100')).toBe("'+1-555-0100")
    expect(neutralise('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)")
    expect(neutralise('\tTabbed')).toBe("'\tTabbed")
  })

  it('leaves an ordinary name alone', () => {
    expect(neutralise('Ana Rahman')).toBe('Ana Rahman')
    expect(neutralise('Nasi Lemak')).toBe('Nasi Lemak')
  })

  it('leaves a negative number summable', () => {
    /**
     * A leading `-` is on the dangerous list, but prefixing every negative
     * figure would fill a refunds column with text — trading a real injection
     * risk for a spreadsheet that silently totals zero.
     */
    expect(neutralise('-250.50')).toBe('-250.50')
    expect(neutralise('-250.50+cmd')).toBe("'-250.50+cmd")
  })

  it('builds a filename that survives a download header', () => {
    expect(safeFilename('Sales 2026-08-01 to 2026-08-07', 'csv')).toBe(
      'Sales-2026-08-01-to-2026-08-07.csv',
    )
    expect(safeFilename('../../etc/passwd', 'csv')).toBe('etc-passwd.csv')
    expect(safeFilename('   ', 'csv')).toBe('report.csv')
  })
})

describe('cell conversion', () => {
  it('sends money out as a decimal number, not minor units', () => {
    // A column of 1166 meaning RM 11.66 is a column somebody will sum,
    // believe, and put in a board pack.
    expect(moneyCell(1_166)).toBe(11.66)
    expect(moneyCell(-500)).toBe(-5)
    expect(moneyCell(0)).toBe(0)
  })

  it('sends a margin out as a percentage, and no margin as nothing', () => {
    expect(percentCell(7_000)).toBe(70)
    expect(percentCell(null)).toBeNull()
  })
})

// --- reading a ZIP back, so the writer is actually checked ---

interface ParsedEntry {
  path: string
  crc: number
  text: string
}

/**
 * A deliberately independent reader.
 *
 * It walks the central directory rather than the local headers, so it checks
 * the half of the archive that a naive writer gets wrong — offsets, sizes and
 * the entry count — and it verifies each CRC against the bytes it extracted.
 * Asserting on the writer's own output shape would prove nothing.
 */
function readZip(bytes: Uint8Array): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()

  let end = bytes.length - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error('No end-of-central-directory record.')

  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const entries: ParsedEntry[] = []

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error(`Bad central header at ${at}`)
    }

    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Bad local header for ${path}`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataAt = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.subarray(dataAt, dataAt + size)

    if (crc32(data) !== crc) {
      throw new Error(`CRC mismatch for ${path}`)
    }

    entries.push({ path, crc, text: decoder.decode(data) })
    at += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

describe('XLSX', () => {
  it('computes the CRC-32 the ZIP format expects', () => {
    // The published check value for "123456789" under CRC-32/ISO-HDLC.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('produces an archive whose central directory can be walked', () => {
    const entries = readZip(toXlsx([sheet]))

    expect(entries.map((e) => e.path)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ])
  })

  it('starts with the local file header signature', () => {
    const bytes = toXlsx([sheet])
    // "PK\x03\x04" — what every unzip tool looks for first.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('writes numbers as numbers and text as inline strings', () => {
    const entries = readZip(toXlsx([sheet]))
    const worksheet = entries.find(
      (e) => e.path === 'xl/worksheets/sheet1.xml',
    )!

    // A number in a `<v>` can be summed by a totals row. The same value as an
    // inline string cannot, and that is the whole reason not to ship a CSV
    // renamed .xls.
    expect(worksheet.text).toContain('<c r="B2"><v>12</v></c>')
    expect(worksheet.text).toContain('<c r="C2"><v>1166.5</v></c>')
    expect(worksheet.text).toContain(
      '<c r="A1" t="inlineStr"><is><t xml:space="preserve">Day</t></is></c>',
    )
  })

  it('cannot express a formula, so injection has nowhere to land', () => {
    const entries = readZip(
      toXlsx([
        {
          name: 'Customers',
          columns: ['Name'],
          rows: [['=cmd|\'/c calc\'!A1']],
        },
      ]),
    )
    const worksheet = entries.find((e) =>
      e.path.startsWith('xl/worksheets/'),
    )!

    // The value survives intact for whoever reads the report, and is inert:
    // a cell is a formula only when it carries an `<f>` element.
    expect(worksheet.text).toContain('=cmd|')
    expect(worksheet.text).not.toContain('<f>')
  })

  it('escapes XML and drops characters that would make the file unopenable', () => {
    /**
     * Built from char codes rather than written as literals: a control
     * character pasted into source is invisible in review and silently
     * mangled by half the tools that touch the file.
     */
    const nul = String.fromCharCode(0)
    const bell = String.fromCharCode(7)

    const entries = readZip(
      toXlsx([
        {
          name: 'Notes',
          columns: ['Note'],
          rows: [[`Fish & <chips>${bell}${nul} "rare"`]],
        },
      ]),
    )
    const worksheet = entries.find((e) =>
      e.path.startsWith('xl/worksheets/'),
    )!

    expect(worksheet.text).toContain('Fish &amp; &lt;chips&gt;')
    expect(worksheet.text).toContain('&quot;rare&quot;')
    // One of these in an order note makes the entire workbook unopenable,
    // and Excel reports it without naming a location.
    expect(worksheet.text).not.toContain(nul)
    expect(worksheet.text).not.toContain(bell)
  })

  it('keeps a newline, which is legal XML and appears in real order notes', () => {
    const entries = readZip(
      toXlsx([{ name: 'N', columns: ['Note'], rows: [['one\ntwo']] }]),
    )
    expect(entries.some((entry) => entry.text.includes('one\ntwo'))).toBe(true)
  })

  it('writes one worksheet per sheet and names every tab', () => {
    const entries = readZip(
      toXlsx([
        { name: 'Sales', columns: ['A'], rows: [] },
        { name: 'Tax', columns: ['A'], rows: [] },
      ]),
    )

    expect(
      entries.filter((e) => e.path.startsWith('xl/worksheets/')),
    ).toHaveLength(2)

    const workbook = entries.find((e) => e.path === 'xl/workbook.xml')!
    expect(workbook.text).toContain('name="Sales"')
    expect(workbook.text).toContain('name="Tax"')
  })

  it('renames a duplicate tab rather than producing a workbook Excel refuses', () => {
    const entries = readZip(
      toXlsx([
        { name: 'August', columns: ['A'], rows: [] },
        { name: 'August', columns: ['A'], rows: [] },
      ]),
    )
    const workbook = entries.find((e) => e.path === 'xl/workbook.xml')!

    expect(workbook.text).toContain('name="August"')
    expect(workbook.text).toContain('name="August 2"')
  })

  it('strips characters Excel refuses in a tab name', () => {
    expect(safeSheetName('Sales/Tax [2026]')).toBe('Sales Tax  2026')
    expect(safeSheetName('')).toBe('Sheet1')
    expect(safeSheetName('x'.repeat(50))).toHaveLength(31)
  })

  it('names columns in bijective base 26', () => {
    expect(columnName(0)).toBe('A')
    expect(columnName(25)).toBe('Z')
    // Not 'BA'. Spreadsheet columns have no zero digit, which is the part
    // every naive implementation gets wrong.
    expect(columnName(26)).toBe('AA')
    expect(columnName(51)).toBe('AZ')
    expect(columnName(52)).toBe('BA')
  })

  it('refuses to build a workbook with no sheets', () => {
    expect(() => toXlsx([])).toThrow(/at least one sheet/i)
  })

  it('is byte-identical across two runs', () => {
    // No timestamps anywhere, which is what makes the assertions above
    // meaningful rather than a snapshot of whenever they last ran.
    expect(toXlsx([sheet])).toEqual(toXlsx([sheet]))
  })
})
