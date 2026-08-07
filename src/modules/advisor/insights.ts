import {
  classifyMenu,
  QUADRANT_MEANING,
  type MenuItemPerformance,
} from './menu-engineering'

/**
 * The insight engine.
 *
 * Pure, like every engine before it, and for a sharper reason than usual: this
 * is the part of the system that tells an owner what to do about their
 * business. Advice assembled by something untestable is advice nobody should
 * take, so every recommendation here is derived by arithmetic from figures the
 * system recorded, carries the figures it was derived from, and can be
 * reproduced exactly.
 *
 * No language model is involved in producing any number, threshold or
 * conclusion. A model may later be asked to write the findings up as prose —
 * see `narrator.ts` — but it is handed the conclusions and cannot reach the
 * data. The distinction matters: a plausible sentence about a margin that
 * nobody computed is the single worst thing this feature could produce.
 *
 * The other discipline running through this file is refusal. Most rules can
 * decline to fire, and the engine as a whole declines when there is too little
 * trade to say anything. An advisor that always has an opinion is one whose
 * opinions are worth nothing.
 */

export type InsightDomain =
  | 'menu'
  | 'sales'
  | 'inventory'
  | 'operations'
  | 'customers'
  | 'finance'

export type Severity =
  /** Something is wrong now and costs money every day it continues. */
  | 'critical'
  /** A trend heading the wrong way, or a number that cannot be trusted. */
  | 'warning'
  /** Nothing is broken; there is money on the table. */
  | 'opportunity'
  /** Worth knowing, needs no action. */
  | 'info'

export type Confidence = 'high' | 'medium' | 'low'

export type EvidenceValue =
  | { kind: 'money'; minor: number }
  | { kind: 'percent'; basisPoints: number }
  | { kind: 'count'; value: number }
  | { kind: 'quantity'; milli: number; unit: string }
  | { kind: 'text'; value: string }

export interface Evidence {
  label: string
  value: EvidenceValue
}

export interface Insight {
  /**
   * Stable across runs for the same underlying subject, because a dismissal
   * is stored against it. A key that changed with the numbers would make
   * every dismissal expire the moment anything moved, which is precisely when
   * the recommendation is least welcome and most repeated.
   */
  key: string
  domain: InsightDomain
  severity: Severity
  title: string
  /** What is true. One sentence, no advice in it. */
  finding: string
  /** What to do about it. Kept separate so the two can be judged separately. */
  recommendation: string
  evidence: Evidence[]
  confidence: Confidence
  /** Why the confidence is what it is. Always populated. */
  basis: string
}

// --- what the engine reasons over ---

export interface SalesFacts {
  bills: number
  covers: number
  netSalesMinor: number
  costMinor: number
  discountMinor: number
  grossProfitMinor: number
  marginBasisPoints: number | null
  costCoverageBasisPoints: number | null
  previousBills: number
  previousNetSalesMinor: number
  previousDiscountMinor: number
  /** Bills with a member attached, for judging loyalty capture. */
  billsWithCustomer: number
}

export interface IngredientFacts {
  ingredientId: string
  name: string
  unit: string
}

export interface StockFacts extends IngredientFacts {
  onHandMilli: number
  reorderPointMilli: number
  reorderQuantityMilli: number
  supplierName: string | null
  neverCounted: boolean
}

export interface WastageFacts extends IngredientFacts {
  wastedMilli: number
  consumedMilli: number
  wastedValueMinor: number
}

export interface CostDriftFacts extends IngredientFacts {
  previousCostPerUnitMinor: number
  currentCostPerUnitMinor: number
  /** Menu items whose recipe uses this ingredient. */
  affectedItems: string[]
}

export interface StationFacts {
  stationId: string
  name: string
  tickets: number
  medianPrepMinutes: number
}

export interface VoidFacts {
  userId: string | null
  name: string
  count: number
  valueMinor: number
}

export interface AtRiskCustomer {
  customerId: string
  name: string
  daysSinceVisit: number
  typicalGapDays: number
  visits: number
  lifetimeSpendMinor: number
}

export interface AdvisorSnapshot {
  /** Length of the period examined, in trading days. */
  periodDays: number
  sales: SalesFacts
  menu: MenuItemPerformance[]
  /** Units sold of each item in the preceding period, keyed by name. */
  previousMenuQuantities: Record<string, number>
  stock: StockFacts[]
  wastage: WastageFacts[]
  costDrift: CostDriftFacts[]
  stations: StationFacts[]
  voids: VoidFacts[]
  atRiskCustomers: AtRiskCustomer[]
  /**
   * Points earned and not yet spent, as points.
   *
   * Deliberately not a money figure. Phase 9 records what a point is earned
   * for and never records what one is worth — redemption is in points, and
   * what those points buy is decided outside this system. Valuing the
   * liability would mean inventing a rate and then reporting it as fact.
   */
  pointsOutstanding: number
  pointsEarnedThisPeriod: number
  activeCustomers: number
  /** Target food cost as a share of net sales. Configurable per restaurant. */
  targetFoodCostBasisPoints: number
  cashShareBasisPoints: number | null
}

// --- thresholds, in one place so they can be argued with ---

/**
 * Below this many settled bills, the engine says so and stops.
 *
 * Every rule below compares proportions, and a proportion of eleven bills is
 * an anecdote. Twenty is not a statistical threshold either — it is the point
 * at which "your discounts are up 40%" stops meaning "somebody comped a
 * coffee".
 */
export const MIN_BILLS_FOR_ADVICE = 20

export const THRESHOLDS = {
  /** Net sales fall, against the previous period of equal length. */
  salesDeclineBasisPoints: 1_000,
  /** One item's unit sales falling, with enough volume to be real. */
  itemDeclineBasisPoints: 3_000,
  minUnitsToJudgeDecline: 20,
  /** Wastage as a share of what was consumed. */
  wastageBasisPoints: 500,
  /** An ingredient's weighted-average cost rising. */
  costDriftBasisPoints: 1_000,
  /** A station's median prep time against the median of all stations. */
  slowStationFactor: 1.5,
  minTicketsToJudgeStation: 20,
  /** One person's share of voided value. */
  voidConcentrationBasisPoints: 5_000,
  minVoidsToJudge: 5,
  /** Discount rate rising, in basis points of net sales. */
  discountCreepBasisPoints: 300,
  /** Recipe coverage below which margin figures are called unreliable. */
  minCostCoverageBasisPoints: 7_500,
  /** Loyalty capture: bills carrying a member. */
  lowCaptureBasisPoints: 1_000,
  /**
   * Outstanding points as a multiple of what a period earns.
   *
   * Three periods' worth banked means points are going in and not coming out,
   * which is the shape of a scheme customers are enrolled in and do not use.
   */
  pointsOverhangFactor: 3,
  /** Cash share of takings above which the drawer is a real exposure. */
  cashHeavyBasisPoints: 6_000,
} as const

// --- helpers ---

function ratioBasisPoints(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Math.round((part * 10_000) / whole)
}

function changeBasisPoints(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) * 10_000) / Math.abs(previous))
}

const money = (minor: number): EvidenceValue => ({ kind: 'money', minor })
const percent = (basisPoints: number): EvidenceValue => ({
  kind: 'percent',
  basisPoints,
})
const count = (value: number): EvidenceValue => ({ kind: 'count', value })
const text = (value: string): EvidenceValue => ({ kind: 'text', value })
const quantity = (milli: number, unit: string): EvidenceValue => ({
  kind: 'quantity',
  milli,
  unit,
})

/**
 * Confidence from sample size.
 *
 * Deliberately crude and deliberately visible. The alternative — presenting
 * every finding with the same weight — makes a conclusion drawn from four
 * bills indistinguishable from one drawn from four hundred, and the reader has
 * no way to tell which they are looking at.
 */
function confidenceFrom(sample: number): Confidence {
  if (sample >= 100) return 'high'
  if (sample >= 30) return 'medium'
  return 'low'
}

// --- the rules ---

function menuInsights(snapshot: AdvisorSnapshot): Insight[] {
  const insights: Insight[] = []
  const analysis = classifyMenu(snapshot.menu)

  /**
   * The insight that qualifies every other margin figure on the page.
   *
   * Raised first and raised loudly, because an owner acting on "remove these
   * dogs" while half the menu is uncosted is being told to remove the dishes
   * that happen to have recipes.
   */
  const coverage = snapshot.sales.costCoverageBasisPoints
  if (coverage !== null && coverage < THRESHOLDS.minCostCoverageBasisPoints) {
    const uncosted = snapshot.menu.filter((item) => !item.isCosted)

    insights.push({
      key: 'menu:coverage',
      domain: 'menu',
      severity: 'warning',
      title: 'Margin figures cover only part of the menu',
      finding: `Only ${(coverage / 100).toFixed(0)}% of sales come from dishes with a recipe, so every cost and margin figure on this page describes that portion and not the whole menu.`,
      recommendation:
        uncosted.length > 0
          ? `Add recipes for the highest-selling uncosted items, starting with ${uncosted
              .slice(0, 3)
              .map((item) => item.name)
              .join(', ')}.`
          : 'Add recipes to the items that are missing them.',
      evidence: [
        { label: 'Sales with a recipe behind them', value: percent(coverage) },
        { label: 'Items with no recipe', value: count(uncosted.length) },
      ],
      confidence: 'high',
      basis: 'Counted directly from the period’s sales, not sampled.',
    })
  }

  for (const item of analysis.items) {
    if (item.quadrant === 'star') continue
    if (!item.menuItemId) continue

    const shared = {
      domain: 'menu' as const,
      evidence: [
        { label: 'Sold', value: count(item.quantity) },
        { label: 'Revenue', value: money(item.revenueMinor) },
        { label: 'Gross profit', value: money(item.contributionMinor) },
        {
          label: 'Profit per portion',
          value: money(item.unitContributionMinor),
        },
        {
          label: 'Menu median profit per portion',
          value: money(analysis.contributionThresholdMinor),
        },
      ],
      confidence: confidenceFrom(item.quantity),
      basis: `Based on ${String(item.quantity)} portions sold over ${String(snapshot.periodDays)} days.`,
    }

    if (item.quadrant === 'dog') {
      insights.push({
        ...shared,
        key: `menu:dog:${item.menuItemId}`,
        severity: 'opportunity',
        title: `${item.name} neither sells nor earns`,
        finding: `${item.name} sold ${String(item.quantity)} portions and returned ${(item.unitContributionMinor / 100).toFixed(2)} each, below the menu median.`,
        recommendation: QUADRANT_MEANING.dog,
      })
      continue
    }

    if (item.quadrant === 'plowhorse') {
      insights.push({
        ...shared,
        key: `menu:plowhorse:${item.menuItemId}`,
        severity: 'opportunity',
        title: `${item.name} is popular but thin`,
        finding: `${item.name} is one of the better sellers, yet returns less per portion than the median dish.`,
        recommendation: QUADRANT_MEANING.plowhorse,
      })
      continue
    }

    insights.push({
      ...shared,
      key: `menu:puzzle:${item.menuItemId}`,
      severity: 'opportunity',
      title: `${item.name} earns well but few order it`,
      finding: `${item.name} returns more per portion than the median dish but accounts for only ${(item.popularityBasisPoints / 100).toFixed(1)}% of portions sold.`,
      recommendation: QUADRANT_MEANING.puzzle,
    })
  }

  for (const item of snapshot.menu) {
    if (!item.menuItemId) continue

    const previous = snapshot.previousMenuQuantities[item.name]
    if (previous === undefined) continue
    if (previous < THRESHOLDS.minUnitsToJudgeDecline) continue

    const change = changeBasisPoints(item.quantity, previous)
    if (change === null || change > -THRESHOLDS.itemDeclineBasisPoints) continue

    insights.push({
      key: `menu:declining:${item.menuItemId}`,
      domain: 'menu',
      severity: 'warning',
      title: `${item.name} is selling markedly less`,
      finding: `${item.name} sold ${String(item.quantity)} portions, down from ${String(previous)} in the previous period.`,
      recommendation:
        'Check whether the recipe, the price or its position on the menu changed, and whether a competitor nearby has started serving it.',
      evidence: [
        { label: 'This period', value: count(item.quantity) },
        { label: 'Previous period', value: count(previous) },
        { label: 'Change', value: percent(change) },
      ],
      confidence: confidenceFrom(previous),
      basis: `Compared against ${String(previous)} portions in the preceding ${String(snapshot.periodDays)} days.`,
    })
  }

  return insights
}

function salesInsights(snapshot: AdvisorSnapshot): Insight[] {
  const { sales } = snapshot
  const insights: Insight[] = []

  const change = changeBasisPoints(
    sales.netSalesMinor,
    sales.previousNetSalesMinor,
  )

  if (change !== null && change <= -THRESHOLDS.salesDeclineBasisPoints) {
    insights.push({
      key: 'sales:decline',
      domain: 'sales',
      severity: 'warning',
      title: 'Net sales are down against the previous period',
      finding: `Net sales fell ${(Math.abs(change) / 100).toFixed(1)}% against the preceding ${String(snapshot.periodDays)} days.`,
      recommendation:
        'Compare covers against bills: fewer people is a marketing problem, while the same people spending less is a menu and upselling one.',
      evidence: [
        { label: 'Net sales', value: money(sales.netSalesMinor) },
        {
          label: 'Previous period',
          value: money(sales.previousNetSalesMinor),
        },
        { label: 'Bills', value: count(sales.bills) },
        { label: 'Previous bills', value: count(sales.previousBills) },
      ],
      confidence: confidenceFrom(Math.min(sales.bills, sales.previousBills)),
      basis: `Compared against ${String(sales.previousBills)} bills in the preceding period.`,
    })
  }

  return insights
}

function inventoryInsights(snapshot: AdvisorSnapshot): Insight[] {
  const insights: Insight[] = []

  /**
   * Negative stock is not a shortage; it is proof the books are wrong. Raised
   * as critical because every cost figure that touches the ingredient is now
   * wrong too, quietly.
   */
  const negative = snapshot.stock.filter((row) => row.onHandMilli < 0)
  if (negative.length > 0) {
    insights.push({
      key: 'inventory:negative',
      domain: 'inventory',
      severity: 'critical',
      title: 'Some ingredients show a negative quantity',
      finding: `${String(negative.length)} ingredient${negative.length === 1 ? '' : 's'} show less than nothing on hand, which means goods were used without being received or a count was never taken.`,
      recommendation:
        'Count these ingredients today. Until you do, their cost per unit — and the margin of every dish using them — is guesswork.',
      evidence: negative.slice(0, 5).map((row) => ({
        label: row.name,
        value: quantity(row.onHandMilli, row.unit),
      })),
      confidence: 'high',
      basis: 'Read directly from the stock ledger.',
    })
  }

  const reorder = snapshot.stock.filter(
    (row) =>
      row.reorderPointMilli > 0 && row.onHandMilli <= row.reorderPointMilli,
  )
  for (const row of reorder) {
    if (row.onHandMilli < 0) continue

    insights.push({
      key: `inventory:reorder:${row.ingredientId}`,
      domain: 'inventory',
      severity: 'warning',
      title: `${row.name} is at its reorder point`,
      finding: `${row.name} is down to its reorder level with no purchase order covering it.`,
      recommendation: row.supplierName
        ? `Raise a purchase order with ${row.supplierName}.`
        : 'Raise a purchase order, and set a preferred supplier so this can name one next time.',
      evidence: [
        { label: 'On hand', value: quantity(row.onHandMilli, row.unit) },
        {
          label: 'Reorder point',
          value: quantity(row.reorderPointMilli, row.unit),
        },
        {
          label: 'Usual order',
          value: quantity(row.reorderQuantityMilli, row.unit),
        },
      ],
      confidence: 'high',
      basis: 'Compared against the reorder point you set for this ingredient.',
    })
  }

  for (const row of snapshot.wastage) {
    if (row.consumedMilli <= 0) continue

    const share = ratioBasisPoints(row.wastedMilli, row.consumedMilli)
    if (share === null || share < THRESHOLDS.wastageBasisPoints) continue

    insights.push({
      key: `inventory:wastage:${row.ingredientId}`,
      domain: 'inventory',
      severity: 'warning',
      title: `${row.name} is being wasted at ${(share / 100).toFixed(1)}%`,
      finding: `${(share / 100).toFixed(1)}% as much ${row.name} was written off as was cooked with, worth ${(row.wastedValueMinor / 100).toFixed(2)}.`,
      recommendation:
        'Check portioning, storage and how much is prepped ahead. Wastage this high is usually one of the three, and it is the cheapest margin there is to recover.',
      evidence: [
        { label: 'Wasted', value: quantity(row.wastedMilli, row.unit) },
        { label: 'Consumed', value: quantity(row.consumedMilli, row.unit) },
        { label: 'Value written off', value: money(row.wastedValueMinor) },
      ],
      confidence: 'high',
      basis: 'Every write-off is recorded individually in the stock ledger.',
    })
  }

  for (const row of snapshot.costDrift) {
    const change = changeBasisPoints(
      row.currentCostPerUnitMinor,
      row.previousCostPerUnitMinor,
    )
    if (change === null || change < THRESHOLDS.costDriftBasisPoints) continue

    insights.push({
      key: `inventory:cost-drift:${row.ingredientId}`,
      domain: 'inventory',
      severity: 'warning',
      title: `${row.name} costs ${(change / 100).toFixed(0)}% more than it did`,
      finding: `The weighted-average cost of ${row.name} rose from ${(row.previousCostPerUnitMinor / 100).toFixed(2)} to ${(row.currentCostPerUnitMinor / 100).toFixed(2)} per ${row.unit}.`,
      recommendation:
        row.affectedItems.length > 0
          ? `Margins on ${row.affectedItems.slice(0, 3).join(', ')} have thinned by the same amount without anyone changing a price. Reprice them or find another supplier.`
          : 'Reprice the dishes that use it, or find another supplier.',
      evidence: [
        {
          label: 'Was',
          value: money(row.previousCostPerUnitMinor),
        },
        { label: 'Now', value: money(row.currentCostPerUnitMinor) },
        { label: 'Change', value: percent(change) },
        {
          label: 'Dishes affected',
          value: count(row.affectedItems.length),
        },
      ],
      confidence: 'high',
      basis: 'Taken from goods receipts, which are the only thing that changes cost.',
    })
  }

  const uncounted = snapshot.stock.filter((row) => row.neverCounted)
  if (uncounted.length > 0) {
    insights.push({
      key: 'inventory:uncounted',
      domain: 'inventory',
      severity: 'info',
      title: `${String(uncounted.length)} ingredients have never been counted`,
      finding:
        'Their levels are whatever the ledger has accumulated since they were created, with nothing physical ever checked against it.',
      recommendation:
        'Count them once to set a baseline. Until then the reconciler can confirm the ledger agrees with itself, but not that either agrees with the shelf.',
      evidence: uncounted.slice(0, 5).map((row) => ({
        label: row.name,
        value: text('never counted'),
      })),
      confidence: 'high',
      basis: 'Read directly from the stock records.',
    })
  }

  return insights
}

function operationsInsights(snapshot: AdvisorSnapshot): Insight[] {
  const insights: Insight[] = []

  const judgeable = snapshot.stations.filter(
    (station) => station.tickets >= THRESHOLDS.minTicketsToJudgeStation,
  )

  /**
   * A station is only slow relative to the others. Comparing against a fixed
   * number of minutes would flag the grill in every restaurant that serves
   * steak, which is not an insight.
   */
  if (judgeable.length >= 2) {
    const times = judgeable
      .map((station) => station.medianPrepMinutes)
      .sort((a, b) => a - b)
    const middle = times[Math.floor(times.length / 2)]

    for (const station of judgeable) {
      if (station.medianPrepMinutes < middle * THRESHOLDS.slowStationFactor) {
        continue
      }

      insights.push({
        key: `operations:slow-station:${station.stationId}`,
        domain: 'operations',
        severity: 'warning',
        title: `${station.name} is running slower than the rest of the kitchen`,
        finding: `Tickets at ${station.name} take a median of ${String(station.medianPrepMinutes)} minutes against ${String(middle)} across the kitchen.`,
        recommendation:
          'Look at what is routed there and whether it is staffed for the peak. A single slow station holds up whole tables, because a table is served when its last dish is.',
        evidence: [
          {
            label: 'Median prep time',
            value: count(station.medianPrepMinutes),
          },
          { label: 'Kitchen median', value: count(middle) },
          { label: 'Tickets', value: count(station.tickets) },
        ],
        confidence: confidenceFrom(station.tickets),
        basis: `Based on ${String(station.tickets)} tickets at this station.`,
      })
    }
  }

  const totalVoidValue = snapshot.voids.reduce(
    (sum, row) => sum + row.valueMinor,
    0,
  )
  const totalVoidCount = snapshot.voids.reduce((sum, row) => sum + row.count, 0)

  if (totalVoidCount >= THRESHOLDS.minVoidsToJudge && snapshot.voids.length > 1) {
    for (const row of snapshot.voids) {
      const share = ratioBasisPoints(row.valueMinor, totalVoidValue)
      if (share === null || share < THRESHOLDS.voidConcentrationBasisPoints) {
        continue
      }

      insights.push({
        key: `operations:voids:${row.userId ?? row.name}`,
        domain: 'operations',
        severity: 'info',
        title: `${row.name} accounts for most voided value`,
        finding: `${row.name} voided ${String(row.count)} lines worth ${(row.valueMinor / 100).toFixed(2)}, which is ${(share / 100).toFixed(0)}% of everything voided this period.`,
        /**
         * Phrased as a question, not an accusation. Concentration is exactly
         * what you would expect from whoever works the till most, and a tool
         * that implies theft from an ordinary roster pattern is a tool that
         * gets switched off.
         */
        recommendation:
          'Worth a look rather than an alarm — this is the expected pattern for whoever works the till most. Check the reasons given, and whether the voids cluster at one time of day.',
        evidence: [
          { label: 'Lines voided', value: count(row.count) },
          { label: 'Value', value: money(row.valueMinor) },
          { label: 'Share of all voids', value: percent(share) },
        ],
        confidence: confidenceFrom(totalVoidCount),
        basis: `Based on ${String(totalVoidCount)} voided lines across ${String(snapshot.voids.length)} people.`,
      })
    }
  }

  return insights
}

function customerInsights(snapshot: AdvisorSnapshot): Insight[] {
  const insights: Insight[] = []
  const { sales } = snapshot

  const capture = ratioBasisPoints(sales.billsWithCustomer, sales.bills)
  if (
    snapshot.activeCustomers > 0 &&
    capture !== null &&
    capture < THRESHOLDS.lowCaptureBasisPoints
  ) {
    insights.push({
      key: 'customers:capture',
      domain: 'customers',
      severity: 'opportunity',
      title: 'Members are rarely being attached to bills',
      finding: `Only ${(capture / 100).toFixed(1)}% of bills carried a member, despite ${String(snapshot.activeCustomers)} customers on the books.`,
      recommendation:
        'Points only accrue when a bill knows who it belongs to. If the till is not asking, the loyalty scheme is costing you the discounts without buying you the returns.',
      evidence: [
        { label: 'Bills with a member', value: count(sales.billsWithCustomer) },
        { label: 'Bills', value: count(sales.bills) },
        { label: 'Customers on file', value: count(snapshot.activeCustomers) },
      ],
      confidence: confidenceFrom(sales.bills),
      basis: `Based on ${String(sales.bills)} settled bills.`,
    })
  }

  for (const customer of snapshot.atRiskCustomers) {
    insights.push({
      key: `customers:at-risk:${customer.customerId}`,
      domain: 'customers',
      severity: 'opportunity',
      title: `${customer.name} has not been in for a while`,
      finding: `${customer.name} normally visits about every ${String(customer.typicalGapDays)} days and it has been ${String(customer.daysSinceVisit)}.`,
      recommendation:
        'A regular who quietly stops coming rarely complains first. Worth a call or an offer before the habit is gone.',
      evidence: [
        { label: 'Days since last visit', value: count(customer.daysSinceVisit) },
        { label: 'Usual gap', value: count(customer.typicalGapDays) },
        { label: 'Visits', value: count(customer.visits) },
        { label: 'Lifetime spend', value: money(customer.lifetimeSpendMinor) },
      ],
      /**
       * Someone with three visits has no reliable rhythm to be late against.
       * The rule still fires — a lapsing regular is worth a call either way —
       * but it says how thin the evidence is.
       */
      confidence: confidenceFrom(customer.visits * 10),
      basis: `Their own pattern across ${String(customer.visits)} visits.`,
    })
  }

  /**
   * Points going in and not coming out.
   *
   * Stated in points, never in money. Phase 9 records what a point is earned
   * for and never records what one is worth — redemption is in points, and
   * what those points buy is decided outside this system. Putting a currency
   * figure on the liability would mean inventing a rate and then reporting it
   * as if it had been measured.
   */
  if (
    snapshot.pointsEarnedThisPeriod > 0 &&
    snapshot.pointsOutstanding >=
      snapshot.pointsEarnedThisPeriod * THRESHOLDS.pointsOverhangFactor
  ) {
    insights.push({
      key: 'customers:points-overhang',
      domain: 'customers',
      severity: 'info',
      title: 'Points are being earned and not spent',
      finding: `Customers are holding ${String(snapshot.pointsOutstanding)} points, about ${String(Math.round(snapshot.pointsOutstanding / snapshot.pointsEarnedThisPeriod))} periods' worth of earning, with little coming back out.`,
      recommendation:
        'A balance that only grows is a scheme people are enrolled in and do not use. Decide what a point buys, tell customers, and record the rate — until it exists, this liability cannot be valued in money at all, only counted.',
      evidence: [
        { label: 'Points outstanding', value: count(snapshot.pointsOutstanding) },
        {
          label: 'Earned this period',
          value: count(snapshot.pointsEarnedThisPeriod),
        },
        {
          label: 'Redemption rate on file',
          value: text('none — points are redeemed as points'),
        },
      ],
      confidence: 'high',
      basis: 'Summed from the append-only loyalty ledger.',
    })
  }

  return insights
}

function financeInsights(snapshot: AdvisorSnapshot): Insight[] {
  const insights: Insight[] = []
  const { sales } = snapshot

  const now = ratioBasisPoints(sales.discountMinor, sales.netSalesMinor)
  const before = ratioBasisPoints(
    sales.previousDiscountMinor,
    sales.previousNetSalesMinor,
  )

  if (
    now !== null &&
    before !== null &&
    now - before >= THRESHOLDS.discountCreepBasisPoints
  ) {
    insights.push({
      key: 'finance:discount-creep',
      domain: 'finance',
      severity: 'warning',
      title: 'Discounts are taking a bigger share of sales',
      finding: `Discounts were ${(now / 100).toFixed(1)}% of net sales, up from ${(before / 100).toFixed(1)}% in the previous period.`,
      recommendation:
        'Check the discounts and voids report for who is applying them and why. Comps rarely creep by policy; they creep by habit.',
      evidence: [
        { label: 'Discount rate now', value: percent(now) },
        { label: 'Previously', value: percent(before) },
        { label: 'Discounted this period', value: money(sales.discountMinor) },
      ],
      confidence: confidenceFrom(Math.min(sales.bills, sales.previousBills)),
      basis: `Compared across ${String(sales.bills)} and ${String(sales.previousBills)} bills.`,
    })
  }

  const foodCost = ratioBasisPoints(sales.costMinor, sales.netSalesMinor)
  const coverage = sales.costCoverageBasisPoints

  /**
   * Food cost is only reported when most of the menu is costed. Below that it
   * is a food cost percentage of an unknown fraction of the business, and
   * stating it against a target invites a decision made on a number that does
   * not mean what it says.
   */
  if (
    foodCost !== null &&
    coverage !== null &&
    coverage >= THRESHOLDS.minCostCoverageBasisPoints &&
    foodCost > snapshot.targetFoodCostBasisPoints
  ) {
    insights.push({
      key: 'finance:food-cost',
      domain: 'finance',
      severity: 'warning',
      title: 'Food cost is above target',
      finding: `Ingredients cost ${(foodCost / 100).toFixed(1)}% of net sales against a target of ${(snapshot.targetFoodCostBasisPoints / 100).toFixed(1)}%.`,
      recommendation:
        'Three things move this: what you pay, how much goes in the pan, and how much goes in the bin. The wastage and cost-drift findings above say which one is yours.',
      evidence: [
        { label: 'Food cost', value: percent(foodCost) },
        { label: 'Target', value: percent(snapshot.targetFoodCostBasisPoints) },
        { label: 'Cost of sales', value: money(sales.costMinor) },
        { label: 'Recipe coverage', value: percent(coverage) },
      ],
      confidence: confidenceFrom(sales.bills),
      basis: `Based on ${String(sales.bills)} bills with ${(coverage / 100).toFixed(0)}% recipe coverage.`,
    })
  }

  if (
    snapshot.cashShareBasisPoints !== null &&
    snapshot.cashShareBasisPoints >= THRESHOLDS.cashHeavyBasisPoints
  ) {
    insights.push({
      key: 'finance:cash-heavy',
      domain: 'finance',
      severity: 'info',
      title: 'Most takings are cash',
      finding: `${(snapshot.cashShareBasisPoints / 100).toFixed(0)}% of what was taken came through the drawer.`,
      recommendation:
        'Cash is the only tender with no independent record, so reconcile it daily rather than weekly and bank it often.',
      evidence: [
        { label: 'Cash share', value: percent(snapshot.cashShareBasisPoints) },
      ],
      confidence: confidenceFrom(sales.bills),
      basis: `Based on payments against ${String(sales.bills)} bills.`,
    })
  }

  return insights
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  opportunity: 2,
  info: 3,
}

export interface AdvisorResult {
  insights: Insight[]
  /** Set when the engine declined to advise, with the reason. */
  refusal: string | null
}

/**
 * Runs every rule.
 *
 * The first thing it does is check whether there is enough trade to say
 * anything at all, and if there is not, it says exactly that and stops. A new
 * restaurant with eleven bills does not need to be told its discount rate rose
 * 40%, and telling it so is how an advisor teaches people to ignore it.
 *
 * The stock rules run either way. "This ingredient shows negative quantity" is
 * true regardless of how busy the week was, and a new restaurant is precisely
 * where a receiving mistake is most likely.
 */
export function generateInsights(snapshot: AdvisorSnapshot): AdvisorResult {
  if (snapshot.sales.bills < MIN_BILLS_FOR_ADVICE) {
    return {
      insights: sortInsights(inventoryInsights(snapshot)),
      refusal: `Only ${String(snapshot.sales.bills)} bills were settled in this period. That is too few to draw conclusions about the menu, the trend or the discount rate, so nothing about them is offered. Stock findings still apply, because a counting error is a counting error whatever the trade was.`,
    }
  }

  return {
    insights: sortInsights([
      ...menuInsights(snapshot),
      ...salesInsights(snapshot),
      ...inventoryInsights(snapshot),
      ...operationsInsights(snapshot),
      ...customerInsights(snapshot),
      ...financeInsights(snapshot),
    ]),
    refusal: null,
  }
}

/**
 * Most severe first, and within a severity the more confident finding first.
 *
 * Ordering by confidence second matters: a critical finding drawn from four
 * bills sitting above a warning drawn from four hundred is how the ranking
 * loses its meaning.
 */
export function sortInsights(insights: readonly Insight[]): Insight[] {
  const confidenceRank: Record<Confidence, number> = {
    high: 0,
    medium: 1,
    low: 2,
  }

  return [...insights].sort((a, b) => {
    const bySeverity =
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity

    const byConfidence =
      confidenceRank[a.confidence] - confidenceRank[b.confidence]
    if (byConfidence !== 0) return byConfidence

    return a.key.localeCompare(b.key)
  })
}
