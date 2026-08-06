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
import { minorToDecimalString } from '@/lib/money'
import { formatQuantity, type StockUnit } from '@/modules/inventory/stock'

interface OutstandingLine {
  id: string
  name: string
  unit: StockUnit
  orderedMilli: number
  receivedMilli: number
  unitCostMinor: number
}

/**
 * Records what actually turned up.
 *
 * Each line defaults to the outstanding quantity, because a complete delivery
 * is the common case and retyping the numbers is where mistakes come from.
 * Every field stays editable, because a short delivery is not an exception.
 */
export function ReceiveGoodsDialog({
  purchaseOrderId,
  lines,
  trigger,
}: {
  purchaseOrderId: string
  lines: OutstandingLine[]
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [values, setValues] = useState<Record<string, { received: string; cost: string }>>(
    () =>
      Object.fromEntries(
        lines.map((line) => [
          line.id,
          {
            received: String((line.orderedMilli - line.receivedMilli) / 1000),
            cost: minorToDecimalString(line.unitCostMinor),
          },
        ]),
      ),
  )

  function update(id: string, patch: Partial<{ received: string; cost: string }>) {
    setValues((current) => ({ ...current, [id]: { ...current[id], ...patch } }))
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const payload = lines
      .map((line) => ({
        purchaseOrderLineId: line.id,
        received: values[line.id]?.received ?? '0',
        unitCost: values[line.id]?.cost || undefined,
      }))
      .filter((line) => Number(line.received) > 0)

    if (payload.length === 0) {
      setError('Enter what was received on at least one line.')
      setPending(false)
      return
    }

    try {
      const result = await postJson<{ status: string }>(
        `/api/inventory/purchase-orders/${purchaseOrderId}/receive`,
        { lines: payload },
      )

      toast.success(
        result.status === 'received'
          ? 'Order fully received'
          : 'Partial delivery recorded',
      )
      setOpen(false)
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Receive goods</DialogTitle>
            <DialogDescription>
              Adjust anything that came up short. Receiving is what sets the
              cost of the stock, so correct the price if the invoice differs.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {lines.map((line) => (
              <div
                key={line.id}
                className="flex flex-wrap items-end gap-2 rounded-md border p-2"
              >
                <div className="min-w-[8rem] flex-1">
                  <div className="truncate text-sm">{line.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {formatQuantity(
                      line.orderedMilli - line.receivedMilli,
                      line.unit,
                    )}{' '}
                    outstanding
                  </div>
                </div>

                <div className="w-24 space-y-1">
                  <Label
                    htmlFor={`recv-${line.id}`}
                    className="text-[10px] text-muted-foreground"
                  >
                    received
                  </Label>
                  <Input
                    id={`recv-${line.id}`}
                    inputMode="decimal"
                    value={values[line.id]?.received ?? ''}
                    onChange={(event) =>
                      update(line.id, { received: event.target.value })
                    }
                  />
                </div>

                <div className="w-28 space-y-1">
                  <Label
                    htmlFor={`cost-${line.id}`}
                    className="text-[10px] text-muted-foreground"
                  >
                    cost / {line.unit === 'each' ? 'piece' : line.unit}
                  </Label>
                  <Input
                    id={`cost-${line.id}`}
                    inputMode="decimal"
                    value={values[line.id]?.cost ?? ''}
                    onChange={(event) =>
                      update(line.id, { cost: event.target.value })
                    }
                  />
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Recording…' : 'Record delivery'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
