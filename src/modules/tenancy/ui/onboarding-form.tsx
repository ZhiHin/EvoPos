'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, postJson } from '@/lib/client/api'

export function OnboardingForm() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = new FormData(event.currentTarget)

    try {
      await postJson('/api/onboarding', {
        restaurantName: form.get('restaurantName'),
      })

      toast.success('Restaurant created')

      startTransition(() => {
        router.push('/dashboard')
        router.refresh()
      })
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
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
        <Label htmlFor="restaurantName">Restaurant name</Label>
        <Input
          id="restaurantName"
          name="restaurantName"
          required
          maxLength={120}
          autoFocus
          placeholder="Kopi Corner"
        />
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating…' : 'Create restaurant'}
      </Button>
    </form>
  )
}
