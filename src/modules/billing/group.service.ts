import { listBranches } from '@/modules/branch/branch.service'
import { readSalesReport, type ReportContext } from '@/modules/reporting/report.service'
import type { ReportRange } from '@/modules/reporting/report'
import { compareBranches, type GroupComparison } from './group'

/**
 * The group view.
 *
 * Built on the Phase 12 sales report rather than its own queries, for the same
 * reason the advisor is: two code paths computing "net sales" is two chances
 * to disagree, and a group page contradicting the sales page in front of the
 * same owner makes both untrusted.
 */
export async function readGroupComparison(
  ctx: ReportContext,
  range: ReportRange,
): Promise<GroupComparison> {
  /**
   * Read across every branch — this page's whole purpose is the comparison,
   * so a branch filter would be a page that compares one thing to itself.
   */
  const [report, allBranches] = await Promise.all([
    readSalesReport(ctx, { range, branchId: null }, 'day'),
    listBranches(ctx.restaurantId, ctx.userId),
  ])

  const traded = new Map(
    report.byBranch.map((line) => [line.branchId, line]),
  )

  /**
   * Every branch, including ones that took nothing.
   *
   * The sales report drops a branch with no bills, deliberately — on a
   * multi-site account most of that list would otherwise be sites that were
   * simply closed that day. On a group page the opposite is true: a site
   * showing nothing is the first thing an owner wants to see, and its absence
   * reads as a bug rather than as a closure.
   */
  return compareBranches(
    allBranches.map((branch) => {
      const line = traded.get(branch.id)

      if (!line) {
        return {
          branchId: branch.id,
          name: branch.name,
          code: branch.code,
          bills: 0,
          covers: 0,
          netSalesMinor: 0,
          costMinor: 0,
          grossProfitMinor: 0,
          averageBillMinor: 0,
          averagePerCoverMinor: null,
          marginBasisPoints: null,
        }
      }

      return {
        branchId: line.branchId,
        name: line.name,
        code: line.code,
        bills: line.summary.bills,
        covers: line.summary.covers,
        netSalesMinor: line.summary.netSalesMinor,
        costMinor: line.summary.costMinor,
        grossProfitMinor: line.summary.grossProfitMinor,
        averageBillMinor: line.summary.averageBillMinor,
        averagePerCoverMinor:
          line.summary.covers > 0 ? line.summary.averagePerCoverMinor : null,
        marginBasisPoints: line.summary.marginBasisPoints,
      }
    }),
  )
}
