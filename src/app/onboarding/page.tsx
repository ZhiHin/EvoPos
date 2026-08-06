import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { requireAuth } from '@/lib/auth/context'
import { listTenantsForUser } from '@/modules/rbac/rbac.repository'
import { OnboardingForm } from '@/modules/tenancy/ui/onboarding-form'

export const metadata: Metadata = { title: 'Set up your restaurant' }

export default async function OnboardingPage() {
  const ctx = await requireAuth()

  // Someone who already has a restaurant does not belong here.
  const tenants = await listTenantsForUser(ctx.user.id)
  if (tenants.length > 0) redirect('/dashboard')

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set up your restaurant</CardTitle>
          <CardDescription>
            You’re signed in as {ctx.user.email}. Name your restaurant to
            finish setting up.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardingForm />
        </CardContent>
      </Card>
    </div>
  )
}
