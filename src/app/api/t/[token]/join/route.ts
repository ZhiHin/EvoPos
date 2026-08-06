import { NextResponse } from 'next/server'

import { assertSameOrigin, readJson, withRoute } from '@/lib/api'
import { setDinerCookie } from '@/modules/session/diner'
import { joinByQrToken } from '@/modules/session/session.service'
import { joinSessionSchema } from '@/modules/session/session.validation'

interface RouteContext {
  params: Promise<{ token: string }>
}

/**
 * Joins a table by scanning its QR.
 *
 * Unauthenticated by design — this is the only way an anonymous diner can
 * obtain any credential at all, and the only thing that authorises it is
 * possession of the printed token, i.e. physically being at the table.
 *
 * The origin check still applies: the request comes from our own scan page,
 * and a cross-site POST here would let another site silently seat someone at
 * a table.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const { token } = await params
    const input = joinSessionSchema.parse(await readJson(request))

    const result = await joinByQrToken(token, input.displayName)

    await setDinerCookie(result.token.token, result.token.expiresAt)

    return NextResponse.json(
      {
        table: result.table,
        displayName: input.displayName,
        isNewSession: result.isNewSession,
      },
      { status: 201 },
    )
  },
)
