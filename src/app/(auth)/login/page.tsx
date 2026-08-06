import { Suspense } from 'react'
import type { Metadata } from 'next'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { isGoogleAuthEnabled } from '@/lib/env'
import { LoginForm } from '@/modules/auth/ui/login-form'

export const metadata: Metadata = { title: 'Sign in' }

export default function LoginPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Welcome back. Enter your details to continue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* useSearchParams reads the ?error= set by the OAuth callback, which
            requires a Suspense boundary during prerender. */}
        <Suspense fallback={null}>
          <LoginForm googleEnabled={isGoogleAuthEnabled} />
        </Suspense>
      </CardContent>
    </Card>
  )
}
