import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { registerOwner } from '@/modules/auth/auth.service'
import { registerSchema } from '@/modules/auth/auth.validation'
import { setSessionCookie } from '@/modules/auth/session'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const input = registerSchema.parse(await readJson(request))
  const result = await registerOwner(input, getRequestMetadata(request))

  await setSessionCookie(result.token, result.expiresAt)

  return NextResponse.json(
    { restaurantId: result.restaurantId },
    { status: 201 },
  )
})
