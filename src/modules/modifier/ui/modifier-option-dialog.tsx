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
import { Switch } from '@/components/ui/switch'
import { ApiClientError, postJson } from '@/lib/client/api'

export function ModifierOptionDialog({
  trigger,
  groupId,
}: {
  trigger: React.ReactNode
  groupId: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDefault, setIsDefault] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      await postJson(`/api/menu/modifier-groups/${groupId}/options`, {
        name: form.get('name'),
        // Sent as a string; the server parses the sign and converts to minor
        // units, so "-0.50" is a legitimate discount.
        priceDelta: form.get('priceDelta') || 0,
        maxQuantity: Number(form.get('maxQuantity') ?? 1),
        isDefault,
      })

      toast.success('Option added')
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
            <DialogTitle>New option</DialogTitle>
            <DialogDescription>
              A price change may be negative — “Small” often costs less than
              the listed price.
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
              <Input
                id="name"
                name="name"
                required
                maxLength={80}
                placeholder="Large"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="priceDelta">Price change</Label>
                <Input
                  id="priceDelta"
                  name="priceDelta"
                  inputMode="decimal"
                  defaultValue="0"
                  placeholder="1.50 or -0.50"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxQuantity">Max per order</Label>
                <Input
                  id="maxQuantity"
                  name="maxQuantity"
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={1}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="pr-4">
                <Label htmlFor="isDefault">Selected by default</Label>
                <p className="text-xs text-muted-foreground">
                  Pre-ticked when a customer opens this item.
                </p>
              </div>
              <Switch
                id="isDefault"
                checked={isDefault}
                onCheckedChange={setIsDefault}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Add option'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
