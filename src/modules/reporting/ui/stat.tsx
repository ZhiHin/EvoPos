import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Comparison } from '../report'

/**
 * The difference against the previous period, or an honest silence.
 *
 * `changeBasisPoints` is null when the previous period was zero. Growth from
 * nothing has no percentage: rendering it as +100% understates a first week
 * of trading and overstates a single sale, and either way it is a number
 * somebody will repeat.
 */
export function Delta({ comparison }: { comparison: Comparison }) {
  if (comparison.changeBasisPoints === null) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="size-3" aria-hidden />
        no comparison
      </span>
    )
  }

  const up = comparison.changeBasisPoints >= 0
  const Icon = up ? ArrowUpRight : ArrowDownRight

  return (
    <span
      className={cn(
        'flex items-center gap-1 text-xs tabular-nums',
        up ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {Math.abs(comparison.changeBasisPoints / 100).toFixed(1)}%
      <span className="text-muted-foreground">vs previous</span>
    </span>
  )
}

export function Stat({
  label,
  value,
  hint,
  comparison,
  className,
}: {
  label: string
  value: string
  hint?: string
  comparison?: Comparison
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="font-mono text-2xl tabular-nums">
          {value}
        </CardTitle>
        {comparison && <Delta comparison={comparison} />}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  )
}

/** A margin, or a plain dash when there is no meaningful one to state. */
export function formatPercent(basisPoints: number | null): string {
  if (basisPoints === null) return '—'
  return `${(basisPoints / 100).toFixed(1)}%`
}
