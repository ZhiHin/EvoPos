import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { login, recordSignIn } from '@/modules/auth/auth.service'
import { loginSchema } from '@/modules/auth/auth.validation'
import { setSessionCookie } from '@/modules/auth/session'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const metadata = getRequestMetadata(request)
  const input = loginSchema.parse(await readJson(request))
  const result = await login(input, metadata)

  await setSessionCookie(result.token, result.expiresAt)

  /**
   * Audit rows are tenant-scoped, so a sign-in can only be recorded once a
   * restaurant is known. A user with several memberships lands tenant-less
   * and is audited when they pick one instead.
   */
  if (result.restaurantId) {
    await recordSignIn(result.restaurantId, result.userId, metadata)
  }

  return NextResponse.json({ restaurantId: result.restaurantId })
})
