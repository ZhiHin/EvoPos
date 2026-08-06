import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { searchCustomers } from '@/modules/crm/customer.service'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('customer.view')
  const query = new URL(request.url).searchParams.get('q') ?? ''

  return NextResponse.json(
    await searchCustomers(ctx.tenant.restaurantId, ctx.user.id, query),
  )
})
