'use client'

import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { ApiClientError, postJson } from '@/lib/client/api'

interface Tenant {
  id: string
  name: string
  roleName: string
}

export function TenantPicker({ tenants }: { tenants: Tenant[] }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(tenant: Tenant) {
    setBusyId(tenant.id)
    setError(null)

    try {
      /**
       * The switch happens server-side, where membership is re-checked. The
       * list rendered here came from the server too, but it arrived via the
       * client — so it is a suggestion to be verified, not an authorisation.
       */
      await postJson('/api/auth/switch-tenant', { restaurantId: tenant.id })

      startTransition(() => {
        router.push('/dashboard')
        router.refresh()
      })
    } catch (cause) {
      setBusyId(null)
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not switch restaurant. Please try again.',
      )
      toast.error('Could not switch restaurant')
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ul className="space-y-2">
        {tenants.map((tenant) => (
          <li key={tenant.id}>
            <Card
              role="button"
              tabIndex={0}
              aria-busy={busyId === tenant.id}
              onClick={() => choose(tenant)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  choose(tenant)
                }
              }}
              className="flex cursor-pointer flex-row items-center justify-between gap-3 p-4 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-busy:opacity-60"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{tenant.name}</div>
                <div className="text-xs text-muted-foreground">
                  {tenant.roleName}
                </div>
              </div>
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}
