'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

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

/**
 * Answering a recommendation.
 *
 * The reason field is required by the API, not just by this form — a dismissal
 * with no reason is indistinguishable from turning off an alarm, and the
 * person who finds it hidden six weeks later deserves an answer.
 *
 * Snoozing and dismissing are one control with two outcomes rather than two
 * buttons: "we are already ordering that" wants a week's quiet, and offering
 * only "dismiss for good" turns every temporary annoyance into a permanent
 * blind spot.
 */
export function DismissButton({
  insightKey,
  title,
}: {
  insightKey: string
  title: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [reason, setReason] = useState('')
  const [snooze, setSnooze] = useState('forever')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)

    try {
      await postJson('/api/insights/dismiss', {
        insightKey,
        reason,
        snoozeDays: snooze === 'forever' ? null : Number(snooze),
      })

      toast.success(
        snooze === 'forever'
          ? 'Dismissed'
          : `Snoozed for ${snooze} day${snooze === '1' ? '' : 's'}`,
      )
      setOpen(false)
      setReason('')
      router.refresh()
    } catch (cause) {
      toast.error(
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
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Dismiss
        </Button>
      </DialogTrigger>

      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Dismiss this recommendation</DialogTitle>
            <DialogDescription>{title}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="reason">Why?</Label>
              <Input
                id="reason"
                required
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Already reordering with the supplier"
              />
              {/*
                Not decoration. Whoever finds this hidden in six weeks needs to
                know whether it was answered or buried.
              */}
              <p className="text-xs text-muted-foreground">
                Recorded against your name in the audit trail, so anyone who
                wonders why this is hidden can find out.
              </p>
            </div>

            <div className="space-y-2">
              <Label>For how long?</Label>
              <Select value={snooze} onValueChange={setSnooze}>
                <SelectTrigger aria-label="Duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">A week</SelectItem>
                  <SelectItem value="30">A month</SelectItem>
                  <SelectItem value="forever">For good</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending || !reason.trim()}>
              {pending ? 'Saving…' : 'Dismiss'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
