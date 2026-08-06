import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { findOrCreateCustomer } from '@/modules/promotion/loyalty.service'
import { findCustomerSchema } from '@/modules/promotion/promotion.validation'

/**
 * Look up a member by phone, creating one if they are new.
 *
 * One call rather than search-then-create: a cashier asking "are you a
 * member?" should not have to know the answer before choosing a button.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('customer.manage')
  const input = findCustomerSchema.parse(await readJson(request))

  const result = await findOrCreateCustomer(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(result, { status: result.wasCreated ? 201 : 200 })
})
