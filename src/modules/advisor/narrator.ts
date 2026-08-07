import type { Insight } from './insights'

/**
 * Turning findings into a briefing.
 *
 * This is the only place in the system where a language model is allowed near
 * the advisor, and the boundary is deliberate and narrow: the model is handed
 * conclusions that have already been computed, and asked to write them up. It
 * cannot reach the database, cannot see a figure that was not derived, and
 * cannot add a finding of its own.
 *
 * The reason is that the failure mode here is not a wrong answer — it is a
 * fluent one. A paragraph confidently describing a margin nobody calculated
 * reads exactly like a paragraph describing one that was, and a restaurant
 * owner has no way to tell them apart. Every number in the briefing therefore
 * comes from `insights.ts`, which is pure and has 41 tests behind it.
 *
 * The narrator is optional. With no model configured the local implementation
 * writes the briefing from the same findings using ordinary string handling —
 * plainer prose, identical facts. Nothing on the page depends on a model being
 * reachable, which is why the advisor works offline, in tests, and on a
 * restaurant's own hardware.
 */

export interface Briefing {
  /** Two or three sentences a manager reads before anything else. */
  summary: string
  /** How the summary was produced, shown to the reader. */
  source: 'local' | 'model'
  /** Present when a model was configured but could not be reached. */
  degraded: string | null
}

export interface Narrator {
  write(
    insights: readonly Insight[],
    refusal: string | null,
    context: { periodDays: number; restaurantName: string },
  ): Promise<Briefing>
}

const SEVERITY_WORD = {
  critical: 'needs fixing today',
  warning: 'worth looking at',
  opportunity: 'money on the table',
  info: 'worth knowing',
} as const

/**
 * The briefing, written without a model.
 *
 * Not a placeholder. It states how many findings there are, what the most
 * severe one is, and where the weight sits — which is most of what a summary
 * is for. A model makes it read better; it does not make it more true.
 */
export class LocalNarrator implements Narrator {
  write(
    insights: readonly Insight[],
    refusal: string | null,
    context: { periodDays: number; restaurantName: string },
  ): Promise<Briefing> {
    if (refusal) {
      return Promise.resolve({
        summary: refusal,
        source: 'local',
        degraded: null,
      })
    }

    if (insights.length === 0) {
      return Promise.resolve({
        summary: `Nothing needs your attention across the last ${String(context.periodDays)} days. Every check the advisor runs came back clean — which is the most common outcome for a business with nothing wrong with it.`,
        source: 'local',
        degraded: null,
      })
    }

    const [first] = insights
    const counts = new Map<string, number>()
    for (const insight of insights) {
      counts.set(insight.severity, (counts.get(insight.severity) ?? 0) + 1)
    }

    const breakdown = (['critical', 'warning', 'opportunity', 'info'] as const)
      .filter((severity) => counts.has(severity))
      .map(
        (severity) =>
          `${String(counts.get(severity))} ${SEVERITY_WORD[severity]}`,
      )
      .join(', ')

    return Promise.resolve({
      summary: `${String(insights.length)} finding${insights.length === 1 ? '' : 's'} across the last ${String(context.periodDays)} days: ${breakdown}. Start with ${first.title.toLowerCase()} — ${first.finding}`,
      source: 'local',
      degraded: null,
    })
  }
}

/**
 * The briefing, written by Claude over the findings.
 *
 * The model receives the findings as text and nothing else. It is not given
 * database access, a tool, or the restaurant's raw figures — only conclusions
 * that have already been derived and tested. Its job is register and ordering:
 * turning a ranked list into something a person reads in one breath.
 *
 * If it is unreachable, slow, or misbehaves, the local narrator answers
 * instead and the page says which one wrote it. An advisor that fails closed
 * on a third-party outage would be an advisor nobody could rely on.
 */
export class ClaudeNarrator implements Narrator {
  private readonly fallback = new LocalNarrator()

  constructor(
    private readonly apiKey: string,
    /** Bounded, because a manager will not wait for a briefing. */
    private readonly timeoutMs = 20_000,
  ) {}

  async write(
    insights: readonly Insight[],
    refusal: string | null,
    context: { periodDays: number; restaurantName: string },
  ): Promise<Briefing> {
    if (refusal || insights.length === 0) {
      return this.fallback.write(insights, refusal, context)
    }

    try {
      /**
       * Imported here rather than at module scope so a deployment with no key
       * configured never loads the SDK at all — the advisor's default path
       * stays free of it.
       */
      const { default: Anthropic } = await import('@anthropic-ai/sdk')

      const client = new Anthropic({
        apiKey: this.apiKey,
        timeout: this.timeoutMs,
        maxRetries: 1,
      })

      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1_000,
        /**
         * `low`. This is a writing task over conclusions that are already
         * drawn — there is nothing here to reason hard about, and a manager
         * waiting on a dashboard is the wrong place to spend thinking budget.
         */
        output_config: { effort: 'low' },
        system: NARRATOR_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: renderFindings(insights, context),
          },
        ],
      })

      const summary = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()

      /**
       * An empty or refused response falls back rather than shipping a blank
       * card. `stop_reason` is checked before the text is trusted, because a
       * refusal returns a normal 200 with nothing useful in it.
       */
      if (response.stop_reason === 'refusal' || summary.length === 0) {
        return {
          ...(await this.fallback.write(insights, refusal, context)),
          degraded: 'The model returned nothing usable, so this was written locally.',
        }
      }

      return { summary, source: 'model', degraded: null }
    } catch {
      /**
       * Deliberately swallowed. The findings below the summary are already
       * complete and correct; losing the paragraph that introduces them is not
       * a reason to fail the page.
       */
      return {
        ...(await this.fallback.write(insights, refusal, context)),
        degraded: 'The writing model could not be reached, so this was written locally.',
      }
    }
  }
}

const NARRATOR_SYSTEM_PROMPT = `You write the opening paragraph of a restaurant manager's daily briefing.

You are given findings that have already been computed from the restaurant's own records. Write two or three sentences introducing them.

Rules, in order of importance:

1. Every number you write must appear in the findings you were given. Do not calculate, estimate, extrapolate or round. If a figure is not in front of you, do not mention it.
2. Do not add findings, causes or advice of your own. The recommendations are already written and appear below your paragraph.
3. Say what matters most first. The findings are ordered by severity; the reader should know where to start.
4. Write for someone who runs a restaurant, not someone who reads dashboards. Plain sentences, no headings, no bullet points, no preamble.

Write the paragraph and nothing else.`

/**
 * The findings as text for the model.
 *
 * Deliberately spare: title, finding and severity. The evidence figures are
 * left out because the model has no reason to restate them and every reason
 * not to be handed numbers it might recombine.
 *
 * Exported so a test can assert what the model is actually shown. This is the
 * security boundary of the whole feature, and a boundary nobody can inspect is
 * a boundary nobody should trust.
 */
export function renderFindings(
  insights: readonly Insight[],
  context: { periodDays: number; restaurantName: string },
): string {
  const lines = insights.map(
    (insight) => `- [${insight.severity}] ${insight.title}. ${insight.finding}`,
  )

  return [
    `Restaurant: ${context.restaurantName}`,
    `Period: the last ${String(context.periodDays)} days`,
    '',
    'Findings, most severe first:',
    ...lines,
  ].join('\n')
}

/**
 * Picks a narrator.
 *
 * No key, no model — and that is a supported configuration, not a degraded
 * one. The advisor's conclusions are identical either way.
 */
export function createNarrator(apiKey?: string | null): Narrator {
  return apiKey ? new ClaudeNarrator(apiKey) : new LocalNarrator()
}
