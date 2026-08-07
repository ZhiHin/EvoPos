import { formatMoney } from '@/lib/money'
import type { Evidence, EvidenceValue } from '../insights'

/**
 * The figures a finding was derived from.
 *
 * Shown beside every recommendation rather than behind a disclosure, because
 * an assertion without its evidence is a guess with a confident tone — and the
 * whole claim of this feature is that it never makes one.
 */
export function formatEvidence(
  value: EvidenceValue,
  currency: string,
): string {
  switch (value.kind) {
    case 'money':
      return formatMoney(value.minor, currency)
    case 'percent':
      return `${(value.basisPoints / 100).toFixed(1)}%`
    case 'count':
      return value.value.toLocaleString()
    case 'quantity':
      // Milli-units back to the human figure: 1500 -> "1.5 kg".
      return `${(value.milli / 1000).toLocaleString()} ${value.unit}`
    case 'text':
      return value.value
  }
}

export function EvidenceList({
  evidence,
  currency,
}: {
  evidence: readonly Evidence[]
  currency: string
}) {
  return (
    <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      {evidence.map((item) => (
        <div
          key={item.label}
          className="flex items-baseline justify-between gap-3 border-b border-dashed py-1"
        >
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="shrink-0 font-mono tabular-nums">
            {formatEvidence(item.value, currency)}
          </dd>
        </div>
      ))}
    </dl>
  )
}
