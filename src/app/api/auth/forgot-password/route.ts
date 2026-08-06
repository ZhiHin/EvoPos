import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { requestPasswordReset } from '@/modules/auth/auth.service'
import { forgotPasswordSchema } from '@/modules/auth/auth.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const input = forgotPasswordSchema.parse(await readJson(request))
  await requestPasswordReset(input.email)

  /**
   * Always the same response, whether or not the address has an account.
   * Differentiating here would turn this endpoint into a membership oracle
   * for any email address someone cares to test.
   */
  return NextResponse.json({
    message:
      'If an account exists for that address, a reset link is on its way.',
  })
})
