import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { requireAuth } from '@/lib/auth/context'
import { switchTenant } from '@/modules/auth/auth.service'
import { switchTenantSchema } from '@/modules/auth/auth.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requireAuth()
  const input = switchTenantSchema.parse(await readJson(request))

  /**
   * Membership is re-verified inside `switchTenant` against the database.
   * The restaurant id arrives from the client, so it is a request, not a
   * fact -- accepting it as given would let anyone move their session into
   * any tenant by editing one field.
   */
  await switchTenant(ctx.user.id, ctx.session.tokenHash, input.restaurantId)

  return NextResponse.json({ restaurantId: input.restaurantId })
})
