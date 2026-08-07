import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  createApiKey,
  listApiKeys,
} from '@/modules/integration/api-key.service'
import { createApiKeySchema } from '@/modules/integration/integration.validation'

export const GET = withRoute(async () => {
  const ctx = await requirePermission('integration.view')

  // Never the token, which exists in plaintext exactly once — at creation.
  return NextResponse.json(
    await listApiKeys(ctx.tenant.restaurantId, ctx.user.id),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('integration.manage')
  const input = createApiKeySchema.parse(await readJson(request))

  const created = await createApiKey(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      name: input.name,
      permissions: input.permissions,
      expiresInDays: input.expiresInDays,
    },
  )

  /**
   * The only response that ever contains the token. Everything afterwards
   * shows the prefix, which identifies a key without being usable as one.
   */
  return NextResponse.json(created, {
    status: 201,
    headers: { 'cache-control': 'no-store' },
  })
})
