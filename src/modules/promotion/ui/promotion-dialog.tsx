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
import { Switch } from '@/components/ui/switch'
import { ApiClientError, postJson } from '@/lib/client/api'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Kind = 'percentage' | 'fixed' | 'bogo' | 'free_item'

/**
 * The value field means something different per kind, so it is labelled per
 * kind rather than left as a bare number the manager has to interpret.
 */
const VALUE_LABEL: Record<Kind, string | null> = {
  percentage: 'Percentage off',
  fixed: 'Amount off',
  bogo: null,
  free_item: null,
}

export function PromotionDialog({ trigger }: { trigger: React.ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('percentage')
  const [days, setDays] = useState<number[]>([])
  const [isStackable, setIsStackable] = useState(true)
  const [requiresVoucher, setRequiresVoucher] = useState(false)

  const valueLabel = VALUE_LABEL[kind]

  function toggleDay(day: number) {
    setDays((current) =>
      current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day],
    )
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const start = String(form.get('startTime') ?? '')
    const end = String(form.get('endTime') ?? '')
    const maxUsage = String(form.get('maxUsageTotal') ?? '')

    try {
      await postJson('/api/promotions', {
        name: form.get('name'),
        description: form.get('description') || undefined,
        kind,
        value: valueLabel ? form.get('value') : undefined,
        priority: Number(form.get('priority') || 100),
        isStackable,
        isActive: true,
        minSpend: form.get('minSpend') || undefined,
        minQuantity: Number(form.get('minQuantity') || 0),
        requiresVoucher,
        // An empty set means every day, not no days — sending [] lets the
        // engine skip the check rather than reject every evaluation.
        daysOfWeek: days.length === 7 ? [] : days,
        startTime: start || undefined,
        endTime: end || undefined,
        maxUsageTotal: maxUsage ? Number(maxUsage) : undefined,
      })

      toast.success('Promotion created')
      setOpen(false)
      setDays([])
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New promotion</DialogTitle>
            <DialogDescription>
              Rules are checked against the bill at the till. Leave a condition
              blank to skip it.
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

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" name="description" maxLength={500} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="kind">Discount type</Label>
                <Select
                  value={kind}
                  onValueChange={(next) => setKind(next as Kind)}
                >
                  <SelectTrigger id="kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage off</SelectItem>
                    <SelectItem value="fixed">Fixed amount off</SelectItem>
                    <SelectItem value="bogo">Buy one get one free</SelectItem>
                    <SelectItem value="free_item">Cheapest item free</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {valueLabel && (
                <div className="space-y-2">
                  <Label htmlFor="value">{valueLabel}</Label>
                  <Input
                    id="value"
                    name="value"
                    inputMode="decimal"
                    required
                    placeholder={kind === 'percentage' ? '10' : '5.00'}
                  />
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="minSpend">Minimum spend</Label>
                <Input
                  id="minSpend"
                  name="minSpend"
                  inputMode="decimal"
                  placeholder="Any"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="minQuantity">Minimum items</Label>
                <Input
                  id="minQuantity"
                  name="minQuantity"
                  type="number"
                  min={0}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Days it runs</Label>
              <div className="flex flex-wrap gap-1">
                {DAYS.map((label, day) => (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant={days.includes(day) ? 'default' : 'outline'}
                    onClick={() => toggleDay(day)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {days.length === 0 || days.length === 7
                  ? 'Runs every day.'
                  : `Runs on ${days.length} day${days.length === 1 ? '' : 's'}.`}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="startTime">Starts at</Label>
                <Input id="startTime" name="startTime" type="time" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endTime">Ends at</Label>
                <Input id="endTime" name="endTime" type="time" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Input
                  id="priority"
                  name="priority"
                  type="number"
                  min={0}
                  defaultValue={100}
                />
                <p className="text-xs text-muted-foreground">
                  Lower runs first.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxUsageTotal">Total redemptions</Label>
                <Input
                  id="maxUsageTotal"
                  name="maxUsageTotal"
                  type="number"
                  min={1}
                  placeholder="Unlimited"
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="pr-4">
                <Label htmlFor="isStackable">Combines with others</Label>
                <p className="text-xs text-muted-foreground">
                  Off means this promotion takes the bill on its own.
                </p>
              </div>
              <Switch
                id="isStackable"
                checked={isStackable}
                onCheckedChange={setIsStackable}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="pr-4">
                <Label htmlFor="requiresVoucher">Needs a voucher code</Label>
                <p className="text-xs text-muted-foreground">
                  Never applies automatically — a code must be entered.
                </p>
              </div>
              <Switch
                id="requiresVoucher"
                checked={requiresVoucher}
                onCheckedChange={setRequiresVoucher}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create promotion'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
