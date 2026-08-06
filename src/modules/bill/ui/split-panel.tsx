'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ApiClientError, postJson } from '@/lib/client/api'
import { formatMoney } from '@/lib/money'
import type { LockedSplit } from '@/modules/bill/bill.service'

type StrategyKind = 'by_owner' | 'even' | 'by_percentage' | 'by_item'

interface PreviewShare {
  memberId: string
  displayName: string
  totalMinor: number
  subtotalMinor: number
  serviceChargeMinor: number
  taxMinor: number
  discountMinor: number
  lines: {
    lineId: string
    nameSnapshot: string
    amountMinor: number
    isShared: boolean
  }[]
}

interface PreviewResponse {
  strategy: StrategyKind
  shares: PreviewShare[]
  billTotalMinor: number
}

const STRATEGIES: { kind: StrategyKind; label: string; hint: string }[] = [
  {
    kind: 'by_owner',
    label: 'What each ordered',
    hint: 'Everyone pays for their own items; shared dishes divide evenly.',
  },
  {
    kind: 'even',
    label: 'Split evenly',
    hint: 'The whole bill divides equally, regardless of who ordered what.',
  },
]

/**
 * The split screen.
 *
 * Only the two strategies that need no further input are offered here.
 * `by_percentage` and `by_item` are fully supported by the engine and the
 * API, but each needs its own editor — per-person sliders, per-dish
 * assignment — and shipping a half-built one would be worse than saying
 * plainly that it is not here yet.
 */
export function SplitPanel({
  sessionId,
  currency,
  billTotalMinor,
  existingSplit,
  initialPreview,
  canLock,
  canVoid,
}: {
  sessionId: string
  currency: string
  billTotalMinor: number
  existingSplit: LockedSplit | null
  /**
   * The default (`by_owner`) split, computed on the server.
   *
   * Passing it in rather than fetching on mount means the amounts are on
   * screen in the first paint — no spinner, no flash — and the component
   * needs no effect at all. Changing strategy is a user action, so it
   * belongs in a handler.
   */
  initialPreview: PreviewResponse | null
  canLock: boolean
  canVoid: boolean
}) {
  const router = useRouter()
  const [strategy, setStrategy] = useState<StrategyKind>('by_owner')
  const [preview, setPreview] = useState<PreviewResponse | null>(initialPreview)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const alreadySplit = existingSplit !== null

  async function chooseStrategy(next: StrategyKind) {
    if (next === strategy) return

    setStrategy(next)
    setLoading(true)
    setError(null)

    try {
      setPreview(
        await postJson<PreviewResponse>(
          `/api/pos/sessions/${sessionId}/split/preview`,
          { strategy: { kind: next } },
        ),
      )
    } catch (cause) {
      setPreview(null)
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not work out the split.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function lock() {
    setPending(true)
    setError(null)

    try {
      await postJson(`/api/pos/sessions/${sessionId}/split`, {
        strategy: { kind: strategy },
        // Sent so the server can refuse if the bill moved while we were here.
        expectedBillTotalMinor: billTotalMinor,
      })
      toast.success('Split locked')
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not lock the split.',
      )
    } finally {
      setPending(false)
    }
  }

  async function voidExisting() {
    setPending(true)
    try {
      await postJson(`/api/pos/splits/${existingSplit!.id}/void`, {
        reason: 'Re-splitting the bill',
      })
      toast.success('Split voided')
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not void the split.',
      )
    } finally {
      setPending(false)
    }
  }

  if (alreadySplit) {
    const drifted =
      existingSplit.currentBillTotalMinor !== existingSplit.billTotalMinor

    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Split</CardTitle>
          <Badge variant="secondary">locked</Badge>
        </CardHeader>

        <CardContent className="space-y-3">
          {drifted && (
            <Alert>
              <AlertDescription>
                Items were added after this split was agreed. The split covers{' '}
                {formatMoney(existingSplit.billTotalMinor, currency)} but the
                bill is now{' '}
                {formatMoney(existingSplit.currentBillTotalMinor, currency)} —
                a difference of{' '}
                <strong>
                  {formatMoney(
                    existingSplit.currentBillTotalMinor -
                      existingSplit.billTotalMinor,
                    currency,
                  )}
                </strong>{' '}
                that nobody has been asked for.
              </AlertDescription>
            </Alert>
          )}

          <ul className="divide-y">
            {existingSplit.shares.map((share) => (
              <li
                key={share.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 truncate">{share.displayName}</span>
                <span className="shrink-0 font-mono text-sm tabular-nums">
                  {formatMoney(share.totalMinor, currency)}
                </span>
              </li>
            ))}
          </ul>

          {canVoid && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={pending}
              onClick={voidExisting}
            >
              Void and split again
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Split the bill</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {STRATEGIES.map((option) => (
            <button
              key={option.kind}
              type="button"
              aria-pressed={strategy === option.kind}
              disabled={loading}
              onClick={() => chooseStrategy(option.kind)}
              className={
                strategy === option.kind
                  ? 'min-h-11 rounded-md border border-primary bg-primary px-3 text-sm text-primary-foreground'
                  : 'min-h-11 rounded-md border px-3 text-sm hover:bg-accent'
              }
            >
              {option.label}
            </button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          {STRATEGIES.find((s) => s.kind === strategy)!.hint}
        </p>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Working out the split…
          </div>
        ) : preview ? (
          <>
            <ul className="divide-y">
              {preview.shares.map((share) => (
                <li key={share.memberId} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">
                      {share.displayName}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {formatMoney(share.totalMinor, currency)}
                    </span>
                  </div>

                  {share.lines.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {share.lines.map((l) => (
                        <li
                          key={`${share.memberId}-${l.lineId}`}
                          className="flex justify-between gap-2 text-xs text-muted-foreground"
                        >
                          <span className="min-w-0 truncate">
                            {l.nameSnapshot}
                            {l.isShared && ' (shared)'}
                          </span>
                          <span className="shrink-0 font-mono tabular-nums">
                            {formatMoney(l.amountMinor, currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            {/* Shown so a cashier can see at a glance that it adds up. */}
            <div className="flex justify-between border-t pt-2 text-sm font-medium">
              <span>Shares total</span>
              <span className="font-mono tabular-nums">
                {formatMoney(
                  preview.shares.reduce((sum, s) => sum + s.totalMinor, 0),
                  currency,
                )}
              </span>
            </div>

            {canLock && (
              <Button
                className="w-full"
                disabled={pending || preview.shares.length === 0}
                onClick={lock}
              >
                {pending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Lock this split
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nobody has joined this table yet, so there is nothing to split.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
