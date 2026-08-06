'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, postJson } from '@/lib/client/api'

/**
 * The first thing a diner sees after scanning.
 *
 * One field. Asking for an account, an email or a phone number here is how
 * QR ordering dies — the person is sitting at a table holding a menu, and
 * every extra field is a reason to put the phone down and wait for a waiter.
 */
export function JoinForm({ token }: { token: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      await postJson(`/api/t/${token}/join`, {
        displayName: form.get('displayName'),
      })
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not join the table. Please try again.',
      )
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="displayName">Your name</Label>
        <Input
          id="displayName"
          name="displayName"
          required
          maxLength={40}
          autoFocus
          autoComplete="given-name"
          placeholder="Ali"
          className="h-12 text-base"
        />
        <p className="text-xs text-muted-foreground">
          So the table knows whose order is whose.
        </p>
      </div>

      <Button type="submit" className="h-12 w-full text-base" disabled={pending}>
        {pending ? 'Joining…' : 'Join table'}
      </Button>
    </form>
  )
}
