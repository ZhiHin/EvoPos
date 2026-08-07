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
import { readPlanStatus } from '@/modules/billing/billing.service'
import {
  FEATURE_LABEL,
  PLAN_ORDER,
  PLANS,
  QUOTA_LABEL,
  type Feature,
} from '@/modules/billing/plans'
import { PlanPicker } from '@/modules/billing/ui/plan-picker'

export const metadata: Metadata = { title: 'Plan' }

const ALL_FEATURES: Feature[] = [
  'advisor',
  'export',
  'webhooks',
  'apiKeys',
  'groupDashboard',
]

/**
 * The plan, and how much of it is being used.
 *
 * Being over a limit is shown as a state, not an error. A downgrade — or an
 * account that grew past its plan — leaves nothing deleted and nothing hidden;
 * the only consequence is that the next create is refused, and this page says
 * exactly that rather than implying something has to be removed.
 */
export default async function PlanPage() {
  const ctx = await requirePermission('billing.view')

  const status = await readPlanStatus(ctx.tenant.restaurantId, ctx.user.id)
  const canManage = ctx.tenant.permissions.has('billing.manage')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plan</h1>
        <p className="text-sm text-muted-foreground">
          On {status.plan.name} · {status.plan.summary}
        </p>
      </div>

      {status.overQuota.length > 0 && (
        <Alert>
          <AlertDescription>
            {/*
              Deliberately not phrased as an error, and deliberately explicit
              that nothing needs removing. Refusing a downgrade until data is
              deleted would make the only route to lower spend a destructive
              one.
            */}
            This account is past its allowance for{' '}
            {status.overQuota
              .map((state) => QUOTA_LABEL[state.quota])
              .join(' and ')}
            . Everything keeps working and nothing has been removed — the only
            effect is that adding another one is refused until the plan
            changes.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage</CardTitle>
          <CardDescription>
            Counted now, not from a running total — so what you see is what the
            system will use when it decides.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {status.quotas.map((state) => {
            const percent =
              state.limit === null
                ? 0
                : Math.min(100, Math.round((state.used / state.limit) * 100))

            return (
              <div key={state.quota} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="capitalize">
                    {QUOTA_LABEL[state.quota]}
                  </span>
                  <span className="font-mono text-xs tabular-nums">
                    {state.used.toLocaleString()}
                    {state.limit === null
                      ? ' · no limit'
                      : ` / ${state.limit.toLocaleString()}`}
                  </span>
                </div>

                {state.limit !== null && (
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                    role="presentation"
                  >
                    <div
                      className={
                        state.isOverQuota
                          ? 'h-full bg-destructive'
                          : 'h-full bg-primary'
                      }
                      style={{ width: `${String(percent)}%` }}
                    />
                  </div>
                )}

                {state.quota === 'monthlyBills' && (
                  /*
                    Stated on the page because it is the one allowance that is
                    never enforced. Software that refused to settle a bill on a
                    busy Saturday over a billing threshold would be software
                    nobody could run a restaurant on.
                  */
                  <p className="text-xs text-muted-foreground">
                    Measured since {status.periodStart.toLocaleDateString()}.
                    This one is never enforced — bills are always settled, and
                    going past it is a conversation rather than an outage.
                  </p>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What is included</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {ALL_FEATURES.map((feature) => {
            const included = status.plan.features.includes(feature)

            return (
              <Badge
                key={feature}
                variant={included ? 'secondary' : 'outline'}
                className={included ? undefined : 'text-muted-foreground'}
              >
                {FEATURE_LABEL[feature]}
                {!included && ' — not included'}
              </Badge>
            )
          })}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLAN_ORDER.map((key) => {
          const plan = PLANS[key]
          const isCurrent = key === status.plan.key

          return (
            <Card key={key} className={isCurrent ? 'border-primary' : undefined}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{plan.name}</CardTitle>
                <CardDescription>{plan.summary}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {(
                    Object.keys(plan.limits) as (keyof typeof plan.limits)[]
                  ).map((quota) => (
                    <li key={quota} className="flex justify-between gap-2">
                      <span className="capitalize">{QUOTA_LABEL[quota]}</span>
                      <span className="font-mono tabular-nums">
                        {plan.limits[quota]?.toLocaleString() ?? 'unlimited'}
                      </span>
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <p className="text-xs font-medium">Current plan</p>
                ) : canManage ? (
                  <PlanPicker to={key} name={plan.name} />
                ) : null}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {!canManage && (
        <p className="text-xs text-muted-foreground">
          Changing the plan needs the <code>billing.manage</code> permission,
          which your role does not hold.
        </p>
      )}
    </div>
  )
}
