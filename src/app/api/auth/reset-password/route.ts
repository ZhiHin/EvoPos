import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { resetPassword } from '@/modules/auth/auth.service'
import { resetPasswordSchema } from '@/modules/auth/auth.validation'
import { clearSessionCookie } from '@/modules/auth/session'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const input = resetPasswordSchema.parse(await readJson(request))
  await resetPassword(input.token, input.password)

  // Every session for that user was revoked, including this browser's if it
  // had one. Drop the now-dead cookie so the UI does not appear signed in.
  await clearSessionCookie()

  return NextResponse.json({
    message: 'Your password has been changed. Sign in with your new password.',
  })
})
