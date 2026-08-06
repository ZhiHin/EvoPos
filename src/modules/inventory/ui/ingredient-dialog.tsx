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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiClientError, postJson } from '@/lib/client/api'

type Unit = 'kg' | 'l' | 'each'

const UNIT_LABEL: Record<Unit, string> = {
  kg: 'Kilograms',
  l: 'Litres',
  each: 'Each (pieces)',
}

export function IngredientDialog({ trigger }: { trigger: React.ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unit, setUnit] = useState<Unit>('kg')

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      await postJson('/api/inventory/ingredients', {
        name: form.get('name'),
        category: form.get('category') || undefined,
        unit,
        costPerUnit: form.get('costPerUnit') || 0,
        reorderPoint: form.get('reorderPoint') || 0,
        reorderQuantity: form.get('reorderQuantity') || 0,
      })

      toast.success('Ingredient added')
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
            <DialogTitle>New ingredient</DialogTitle>
            <DialogDescription>
              The unit is how this is bought, counted and costed. It cannot be
              changed once stock has moved.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required maxLength={120} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  name="category"
                  maxLength={80}
                  placeholder="Produce, Dry goods, Bar"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="unit">Unit</Label>
                <Select
                  value={unit}
                  onValueChange={(next) => setUnit(next as Unit)}
                >
                  <SelectTrigger id="unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(UNIT_LABEL) as Unit[]).map((key) => (
                      <SelectItem key={key} value={key}>
                        {UNIT_LABEL[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="costPerUnit">
                Cost per {unit === 'each' ? 'piece' : unit}
              </Label>
              <Input
                id="costPerUnit"
                name="costPerUnit"
                inputMode="decimal"
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground">
                A starting figure. Receiving a delivery replaces it with a
                weighted average of what you actually paid.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="reorderPoint">Reorder point</Label>
                <Input
                  id="reorderPoint"
                  name="reorderPoint"
                  inputMode="decimal"
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">
                  Blank or zero disables the alert.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reorderQuantity">Order quantity</Label>
                <Input
                  id="reorderQuantity"
                  name="reorderQuantity"
                  inputMode="decimal"
                  placeholder="0"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add ingredient'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
