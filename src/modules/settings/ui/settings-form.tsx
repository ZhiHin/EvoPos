'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiClientError, patchJson } from '@/lib/client/api'
import type { RestaurantSettings } from '@/modules/settings/settings.service'
import { basisPointsToPercent } from '@/modules/settings/settings.validation'

export function SettingsForm({
  settings,
  readOnly,
}: {
  settings: RestaurantSettings
  readOnly: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [taxInclusive, setTaxInclusive] = useState(settings.taxInclusive)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setFieldErrors({})
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      await patchJson('/api/settings', {
        name: form.get('name'),
        currency: form.get('currency'),
        timezone: form.get('timezone'),
        locale: form.get('locale'),
        taxRatePercent: Number(form.get('taxRatePercent')),
        serviceChargePercent: Number(form.get('serviceChargePercent')),
        taxInclusive,
      })

      toast.success('Settings saved')
      router.refresh()
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
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-8">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-4">
        <h2 className="text-sm font-medium">Restaurant</h2>

        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            required
            maxLength={120}
            defaultValue={settings.name}
            disabled={readOnly}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <Input
              id="currency"
              name="currency"
              required
              maxLength={3}
              defaultValue={settings.currency}
              disabled={readOnly}
              className="font-mono uppercase"
              aria-invalid={!!fieldErrors.currency}
            />
            {fieldErrors.currency && (
              <p className="text-xs text-destructive">{fieldErrors.currency}</p>
            )}
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="timezone">Time zone</Label>
            <Input
              id="timezone"
              name="timezone"
              required
              maxLength={64}
              defaultValue={settings.timezone}
              disabled={readOnly}
              placeholder="Asia/Kuala_Lumpur"
              aria-invalid={!!fieldErrors.timezone}
            />
            {fieldErrors.timezone && (
              <p className="text-xs text-destructive">{fieldErrors.timezone}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="locale">Language</Label>
          <Input
            id="locale"
            name="locale"
            required
            maxLength={10}
            defaultValue={settings.locale}
            disabled={readOnly}
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Tax and service charge</h2>
          <p className="text-xs text-muted-foreground">
            Applied to every bill. Changes are recorded in the audit trail.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="taxRatePercent">Tax rate (%)</Label>
            <Input
              id="taxRatePercent"
              name="taxRatePercent"
              type="number"
              required
              min={0}
              max={100}
              step={0.01}
              defaultValue={basisPointsToPercent(settings.taxRateBasisPoints)}
              disabled={readOnly}
              aria-invalid={!!fieldErrors.taxRatePercent}
            />
            {fieldErrors.taxRatePercent && (
              <p className="text-xs text-destructive">
                {fieldErrors.taxRatePercent}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="serviceChargePercent">Service charge (%)</Label>
            <Input
              id="serviceChargePercent"
              name="serviceChargePercent"
              type="number"
              required
              min={0}
              max={100}
              step={0.01}
              defaultValue={basisPointsToPercent(
                settings.serviceChargeBasisPoints,
              )}
              disabled={readOnly}
              aria-invalid={!!fieldErrors.serviceChargePercent}
            />
            {fieldErrors.serviceChargePercent && (
              <p className="text-xs text-destructive">
                {fieldErrors.serviceChargePercent}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5 pr-4">
            <Label htmlFor="taxInclusive">Menu prices include tax</Label>
            <p className="text-xs text-muted-foreground">
              On: tax is extracted from the price shown. Off: tax is added at
              checkout.
            </p>
          </div>
          <Switch
            id="taxInclusive"
            checked={taxInclusive}
            onCheckedChange={setTaxInclusive}
            disabled={readOnly}
          />
        </div>
      </section>

      {!readOnly && (
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      )}
    </form>
  )
}
