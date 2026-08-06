import type { Metadata } from 'next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { requirePermission } from '@/lib/auth/context'
import { formatMoney } from '@/lib/money'
import { listPromotions } from '@/modules/promotion/promotion.service'
import { PromotionDialog } from '@/modules/promotion/ui/promotion-dialog'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Promotions' }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "20% off", "RM 5.00 off", "Buy one get one free". */
function describeDiscount(
  kind: string,
  value: number,
  currency: string,
): string {
  switch (kind) {
    case 'percentage':
      // Stored in basis points, so 2000 reads back as 20%.
      return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}% off`
    case 'fixed':
      return `${formatMoney(value, currency)} off`
    case 'bogo':
      return 'Buy one get one free'
    case 'free_item':
      return 'Cheapest item free'
    default:
      return kind
  }
}

function describeWhen(promotion: {
  daysOfWeek: number[]
  startTime: string | null
  endTime: string | null
  validFrom: Date | null
  validTo: Date | null
}): string {
  const parts: string[] = []

  parts.push(
    promotion.daysOfWeek.length === 0
      ? 'Every day'
      : promotion.daysOfWeek
          .slice()
          .sort((a, b) => a - b)
          .map((day) => DAYS[day])
          .join(', '),
  )

  if (promotion.startTime && promotion.endTime) {
    parts.push(`${promotion.startTime}–${promotion.endTime}`)
  }

  if (promotion.validTo) {
    parts.push(`until ${promotion.validTo.toLocaleDateString()}`)
  }

  return parts.join(' · ')
}

export default async function PromotionsPage() {
  const ctx = await requirePermission('promotion.view')

  const [promotions, settings] = await Promise.all([
    listPromotions(ctx.tenant.restaurantId, ctx.user.id),
    getSettings(ctx.tenant.restaurantId, ctx.user.id),
  ])

  const canCreate = ctx.tenant.permissions.has('promotion.create')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Promotions</h1>
          <p className="text-sm text-muted-foreground">
            Evaluated against every bill at the till. Lower priority runs
            first, and a non-combining promotion takes the bill on its own.
          </p>
        </div>

        {canCreate && (
          <PromotionDialog trigger={<Button>New promotion</Button>} />
        )}
      </div>

      {promotions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No promotions yet. Create one — a happy hour, a spend threshold, a
            voucher campaign — and it applies itself at the till.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {promotions.map((promotion) => {
            const remaining =
              promotion.maxUsageTotal === null
                ? null
                : Math.max(0, promotion.maxUsageTotal - promotion.usageCount)

            return (
              <Card key={promotion.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {promotion.name}
                      </span>
                      {!promotion.isActive && (
                        <Badge variant="outline" className="text-[10px]">
                          paused
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {describeDiscount(
                        promotion.kind,
                        promotion.value,
                        settings.currency,
                      )}
                    </p>
                  </div>

                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    #{promotion.priority}
                  </span>
                </CardHeader>

                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  {promotion.description && (
                    <p className="text-foreground">{promotion.description}</p>
                  )}

                  <p>{describeWhen(promotion)}</p>

                  <div className="flex flex-wrap gap-1 pt-1">
                    {promotion.minSpendMinor > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        min {formatMoney(promotion.minSpendMinor, settings.currency)}
                      </Badge>
                    )}
                    {promotion.minQuantity > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        min {promotion.minQuantity} items
                      </Badge>
                    )}
                    {promotion.requiresVoucher && (
                      <Badge variant="secondary" className="text-[10px]">
                        voucher only
                      </Badge>
                    )}
                    {!promotion.isStackable && (
                      <Badge variant="secondary" className="text-[10px]">
                        exclusive
                      </Badge>
                    )}
                    {promotion.menuItemIds.length > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        {promotion.menuItemIds.length} items
                      </Badge>
                    )}
                    {promotion.categoryIds.length > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        {promotion.categoryIds.length} categories
                      </Badge>
                    )}
                  </div>

                  <p className="pt-1 tabular-nums">
                    Used {promotion.usageCount}
                    {remaining !== null && ` · ${remaining} left`}
                  </p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
