'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { Loader2, Minus, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiClientError, postJson } from '@/lib/client/api'
import { formatMoney } from '@/lib/money'
import type { ModifierGroupRules } from '@/modules/modifier/pricing'
import type { SessionBill } from '@/modules/session/order.service'

export interface DinerMenuItem {
  id: string
  name: string
  description: string | null
  priceMinor: number
  categoryName: string | null
  modifierGroups: ModifierGroupRules[]
}

interface CartLine {
  key: string
  menuItemId: string
  name: string
  quantity: number
  isShared: boolean
  unitPreviewMinor: number
  modifierSelections: { groupId: string; optionId: string; quantity: number }[]
  modifierLabels: string[]
}

/**
 * The diner ordering screen.
 *
 * The cart lives in component state, not in the database. A half-built cart
 * is not an order — persisting one would put unplaced items on a bill the
 * kitchen might see, and require a whole reconciliation story for carts that
 * are abandoned when someone closes the tab.
 *
 * Prices shown here are a preview computed from the same rules the server
 * uses. The server recomputes everything on submit; nothing sent from this
 * component is trusted as an amount.
 */
export function OrderScreen({
  items,
  bill,
  currency,
  displayName,
  billRequested,
}: {
  items: DinerMenuItem[]
  bill: SessionBill
  currency: string
  displayName: string
  billRequested: boolean
}) {
  const router = useRouter()
  const [cart, setCart] = useState<CartLine[]>([])
  const [configuring, setConfiguring] = useState<DinerMenuItem | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cartTotal = useMemo(
    () =>
      cart.reduce((sum, l) => sum + l.unitPreviewMinor * l.quantity, 0),
    [cart],
  )

  const byCategory = useMemo(() => {
    const map = new Map<string, DinerMenuItem[]>()
    for (const item of items) {
      const key = item.categoryName ?? 'More'
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return [...map.entries()]
  }, [items])

  function addToCart(
    item: DinerMenuItem,
    selections: CartLine['modifierSelections'],
    labels: string[],
    isShared: boolean,
  ) {
    const delta = selections.reduce((sum, s) => {
      const group = item.modifierGroups.find((g) => g.groupId === s.groupId)
      const option = group?.options.find((o) => o.optionId === s.optionId)
      return sum + (option?.priceDeltaMinor ?? 0) * s.quantity
    }, 0)

    setCart((current) => [
      ...current,
      {
        key: `${item.id}-${current.length}-${Date.now()}`,
        menuItemId: item.id,
        name: item.name,
        quantity: 1,
        isShared,
        unitPreviewMinor: Math.max(0, item.priceMinor + delta),
        modifierSelections: selections,
        modifierLabels: labels,
      },
    ])
  }

  async function placeOrder() {
    setError(null)
    setPending(true)

    try {
      await postJson('/api/diner/order', {
        lines: cart.map((line) => ({
          menuItemId: line.menuItemId,
          quantity: line.quantity,
          isShared: line.isShared,
          modifierSelections: line.modifierSelections,
        })),
      })

      toast.success('Order sent to the kitchen')
      setCart([])
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not place the order. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  async function callService(type: 'call_waiter' | 'request_bill') {
    try {
      await postJson('/api/diner/service', { type })
      toast.success(
        type === 'call_waiter'
          ? 'A waiter is on the way'
          : 'Your bill has been requested',
      )
      router.refresh()
    } catch {
      toast.error('Could not send that request.')
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-6 pb-40">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">Ordering as</p>
        <h1 className="text-xl font-semibold tracking-tight">{displayName}</h1>
      </header>

      {billRequested && (
        <Alert>
          <AlertDescription>
            The bill has been requested for this table, so no more items can be
            added. Please ask a member of staff if you need anything else.
          </AlertDescription>
        </Alert>
      )}

      {bill.lines.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <h2 className="text-sm font-medium">Already ordered</h2>
            <ul className="divide-y text-sm">
              {bill.lines.map((line) => (
                <li key={line.id} className="flex justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">
                      {line.quantity}× {line.nameSnapshot}
                    </span>
                    {line.memberId === null && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        shared
                      </Badge>
                    )}
                    {line.memberName && (
                      <span className="block text-xs text-muted-foreground">
                        {line.memberName}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {formatMoney(line.lineTotalMinor, currency)}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="space-y-1 border-t pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Yours</dt>
                <dd className="font-mono tabular-nums">
                  {formatMoney(bill.personalTotalMinor, currency)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Shared by the table</dt>
                <dd className="font-mono tabular-nums">
                  {formatMoney(bill.sharedTotalMinor, currency)}
                </dd>
              </div>
              <div className="flex justify-between font-medium">
                <dt>Table total</dt>
                <dd className="font-mono tabular-nums">
                  {formatMoney(bill.sessionTotalMinor, currency)}
                </dd>
              </div>
            </dl>

            <p className="text-xs text-muted-foreground">
              How shared items are divided is settled when you pay.
            </p>
          </CardContent>
        </Card>
      )}

      {!billRequested &&
        byCategory.map(([category, categoryItems]) => (
          <section key={category} className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {category}
            </h2>
            <ul className="space-y-2">
              {categoryItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      // Items with no choices to make go straight in.
                      if (item.modifierGroups.length === 0) {
                        addToCart(item, [], [], false)
                      } else {
                        setConfiguring(item)
                      }
                    }}
                    className="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{item.name}</span>
                      {item.description && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-sm tabular-nums">
                      {formatMoney(item.priceMinor, currency)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

      <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 p-4 backdrop-blur">
        <div className="mx-auto w-full max-w-lg space-y-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {cart.length > 0 && (
            <ul className="max-h-32 space-y-1 overflow-y-auto text-sm">
              {cart.map((line) => (
                <li
                  key={line.key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0 truncate">
                    {line.name}
                    {line.modifierLabels.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {' '}
                        · {line.modifierLabels.join(', ')}
                      </span>
                    )}
                    {line.isShared && (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        shared
                      </Badge>
                    )}
                  </span>

                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`One fewer ${line.name}`}
                      onClick={() =>
                        setCart((c) =>
                          line.quantity === 1
                            ? c.filter((l) => l.key !== line.key)
                            : c.map((l) =>
                                l.key === line.key
                                  ? { ...l, quantity: l.quantity - 1 }
                                  : l,
                              ),
                        )
                      }
                    >
                      <Minus className="size-3" />
                    </Button>
                    <span className="w-5 text-center tabular-nums">
                      {line.quantity}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`One more ${line.name}`}
                      onClick={() =>
                        setCart((c) =>
                          c.map((l) =>
                            l.key === line.key
                              ? { ...l, quantity: l.quantity + 1 }
                              : l,
                          ),
                        )
                      }
                    >
                      <Plus className="size-3" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-12"
              onClick={() => callService('call_waiter')}
            >
              Call waiter
            </Button>

            {cart.length > 0 ? (
              <Button
                type="button"
                className="h-12 flex-1 text-base"
                onClick={placeOrder}
                disabled={pending}
              >
                {pending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Place order · {formatMoney(cartTotal, currency)}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                className="h-12 flex-1"
                onClick={() => callService('request_bill')}
                disabled={billRequested}
              >
                {billRequested ? 'Bill requested' : 'Request bill'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <ConfigureDialog
        item={configuring}
        currency={currency}
        onClose={() => setConfiguring(null)}
        onAdd={(selections, labels, isShared) => {
          if (configuring) addToCart(configuring, selections, labels, isShared)
          setConfiguring(null)
        }}
      />
    </div>
  )
}

/**
 * Modifier selection for one item.
 *
 * Enforces min/max client-side purely so the button can be disabled with an
 * explanation. The server runs the same rules again on submit and is the only
 * thing that actually decides — this is convenience, not enforcement.
 */
function ConfigureDialog({
  item,
  currency,
  onClose,
  onAdd,
}: {
  item: DinerMenuItem | null
  currency: string
  onClose: () => void
  onAdd: (
    selections: { groupId: string; optionId: string; quantity: number }[],
    labels: string[],
    isShared: boolean,
  ) => void
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const [isShared, setIsShared] = useState(false)

  const groups = item?.modifierGroups ?? []

  const unmet = groups.filter(
    (g) => (chosen[g.groupId]?.length ?? 0) < g.minSelection,
  )

  function toggle(group: ModifierGroupRules, optionId: string) {
    setChosen((current) => {
      const existing = current[group.groupId] ?? []
      const isOn = existing.includes(optionId)

      if (isOn) {
        return { ...current, [group.groupId]: existing.filter((o) => o !== optionId) }
      }

      // A pick-one group swaps rather than accumulating, which is what a
      // radio-style choice does even though these render as buttons.
      if (group.maxSelection === 1) {
        return { ...current, [group.groupId]: [optionId] }
      }

      if (
        group.maxSelection !== null &&
        existing.length >= group.maxSelection
      ) {
        return current
      }

      return { ...current, [group.groupId]: [...existing, optionId] }
    })
  }

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(next) => {
        if (!next) {
          setChosen({})
          setIsShared(false)
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item?.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {groups.map((group) => (
            <div key={group.groupId} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>{group.name}</Label>
                <span className="text-xs text-muted-foreground">
                  {group.minSelection >= 1 ? 'Required' : 'Optional'}
                  {group.maxSelection === 1
                    ? ' · pick 1'
                    : group.maxSelection !== null
                      ? ` · up to ${group.maxSelection}`
                      : ''}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {group.options
                  .filter((o) => o.isAvailable)
                  .map((option) => {
                    const selected = (
                      chosen[group.groupId] ?? []
                    ).includes(option.optionId)

                    return (
                      <button
                        key={option.optionId}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggle(group, option.optionId)}
                        className={
                          selected
                            ? 'min-h-11 rounded-md border border-primary bg-primary px-3 text-sm text-primary-foreground'
                            : 'min-h-11 rounded-md border px-3 text-sm hover:bg-accent'
                        }
                      >
                        {option.name}
                        {option.priceDeltaMinor !== 0 && (
                          <span className="ml-1 text-xs opacity-80">
                            {option.priceDeltaMinor > 0 ? '+' : '−'}
                            {formatMoney(
                              Math.abs(option.priceDeltaMinor),
                              currency,
                            )}
                          </span>
                        )}
                      </button>
                    )
                  })}
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="pr-3">
              <Label htmlFor="isShared">Sharing with the table</Label>
              <p className="text-xs text-muted-foreground">
                Goes on the table’s bill rather than yours.
              </p>
            </div>
            <Switch
              id="isShared"
              checked={isShared}
              onCheckedChange={setIsShared}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            className="h-12 w-full text-base"
            disabled={unmet.length > 0}
            onClick={() => {
              const selections = Object.entries(chosen).flatMap(
                ([groupId, optionIds]) =>
                  optionIds.map((optionId) => ({
                    groupId,
                    optionId,
                    quantity: 1,
                  })),
              )

              const labels = Object.entries(chosen).flatMap(
                ([groupId, optionIds]) => {
                  const group = groups.find((g) => g.groupId === groupId)
                  return optionIds.map(
                    (optionId) =>
                      group?.options.find((o) => o.optionId === optionId)
                        ?.name ?? '',
                  )
                },
              )

              setChosen({})
              setIsShared(false)
              onAdd(selections, labels.filter(Boolean), isShared)
            }}
          >
            {unmet.length > 0
              ? `Choose ${unmet[0].name}`
              : 'Add to order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
