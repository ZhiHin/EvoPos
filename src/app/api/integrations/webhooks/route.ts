import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createWebhookEndpointSchema } from '@/modules/integration/integration.validation'
import type { WebhookEvent } from '@/modules/integration/webhook'
import {
  createEndpoint,
  listEndpoints,
} from '@/modules/integration/webhook.service'

export const GET = withRoute(async () => {
  const ctx = await requirePermission('integration.view')

  // The signing secret is never returned. It is shown once, at creation.
  return NextResponse.json(
    await listEndpoints(ctx.tenant.restaurantId, ctx.user.id),
  )
})

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('integration.manage')
  const input = createWebhookEndpointSchema.parse(await readJson(request))

  const created = await createEndpoint(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    {
      url: input.url,
      description: input.description,
      events: input.events as WebhookEvent[],
    },
  )

  return NextResponse.json(created, {
    status: 201,
    headers: { 'cache-control': 'no-store' },
  })
})
