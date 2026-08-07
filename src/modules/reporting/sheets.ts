import { describeRange } from './report'
import type { ItemReport, LossReport, SalesReport, TaxReport } from './report.service'
import { moneyCell, percentCell, type Sheet } from './sheet'

/**
 * Reports as tables.
 *
 * Kept apart from both the services that produce reports and the writers that
 * serialise them, so a new export format costs nothing and a new report costs
 * one function.
 *
 * Every money figure goes out through `moneyCell`, which converts minor units
 * to a decimal number. A spreadsheet column of 1166 that means RM 11.66 is a
 * column somebody will sum, believe, and put in front of a bank.
 */

export function salesSheets(report: SalesReport, timeZone: string): Sheet[] {
  const sheets: Sheet[] = [
    {
      name: 'Sales summary',
      columns: ['Measure', 'This period', 'Previous period'],
      rows: [
        ['Bills', report.summary.bills, report.previous.bills],
        ['Covers', report.summary.covers, report.previous.covers],
        [
          'Net sales',
          moneyCell(report.summary.netSalesMinor),
          moneyCell(report.previous.netSalesMinor),
        ],
        [
          'Discounts',
          moneyCell(report.summary.discountMinor),
          moneyCell(report.previous.discountMinor),
        ],
        [
          'Service charge',
          moneyCell(report.summary.serviceChargeMinor),
          moneyCell(report.previous.serviceChargeMinor),
        ],
        [
          'Tax',
          moneyCell(report.summary.taxMinor),
          moneyCell(report.previous.taxMinor),
        ],
        [
          'Total billed',
          moneyCell(report.summary.totalMinor),
          moneyCell(report.previous.totalMinor),
        ],
        [
          'Refunded',
          moneyCell(report.summary.refundedMinor),
          moneyCell(report.previous.refundedMinor),
        ],
        [
          'Cost of sales',
          moneyCell(report.summary.costMinor),
          moneyCell(report.previous.costMinor),
        ],
        [
          'Gross profit',
          moneyCell(report.summary.grossProfitMinor),
          moneyCell(report.previous.grossProfitMinor),
        ],
        [
          'Margin %',
          percentCell(report.summary.marginBasisPoints),
          percentCell(report.previous.marginBasisPoints),
        ],
        [
          'Average bill',
          moneyCell(report.summary.averageBillMinor),
          moneyCell(report.previous.averageBillMinor),
        ],
        [
          'Average per cover',
          moneyCell(report.summary.averagePerCoverMinor),
          moneyCell(report.previous.averagePerCoverMinor),
        ],
        /**
         * Coverage rides along on the summary rather than sitting in a
         * footnote. A margin read without it is a margin on whichever part of
         * the menu happens to have a recipe.
         */
        [
          'Recipe coverage %',
          percentCell(report.summary.costCoverageBasisPoints),
          percentCell(report.previous.costCoverageBasisPoints),
        ],
      ],
    },
    {
      name: 'Sales by period',
      columns: [
        'Period',
        'Bills',
        'Covers',
        'Net sales',
        'Discounts',
        'Tax',
        'Total billed',
        'Average bill',
      ],
      rows: report.series.map((bucket) => [
        bucket.key,
        bucket.summary.bills,
        bucket.summary.covers,
        moneyCell(bucket.summary.netSalesMinor),
        moneyCell(bucket.summary.discountMinor),
        moneyCell(bucket.summary.taxMinor),
        moneyCell(bucket.summary.totalMinor),
        moneyCell(bucket.summary.averageBillMinor),
      ]),
    },
  ]

  if (report.byBranch.length > 1) {
    sheets.push({
      name: 'Sales by branch',
      columns: ['Branch', 'Code', 'Bills', 'Covers', 'Net sales', 'Total billed'],
      rows: report.byBranch.map((line) => [
        line.name,
        line.code,
        line.summary.bills,
        line.summary.covers,
        moneyCell(line.summary.netSalesMinor),
        moneyCell(line.summary.totalMinor),
      ]),
    })
  }

  sheets.push({
    name: 'Payment methods',
    columns: ['Method', 'Payments', 'Amount'],
    rows: report.byMethod.map((line) => [
      line.method,
      line.count,
      moneyCell(line.amountMinor),
    ]),
  })

  sheets.push({
    name: 'By hour',
    columns: [`Hour (${timeZone})`, 'Bills', 'Total billed'],
    rows: report.byHour.map((hour) => [
      `${String(hour.hour).padStart(2, '0')}:00`,
      hour.bills,
      moneyCell(hour.totalMinor),
    ]),
  })

  return sheets
}

export function itemSheets(report: ItemReport): Sheet[] {
  return [
    {
      name: 'Item performance',
      columns: [
        'Item',
        'Category',
        'Quantity',
        'Revenue',
        'Cost',
        'Gross profit',
        'Margin %',
        'Costed',
      ],
      rows: report.items.map((item) => [
        item.name,
        item.categoryName ?? 'Uncategorised',
        item.quantity,
        moneyCell(item.revenueMinor),
        // Blank rather than zero when nothing was costed: a zero here reads as
        // "this dish is free to make", which is a very different claim from
        // "nobody has written its recipe".
        item.isCosted ? moneyCell(item.costMinor) : null,
        item.isCosted ? moneyCell(item.grossProfitMinor) : null,
        percentCell(item.marginBasisPoints),
        item.isCosted ? 'yes' : 'no',
      ]),
    },
    {
      name: 'By category',
      columns: ['Category', 'Quantity', 'Revenue', 'Cost'],
      rows: report.categories.map((category) => [
        category.categoryName,
        category.quantity,
        moneyCell(category.revenueMinor),
        moneyCell(category.costMinor),
      ]),
    },
  ]
}

export function taxSheets(report: TaxReport): Sheet[] {
  return [
    {
      name: 'Tax',
      columns: [
        'Rate %',
        'Basis',
        'Bills',
        'Taxable amount',
        'Tax',
        'Service charge',
      ],
      rows: report.lines.map((line) => [
        percentCell(line.rateBasisPoints),
        // The distinction belongs on a tax return: inclusive pricing means the
        // tax was extracted from the price shown, not added to it.
        line.taxIsIncluded ? 'Inclusive' : 'Added',
        line.bills,
        moneyCell(line.taxableBaseMinor),
        moneyCell(line.taxMinor),
        moneyCell(line.serviceChargeMinor),
      ]),
    },
  ]
}

export function lossSheets(report: LossReport): Sheet[] {
  return [
    {
      name: 'Discounts and comps',
      columns: ['Reason', 'Applied by', 'Count', 'Value'],
      rows: report.manualDiscounts.map((line) => [
        line.reason,
        line.appliedBy ?? 'Unknown',
        line.count,
        moneyCell(line.valueMinor),
      ]),
    },
    {
      name: 'Promotions',
      columns: ['Promotion', 'Redemptions', 'Value'],
      rows: report.promotions.map((line) => [
        line.name,
        line.count,
        moneyCell(line.valueMinor),
      ]),
    },
    {
      name: 'Voids',
      columns: ['Item', 'Voided by', 'Count', 'Value'],
      rows: report.voids.map((line) => [
        line.name,
        line.voidedBy ?? 'Unknown',
        line.count,
        moneyCell(line.valueMinor),
      ]),
    },
  ]
}

/** The filename a download arrives under, before it is made safe. */
export function exportBaseName(
  report: string,
  range: { from: Date; to: Date },
  timeZone: string,
  startMinutes: number,
): string {
  return `${report}-${describeRange(range, timeZone, startMinutes).replaceAll(' ', '-')}`
}
