import { NextResponse } from 'next/server'

import { assertSameOrigin, withRoute } from '@/lib/api'
import {
  clearSessionCookie,
  invalidateSession,
  readSessionCookie,
} from '@/modules/auth/session'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const token = await readSessionCookie()

  /**
   * The row is deleted, not just the cookie. Clearing the cookie alone would
   * leave a token that still authenticates anyone who captured it, which
   * makes "sign out" a purely cosmetic action on a shared POS terminal.
   */
  if (token) await invalidateSession(token)
  await clearSessionCookie()

  // Unconditional 200: whether a session existed is not information a caller
  // needs, and returning 401 here would make signing out fail confusingly.
  return NextResponse.json({ ok: true })
})
