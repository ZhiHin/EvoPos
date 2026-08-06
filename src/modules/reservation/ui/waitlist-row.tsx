'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiClientError, patchJson } from '@/lib/client/api'
import { minutesSince, useNow } from '@/lib/client/use-now'

interface Entry {
  id: string
  guestName: string
  guestPhone: string | null
  partySize: number
  quotedWaitMinutes: number
  status: string
  joinedAt: Date
  position: number
}

export function WaitlistRow({
  entry,
  tables,
  canManage,
}: {
  entry: Entry
  tables: { id: string; code: string }[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  // Ticks once a minute. How long someone has actually been waiting is the
  // number that decides who gets seated next, so it must not go stale.
  const waitedMinutes = minutesSince(entry.joinedAt, useNow())

  async function act(body: Record<string, unknown>, message: string) {
    setPending(true)
    try {
      const result = await patchJson<{ sessionId?: string }>(
        `/api/waitlist/${entry.id}`,
        body,
      )
      toast.success(message)

      if (result.sessionId) {
        router.push(`/floor/${result.sessionId}`)
        return
      }
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
          {entry.position}
        </span>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{entry.guestName}</span>
            <span className="shrink-0 text-sm text-muted-foreground">
              ×{entry.partySize}
            </span>
            {entry.status === 'notified' && (
              <Badge variant="secondary" className="text-[10px]">
                notified
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {waitedMinutes !== null && `waiting ${waitedMinutes}m · `}
            quoted {entry.quotedWaitMinutes}m
            {entry.guestPhone && ` · ${entry.guestPhone}`}
          </p>
        </div>
      </div>

      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => act({ action: 'left' }, 'Marked as left')}
            disabled={pending}
          >
            Left
          </Button>

          {entry.status === 'waiting' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => act({ action: 'notify' }, 'Marked as notified')}
              disabled={pending}
            >
              Notify
            </Button>
          )}

          {tables.length > 0 && (
            <Select
              value=""
              onValueChange={(tableId) =>
                act({ action: 'seat', tableId }, `${entry.guestName} seated`)
              }
            >
              <SelectTrigger
                className="w-[120px]"
                aria-label={`Seat ${entry.guestName}`}
                disabled={pending}
              >
                <SelectValue placeholder="Seat at…" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((table) => (
                  <SelectItem key={table.id} value={table.id}>
                    {table.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </li>
  )
}
