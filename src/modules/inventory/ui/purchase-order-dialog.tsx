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
import { minorToDecimalString } from '@/lib/money'
import type { StockUnit } from '@/modules/inventory/stock'

interface IngredientOption {
  id: string
  name: string
  unit: StockUnit
  costPerUnitMinor: number
}

interface Line {
  ingredientId: string
  quantity: string
  unitCost: string
}

export function PurchaseOrderDialog({
  suppliers,
  branches,
  ingredients,
  trigger,
}: {
  suppliers: { id: string; name: string }[]
  branches: { id: string; name: string }[]
  ingredients: IngredientOption[]
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '')
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '')
  const [lines, setLines] = useState<Line[]>([])

  const byId = new Map(ingredients.map((i) => [i.id, i]))

  const chosen = new Set(lines.map((line) => line.ingredientId))
  const available = ingredients.filter((i) => !chosen.has(i.id))

  function addLine(ingredientId: string) {
    const ingredient = byId.get(ingredientId)
    if (!ingredient) return

    setLines((current) => [
      ...current,
      {
        ingredientId,
        quantity: '',
        // Pre-filled with what it last cost. A price that has not changed is
        // the common case, and retyping it is where typos come from.
        unitCost: minorToDecimalString(ingredient.costPerUnitMinor),
      },
    ])
  }

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    )
  }

  const totalMinor = lines.reduce((sum, line) => {
    const quantity = Number(line.quantity)
    const cost = Number(line.unitCost)
    if (!Number.isFinite(quantity) || !Number.isFinite(cost)) return sum
    return sum + Math.round(quantity * cost * 100)
  }, 0)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (lines.length === 0) {
      setError('Add at least one line.')
      return
    }

    setPending(true)
    const form = new FormData(event.currentTarget)
    const expected = String(form.get('expectedAt') ?? '')

    try {
      await postJson('/api/inventory/purchase-orders', {
        branchId,
        supplierId,
        expectedAt: expected ? new Date(expected).toISOString() : undefined,
        notes: form.get('notes') || undefined,
        lines: lines.map((line) => ({
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          unitCost: line.unitCost,
        })),
      })

      toast.success('Purchase order raised')
      setOpen(false)
      setLines([])
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
            <DialogTitle>New purchase order</DialogTitle>
            <DialogDescription>
              Raised as a draft. Someone else has to approve it before goods
              can be received against it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="supplier">Supplier</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger id="supplier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {suppliers.map((supplier) => (
                      <SelectItem key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="branch">Deliver to</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger id="branch">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="expectedAt">Expected</Label>
              <Input id="expectedAt" name="expectedAt" type="date" />
            </div>

            <div className="space-y-2">
              <Label>Lines</Label>

              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nothing added yet.
                </p>
              )}

              {lines.map((line, index) => {
                const ingredient = byId.get(line.ingredientId)
                if (!ingredient) return null

                return (
                  <div
                    key={line.ingredientId}
                    className="flex flex-wrap items-end gap-2 rounded-md border p-2"
                  >
                    <span className="min-w-[8rem] flex-1 truncate text-sm">
                      {ingredient.name}
                    </span>

                    <div className="w-24 space-y-1">
                      <Label
                        htmlFor={`qty-${index}`}
                        className="text-[10px] text-muted-foreground"
                      >
                        {ingredient.unit === 'each' ? 'pieces' : ingredient.unit}
                      </Label>
                      <Input
                        id={`qty-${index}`}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(index, { quantity: event.target.value })
                        }
                        required
                      />
                    </div>

                    <div className="w-28 space-y-1">
                      <Label
                        htmlFor={`cost-${index}`}
                        className="text-[10px] text-muted-foreground"
                      >
                        cost / {ingredient.unit === 'each' ? 'piece' : ingredient.unit}
                      </Label>
                      <Input
                        id={`cost-${index}`}
                        inputMode="decimal"
                        value={line.unitCost}
                        onChange={(event) =>
                          updateLine(index, { unitCost: event.target.value })
                        }
                        required
                      />
                    </div>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setLines((current) =>
                          current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )
              })}

              {available.length > 0 && (
                <Select value="" onValueChange={addLine}>
                  <SelectTrigger aria-label="Add ingredient">
                    <SelectValue placeholder="Add an ingredient…" />
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((ingredient) => (
                      <SelectItem key={ingredient.id} value={ingredient.id}>
                        {ingredient.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input id="notes" name="notes" maxLength={1000} />
            </div>

            <div className="flex justify-between border-t pt-3 text-sm font-medium">
              <span>Total</span>
              <span className="font-mono tabular-nums">
                {minorToDecimalString(totalMinor)}
              </span>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending || lines.length === 0}>
              {pending ? 'Raising…' : 'Raise order'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
