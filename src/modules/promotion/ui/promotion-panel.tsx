'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiClientError, postJson } from '@/lib/client/api'

interface AppliedPromotion {
  promotionId: string
  name: string
  discountMinor: number
}

/**
 * The till's controls for promotions.
 *
 * Neither button sends an amount. The server re-evaluates the bill and writes
 * the discount itself, so a tampered request can only ask for a re-check, not
 * name its own figure.
 */
export function PromotionPanel({
  sessionId,
  canRedeemVoucher,
}: {
  sessionId: string
  canRedeemVoucher: boolean
}) {
  const router = useRouter()
  const [applying, setApplying] = useState(false)
  const [redeeming, setRedeeming] = useState(false)
  const [code, setCode] = useState('')

  async function onApply() {
    setApplying(true)
    try {
      const result = await postJson<{ applied: AppliedPromotion[] }>(
        `/api/pos/sessions/${sessionId}/promotions`,
        {},
      )

      toast.success(
        result.applied.length === 0
          ? 'No promotions apply to this bill'
          : `Applied ${result.applied.map((p) => p.name).join(', ')}`,
      )
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not check promotions. Please try again.',
      )
    } finally {
      setApplying(false)
    }
  }

  async function onRedeem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!code.trim()) return

    setRedeeming(true)
    try {
      await postJson(`/api/pos/sessions/${sessionId}/voucher`, { code })
      toast.success('Voucher applied')
      setCode('')
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not redeem that code. Please try again.',
      )
    } finally {
      setRedeeming(false)
    }
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={onApply}
        disabled={applying}
      >
        {applying ? 'Checking…' : 'Check promotions'}
      </Button>

      {canRedeemVoucher && (
        <form onSubmit={onRedeem} className="flex gap-2">
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="Voucher code"
            aria-label="Voucher code"
            maxLength={40}
            className="font-mono uppercase"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={redeeming || code.trim().length === 0}
          >
            {redeeming ? '…' : 'Apply'}
          </Button>
        </form>
      )}
    </div>
  )
}
