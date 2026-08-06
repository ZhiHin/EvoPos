import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requireAuth } from '@/lib/auth/context'
import { ConflictError } from '@/lib/errors'
import { listTenantsForUser } from '@/modules/rbac/rbac.repository'
import { setActiveTenant } from '@/modules/auth/session'
import { createRestaurantForUser } from '@/modules/tenancy/tenancy.service'
import { createRestaurantSchema } from '@/modules/tenancy/tenancy.validation'

/**
 * Creates a first restaurant for a signed-in user who has none.
 *
 * This is the landing point for Google sign-ups, which produce an
 * authenticated user with no membership anywhere.
 */
export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requireAuth()
  const input = createRestaurantSchema.parse(await readJson(request))

  /**
   * Restricted to users with no restaurant yet.
   *
   * Owning several restaurants is a legitimate thing to want, but creating
   * them is a billing-bearing action that belongs in the plan-aware flow of
   * Phase 14 -- not in an endpoint whose whole purpose is to get a brand new
   * account off the ground. Leaving it open here would make it a free way to
   * mint unlimited tenants.
   */
  const existing = await listTenantsForUser(ctx.user.id)
  if (existing.length > 0) {
    throw new ConflictError(
      'You already belong to a restaurant. Additional restaurants are added from settings.',
    )
  }

  const restaurantId = await createRestaurantForUser(
    ctx.user.id,
    input.restaurantName,
    getRequestMetadata(request),
  )

  await setActiveTenant(ctx.session.tokenHash, restaurantId)

  return NextResponse.json({ restaurantId }, { status: 201 })
})
