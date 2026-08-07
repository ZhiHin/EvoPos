/**
 * The tabular shape every export is built from.
 *
 * One shape rather than a formatter per report, so adding a report means
 * describing its columns rather than writing a CSV writer and an Excel writer
 * and keeping them agreeing with each other.
 *
 * Numbers stay numbers all the way to the file. Formatting them to strings in
 * the service is the mistake that produces a spreadsheet where the totals row
 * cannot be summed, which is the first thing anybody does with an export.
 */
export type CellValue = string | number | null

export interface Sheet {
  /** Becomes the worksheet tab name, and the downloaded file's name. */
  name: string
  columns: readonly string[]
  rows: readonly (readonly CellValue[])[]
}

/**
 * Money leaves the system as a decimal number, not minor units.
 *
 * A column of 1166 that means RM 11.66 is a column somebody will sum, believe,
 * and put in a board pack. The conversion happens once, here, and produces a
 * real number so the spreadsheet can total it.
 */
export function moneyCell(minor: number): number {
  return Math.round(minor) / 100
}

/** Basis points as a percentage number: 7000 -> 70. Null stays null. */
export function percentCell(basisPoints: number | null): number | null {
  return basisPoints === null ? null : Math.round(basisPoints) / 100
}
