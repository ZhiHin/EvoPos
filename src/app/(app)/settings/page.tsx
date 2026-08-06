import type { Metadata } from 'next'

import { requirePermission } from '@/lib/auth/context'
import { getSettings } from '@/modules/settings/settings.service'
import { SettingsForm } from '@/modules/settings/ui/settings-form'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const ctx = await requirePermission('settings.view')

  const settings = await getSettings(ctx.tenant.restaurantId, ctx.user.id)

  /**
   * Viewing and editing are separate permissions: a manager may need to read
   * the tax rate without being able to change what every bill charges.
   * `readOnly` disables the inputs, but the PATCH route's own
   * `requirePermission('settings.update')` is what actually refuses the write.
   */
  const readOnly = !ctx.tenant.permissions.has('settings.update')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          {readOnly
            ? 'You can view these settings but not change them.'
            : 'Applies across every branch of this restaurant.'}
        </p>
      </div>

      <SettingsForm settings={settings} readOnly={readOnly} />
    </div>
  )
}
