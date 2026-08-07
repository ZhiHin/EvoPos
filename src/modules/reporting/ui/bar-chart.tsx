import { cn } from '@/lib/utils'

/**
 * A bar chart, in CSS.
 *
 * No charting library. What these charts need is a proportional bar and a
 * readable label; a library would bring a runtime, a theme system and a
 * canvas that prints as a blank rectangle. This renders on the server, needs
 * no JavaScript, inherits the theme, and appears on the printed page.
 *
 * Bars are scaled against the largest value rather than against a rounded
 * axis maximum, so the tallest bar is always full height. That is the right
 * choice for comparing days to each other and the wrong one for judging
 * absolute size, which is what the figure beside each bar is for.
 */
export function BarChart({
  data,
  className,
}: {
  data: { label: string; value: number; caption?: string }[]
  className?: string
}) {
  const peak = Math.max(...data.map((point) => point.value), 0)

  if (data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing to chart for this period.
      </p>
    )
  }

  return (
    <ul className={cn('space-y-1.5', className)}>
      {data.map((point) => (
        <li key={point.label} className="flex items-center gap-3 text-sm">
          <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">
            {point.label}
          </span>

          <span
            className="h-5 min-w-px rounded-sm bg-primary/80"
            style={{
              // A zero-value bar still shows a hairline, so a day that traded
              // nothing is visibly present rather than looking like a gap in
              // the data.
              width: peak > 0 ? `${Math.max(0.5, (point.value / peak) * 100)}%` : '0.5%',
            }}
            aria-hidden
          />

          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
            {point.caption ?? point.value}
          </span>
        </li>
      ))}
    </ul>
  )
}
