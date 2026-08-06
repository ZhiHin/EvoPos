import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { resolveTableByToken } from '@/modules/table/table.service'

export const metadata: Metadata = { title: 'Table' }

/**
 * The public QR landing page. No authentication, no session, no tenant.
 *
 * `resolveTableByToken` runs under `withQrToken`, where the only policies
 * that match are the three scoped to this exact token — so this page can
 * render one table and has no query shape capable of reaching a second.
 *
 * Phase 1 confirms the token resolves. Phase 4 turns this into the join flow:
 * the diner enters a name, a Dining Session member is created, and a
 * short-lived session token is issued. That short-lived token is the
 * "time-limited" credential the spec asks for; this printed one only names
 * the table and grants nothing.
 */
export default async function ScanPage({ params }: PageProps<'/t/[token]'>) {
  const { token } = await params
  const table = await resolveTableByToken(token)

  // 404 for unknown, rotated and malformed alike. Distinguishing them would
  // tell someone probing tokens whether they had found a real one.
  if (!table) notFound()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardDescription>{table.restaurantName}</CardDescription>
          <CardTitle className="text-2xl">
            {table.tableName ?? `Table ${table.tableCode}`}
          </CardTitle>
          <CardDescription>{table.branchName}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Ordering opens here soon. Please ask a member of staff in the
            meantime.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
