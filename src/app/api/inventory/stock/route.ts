import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { ValidationError } from '@/lib/errors'
import {
  listReorderSuggestions,
  listStock,
} from '@/modules/inventory/inventory.service'

export const GET = withRoute(async (request: Request) => {
  const ctx = await requirePermission('stock.view')

  const url = new URL(request.url)
  const branchId = url.searchParams.get('branchId')

  if (!branchId) {
    // Stock is per branch and there is no sensible restaurant-wide default:
    // summing two kitchens' shelves would describe a larder nobody can cook
    // from.
    throw new ValidationError('A branch is required.', {
      branchId: ['A branch is required.'],
    })
  }

  const [stock, reorder] = await Promise.all([
    listStock(ctx.tenant.restaurantId, ctx.user.id, branchId),
    listReorderSuggestions(ctx.tenant.restaurantId, ctx.user.id, branchId),
  ])

  return NextResponse.json({ stock, reorder })
})
