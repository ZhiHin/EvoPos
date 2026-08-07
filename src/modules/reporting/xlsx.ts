import type { CellValue, Sheet } from './sheet'

/**
 * A minimal, dependency-free .xlsx writer.
 *
 * An .xlsx file is a ZIP archive of XML parts. Writing one directly is a
 * couple of hundred lines; the alternative is a dependency whose own
 * transitive tree is larger than this application's, pulled in to produce four
 * small XML documents.
 *
 * The other option — renaming a CSV to `.xls` — is what a great many systems
 * actually ship. It works only because Excel guesses, it warns the user the
 * file is corrupt, and it loses every number as text. It is not an Excel
 * export; it is a CSV wearing a hat.
 *
 * Entries are stored uncompressed. Deflate would mean writing an encoder for
 * files measured in tens of kilobytes, and a stored ZIP is a valid ZIP.
 *
 * Numbers are written as numeric cells, so a totals row can sum them. Text is
 * written as an inline string, which is also why this format cannot carry a
 * formula injection: a cell is a formula only when it contains an explicit
 * `<f>` element, and this writer never emits one.
 */

// --- XML ---

const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13
const SPACE = 32

/**
 * XML 1.0 permits only tab, newline, carriage return and #x20 upward.
 *
 * A stray control character in an order note makes the whole workbook
 * unopenable — Excel reports "unreadable content" and names no location, so
 * the one bad note is unfindable without the source data.
 *
 * Written as a code-point filter rather than a regular expression: a class of
 * literal control characters in source is invisible in a diff and easy to
 * corrupt with an editor that trims them.
 */
function stripIllegalXml(value: string): string {
  let output = ''

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (
      code === TAB ||
      code === LINE_FEED ||
      code === CARRIAGE_RETURN ||
      code >= SPACE
    ) {
      output += character
    }
  }

  return output
}

function escapeXml(value: string): string {
  return stripIllegalXml(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships'

/** 0 -> A, 25 -> Z, 26 -> AA. Spreadsheet columns are bijective base 26. */
export function columnName(index: number): string {
  let name = ''
  let remaining = index

  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name
    remaining = Math.floor(remaining / 26) - 1
  } while (remaining >= 0)

  return name
}

/**
 * Excel refuses these characters in a tab name outright, and a workbook that
 * will not open is a worse outcome than a tab named slightly differently from
 * the report inside it.
 */
export function safeSheetName(name: string): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31)
  return cleaned || 'Sheet1'
}

function cellXml(value: CellValue, reference: string): string {
  if (value === null || value === '') return ''

  if (typeof value === 'number') {
    // A non-finite number has no XML representation. An empty cell is a
    // truthful "no answer"; NaN in a spreadsheet is not.
    if (!Number.isFinite(value)) return ''
    return `<c r="${reference}"><v>${value}</v></c>`
  }

  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

function rowXml(cells: readonly CellValue[], rowNumber: number): string {
  const body = cells
    .map((cell, index) => cellXml(cell, `${columnName(index)}${rowNumber}`))
    .join('')

  return `<row r="${rowNumber}">${body}</row>`
}

function sheetXml(sheet: Sheet): string {
  const rows = [
    rowXml(sheet.columns, 1),
    ...sheet.rows.map((row, index) => rowXml(row, index + 2)),
  ].join('')

  return `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}"><sheetData>${rows}</sheetData></worksheet>`
}

/**
 * The smallest style sheet Excel accepts.
 *
 * Two fills, and the first two must be `none` then `gray125`. It reads like
 * boilerplate and is load-bearing: Excel rejects the workbook without them.
 */
const STYLES_XML = `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`

// --- ZIP ---

/** The reversed CRC-32 polynomial, as every ZIP implementation uses it. */
const CRC32_POLYNOMIAL = 0xedb88320

let crcTable: Uint32Array | null = null

function crc32TableOnce(): Uint32Array {
  if (crcTable) return crcTable

  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? CRC32_POLYNOMIAL ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }

  crcTable = table
  return table
}

export function crc32(bytes: Uint8Array): number {
  const table = crc32TableOnce()
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  path: string
  size: number
  crc: number
  offset: number
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = []
  private size = 0

  get length(): number {
    return this.size
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.size += bytes.length
  }

  uint16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]))
  }

  uint32(value: number): void {
    this.push(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    )
  }

  toUint8Array(): Uint8Array {
    const output = new Uint8Array(this.size)
    let at = 0
    for (const chunk of this.chunks) {
      output.set(chunk, at)
      at += chunk.length
    }
    return output
  }
}

/**
 * A fixed 1980-01-01 timestamp on every entry.
 *
 * ZIP stores modification times in DOS format and nothing here reads them.
 * Fixing them makes the same report export to byte-identical output twice,
 * which is what lets a test assert on the archive at all — and `Date.now()`
 * inside a pure function is a purity violation looking for somewhere to
 * happen.
 */
const DOS_TIME = 0
const DOS_DATE = 0x0021

/** Bit 11: the filename is UTF-8 rather than the DOS code page. */
const FLAG_UTF8 = 0x0800
const METHOD_STORED = 0
const VERSION_NEEDED = 20

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_SIGNATURE = 0x06054b50

function buildZip(files: readonly { path: string; text: string }[]): Uint8Array {
  const encoder = new TextEncoder()
  const local = new ByteWriter()
  const entries: ZipEntry[] = []

  for (const file of files) {
    const bytes = encoder.encode(file.text)
    const name = encoder.encode(file.path)
    const crc = crc32(bytes)
    const offset = local.length

    local.uint32(LOCAL_HEADER_SIGNATURE)
    local.uint16(VERSION_NEEDED)
    local.uint16(FLAG_UTF8)
    local.uint16(METHOD_STORED)
    local.uint16(DOS_TIME)
    local.uint16(DOS_DATE)
    local.uint32(crc)
    // Stored, so compressed and uncompressed sizes are the same number.
    local.uint32(bytes.length)
    local.uint32(bytes.length)
    local.uint16(name.length)
    local.uint16(0)
    local.push(name)
    local.push(bytes)

    entries.push({ path: file.path, size: bytes.length, crc, offset })
  }

  const central = new ByteWriter()
  for (const entry of entries) {
    const name = encoder.encode(entry.path)

    central.uint32(CENTRAL_HEADER_SIGNATURE)
    central.uint16(VERSION_NEEDED)
    central.uint16(VERSION_NEEDED)
    central.uint16(FLAG_UTF8)
    central.uint16(METHOD_STORED)
    central.uint16(DOS_TIME)
    central.uint16(DOS_DATE)
    central.uint32(entry.crc)
    central.uint32(entry.size)
    central.uint32(entry.size)
    central.uint16(name.length)
    central.uint16(0)
    central.uint16(0)
    central.uint16(0)
    central.uint16(0)
    central.uint32(0)
    central.uint32(entry.offset)
    central.push(name)
  }

  const end = new ByteWriter()
  end.uint32(END_OF_CENTRAL_SIGNATURE)
  end.uint16(0)
  end.uint16(0)
  end.uint16(entries.length)
  end.uint16(entries.length)
  end.uint32(central.length)
  end.uint32(local.length)
  end.uint16(0)

  const output = new ByteWriter()
  output.push(local.toUint8Array())
  output.push(central.toUint8Array())
  output.push(end.toUint8Array())
  return output.toUint8Array()
}

// --- the workbook ---

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Builds a workbook from one or more sheets.
 *
 * Multiple sheets rather than one file per report, because the question an
 * accountant asks is "send me the month", and four attachments is four
 * chances to open the wrong one.
 */
export function toXlsx(sheets: readonly Sheet[]): Uint8Array {
  if (sheets.length === 0) {
    throw new Error('A workbook needs at least one sheet.')
  }

  const named = sheets.map((sheet, index) => ({
    sheet,
    /**
     * Excel refuses a workbook with two tabs of the same name, and two
     * reports over the same period collide easily. Numbering the duplicate is
     * less surprising than dropping the sheet.
     */
    name: safeSheetName(
      sheets.findIndex((other) => other.name === sheet.name) === index
        ? sheet.name
        : `${sheet.name} ${index + 1}`,
    ),
    id: index + 1,
  }))

  const files = [
    {
      path: '[Content_Types].xml',
      text:
        `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        named
          .map(
            ({ id }) =>
              `<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    },
    {
      path: '_rels/.rels',
      text:
        `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    },
    {
      path: 'xl/workbook.xml',
      text:
        `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
        named
          .map(
            ({ name, id }) =>
              `<sheet name="${escapeXml(name)}" sheetId="${id}" r:id="rId${id}"/>`,
          )
          .join('') +
        '</sheets></workbook>',
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      text:
        `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
        named
          .map(
            ({ id }) =>
              `<Relationship Id="rId${id}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${id}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${named.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    { path: 'xl/styles.xml', text: STYLES_XML },
    ...named.map(({ sheet, id }) => ({
      path: `xl/worksheets/sheet${id}.xml`,
      text: sheetXml(sheet),
    })),
  ]

  return buildZip(files)
}
