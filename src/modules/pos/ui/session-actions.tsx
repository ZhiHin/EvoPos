'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ApiClientError, deleteJson, postJson } from '@/lib/client/api'

/**
 * Small action buttons shared across the floor and session screens.
 *
 * Each one is a single server call followed by `router.refresh()` — the page
 * re-reads from the database rather than patching local state, so what staff
 * see is always what is actually recorded rather than an optimistic guess
 * that might have failed.
 */

function useAction() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function run(fn: () => Promise<unknown>, success: string) {
    setPending(true)
    try {
      await fn()
      toast.success(success)
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'That did not work. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return { pending, run }
}

export function ResolveRequestButton({ requestId }: { requestId: string }) {
  const { pending, run } = useAction()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        run(
          () => postJson(`/api/pos/service-requests/${requestId}`, {}),
          'Marked as handled',
        )
      }
    >
      Handled
    </Button>
  )
}

export function CloseSessionButton({ sessionId }: { sessionId: string }) {
  const { pending, run } = useAction()
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
        Close bill
      </Button>
    )
  }

  return (
    <span className="flex gap-2">
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() =>
          run(
            () => postJson(`/api/pos/sessions/${sessionId}/close`, {}),
            'Bill closed and table freed',
          )
        }
      >
        Confirm close
      </Button>
    </span>
  )
}

export function VoidLineButton({ lineId }: { lineId: string }) {
  const { pending, run } = useAction()
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Void
      </Button>
    )
  }

  return (
    <span className="flex items-center gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
        maxLength={200}
        className="h-8 w-32 rounded-md border bg-transparent px-2 text-xs"
      />
      <Button
        size="sm"
        variant="destructive"
        // A void without a stated reason is exactly the record nobody can
        // audit later, so the button stays disabled until there is one.
        disabled={pending || reason.trim().length === 0}
        onClick={() =>
          run(
            () =>
              postJson(`/api/pos/order-lines/${lineId}/void`, {
                reason: reason.trim(),
              }),
            'Item voided',
          )
        }
      >
        Void
      </Button>
    </span>
  )
}

export function RemoveDiscountButton({ discountId }: { discountId: string }) {
  const { pending, run } = useAction()

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        run(
          () => deleteJson(`/api/pos/discounts/${discountId}`),
          'Discount removed',
        )
      }
    >
      Remove
    </Button>
  )
}
