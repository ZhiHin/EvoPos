'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ApiClientError, postJson } from '@/lib/client/api'
import { formatMinutes } from '@/modules/workforce/timesheet'

/**
 * Clocks the signed-in person in or out.
 *
 * Never takes a user — the server uses whoever is authenticated. Clocking in
 * for a colleague running late is buddy-punching, and the fix is to make it
 * unexpressible rather than to guard it.
 */
export function ClockButton({
  branchId,
  openPunch,
}: {
  branchId: string
  openPunch: { clockInAt: Date } | null
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function clock() {
    setPending(true)
    try {
      if (openPunch) {
        const result = await postJson<{ workedMinutes: number }>(
          '/api/attendance',
          { action: 'out', breakMinutes: 0 },
        )
        toast.success(`Clocked out — ${formatMinutes(result.workedMinutes)}`)
      } else {
        const result = await postJson<{ latenessMinutes: number }>(
          '/api/attendance',
          { action: 'in', branchId },
        )
        toast.success(
          result.latenessMinutes > 0
            ? `Clocked in — ${result.latenessMinutes}m late`
            : 'Clocked in',
        )
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
    <Button
      variant={openPunch ? 'outline' : 'default'}
      onClick={clock}
      disabled={pending}
    >
      {pending
        ? '…'
        : openPunch
          ? `Clock out (since ${new Date(openPunch.clockInAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })})`
          : 'Clock in'}
    </Button>
  )
}
