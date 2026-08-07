import { describe, expect, it } from 'vitest'

import { createNarrator, LocalNarrator, renderFindings } from './narrator'
import type { Insight } from './insights'

function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    key: 'inventory:wastage:i1',
    domain: 'inventory',
    severity: 'warning',
    title: 'Noodles are being wasted at 6.0%',
    finding: 'More noodles were written off than the threshold allows.',
    recommendation: 'Check portioning and storage.',
    evidence: [
      { label: 'Wasted', value: { kind: 'quantity', milli: 6_000, unit: 'kg' } },
      { label: 'Value written off', value: { kind: 'money', minor: 3_000 } },
    ],
    confidence: 'high',
    basis: 'Every write-off is recorded individually.',
    ...overrides,
  }
}

const context = { periodDays: 7, restaurantName: 'Kopi Corner' }

describe('what the model is shown', () => {
  it('hands over conclusions, never the figures behind them', () => {
    const rendered = renderFindings([insight()], context)

    expect(rendered).toContain('Noodles are being wasted at 6.0%')
    expect(rendered).toContain('[warning]')

    /**
     * The security boundary of this whole feature. The model is given
     * conclusions that were already computed and tested; handing it the raw
     * evidence figures would give it numbers to recombine, and a fluent
     * sentence about a margin nobody calculated is indistinguishable from one
     * about a margin that was.
     */
    expect(rendered).not.toContain('3000')
    expect(rendered).not.toContain('6000')
    expect(rendered).not.toContain('Value written off')
  })

  it('does not pass the recommendation either', () => {
    // The advice is already written and rendered below the paragraph. Giving
    // it to the model invites a paraphrase that quietly says something else.
    const rendered = renderFindings([insight()], context)
    expect(rendered).not.toContain('Check portioning')
  })

  it('keeps the severity ordering it was given', () => {
    const rendered = renderFindings(
      [
        insight({ key: 'a', severity: 'critical', title: 'First' }),
        insight({ key: 'b', severity: 'info', title: 'Second' }),
      ],
      context,
    )

    expect(rendered.indexOf('First')).toBeLessThan(rendered.indexOf('Second'))
  })
})

describe('the local narrator', () => {
  const narrator = new LocalNarrator()

  it('states the refusal verbatim when the engine declined', async () => {
    const briefing = await narrator.write([], 'Only 4 bills were settled.', context)

    expect(briefing.summary).toBe('Only 4 bills were settled.')
    expect(briefing.source).toBe('local')
  })

  it('says so plainly when there is nothing wrong', async () => {
    const briefing = await narrator.write([], null, context)

    // Silence is a real answer, not an empty state to be filled.
    expect(briefing.summary).toMatch(/nothing needs your attention/i)
  })

  it('counts the findings and leads with the most severe', async () => {
    const briefing = await narrator.write(
      [
        insight({ key: 'a', severity: 'critical', title: 'Stock is negative' }),
        insight({ key: 'b', severity: 'warning' }),
        insight({ key: 'c', severity: 'opportunity' }),
      ],
      null,
      context,
    )

    expect(briefing.summary).toContain('3 findings')
    expect(briefing.summary).toContain('1 needs fixing today')
    expect(briefing.summary).toContain('stock is negative')
  })

  it('reads correctly for a single finding', async () => {
    const briefing = await narrator.write([insight()], null, context)
    expect(briefing.summary).toContain('1 finding across')
    expect(briefing.summary).not.toContain('1 findings')
  })
})

describe('choosing a narrator', () => {
  it('uses the local one when no model is configured', () => {
    // Not a degraded mode. The findings are identical either way; only the
    // paragraph introducing them is plainer.
    expect(createNarrator(null)).toBeInstanceOf(LocalNarrator)
    expect(createNarrator(undefined)).toBeInstanceOf(LocalNarrator)
  })

  it('uses the model when one is configured', () => {
    expect(createNarrator('sk-test')).not.toBeInstanceOf(LocalNarrator)
  })
})

describe('the model narrator', () => {
  it('answers locally without calling out when there is nothing to write up', async () => {
    /**
     * No network call is made here — a refusal or an empty finding list is
     * delegated before the SDK is even imported. Worth asserting, because a
     * dashboard that opens a paid API connection to say "nothing is wrong" is
     * a bill nobody agreed to.
     */
    const narrator = createNarrator('sk-test')

    const refused = await narrator.write([], 'Not enough trade.', context)
    expect(refused.source).toBe('local')
    expect(refused.summary).toBe('Not enough trade.')

    const empty = await narrator.write([], null, context)
    expect(empty.source).toBe('local')
  })
})
