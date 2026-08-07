import type { Metadata } from 'next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { requirePermission } from '@/lib/auth/context'
import { planHasFeature } from '@/modules/billing/billing.service'
import { listApiKeys } from '@/modules/integration/api-key.service'
import {
  CreateApiKeyDialog,
  CreateWebhookDialog,
  DisabledBadge,
  EndpointActions,
  RevokeKeyButton,
} from '@/modules/integration/ui/integration-panels'
import { WEBHOOK_EVENT_LABEL } from '@/modules/integration/webhook'
import { listEndpoints } from '@/modules/integration/webhook.service'

export const metadata: Metadata = { title: 'Integrations' }

/**
 * API keys and outbound webhooks.
 *
 * Both are plan-gated, and the page says so rather than hiding the section —
 * an empty page with no explanation reads as broken, and a customer who cannot
 * see a capability exists will not upgrade to reach it.
 */
export default async function IntegrationsPage() {
  const ctx = await requirePermission('integration.view')
  const { restaurantId } = ctx.tenant

  const [keys, endpoints, hasKeys, hasWebhooks] = await Promise.all([
    listApiKeys(restaurantId, ctx.user.id),
    listEndpoints(restaurantId, ctx.user.id),
    planHasFeature({ restaurantId, userId: ctx.user.id }, 'apiKeys'),
    planHasFeature({ restaurantId, userId: ctx.user.id }, 'webhooks'),
  ])

  const canManage = ctx.tenant.permissions.has('integration.manage')

  /**
   * A key can only be granted permissions the person creating it holds.
   *
   * Enforced here for the picker and irrelevant to security on its own — but
   * worth stating: without it, anybody with `integration.manage` could mint a
   * key with permissions their own role was deliberately denied, which is a
   * privilege-escalation route through the integrations page.
   */
  const grantable = [...ctx.tenant.permissions].sort()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Ways for other systems to read from, and be told by, this restaurant.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">API keys</CardTitle>
              <CardDescription>
                Authenticate as{' '}
                <code className="text-xs">Authorization: Bearer …</code> against
                the same endpoints the app uses, with the same permission checks.
              </CardDescription>
            </div>
            {canManage && hasKeys && (
              <CreateApiKeyDialog availablePermissions={grantable} />
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!hasKeys ? (
            <p className="p-6 text-sm text-muted-foreground">
              API access is not included in your plan.
            </p>
          ) : keys.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No keys yet.
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {keys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center justify-between gap-4 px-6 py-3"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{key.name}</span>
                      <code className="font-mono text-[10px] text-muted-foreground">
                        {key.prefix}…
                      </code>
                      {key.revokedAt && (
                        <Badge variant="outline" className="text-[10px]">
                          revoked
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {key.permissions.length} permission
                      {key.permissions.length === 1 ? '' : 's'}
                      {key.lastUsedAt
                        ? ` · last used ${key.lastUsedAt.toLocaleDateString()}`
                        : ' · never used'}
                    </span>
                  </span>

                  {canManage && !key.revokedAt && (
                    <RevokeKeyButton keyId={key.id} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Webhooks</CardTitle>
              <CardDescription>
                Told when something happens here. Every delivery is signed;
                verify the signature before trusting the body.
              </CardDescription>
            </div>
            {canManage && hasWebhooks && <CreateWebhookDialog />}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!hasWebhooks ? (
            <p className="p-6 text-sm text-muted-foreground">
              Webhooks are not included in your plan.
            </p>
          ) : endpoints.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No endpoints yet.
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {endpoints.map((endpoint) => (
                <li key={endpoint.id} className="space-y-1 px-6 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-xs">
                          {endpoint.url}
                        </span>
                        {!endpoint.isActive && (
                          <DisabledBadge reason={endpoint.disabledReason} />
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {endpoint.events
                          .map((event) => WEBHOOK_EVENT_LABEL[event])
                          .join(' · ')}
                      </span>
                    </span>

                    {canManage && (
                      <EndpointActions
                        endpointId={endpoint.id}
                        isActive={endpoint.isActive}
                      />
                    )}
                  </div>

                  {endpoint.disabledReason && (
                    /*
                      The reason, always. An integration that quietly stopped
                      working with nothing to explain it is the worst version
                      of this failure.
                    */
                    <p className="text-xs text-destructive">
                      {endpoint.disabledReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Alert>
        <AlertDescription>
          Deliveries are queued and sent by a scheduled worker, not inline — so
          a slow endpoint can never slow down settling a bill. That worker has
          to be triggered from outside the application; see{' '}
          <code className="text-xs">docs/phase-14/README.md</code>.
        </AlertDescription>
      </Alert>
    </div>
  )
}
