import { describe, expect, it } from 'vitest'

import {
  checkQuota,
  featureRefusal,
  hasFeature,
  PLAN_ORDER,
  PLANS,
  planChangeEffect,
  planFor,
  quotaState,
  smallestPlanAllowing,
  smallestPlanWith,
} from './plans'

describe('quotas', () => {
  it('allows creation below the ceiling', () => {
    // Launch allows 1 branch; nothing created yet.
    expect(checkQuota('branches', 0, PLANS.launch)).toBeNull()
  })

  it('refuses once the ceiling is reached', () => {
    const refusal = checkQuota('branches', 1, PLANS.launch)

    expect(refusal).not.toBeNull()
    // Names the number, the plan and the way out. "Upgrade required" tells
    // someone nothing about what they hit.
    expect(refusal!.message).toContain('1 branches')
    expect(refusal!.message).toContain('Launch')
    expect(refusal!.upgradeTo).toBe('grow')
  })

  it('never refuses on an unlimited plan', () => {
    expect(checkQuota('branches', 5_000, PLANS.enterprise)).toBeNull()
    expect(quotaState('branches', 5_000, PLANS.enterprise).remaining).toBeNull()
  })

  it('reports how many are left', () => {
    const state = quotaState('staff', 20, PLANS.grow)

    expect(state.limit).toBe(25)
    expect(state.remaining).toBe(5)
    expect(state.isOverQuota).toBe(false)
  })

  it('points at a plan that allows one MORE, not one that merely matches', () => {
    /**
     * An account with exactly 3 branches has met Grow's ceiling. Telling them
     * to move to Grow would leave them unable to do the thing they were
     * refused.
     */
    expect(smallestPlanAllowing('branches', 3)).toBe('scale')
    expect(smallestPlanAllowing('branches', 10)).toBe('enterprise')
  })

  it('falls back to the cheapest plan when nothing has been used', () => {
    expect(smallestPlanAllowing('branches', 0)).toBe('launch')
  })
})

describe('being over quota', () => {
  /**
   * The important behaviour in this module. A downgrade — or a plan whose
   * allowance is lowered — can leave an account past a ceiling without anyone
   * doing anything wrong.
   */
  it('is a state, not an error', () => {
    const state = quotaState('branches', 7, PLANS.launch)

    expect(state.isOverQuota).toBe(true)
    expect(state.used).toBe(7)
    // Seven branches. Nothing here proposes removing six of them.
    expect(state.remaining).toBe(0)
  })

  it('only ever refuses the next one', () => {
    const refusal = checkQuota('branches', 7, PLANS.launch)

    expect(refusal).not.toBeNull()
    expect(refusal!.upgradeTo).toBe('scale')
    // The message reports what is in use rather than what must be removed.
    expect(refusal!.message).toContain('you are using 7')
    expect(refusal!.message).not.toMatch(/delete|remove/i)
  })
})

describe('features', () => {
  it('gates by plan', () => {
    expect(hasFeature(PLANS.launch, 'webhooks')).toBe(false)
    expect(hasFeature(PLANS.scale, 'webhooks')).toBe(true)
  })

  it('names the cheapest plan that includes it', () => {
    expect(smallestPlanWith('advisor')).toBe('grow')
    expect(smallestPlanWith('apiKeys')).toBe('scale')
  })

  it('says nothing when the feature is already included', () => {
    expect(featureRefusal(PLANS.scale, 'webhooks')).toBeNull()
  })

  it('explains what is missing and where to get it', () => {
    const refusal = featureRefusal(PLANS.launch, 'apiKeys')

    expect(refusal!.message).toContain('API access')
    expect(refusal!.message).toContain('Scale')
    expect(refusal!.upgradeTo).toBe('scale')
  })

  it('keeps every feature available on the top plan', () => {
    // A gap here would mean a paying enterprise customer refused something a
    // cheaper plan includes.
    for (const key of PLAN_ORDER) {
      for (const feature of PLANS[key].features) {
        expect(hasFeature(PLANS.enterprise, feature)).toBe(true)
      }
    }
  })

  it('never shrinks a limit as plans get larger', () => {
    /**
     * A ceiling that went down at a higher price would be a billing page
     * nobody could explain. Asserted rather than assumed, because the
     * catalogue is hand-written.
     */
    const quotas = ['branches', 'staff', 'menuItems', 'monthlyBills'] as const

    for (const quota of quotas) {
      let previous: number | null = 0
      for (const key of PLAN_ORDER) {
        const limit = PLANS[key].limits[quota]
        if (previous === null) {
          expect(limit).toBeNull()
        } else if (limit !== null) {
          expect(limit).toBeGreaterThanOrEqual(previous)
        }
        previous = limit
      }
    }
  })
})

describe('changing plan', () => {
  const usage = {
    branches: 4,
    staff: 30,
    menuItems: 200,
    monthlyBills: 5_000,
  }

  it('reports an upgrade as clearing everything', () => {
    const effect = planChangeEffect('grow', 'scale', usage)

    expect(effect.direction).toBe('upgrade')
    expect(effect.wouldExceed).toEqual([])
    expect(effect.wouldLose).toEqual([])
  })

  it('names exactly what a downgrade would cost, before it happens', () => {
    const effect = planChangeEffect('scale', 'launch', usage)

    expect(effect.direction).toBe('downgrade')
    expect(effect.wouldExceed.map((state) => state.quota).sort()).toEqual([
      'branches',
      'menuItems',
      'monthlyBills',
      'staff',
    ])
    expect(effect.wouldLose).toContain('webhooks')
    expect(effect.wouldLose).toContain('apiKeys')
  })

  it('does not refuse a downgrade that leaves an account over quota', () => {
    /**
     * Refusing would mean the only way to reduce spend is to delete data
     * first. The customer is told what stops being possible and decides.
     */
    const effect = planChangeEffect('scale', 'launch', usage)

    expect(effect.wouldExceed.length).toBeGreaterThan(0)
    // There is no `allowed: false` here, deliberately.
    expect(effect).not.toHaveProperty('allowed')
  })

  it('recognises a change to the same plan', () => {
    expect(planChangeEffect('grow', 'grow', usage).direction).toBe('unchanged')
  })
})

describe('resolving a plan', () => {
  it('falls back to the cheapest plan for an unrecognised key', () => {
    // A stored value the code does not know must not grant everything. The
    // safe direction is the smallest plan, not the largest.
    expect(planFor('platinum').key).toBe('launch')
    expect(planFor('scale').key).toBe('scale')
  })
})
