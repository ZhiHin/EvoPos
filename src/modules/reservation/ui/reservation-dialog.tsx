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

interface Availability {
  available: boolean
  message: string | null
  alternatives: string[]
}

export function ReservationDialog({
  branchId,
  defaultDate,
  trigger,
}: {
  branchId: string
  defaultDate: string
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availability, setAvailability] = useState<Availability | null>(null)

  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState('19:00')
  const [partySize, setPartySize] = useState('2')

  function requestedAt(): Date {
    return new Date(`${date}T${time}:00`)
  }

  /**
   * Advisory only. The booking itself re-checks server-side, because two
   * people on two phones can both be told yes a moment before one of them
   * takes the last table.
   */
  async function check() {
    setError(null)
    try {
      const result = await postJson<Availability>(
        '/api/reservations/availability',
        {
          branchId,
          startsAt: requestedAt().toISOString(),
          partySize: Number(partySize),
        },
      )
      setAvailability(result)
    } catch {
      setAvailability(null)
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      await postJson('/api/reservations', {
        branchId,
        guestName: form.get('guestName'),
        guestPhone: form.get('guestPhone') || undefined,
        guestEmail: form.get('guestEmail') || undefined,
        partySize: Number(partySize),
        startsAt: requestedAt().toISOString(),
        occasion: form.get('occasion') || undefined,
        notes: form.get('notes') || undefined,
      })

      toast.success('Booking taken')
      setOpen(false)
      setAvailability(null)
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New booking</DialogTitle>
            <DialogDescription>
              A table is picked automatically — the smallest one that fits.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="guestName">Name</Label>
              <Input id="guestName" name="guestName" required maxLength={120} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="guestPhone">Phone</Label>
                <Input id="guestPhone" name="guestPhone" maxLength={40} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="partySize">Party size</Label>
                <Input
                  id="partySize"
                  type="number"
                  min={1}
                  max={100}
                  value={partySize}
                  onChange={(event) => setPartySize(event.target.value)}
                  onBlur={check}
                  required
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="date">Date</Label>
                <Input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  onBlur={check}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="time">Time</Label>
                <Input
                  id="time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  onBlur={check}
                  required
                />
              </div>
            </div>

            {availability && !availability.available && (
              <Alert>
                <AlertDescription className="space-y-2">
                  <span className="block">{availability.message}</span>
                  {availability.alternatives.length > 0 && (
                    <span className="flex flex-wrap gap-1 pt-1">
                      {availability.alternatives.map((alternative) => {
                        const when = new Date(alternative)
                        const label = when.toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })

                        return (
                          <Button
                            key={alternative}
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setTime(label.replace(/\s?[ap]m/i, ''))
                              setDate(when.toISOString().slice(0, 10))
                              setAvailability(null)
                            }}
                          >
                            {label}
                          </Button>
                        )
                      })}
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {availability?.available && (
              <p className="text-xs text-muted-foreground">
                A table is free at that time.
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="occasion">Occasion</Label>
                <Input
                  id="occasion"
                  name="occasion"
                  maxLength={120}
                  placeholder="Birthday, anniversary"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="guestEmail">Email</Label>
                <Input id="guestEmail" name="guestEmail" type="email" />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                name="notes"
                maxLength={500}
                placeholder="Allergies, wheelchair access, high chair"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Booking…' : 'Take booking'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
