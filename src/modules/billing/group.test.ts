import { describe, expect, it } from 'vitest'

import {
  compareBranches,
  MIN_BRANCHES_TO_COMPARE,
  type BranchPerformance,
} from './group'

function branch(
  name: string,
  overrides: Partial<BranchPerformance> = {},
): BranchPerformance {
  const netSalesMinor = overrides.netSalesMinor ?? 100_000
  const costMinor = overrides.costMinor ?? 30_000
  const bills = overrides.bills ?? 100

  return {
    branchId: `id-${name}`,
    name,
    code: name.slice(0, 2).toUpperCase(),
    bills,
    covers: overrides.covers ?? bills * 2,
    netSalesMinor,
    costMinor,
    grossProfitMinor: netSalesMinor - costMinor,
    averageBillMinor:
      overrides.averageBillMinor ??
      (bills === 0 ? 0 : Math.round(netSalesMinor / bills)),
    averagePerCoverMinor: overrides.averagePerCoverMinor ?? null,
    marginBasisPoints:
      overrides.marginBasisPoints ??
      (netSalesMinor === 0
        ? null
        : Math.round(((netSalesMinor - costMinor) * 10_000) / netSalesMinor)),
    ...overrides,
  }
}

describe('ranking', () => {
  it('orders by net sales and reports each share', () => {
    const result = compareBranches([
      branch('Small', { netSalesMinor: 50_000 }),
      branch('Large', { netSalesMinor: 150_000 }),
    ])

    expect(result.branches.map((b) => b.name)).toEqual(['Large', 'Small'])
    expect(result.branches[0].rank).toBe(1)
    expect(result.branches[0].shareBasisPoints).toBe(7_500)
    expect(result.branches[1].shareBasisPoints).toBe(2_500)
  })

  it('does not divide by zero when the group traded nothing', () => {
    const result = compareBranches([
      branch('A', { netSalesMinor: 0, bills: 0 }),
      branch('B', { netSalesMinor: 0, bills: 0 }),
    ])

    expect(result.totals.netSalesMinor).toBe(0)
    expect(result.branches.every((b) => b.shareBasisPoints === 0)).toBe(true)
  })

  it('totals the group', () => {
    const result = compareBranches([
      branch('A', { netSalesMinor: 100_000, costMinor: 30_000, bills: 100 }),
      branch('B', { netSalesMinor: 60_000, costMinor: 20_000, bills: 60 }),
    ])

    expect(result.totals.branches).toBe(2)
    expect(result.totals.bills).toBe(160)
    expect(result.totals.netSalesMinor).toBe(160_000)
    expect(result.totals.grossProfitMinor).toBe(110_000)
  })
})

describe('outliers', () => {
  it('refuses to compare fewer than three trading sites', () => {
    /**
     * Two sites do not have a median; they have each other. Calling the
     * smaller one an outlier because it differs from the larger is arithmetic
     * dressed up as insight.
     */
    const result = compareBranches([
      branch('A', { bills: 100, averageBillMinor: 1_000 }),
      branch('B', { bills: 100, averageBillMinor: 3_000 }),
    ])

    expect(result.outliers).toEqual([])
  })

  it('names a site taking materially less per bill', () => {
    const result = compareBranches([
      branch('A', { averageBillMinor: 1_000 }),
      branch('B', { averageBillMinor: 1_000 }),
      branch('C', { averageBillMinor: 1_000 }),
      branch('Quiet', { averageBillMinor: 700 }),
    ])

    const outlier = result.outliers.find((o) => o.name === 'Quiet')

    expect(outlier).toBeDefined()
    expect(outlier!.kind).toBe('low_average_bill')
    expect(outlier!.message).toContain('30%')
  })

  it('names a site doing better, as an opportunity', () => {
    /**
     * A comparison that only ever surfaces failures teaches people that
     * opening it is bad news. A site doing something that works is worth
     * finding.
     */
    const result = compareBranches([
      branch('A', { averageBillMinor: 1_000 }),
      branch('B', { averageBillMinor: 1_000 }),
      branch('C', { averageBillMinor: 1_000 }),
      branch('Star', { averageBillMinor: 1_500 }),
    ])

    const outlier = result.outliers.find((o) => o.name === 'Star')

    expect(outlier!.kind).toBe('high_average_bill')
    expect(outlier!.message).toContain('what they are doing differently')
  })

  it('ignores a difference inside the tolerance', () => {
    // Tighter and every group of five sites has three outliers, which is the
    // same as having none.
    const result = compareBranches([
      branch('A', { averageBillMinor: 1_000 }),
      branch('B', { averageBillMinor: 1_000 }),
      branch('C', { averageBillMinor: 1_000 }),
      branch('D', { averageBillMinor: 900 }),
    ])

    expect(result.outliers).toEqual([])
  })

  it('flags a thin margin against the group median', () => {
    const result = compareBranches([
      branch('A', { marginBasisPoints: 7_000 }),
      branch('B', { marginBasisPoints: 7_000 }),
      branch('C', { marginBasisPoints: 7_000 }),
      branch('Leaky', { marginBasisPoints: 5_000 }),
    ])

    const outlier = result.outliers.find((o) => o.kind === 'low_margin')

    expect(outlier!.name).toBe('Leaky')
    expect(outlier!.message).toContain('wastage')
  })

  it('leaves a closed site out of the exceptions', () => {
    /**
     * A branch shut for refurbishment is not underperforming, and putting it
     * at the top of an exceptions list is how the list gets ignored.
     */
    const result = compareBranches([
      branch('A', { averageBillMinor: 1_000 }),
      branch('B', { averageBillMinor: 1_000 }),
      branch('C', { averageBillMinor: 1_000 }),
      branch('Closed', { bills: 0, netSalesMinor: 0, averageBillMinor: 0 }),
    ])

    expect(result.outliers.map((o) => o.name)).not.toContain('Closed')
    // Still ranked, so it is visible rather than hidden.
    expect(result.branches.map((b) => b.name)).toContain('Closed')
  })

  it('needs the minimum number of TRADING sites, not registered ones', () => {
    const result = compareBranches([
      branch('A', { averageBillMinor: 1_000 }),
      branch('B', { averageBillMinor: 700 }),
      ...Array.from({ length: MIN_BRANCHES_TO_COMPARE }, (_, i) =>
        branch(`Closed${String(i)}`, {
          bills: 0,
          netSalesMinor: 0,
          averageBillMinor: 0,
        }),
      ),
    ])

    // Five branches, two of them trading. No comparison.
    expect(result.outliers).toEqual([])
  })

  it('puts the worst gap first', () => {
    const result = compareBranches([
      branch('A', { averageBillMinor: 1_000 }),
      branch('B', { averageBillMinor: 1_000 }),
      branch('C', { averageBillMinor: 1_000 }),
      branch('Bad', { averageBillMinor: 700 }),
      branch('Worse', { averageBillMinor: 400 }),
    ])

    expect(result.outliers[0].name).toBe('Worse')
  })
})

describe('the group median', () => {
  it('is reported so a reader can check the comparison', () => {
    const result = compareBranches([
      branch('A', { averageBillMinor: 1_000 }),
      branch('B', { averageBillMinor: 2_000 }),
      branch('C', { averageBillMinor: 3_000 }),
    ])

    expect(result.median.averageBillMinor).toBe(2_000)
  })

  it('is null when nothing traded', () => {
    const result = compareBranches([
      branch('A', { bills: 0, netSalesMinor: 0 }),
    ])

    expect(result.median.averageBillMinor).toBeNull()
    expect(result.median.marginBasisPoints).toBeNull()
  })
})
