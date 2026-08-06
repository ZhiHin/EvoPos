'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, postJson } from '@/lib/client/api'
import { formatMoney, minorToDecimalString } from '@/lib/money'

type Method = 'cash' | 'card_terminal' | 'ewallet_terminal' | 'bank_transfer'

const METHODS: { value: Method; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card_terminal', label: 'Card' },
  { value: 'ewallet_terminal', label: 'E-wallet' },
  { value: 'bank_transfer', label: 'Transfer' },
]

interface TakePaymentResponse {
  amountMinor: number
  changeMinor: number
  roundingAdjustmentMinor: number
  wasReplay: boolean
  settlement: { outstandingMinor: number; isSettled: boolean }
}

export function TakePaymentDialog({
  sessionId,
  outstandingMinor,
  currency,
  splitShareId,
  trigger,
}: {
  sessionId: string
  outstandingMinor: number
  currency: string
  splitShareId?: string
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState<Method>('cash')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [change, setChange] = useState<number | null>(null)

  /**
   * Generated once per dialog opening, not per submit.
   *
   * That is the whole point: a double-click, or a retry after a dropped
   * connection, sends the SAME key and the server returns the original
   * payment instead of taking money twice. Regenerating it per attempt would
   * make the mechanism useless.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => globalThis.crypto.randomUUID(),
  )

  function reset(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      setIdempotencyKey(globalThis.crypto.randomUUID())
      setError(null)
      setChange(null)
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      const result = await postJson<TakePaymentResponse>(
        `/api/pos/sessions/${sessionId}/payments`,
        {
          method,
          amount: form.get('amount'),
          tendered: method === 'cash' ? form.get('tendered') : undefined,
          reference: form.get('reference') || undefined,
          splitShareId,
          idempotencyKey,
        },
      )

      if (result.wasReplay) {
        toast.info('That payment was already recorded')
      } else {
        toast.success(
          result.settlement.isSettled
            ? 'Paid in full'
            : `${formatMoney(result.settlement.outstandingMinor, currency)} still outstanding`,
        )
      }

      // Change stays on screen after the dialog would otherwise close, so the
      // cashier can count it out without reopening anything.
      if (result.changeMinor > 0) {
        setChange(result.changeMinor)
      } else {
        setOpen(false)
      }

      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not record the payment.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        {change !== null ? (
          <>
            <DialogHeader>
              <DialogTitle>Change due</DialogTitle>
            </DialogHeader>
            <p className="py-6 text-center font-mono text-4xl tabular-nums">
              {formatMoney(change, currency)}
            </p>
            <DialogFooter>
              <Button className="w-full" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <DialogHeader>
              <DialogTitle>Take payment</DialogTitle>
              <DialogDescription>
                {formatMoney(outstandingMinor, currency)} outstanding
                {splitShareId ? ' on this share' : ''}.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-2">
                {METHODS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={method === option.value}
                    onClick={() => setMethod(option.value)}
                    className={
                      method === option.value
                        ? 'min-h-11 flex-1 rounded-md border border-primary bg-primary px-3 text-sm text-primary-foreground'
                        : 'min-h-11 flex-1 rounded-md border px-3 text-sm hover:bg-accent'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <Input
                  id="amount"
                  name="amount"
                  inputMode="decimal"
                  required
                  defaultValue={minorToDecimalString(outstandingMinor)}
                  className="h-12 text-lg"
                />
              </div>

              {method === 'cash' ? (
                <div className="space-y-2">
                  <Label htmlFor="tendered">Cash received</Label>
                  <Input
                    id="tendered"
                    name="tendered"
                    inputMode="decimal"
                    required
                    defaultValue={minorToDecimalString(outstandingMinor)}
                    className="h-12 text-lg"
                  />
                  <p className="text-xs text-muted-foreground">
                    Cash totals round to the nearest 5 sen. The adjustment is
                    recorded and shown on the receipt.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="reference">Reference (optional)</Label>
                  <Input
                    id="reference"
                    name="reference"
                    maxLength={120}
                    placeholder="Terminal approval code"
                  />
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="submit" className="h-12 w-full" disabled={pending}>
                {pending ? 'Recording…' : 'Take payment'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
