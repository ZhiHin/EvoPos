import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { editPunch } from '@/modules/workforce/workforce.service'
import { editPunchSchema } from '@/modules/workforce/workforce.validation'

interface RouteContext {
  params: Promise<{ punchId: string }>
}

/** Corrects a timesheet entry. Changes what someone is paid, so it is audited. */
export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('attendance.edit')
    const { punchId } = await params
    const input = editPunchSchema.parse(await readJson(request))

    await editPunch(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      punchId,
      {
        clockInAt: input.clockInAt ? new Date(input.clockInAt) : undefined,
        clockOutAt:
          input.clockOutAt === undefined
            ? undefined
            : input.clockOutAt === null
              ? null
              : new Date(input.clockOutAt),
        breakMinutes: input.breakMinutes,
      },
      input.reason,
    )

    return NextResponse.json({ ok: true })
  },
)
