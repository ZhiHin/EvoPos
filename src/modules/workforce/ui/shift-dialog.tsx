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

export function ShiftDialog({
  branchId,
  staff,
  weekStart,
  trigger,
}: {
  branchId: string
  staff: { id: string; name: string }[]
  weekStart: string
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userId, setUserId] = useState(staff[0]?.id ?? '')

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const date = String(form.get('date'))
    const startTime = String(form.get('startTime'))
    const endTime = String(form.get('endTime'))

    const startsAt = new Date(`${date}T${startTime}:00`)
    const endsAt = new Date(`${date}T${endTime}:00`)

    // A shift ending before it starts is a night shift crossing midnight,
    // not a mistake — so it rolls to the next day rather than being rejected.
    if (endsAt <= startsAt) endsAt.setDate(endsAt.getDate() + 1)

    try {
      await postJson('/api/shifts', {
        branchId,
        userId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        position: form.get('position') || undefined,
        notes: form.get('notes') || undefined,
      })

      toast.success('Shift added as a draft')
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
            <DialogTitle>Add shift</DialogTitle>
            <DialogDescription>
              Saved as a draft. Nobody sees it until the week is published.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="shift-user">Person</Label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger id="shift-user">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="shift-date">Date</Label>
              <Input
                id="shift-date"
                name="date"
                type="date"
                defaultValue={weekStart}
                required
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="shift-start">Starts</Label>
                <Input
                  id="shift-start"
                  name="startTime"
                  type="time"
                  defaultValue="09:00"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shift-end">Ends</Label>
                <Input
                  id="shift-end"
                  name="endTime"
                  type="time"
                  defaultValue="17:00"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="shift-position">Position</Label>
              <Input
                id="shift-position"
                name="position"
                maxLength={80}
                placeholder="Bar, Pass, Front"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="shift-notes">Notes</Label>
              <Input id="shift-notes" name="notes" maxLength={500} />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add shift'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
