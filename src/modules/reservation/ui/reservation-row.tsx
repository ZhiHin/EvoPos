'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ApiClientError, postJson } from '@/lib/client/api'

interface Reservation {
  id: string
  guestName: string
  guestPhone: string | null
  partySize: number
  startsAt: Date
  status: string
  tableCode: string | null
  occasion: string | null
  notes: string | null
}

export function ReservationRow({
  reservation,
  canSeat,
  canCancel,
}: {
  reservation: Reservation
  canSeat: boolean
  canCancel: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)

  async function seat() {
    setPending('seat')
    try {
      const result = await postJson<{ sessionId: string }>(
        `/api/reservations/${reservation.id}`,
        {},
      )
      toast.success(`${reservation.guestName} seated`)
      router.push(`/floor/${result.sessionId}`)
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not seat that booking.',
      )
      setPending(null)
    }
  }

  async function close(outcome: 'cancelled' | 'no_show') {
    const label = outcome === 'no_show' ? 'a no-show' : 'cancelled'
    if (!window.confirm(`Mark ${reservation.guestName} as ${label}?`)) return

    setPending(outcome)
    try {
      await postJson(`/api/reservations/${reservation.id}/cancel`, { outcome })
      toast.success(`Marked ${label}`)
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong.',
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 font-mono text-sm tabular-nums">
          {reservation.startsAt.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">
              {reservation.guestName}
            </span>
            <span className="shrink-0 text-sm text-muted-foreground">
              ×{reservation.partySize}
            </span>
            {reservation.tableCode && (
              <Badge variant="outline" className="text-[10px]">
                {reservation.tableCode}
              </Badge>
            )}
            {reservation.occasion && (
              <Badge variant="secondary" className="text-[10px]">
                {reservation.occasion}
              </Badge>
            )}
          </div>

          {(reservation.guestPhone || reservation.notes) && (
            <p className="truncate text-xs text-muted-foreground">
              {[reservation.guestPhone, reservation.notes]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {canCancel && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => close('no_show')}
              disabled={pending !== null}
            >
              No-show
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => close('cancelled')}
              disabled={pending !== null}
            >
              Cancel
            </Button>
          </>
        )}
        {canSeat && (
          <Button size="sm" onClick={seat} disabled={pending !== null}>
            {pending === 'seat' ? 'Seating…' : 'Seat'}
          </Button>
        )}
      </div>
    </li>
  )
}
