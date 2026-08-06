'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, postJson } from '@/lib/client/api'

const OAUTH_ERRORS: Record<string, string> = {
  oauth_expired: 'That sign-in attempt timed out. Please try again.',
  oauth_rejected:
    'Google sign-in was rejected. Try signing in with your password.',
  oauth_failed: 'Google sign-in failed. Please try again.',
}

export function LoginForm({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(
    OAUTH_ERRORS[params.get('error') ?? ''] ?? null,
  )

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = new FormData(event.currentTarget)

    try {
      const result = await postJson<{ restaurantId: string | null }>(
        '/api/auth/login',
        {
          email: form.get('email'),
          password: form.get('password'),
        },
      )

      toast.success('Signed in')

      // A user with several restaurants lands tenant-less and has to choose.
      const next = result.restaurantId
        ? (params.get('next') ?? '/dashboard')
        : '/select-restaurant'

      startTransition(() => {
        router.push(next)
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
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@restaurant.com"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {googleEnabled && (
        <>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">
                or continue with
              </span>
            </div>
          </div>

          {/* A plain link, not fetch: the OAuth flow is a browser redirect. */}
          <Button asChild variant="outline" className="w-full">
            <a href="/api/auth/google">Continue with Google</a>
          </Button>
        </>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Don’t have an account?{' '}
        <Link
          href="/register"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Create one
        </Link>
      </p>
    </div>
  )
}
