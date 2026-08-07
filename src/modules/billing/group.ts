/**
 * Comparing sites to each other.
 *
 * Pure, and the arithmetic is more delicate than it looks. A league table
 * ranked on takings tells a group owner what they already know — the big site
 * takes more money than the small one. What they do not know is which site is
 * underperforming *for its size*, and that is a different calculation.
 */

export interface BranchPerformance {
  branchId: string
  name: string
  code: string
  bills: number
  covers: number
  netSalesMinor: number
  costMinor: number
  grossProfitMinor: number
  averageBillMinor: number
  /** Null when the branch counted no covers. */
  averagePerCoverMinor: number | null
  marginBasisPoints: number | null
}

export interface GroupComparison {
  branches: RankedBranch[]
  totals: {
    branches: number
    bills: number
    covers: number
    netSalesMinor: number
    grossProfitMinor: number
  }
  /** Group-wide averages the outlier detection is measured against. */
  median: {
    averageBillMinor: number | null
    marginBasisPoints: number | null
  }
  outliers: Outlier[]
}

export interface RankedBranch extends BranchPerformance {
  /** 1 is the largest by net sales. */
  rank: number
  /** This branch's share of group net sales, in basis points. */
  shareBasisPoints: number
}

export interface Outlier {
  branchId: string
  name: string
  kind: 'low_average_bill' | 'low_margin' | 'high_average_bill'
  /** How far from the group median, in basis points. */
  deviationBasisPoints: number
  message: string
}

/**
 * The threshold at which a branch is called out.
 *
 * Twenty per cent from the median. Tighter than that and every group of five
 * sites has three outliers, which is the same as having none — the list stops
 * being a list of things to look at.
 */
export const OUTLIER_BASIS_POINTS = 2_000

/**
 * Below this many branches, no comparison is offered at all.
 *
 * Two sites do not have a median; they have each other. Calling the smaller
 * one an outlier because it differs from the larger is arithmetic dressed up
 * as insight.
 */
export const MIN_BRANCHES_TO_COMPARE = 3

function median(values: readonly number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value))
  if (usable.length === 0) return null

  const sorted = [...usable].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

function deviation(value: number, from: number): number {
  if (from === 0) return 0
  return Math.round(((value - from) * 10_000) / Math.abs(from))
}

/**
 * Ranks branches and names the ones worth asking about.
 *
 * Branches that traded nothing are ranked but never called out. A site that
 * was closed for refurbishment is not underperforming, and putting it at the
 * top of an exceptions list is how the list gets ignored.
 */
export function compareBranches(
  performance: readonly BranchPerformance[],
): GroupComparison {
  const ranked: RankedBranch[] = [...performance]
    .sort((a, b) => b.netSalesMinor - a.netSalesMinor)
    .map((branch, index) => ({ ...branch, rank: index + 1, shareBasisPoints: 0 }))

  const totalNet = ranked.reduce(
    (sum, branch) => sum + branch.netSalesMinor,
    0,
  )

  for (const branch of ranked) {
    branch.shareBasisPoints =
      totalNet === 0
        ? 0
        : Math.round((branch.netSalesMinor * 10_000) / totalNet)
  }

  const trading = ranked.filter((branch) => branch.bills > 0)

  const medianAverageBill = median(
    trading.map((branch) => branch.averageBillMinor),
  )
  const medianMargin = median(
    trading
      .map((branch) => branch.marginBasisPoints)
      .filter((value): value is number => value !== null),
  )

  const outliers: Outlier[] = []

  if (trading.length >= MIN_BRANCHES_TO_COMPARE) {
    for (const branch of trading) {
      if (medianAverageBill !== null && medianAverageBill > 0) {
        const gap = deviation(branch.averageBillMinor, medianAverageBill)

        if (gap <= -OUTLIER_BASIS_POINTS) {
          outliers.push({
            branchId: branch.branchId,
            name: branch.name,
            kind: 'low_average_bill',
            deviationBasisPoints: gap,
            message: `${branch.name} takes ${String(Math.abs(gap) / 100)}% less per bill than the group median. Look at upselling, the menu on offer there, and whether the same promotions are running.`,
          })
        } else if (gap >= OUTLIER_BASIS_POINTS) {
          /**
           * A high outlier is raised too, and as an opportunity rather than a
           * problem. A site doing something that works is worth finding, and a
           * comparison that only ever surfaces failures teaches people that
           * opening it is bad news.
           */
          outliers.push({
            branchId: branch.branchId,
            name: branch.name,
            kind: 'high_average_bill',
            deviationBasisPoints: gap,
            message: `${branch.name} takes ${String(gap / 100)}% more per bill than the group median. Worth finding out what they are doing differently before assuming it is the location.`,
          })
        }
      }

      if (
        medianMargin !== null &&
        branch.marginBasisPoints !== null &&
        medianMargin > 0
      ) {
        const gap = deviation(branch.marginBasisPoints, medianMargin)

        if (gap <= -OUTLIER_BASIS_POINTS) {
          outliers.push({
            branchId: branch.branchId,
            name: branch.name,
            kind: 'low_margin',
            deviationBasisPoints: gap,
            message: `${branch.name} runs ${String(Math.abs(gap) / 100)}% below the group's median margin. Check portioning and wastage there against the other sites.`,
          })
        }
      }
    }
  }

  return {
    branches: ranked,
    totals: {
      branches: ranked.length,
      bills: ranked.reduce((sum, b) => sum + b.bills, 0),
      covers: ranked.reduce((sum, b) => sum + b.covers, 0),
      netSalesMinor: totalNet,
      grossProfitMinor: ranked.reduce(
        (sum, b) => sum + b.grossProfitMinor,
        0,
      ),
    },
    median: {
      averageBillMinor: medianAverageBill,
      marginBasisPoints: medianMargin,
    },
    outliers: outliers.sort(
      (a, b) => a.deviationBasisPoints - b.deviationBasisPoints,
    ),
  }
}
