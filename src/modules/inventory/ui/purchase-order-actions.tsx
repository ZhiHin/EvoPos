'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ApiClientError, patchJson } from '@/lib/client/api'

export function PurchaseOrderActions({
  purchaseOrderId,
  status,
  canApprove,
  canCancel,
}: {
  purchaseOrderId: string
  status: string
  canApprove: boolean
  canCancel: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState<'approve' | 'cancel' | null>(null)

  const showApprove = canApprove && status === 'draft'
  const showCancel =
    canCancel && status !== 'received' && status !== 'cancelled'

  if (!showApprove && !showCancel) return null

  async function run(action: 'approve' | 'cancel') {
    if (action === 'cancel' && !window.confirm('Cancel this purchase order?')) {
      return
    }

    setPending(action)
    try {
      await patchJson(`/api/inventory/purchase-orders/${purchaseOrderId}`, {
        action,
        ...(action === 'cancel' ? { reason: 'Cancelled from the order' } : {}),
      })

      toast.success(action === 'approve' ? 'Approved' : 'Cancelled')
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <>
      {showApprove && (
        <Button
          variant="outline"
          onClick={() => run('approve')}
          disabled={pending !== null}
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
      )}
      {showCancel && (
        <Button
          variant="ghost"
          onClick={() => run('cancel')}
          disabled={pending !== null}
        >
          {pending === 'cancel' ? 'Cancelling…' : 'Cancel'}
        </Button>
      )}
    </>
  )
}
