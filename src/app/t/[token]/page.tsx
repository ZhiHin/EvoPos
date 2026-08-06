import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { diningSessions, restaurants } from '@/lib/db/schema'
import { loadDinerMenu } from '@/modules/session/diner-menu'
import { withCurrentDiner } from '@/modules/session/diner'
import { readSessionBill } from '@/modules/session/order.service'
import { JoinForm } from '@/modules/session/ui/join-form'
import { OrderScreen } from '@/modules/session/ui/order-screen'
import { resolveTableByToken } from '@/modules/table/table.service'

export const metadata: Metadata = { title: 'Order' }

/**
 * The QR landing page.
 *
 * Two states, decided by whether the visitor already holds a live diner
 * cookie for a session: join, or order. Everything past the join is read
 * through the diner's own database context — this page never acquires tenant
 * context on their behalf.
 */
export default async function ScanPage({ params }: PageProps<'/t/[token]'>) {
  const { token } = await params

  const table = await resolveTableByToken(token)
  // 404 for unknown, rotated and malformed alike, so probing a token tells
  // you nothing about whether you found a real one.
  if (!table) notFound()

  const diner = await withCurrentDiner(async (tx, ctx) => {
    // A cookie from a different restaurant's table must not unlock this one.
    if (ctx.restaurantId !== table.restaurantId) return null

    const [session] = await tx
      .select({ status: diningSessions.status })
      .from(diningSessions)
      .where(eq(diningSessions.id, ctx.sessionId))
      .limit(1)

    if (!session || session.status === 'closed') return null

    const [restaurant] = await tx
      .select({ currency: restaurants.currency })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId))
      .limit(1)

    const [menu, bill] = await Promise.all([
      loadDinerMenu(tx, ctx.restaurantId),
      readSessionBill(tx, ctx.sessionId, ctx.memberId),
    ])

    return {
      displayName: ctx.displayName,
      currency: restaurant?.currency ?? 'MYR',
      billRequested: session.status === 'bill_requested',
      menu,
      bill,
    }
  })

  if (diner) {
    return (
      <div className="min-h-svh bg-muted/40 p-4">
        <OrderScreen
          items={diner.menu}
          bill={diner.bill}
          currency={diner.currency}
          displayName={diner.displayName}
          billRequested={diner.billRequested}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardDescription>{table.restaurantName}</CardDescription>
          <CardTitle className="text-2xl">
            {table.tableName ?? `Table ${table.tableCode}`}
          </CardTitle>
          <CardDescription>{table.branchName}</CardDescription>
        </CardHeader>
        <CardContent>
          <JoinForm token={token} />
        </CardContent>
      </Card>
    </div>
  )
}
