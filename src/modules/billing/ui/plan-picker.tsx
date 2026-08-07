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
import { ApiClientError, postJson } from '@/lib/client/api'

interface Effect {
  direction: 'upgrade' | 'downgrade' | 'unchanged'
  wouldExceed: { quota: string; used: number; limit: number | null }[]
  wouldLose: string[]
}

/**
 * Changing plan.
 *
 * The consequences are fetched and shown BEFORE the change, not reported
 * afterwards. A customer downgrading is entitled to know which limits they
 * will be past and what stops working while they can still say no — finding
 * out afterwards is how a billing page loses somebody's trust permanently.
 */
export function PlanPicker({ to, name }: { to: string; name: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [effect, setEffect] = useState<Effect | null>(null)

  async function preview(next: boolean): Promise<void> {
    setOpen(next)
    if (!next) return

    try {
      setEffect(await postJson<Effect>('/api/plan/preview', { plan: to }))
    } catch {
      // The confirm dialog still works; it just cannot show the consequences.
      setEffect(null)
    }
  }

  async function confirm(): Promise<void> {
    setPending(true)

    try {
      await postJson('/api/plan', { plan: to })
      toast.success(`Now on ${name}`)
      setOpen(false)
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
    <Dialog open={open} onOpenChange={preview}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full">
          Move to {name}
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to {name}?</DialogTitle>
          <DialogDescription>
            {effect?.direction === 'downgrade'
              ? 'Nothing will be deleted. Here is what changes.'
              : 'This takes effect immediately.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm">
          {effect && effect.wouldExceed.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium">You will be over the allowance for:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {effect.wouldExceed.map((state) => (
                  <li key={state.quota}>
                    {state.quota} — using {state.used}, allowance{' '}
                    {state.limit ?? 'unlimited'}
                  </li>
                ))}
              </ul>
              {/*
                Said plainly, because it is the fear this dialog exists to
                answer. A downgrade must never be a destructive operation.
              */}
              <p className="text-xs text-muted-foreground">
                These keep working. You will not be able to add more until the
                plan changes again.
              </p>
            </div>
          )}

          {effect && effect.wouldLose.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium">These will switch off:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {effect.wouldLose.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            </div>
          )}

          {effect &&
            effect.wouldExceed.length === 0 &&
            effect.wouldLose.length === 0 && (
              <p className="text-muted-foreground">
                Nothing you are using today is affected.
              </p>
            )}
        </div>

        <DialogFooter>
          <Button onClick={confirm} disabled={pending}>
            {pending ? 'Changing…' : `Move to ${name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
