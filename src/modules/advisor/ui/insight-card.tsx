import { AlertTriangle, Info, Lightbulb, OctagonAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Confidence, Insight, Severity } from '../insights'
import { DismissButton } from './dismiss-button'
import { EvidenceList } from './evidence-list'

const SEVERITY: Record<
  Severity,
  { icon: typeof Info; label: string; className: string }
> = {
  critical: {
    icon: OctagonAlert,
    label: 'Fix today',
    className: 'text-destructive',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Look at this',
    className: 'text-amber-600 dark:text-amber-400',
  },
  opportunity: {
    icon: Lightbulb,
    label: 'Opportunity',
    className: 'text-emerald-600 dark:text-emerald-400',
  },
  info: { icon: Info, label: 'For information', className: 'text-muted-foreground' },
}

/**
 * How much weight the finding can bear.
 *
 * Shown on every card rather than only the weak ones. If low confidence were
 * the only labelled state, the absence of a label would come to mean "this one
 * is certain" — which is a stronger claim than the engine ever makes.
 */
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'Well evidenced',
  medium: 'Reasonably evidenced',
  low: 'Thin evidence',
}

export function InsightCard({
  insight,
  currency,
  canDismiss,
}: {
  insight: Insight
  currency: string
  canDismiss: boolean
}) {
  const severity = SEVERITY[insight.severity]
  const Icon = severity.icon

  return (
    <Card
      className={
        insight.severity === 'critical' ? 'border-destructive' : undefined
      }
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Icon className={cn('size-4 shrink-0', severity.className)} aria-hidden />
              <span className={cn('text-xs font-medium', severity.className)}>
                {severity.label}
              </span>
              <Badge variant="outline" className="text-[10px] font-normal">
                {insight.domain}
              </Badge>
            </div>
            <CardTitle className="text-base">{insight.title}</CardTitle>
            <CardDescription>{insight.finding}</CardDescription>
          </div>

          {canDismiss && (
            <DismissButton insightKey={insight.key} title={insight.title} />
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/*
          Finding and recommendation are kept visually apart because they are
          judged separately: the reader can accept that something is true and
          still disagree about what to do about it.
        */}
        <p className="rounded-md bg-accent/40 p-3 text-sm">
          {insight.recommendation}
        </p>

        <EvidenceList evidence={insight.evidence} currency={currency} />

        <p className="text-xs text-muted-foreground">
          <span className="font-medium">
            {CONFIDENCE_LABEL[insight.confidence]}.
          </span>{' '}
          {insight.basis}
        </p>
      </CardContent>
    </Card>
  )
}
