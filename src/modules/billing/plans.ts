/**
 * Plans, limits and quota arithmetic.
 *
 * Pure, like every engine before it, because this is the code that decides
 * whether a restaurant may add a branch on a Friday night. A limit enforced by
 * a query nobody can test is a limit that will one day refuse the wrong thing.
 *
 * The important behaviour in this file is what happens when an account is
 * ALREADY past a limit — after a downgrade, or after a plan's allowance is
 * lowered. Nothing is deleted, nothing stops working, and nothing is hidden.
 * The only consequence is that creating another one is refused. Anything else
 * would mean a billing change silently destroying a customer's data, which is
 * not a thing software should be able to do.
 */

export type PlanKey = 'launch' | 'grow' | 'scale' | 'enterprise'

/** Countable things a plan puts a ceiling on. */
export type Quota = 'branches' | 'staff' | 'menuItems' | 'monthlyBills'

/**
 * Capabilities a plan switches on.
 *
 * Separate from quotas because they fail differently: a quota refuses one
 * action and leaves the rest of the product working, while a feature gate
 * closes a whole page. The two need different messages and different UI.
 */
export type Feature =
  | 'advisor'
  | 'webhooks'
  | 'apiKeys'
  | 'groupDashboard'
  | 'export'

/** `null` means no ceiling. Not `Infinity`, which does not survive JSON. */
export type Limit = number | null

export interface Plan {
  key: PlanKey
  name: string
  /** One line a customer reads when choosing. */
  summary: string
  limits: Record<Quota, Limit>
  features: readonly Feature[]
}

/**
 * The plan catalogue.
 *
 * Deliberately in code rather than in the database. A plan is a promise about
 * what the software does, and every one of these limits is enforced by a code
 * path that has to exist — an admin screen that could invent a fifth plan
 * would produce a plan nothing enforces, which is the same mistake the
 * permission registry avoids for the same reason.
 */
export const PLANS: Record<PlanKey, Plan> = {
  launch: {
    key: 'launch',
    name: 'Launch',
    summary: 'A single site finding its feet.',
    limits: {
      branches: 1,
      staff: 5,
      menuItems: 100,
      monthlyBills: 1_000,
    },
    features: [],
  },
  grow: {
    key: 'grow',
    name: 'Grow',
    summary: 'A few sites, and the reporting to run them.',
    limits: {
      branches: 3,
      staff: 25,
      menuItems: 500,
      monthlyBills: 10_000,
    },
    features: ['advisor', 'export'],
  },
  scale: {
    key: 'scale',
    name: 'Scale',
    summary: 'A group, with integrations and cross-site comparison.',
    limits: {
      branches: 10,
      staff: 100,
      menuItems: null,
      monthlyBills: 50_000,
    },
    features: ['advisor', 'export', 'webhooks', 'apiKeys', 'groupDashboard'],
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    summary: 'No ceilings, and everything switched on.',
    limits: {
      branches: null,
      staff: null,
      menuItems: null,
      monthlyBills: null,
    },
    features: ['advisor', 'export', 'webhooks', 'apiKeys', 'groupDashboard'],
  },
}

export const PLAN_ORDER: readonly PlanKey[] = [
  'launch',
  'grow',
  'scale',
  'enterprise',
]

export function planFor(key: string): Plan {
  return PLANS[key as PlanKey] ?? PLANS.launch
}

/** What a quota is called when it is refused, in a customer's words. */
export const QUOTA_LABEL: Record<Quota, string> = {
  branches: 'branches',
  staff: 'staff members',
  menuItems: 'menu items',
  monthlyBills: 'bills this month',
}

export interface QuotaState {
  quota: Quota
  used: number
  limit: Limit
  /**
   * True when usage has already met or passed the ceiling.
   *
   * Note this is reachable WITHOUT anyone doing anything wrong: a downgrade
   * from a plan allowing ten branches to one allowing three leaves an account
   * with seven branches over quota. Every one of them keeps working.
   */
  isOverQuota: boolean
  /** Null when there is no ceiling. */
  remaining: number | null
}

export function quotaState(
  quota: Quota,
  used: number,
  plan: Plan,
): QuotaState {
  const limit = plan.limits[quota]

  if (limit === null) {
    return { quota, used, limit: null, isOverQuota: false, remaining: null }
  }

  return {
    quota,
    used,
    limit,
    isOverQuota: used >= limit,
    remaining: Math.max(0, limit - used),
  }
}

export interface QuotaRefusal {
  quota: Quota
  used: number
  limit: number
  message: string
  /** The cheapest plan that would allow it, or null if none would. */
  upgradeTo: PlanKey | null
}

/**
 * The cheapest plan whose ceiling clears the current usage.
 *
 * Returns the plan that allows one MORE than is currently used, not one that
 * merely matches — an account being told to upgrade wants to be able to
 * perform the action afterwards.
 */
export function smallestPlanAllowing(
  quota: Quota,
  used: number,
): PlanKey | null {
  for (const key of PLAN_ORDER) {
    const limit = PLANS[key].limits[quota]
    if (limit === null || limit > used) return key
  }
  return null
}

/**
 * Decides whether one more may be created.
 *
 * Returns a refusal rather than throwing, so the caller decides whether this
 * is an error to surface or a button to disable. The message names the number,
 * the plan and the way out — "upgrade required" on its own tells someone
 * nothing about what they hit or what to do.
 */
export function checkQuota(
  quota: Quota,
  used: number,
  plan: Plan,
): QuotaRefusal | null {
  const state = quotaState(quota, used, plan)
  if (!state.isOverQuota || state.limit === null) return null

  const upgradeTo = smallestPlanAllowing(quota, used)

  return {
    quota,
    used,
    limit: state.limit,
    message: upgradeTo
      ? `The ${plan.name} plan includes ${String(state.limit)} ${QUOTA_LABEL[quota]}, and you are using ${String(used)}. Move to ${PLANS[upgradeTo].name} to add more.`
      : `The ${plan.name} plan includes ${String(state.limit)} ${QUOTA_LABEL[quota]}, and you are using ${String(used)}.`,
    upgradeTo,
  }
}

export function hasFeature(plan: Plan, feature: Feature): boolean {
  return plan.features.includes(feature)
}

export const FEATURE_LABEL: Record<Feature, string> = {
  advisor: 'The advisor',
  webhooks: 'Webhooks',
  apiKeys: 'API access',
  groupDashboard: 'The group dashboard',
  export: 'Report export',
}

/** The cheapest plan that includes a feature. */
export function smallestPlanWith(feature: Feature): PlanKey | null {
  return PLAN_ORDER.find((key) => hasFeature(PLANS[key], feature)) ?? null
}

export function featureRefusal(
  plan: Plan,
  feature: Feature,
): { message: string; upgradeTo: PlanKey | null } | null {
  if (hasFeature(plan, feature)) return null

  const upgradeTo = smallestPlanWith(feature)

  return {
    message: upgradeTo
      ? `${FEATURE_LABEL[feature]} is not included in ${plan.name}. It is available from ${PLANS[upgradeTo].name}.`
      : `${FEATURE_LABEL[feature]} is not available on your plan.`,
    upgradeTo,
  }
}

/**
 * What a plan change would mean, computed before it happens.
 *
 * A downgrade that leaves an account over quota is allowed — refusing it would
 * mean the only way to reduce spend is to delete data first. But the customer
 * is told exactly what will stop being possible and what will switch off,
 * before they agree to it rather than after.
 */
export interface PlanChangeEffect {
  from: PlanKey
  to: PlanKey
  direction: 'upgrade' | 'downgrade' | 'unchanged'
  /** Quotas the account would immediately be over. Nothing is deleted. */
  wouldExceed: QuotaState[]
  /** Features that would stop working. */
  wouldLose: Feature[]
}

export function planChangeEffect(
  from: PlanKey,
  to: PlanKey,
  usage: Record<Quota, number>,
): PlanChangeEffect {
  const target = PLANS[to]
  const fromIndex = PLAN_ORDER.indexOf(from)
  const toIndex = PLAN_ORDER.indexOf(to)

  const wouldExceed = (Object.keys(usage) as Quota[])
    .map((quota) => quotaState(quota, usage[quota], target))
    .filter((state) => state.isOverQuota)

  return {
    from,
    to,
    direction:
      toIndex === fromIndex
        ? 'unchanged'
        : toIndex > fromIndex
          ? 'upgrade'
          : 'downgrade',
    wouldExceed,
    wouldLose: PLANS[from].features.filter(
      (feature) => !hasFeature(target, feature),
    ),
  }
}
