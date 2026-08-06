import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { requireAuth } from '@/lib/auth/context'
import { listTenantsForUser } from '@/modules/rbac/rbac.repository'
import { TenantPicker } from '@/modules/tenancy/ui/tenant-picker'

export const metadata: Metadata = { title: 'Choose a restaurant' }

export default async function SelectRestaurantPage() {
  const ctx = await requireAuth()
  const tenants = await listTenantsForUser(ctx.user.id)

  if (tenants.length === 0) redirect('/onboarding')

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Choose a restaurant
          </h1>
          <p className="text-sm text-muted-foreground">
            You belong to {tenants.length} restaurants. Pick the one you want to
            work in.
          </p>
        </div>

        <TenantPicker tenants={tenants} />
      </div>
    </div>
  )
}
