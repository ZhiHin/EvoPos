'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, postJson } from '@/lib/client/api'

export function RegisterForm() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setFieldErrors({})

    const form = new FormData(event.currentTarget)

    try {
      await postJson('/api/auth/register', {
        name: form.get('name'),
        email: form.get('email'),
        password: form.get('password'),
        restaurantName: form.get('restaurantName'),
      })

      toast.success('Welcome aboard')

      startTransition(() => {
        router.push('/dashboard')
        router.refresh()
      })
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        setError(cause.message)
        if (cause.details) {
          setFieldErrors(
            Object.fromEntries(
              Object.entries(cause.details).map(([k, v]) => [k, v[0]]),
            ),
          )
        }
      } else {
        setError('Something went wrong. Please try again.')
      }
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
          placeholder="Kopi Corner"
          aria-invalid={!!fieldErrors.restaurantName}
        />
        {fieldErrors.restaurantName && (
          <p className="text-xs text-destructive">
            {fieldErrors.restaurantName}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Your name</Label>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          required
          maxLength={120}
          aria-invalid={!!fieldErrors.name}
        />
        {fieldErrors.name && (
          <p className="text-xs text-destructive">{fieldErrors.name}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={!!fieldErrors.email}
        />
        {fieldErrors.email && (
          <p className="text-xs text-destructive">{fieldErrors.email}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          aria-invalid={!!fieldErrors.password}
        />
        {/* Mirrors the server rule in auth.validation.ts. The server is what
            enforces it; this only sets expectations before submitting. */}
        <p className="text-xs text-muted-foreground">
          At least 12 characters. A memorable phrase beats a short, complicated
          password.
        </p>
        {fieldErrors.password && (
          <p className="text-xs text-destructive">{fieldErrors.password}</p>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating your restaurant…' : 'Create account'}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </form>
  )
}
