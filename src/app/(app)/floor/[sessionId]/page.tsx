import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requirePermission } from '@/lib/auth/context'
import { withTenant } from '@/lib/db'
import { diningSessions, diningTables } from '@/lib/db/schema'
import { formatMoney } from '@/lib/money'
import { computeSessionTotals } from '@/modules/pos/pos.service'
import {
  CloseSessionButton,
  RemoveDiscountButton,
  VoidLineButton,
} from '@/modules/pos/ui/session-actions'
import { readSessionBill } from '@/modules/session/order.service'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Bill' }

export default async function SessionPage({
  params,
}: PageProps<'/floor/[sessionId]'>) {
  const ctx = await requirePermission('order.view')
  const { sessionId } = await params
  const { restaurantId } = ctx.tenant
  const userId = ctx.user.id

  const data = await withTenant({ restaurantId, userId }, async (tx) => {
    const [session] = await tx
      .select({
        id: diningSessions.id,
        type: diningSessions.type,
        status: diningSessions.status,
        tableCode: diningTables.code,
        customerName: diningSessions.customerName,
        openedAt: diningSessions.openedAt,
      })
      .from(diningSessions)
      .leftJoin(diningTables, eq(diningTables.id, diningSessions.tableId))
      .where(eq(diningSessions.id, sessionId))
      .limit(1)

    if (!session) return null

    const [bill, totals] = await Promise.all([
      readSessionBill(tx, sessionId, null),
      computeSessionTotals(tx, restaurantId, sessionId),
    ])

    return { session, bill, totals }
  })

  // Absent, or another tenant's — indistinguishable, as it should be.
  if (!data) notFound()

  const settings = await getSettings(restaurantId, userId)
  const { session, bill, totals } = data

  const canVoid = ctx.tenant.permissions.has('order.void')
  const canClose = ctx.tenant.permissions.has('session.close')
  const canRemoveDiscount = ctx.tenant.permissions.has('discount.remove')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/floor"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Floor
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {session.tableCode ?? session.customerName ?? 'Order'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Opened {session.openedAt.toLocaleTimeString()} ·{' '}
            {session.type.replace('_', ' ')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {session.status === 'bill_requested' && (
            <Badge>bill requested</Badge>
          )}
          {canClose && session.status !== 'closed' && (
            <CloseSessionButton sessionId={session.id} />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Items</CardTitle>
          </CardHeader>
          <CardContent>
            {bill.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing ordered yet.
              </p>
            ) : (
              <ul className="divide-y">
                {bill.lines.map((line) => (
                  <li
                    key={line.id}
                    className="flex items-start justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">
                        {line.quantity}× {line.nameSnapshot}
                      </div>

                      {line.modifiers.length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          {line.modifiers
                            .map((m) => `${m.group}: ${m.option}`)
                            .join(' · ')}
                        </div>
                      )}

                      <div className="mt-1 flex items-center gap-2">
                        {line.memberName ? (
                          <span className="text-xs text-muted-foreground">
                            {line.memberName}
                          </span>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            shared
                          </Badge>
                        )}
                        {line.notes && (
                          <span className="text-xs italic text-muted-foreground">
                            “{line.notes}”
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-mono text-sm tabular-nums">
                        {formatMoney(line.lineTotalMinor, settings.currency)}
                      </span>
                      {canVoid && <VoidLineButton lineId={line.id} />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="font-mono tabular-nums">
                  {formatMoney(totals.subtotalMinor, settings.currency)}
                </dd>
              </div>

              {totals.discounts.map((discount) => (
                <div
                  key={discount.id}
                  className="flex items-center justify-between gap-2"
                >
                  <dt className="min-w-0 truncate text-muted-foreground">
                    {discount.reason}
                  </dt>
                  <dd className="flex shrink-0 items-center gap-1 font-mono tabular-nums">
                    −
                    {discount.type === 'percentage'
                      ? `${discount.value / 100}%`
                      : formatMoney(discount.value, settings.currency)}
                    {canRemoveDiscount && (
                      <RemoveDiscountButton discountId={discount.id} />
                    )}
                  </dd>
                </div>
              ))}

              {totals.discountMinor > 0 && (
                <div className="flex justify-between border-t pt-2">
                  <dt className="text-muted-foreground">After discount</dt>
                  <dd className="font-mono tabular-nums">
                    {formatMoney(
                      totals.discountedSubtotalMinor,
                      settings.currency,
                    )}
                  </dd>
                </div>
              )}

              {totals.serviceChargeMinor > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Service charge</dt>
                  <dd className="font-mono tabular-nums">
                    {formatMoney(totals.serviceChargeMinor, settings.currency)}
                  </dd>
                </div>
              )}

              {totals.taxMinor > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">
                    Tax{totals.taxIsIncluded ? ' (included)' : ''}
                  </dt>
                  <dd className="font-mono tabular-nums">
                    {formatMoney(totals.taxMinor, settings.currency)}
                  </dd>
                </div>
              )}

              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd className="font-mono tabular-nums">
                  {formatMoney(totals.totalMinor, settings.currency)}
                </dd>
              </div>
            </dl>

            {/* Payment is Phase 7. Saying so is better than a dead button. */}
            <Button className="mt-4 w-full" disabled>
              Take payment (Phase 7)
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
