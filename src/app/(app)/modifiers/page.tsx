import type { Metadata } from 'next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { requirePermission } from '@/lib/auth/context'
import { formatMoney, minorToDecimalString } from '@/lib/money'
import { listModifierGroups } from '@/modules/modifier/modifier.service'
import { ModifierGroupDialog } from '@/modules/modifier/ui/modifier-group-dialog'
import { ModifierOptionDialog } from '@/modules/modifier/ui/modifier-option-dialog'
import { getSettings } from '@/modules/settings/settings.service'

export const metadata: Metadata = { title: 'Modifiers' }

/** "Required · pick 1", "Optional · pick up to 3", "Optional · any number". */
function describeRules(min: number, max: number | null): string {
  const requirement = min >= 1 ? 'Required' : 'Optional'

  if (max === null) return `${requirement} · any number`
  if (min === max) return `${requirement} · pick exactly ${max}`
  if (min >= 1) return `${requirement} · pick ${min}–${max}`
  return `${requirement} · pick up to ${max}`
}

export default async function ModifiersPage() {
  const ctx = await requirePermission('menu.modifier.view')

  const [groups, settings] = await Promise.all([
    listModifierGroups(ctx.tenant.restaurantId, ctx.user.id),
    getSettings(ctx.tenant.restaurantId, ctx.user.id),
  ])

  const canCreate = ctx.tenant.permissions.has('menu.modifier.create')
  const canEdit = ctx.tenant.permissions.has('menu.modifier.update')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Modifiers</h1>
          <p className="text-sm text-muted-foreground">
            Reusable questions asked about menu items. Attach a group to as
            many items as you like — editing it once updates them all.
          </p>
        </div>

        {canCreate && (
          <ModifierGroupDialog trigger={<Button>New group</Button>} />
        )}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No modifier groups yet. Create one — “Size”, “Ice level”, “Add-ons”
            — then add its options.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((group) => (
            <Card key={group.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                <div className="min-w-0">
                  <div className="font-medium">{group.name}</div>
                  <p className="text-xs text-muted-foreground">
                    {describeRules(group.minSelection, group.maxSelection)}
                  </p>
                  {group.description && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {group.description}
                    </p>
                  )}
                </div>

                {canEdit && (
                  <ModifierGroupDialog
                    group={group}
                    trigger={
                      <Button variant="ghost" size="sm">
                        Edit
                      </Button>
                    }
                  />
                )}
              </CardHeader>

              <CardContent className="space-y-3">
                {group.options.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No options yet. A required group with no options cannot be
                    satisfied, so add at least one.
                  </p>
                ) : (
                  <ul className="divide-y text-sm">
                    {group.options.map((option) => (
                      <li
                        key={option.id}
                        className="flex items-center justify-between gap-3 py-2"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{option.name}</span>
                          {option.isDefault && (
                            <Badge
                              variant="secondary"
                              className="text-[10px]"
                            >
                              default
                            </Badge>
                          )}
                          {!option.isAvailable && (
                            <Badge
                              variant="outline"
                              className="text-[10px]"
                            >
                              unavailable
                            </Badge>
                          )}
                          {option.maxQuantity > 1 && (
                            <span className="text-[10px] text-muted-foreground">
                              up to ×{option.maxQuantity}
                            </span>
                          )}
                        </span>

                        <span className="shrink-0 font-mono text-xs tabular-nums">
                          {option.priceDeltaMinor === 0
                            ? '—'
                            : option.priceDeltaMinor > 0
                              ? `+${formatMoney(option.priceDeltaMinor, settings.currency)}`
                              : `−${minorToDecimalString(Math.abs(option.priceDeltaMinor))}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {canEdit && (
                  <ModifierOptionDialog
                    groupId={group.id}
                    trigger={
                      <Button variant="outline" size="sm" className="w-full">
                        Add option
                      </Button>
                    }
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
