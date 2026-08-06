import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { ValidationError } from '@/lib/errors'
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  readPurchaseOrder,
} from '@/modules/inventory/purchasing.service'
import { cancelPurchaseOrderSchema } from '@/modules/inventory/inventory.validation'

interface RouteContext {
  params: Promise<{ purchaseOrderId: string }>
}

export const GET = withRoute(
  async (_request: Request, { params }: RouteContext) => {
    const ctx = await requirePermission('purchase.view')
    const { purchaseOrderId } = await params

    return NextResponse.json(
      await readPurchaseOrder(
        ctx.tenant.restaurantId,
        ctx.user.id,
        purchaseOrderId,
      ),
    )
  },
)

/**
 * Approve or cancel.
 *
 * One route, two actions, because they are the same shape of state change on
 * the same document and each needs its own permission — which the branch
 * below applies before anything is read or written.
 */
export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const { purchaseOrderId } = await params
    const body = (await readJson(request)) as { action?: unknown }

    if (body.action === 'approve') {
      const ctx = await requirePermission('purchase.approve')

      await approvePurchaseOrder(
        {
          restaurantId: ctx.tenant.restaurantId,
          userId: ctx.user.id,
          ...getRequestMetadata(request),
        },
        purchaseOrderId,
      )

      return NextResponse.json({ status: 'approved' })
    }

    if (body.action === 'cancel') {
      const ctx = await requirePermission('purchase.cancel')
      const input = cancelPurchaseOrderSchema.parse(body)

      await cancelPurchaseOrder(
        {
          restaurantId: ctx.tenant.restaurantId,
          userId: ctx.user.id,
          ...getRequestMetadata(request),
        },
        purchaseOrderId,
        input.reason,
      )

      return NextResponse.json({ status: 'cancelled' })
    }

    throw new ValidationError('Unknown action.', {
      action: ['Expected "approve" or "cancel".'],
    })
  },
)
