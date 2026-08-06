import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requireDiner } from '@/modules/session/diner'
import { readSessionBill } from '@/modules/session/order.service'

/**
 * The current diner's view of their table's bill.
 *
 * Scoped by row-level security, not by the query: `order_lines_member_read`
 * only matches rows whose session equals `app.session_id`, so this endpoint
 * has no shape that could return another table's items.
 */
export const GET = withRoute(async () => {
  const bill = await requireDiner((tx, diner) =>
    readSessionBill(tx, diner.sessionId, diner.memberId),
  )

  return NextResponse.json(bill)
})
