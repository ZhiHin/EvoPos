'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ApiClientError, postJson } from '@/lib/client/api'
import type { KitchenTicketGroup } from '@/modules/kitchen/kitchen.service'

/**
 * Age thresholds, in minutes.
 *
 * Derived from `placedAt` every render rather than stored. A "late" flag in
 * the database would need a background job to maintain and would be wrong
 * between runs — the clock is the only thing that actually knows.
 */
const WARN_AFTER_MINUTES = 8
const LATE_AFTER_MINUTES = 15

function minutesSince(date: Date): number {
  return Math.floor((Date.now() - new Date(date).getTime()) / 60_000)
}

export function TicketCard({ ticket }: { ticket: KitchenTicketGroup }) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)

  /**
   * Re-renders once a minute so the timer advances without a server round
   * trip. The queue itself is refreshed by the page's own polling.
   */
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  const age = minutesSince(ticket.placedAt)
  const tone =
    age >= LATE_AFTER_MINUTES
      ? 'border-destructive'
      : age >= WARN_AFTER_MINUTES
        ? 'border-primary'
        : undefined

  async function advance(lineId: string, to: 'preparing' | 'ready' | 'served') {
    setPending(lineId)
    try {
      await postJson(`/api/kitchen/lines/${lineId}/advance`, { to })
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not update that item.',
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <Card className={tone}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-lg font-semibold">{ticket.destination}</span>
          <span
            className={
              age >= LATE_AFTER_MINUTES
                ? 'font-mono text-lg font-bold tabular-nums text-destructive'
                : 'font-mono text-lg tabular-nums text-muted-foreground'
            }
          >
            {age}m
          </span>
        </div>

        <ul className="space-y-2">
          {ticket.lines.map((line) => (
            <li key={line.id} className="rounded-md border p-2">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium">
                    {line.quantity}× {line.nameSnapshot}
                  </span>

                  {line.modifiers.length > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {line.modifiers.join(' · ')}
                    </span>
                  )}

                  {/* Impossible to skim past — allergies live here. */}
                  {line.notes && (
                    <span className="mt-1 block rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                      {line.notes}
                    </span>
                  )}
                </span>

                {line.status !== 'pending' && (
                  <Badge
                    variant={line.status === 'ready' ? 'default' : 'secondary'}
                  >
                    {line.status}
                  </Badge>
                )}
              </div>

              <div className="mt-2 flex gap-2">
                {line.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 flex-1"
                    disabled={pending === line.id}
                    onClick={() => advance(line.id, 'preparing')}
                  >
                    Start
                  </Button>
                )}

                {line.status !== 'ready' && (
                  <Button
                    size="sm"
                    className="min-h-11 flex-1"
                    disabled={pending === line.id}
                    onClick={() => advance(line.id, 'ready')}
                  >
                    Ready
                  </Button>
                )}

                {line.status === 'ready' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-h-11 flex-1"
                    disabled={pending === line.id}
                    onClick={() => advance(line.id, 'served')}
                  >
                    Served
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
