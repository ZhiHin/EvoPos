import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { updateSettings } from '@/modules/settings/settings.service'
import { updateSettingsSchema } from '@/modules/settings/settings.validation'

export const PATCH = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('settings.update')
  const input = updateSettingsSchema.parse(await readJson(request))

  await updateSettings(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json({ ok: true })
})
