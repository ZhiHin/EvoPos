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
import { type StockUnit } from '@/modules/inventory/stock'

const REASONS = ['Spoiled', 'Dropped', 'Burnt', 'Expired', 'Over-portioned']

export function WastageDialog({
  branchId,
  ingredient,
  trigger,
}: {
  branchId: string
  ingredient: { ingredientId: string; name: string; unit: StockUnit }
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      await postJson('/api/inventory/wastage', {
        branchId,
        ingredientId: ingredient.ingredientId,
        quantity: form.get('quantity'),
        reason: reason || form.get('reason'),
      })

      toast.success('Wastage recorded')
      setOpen(false)
      setReason('')
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
            <DialogTitle>Record wastage</DialogTitle>
            <DialogDescription>
              {ingredient.name} — this writes the value off, so say what
              happened.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="quantity">
                Quantity ({ingredient.unit === 'each' ? 'pieces' : ingredient.unit})
              </Label>
              <Input
                id="quantity"
                name="quantity"
                inputMode="decimal"
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="reason">Reason</Label>
              <div className="flex flex-wrap gap-1">
                {REASONS.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    size="sm"
                    variant={reason === preset ? 'default' : 'outline'}
                    onClick={() => setReason(reason === preset ? '' : preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
              <Input
                id="reason"
                name="reason"
                maxLength={200}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Or type your own"
                required
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? 'Recording…' : 'Record wastage'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
