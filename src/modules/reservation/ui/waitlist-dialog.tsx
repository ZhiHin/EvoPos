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

export function WaitlistDialog({
  branchId,
  trigger,
}: {
  branchId: string
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
      const result = await postJson<{
        quotedWaitMinutes: number
        position: number
      }>('/api/waitlist', {
        branchId,
        guestName: form.get('guestName'),
        guestPhone: form.get('guestPhone') || undefined,
        partySize: Number(form.get('partySize')),
        notes: form.get('notes') || undefined,
      })

      toast.success(
        result.quotedWaitMinutes === 0
          ? `Added — number ${result.position}, seat them now`
          : `Added — number ${result.position}, quoted ${result.quotedWaitMinutes} minutes`,
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
            <DialogTitle>Add to the waiting list</DialogTitle>
            <DialogDescription>
              The quote is worked out from the parties ahead who want the same
              size of table, and it is kept — so “you said twenty minutes” can
              be answered honestly an hour later.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="wl-name">Name</Label>
              <Input
                id="wl-name"
                name="guestName"
                required
                maxLength={120}
                autoFocus
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wl-phone">Phone</Label>
                <Input id="wl-phone" name="guestPhone" maxLength={40} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wl-size">Party size</Label>
                <Input
                  id="wl-size"
                  name="partySize"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={2}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="wl-notes">Notes</Label>
              <Input id="wl-notes" name="notes" maxLength={500} />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
