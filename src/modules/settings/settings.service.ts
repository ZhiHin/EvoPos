import { eq } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import { restaurants } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import type { UpdateSettingsInput } from './settings.validation'

export interface RestaurantSettings {
  name: string
  currency: string
  timezone: string
  locale: string
  taxRateBasisPoints: number
  serviceChargeBasisPoints: number
  taxInclusive: boolean
}

const SETTINGS_COLUMNS = {
  name: restaurants.name,
  currency: restaurants.currency,
  timezone: restaurants.timezone,
  locale: restaurants.locale,
  taxRateBasisPoints: restaurants.taxRateBasisPoints,
  serviceChargeBasisPoints: restaurants.serviceChargeBasisPoints,
  taxInclusive: restaurants.taxInclusive,
} as const

async function findSettingsIn(
  tx: Transaction,
  restaurantId: string,
): Promise<RestaurantSettings | null> {
  const [row] = await tx
    .select(SETTINGS_COLUMNS)
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)

  return row ?? null
}

export async function getSettings(
  restaurantId: string,
  userId: string,
): Promise<RestaurantSettings> {
  const settings = await withTenant({ restaurantId, userId }, (tx) =>
    findSettingsIn(tx, restaurantId),
  )

  if (!settings) throw new NotFoundError('Restaurant not found.')
  return settings
}

/**
 * Confirms a timezone against the runtime's own IANA database rather than a
 * hand-maintained list, which would drift as zones are added and renamed.
 * An invalid zone would break every date printed on a receipt.
 */
function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
  } catch {
    throw new ValidationError('That is not a recognised time zone.', {
      timezone: ['Use an IANA zone such as Asia/Kuala_Lumpur'],
    })
  }
}

export async function updateSettings(
  ctx: BranchActorContext,
  input: UpdateSettingsInput,
): Promise<void> {
  assertValidTimezone(input.timezone)

  await withTenant(ctx, async (tx) => {
    const before = await findSettingsIn(tx, ctx.restaurantId)
    if (!before) throw new NotFoundError('Restaurant not found.')

    const after = {
      name: input.name,
      currency: input.currency,
      timezone: input.timezone,
      locale: input.locale,
      // Already converted to basis points by the schema's transform.
      taxRateBasisPoints: input.taxRatePercent,
      serviceChargeBasisPoints: input.serviceChargePercent,
      taxInclusive: input.taxInclusive,
    }

    await tx
      .update(restaurants)
      .set(after)
      .where(eq(restaurants.id, ctx.restaurantId))

    /**
     * Tax and service charge changes are money changes. They appear on every
     * bill until changed again, so "who set this rate, and when" is a
     * question an accountant will eventually ask — and the audit trail is the
     * only place that can answer it.
     */
    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'settings.updated',
      entityType: 'restaurant',
      entityId: ctx.restaurantId,
      before,
      after,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
