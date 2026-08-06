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
import { formatQuantity, type StockUnit } from '@/modules/inventory/stock'

/**
 * Records what is physically on the shelf.
 *
 * Asks for the counted quantity, never a difference. Someone with a clipboard
 * knows there are 4 kg; making them work out that this is 1.4 kg less than
 * the system thinks is asking for arithmetic under time pressure, and the
 * mistakes go straight into the books.
 */
export function CountDialog({
  branchId,
  ingredient,
  trigger,
}: {
  branchId: string
  ingredient: {
    ingredientId: string
    name: string
    unit: StockUnit
    quantityMilli: number
  }
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      const result = await postJson<{ adjustmentMilli: number }>(
        '/api/inventory/count',
        {
          branchId,
          ingredientId: ingredient.ingredientId,
          counted: form.get('counted'),
          reason: form.get('reason') || undefined,
        },
      )

      toast.success(
        result.adjustmentMilli === 0
          ? 'Counted — the books were right'
          : `Adjusted by ${formatQuantity(Math.abs(result.adjustmentMilli), ingredient.unit)}`,
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
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Count {ingredient.name}</DialogTitle>
            <DialogDescription>
              The system currently thinks there is{' '}
              {formatQuantity(ingredient.quantityMilli, ingredient.unit)}.
              Enter what is actually there.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="counted">
                Counted ({ingredient.unit === 'each' ? 'pieces' : ingredient.unit})
              </Label>
              <Input
                id="counted"
                name="counted"
                inputMode="decimal"
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="reason">Note</Label>
              <Input
                id="reason"
                name="reason"
                maxLength={200}
                placeholder="Optional"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Record count'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
