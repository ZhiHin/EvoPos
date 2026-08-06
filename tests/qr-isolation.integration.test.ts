import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import { branches, diningTables, restaurants, users } from '@/lib/db/schema'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createTable, rotateTableQr } from '@/modules/table/table.service'
import { resolveTableByToken } from '@/modules/table/table.repository'

/**
 * The public QR scan path is the only unauthenticated route that touches
 * tenant data. These tests exist to prove it cannot be turned into a way to
 * enumerate tables or reach a second restaurant.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

describe.skipIf(!enabled)('QR scan isolation', () => {
  let alphaId: string
  let betaId: string
  let alphaOwnerId: string
  let betaOwnerId: string
  let alphaTableId: string
  let alphaToken: string
  let betaToken: string

  beforeAll(async () => {
    await syncPermissionRegistry()
    const suffix = randomUUID().slice(0, 8)

    const [alphaOwner] = await db
      .insert(users)
      .values({ email: `qr-alpha-${suffix}@test.local`, name: 'Alpha' })
      .returning({ id: users.id })
    const [betaOwner] = await db
      .insert(users)
      .values({ email: `qr-beta-${suffix}@test.local`, name: 'Beta' })
      .returning({ id: users.id })

    alphaOwnerId = alphaOwner.id
    betaOwnerId = betaOwner.id

    alphaId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, alphaOwnerId, `QR Alpha ${suffix}`),
      )
    ).restaurantId
    betaId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, betaOwnerId, `QR Beta ${suffix}`),
      )
    ).restaurantId

    const [alphaBranch] = await withTenant(
      { restaurantId: alphaId, userId: alphaOwnerId },
      (tx) =>
        tx
          .insert(branches)
          .values({ restaurantId: alphaId, name: 'Alpha Main', code: 'A1' })
          .returning({ id: branches.id }),
    )
    const [betaBranch] = await withTenant(
      { restaurantId: betaId, userId: betaOwnerId },
      (tx) =>
        tx
          .insert(branches)
          .values({ restaurantId: betaId, name: 'Beta Main', code: 'B1' })
          .returning({ id: branches.id }),
    )

    const alphaTable = await createTable(
      { restaurantId: alphaId, userId: alphaOwnerId },
      alphaBranch.id,
      { code: 'T1', capacity: 4 },
    )
    alphaTableId = alphaTable.id
    alphaToken = alphaTable.qrToken

    betaToken = (
      await createTable(
        { restaurantId: betaId, userId: betaOwnerId },
        betaBranch.id,
        { code: 'T1', capacity: 2 },
      )
    ).qrToken
  })

  afterAll(async () => {
    await withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, alphaId)),
    )
    await withTenant({ restaurantId: betaId, userId: betaOwnerId }, (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, betaId)),
    )
    await db.delete(users).where(eq(users.id, alphaOwnerId))
    await db.delete(users).where(eq(users.id, betaOwnerId))
  })

  it('resolves a valid token to its table', async () => {
    await expect(resolveTableByToken(alphaToken)).resolves.toMatchObject({
      tableCode: 'T1',
      branchName: 'Alpha Main',
    })
  })

  it('reads the restaurant name through the QR lookup policies', async () => {
    // If restaurants_qr_lookup were missing, the inner join would match
    // nothing and this would be null rather than merely blank.
    const scanned = await resolveTableByToken(alphaToken)
    expect(scanned?.restaurantName).toContain('QR Alpha')
  })

  it('returns null for an unknown token', async () => {
    await expect(resolveTableByToken('z'.repeat(32))).resolves.toBeNull()
  })

  it('returns null for a malformed token without querying', async () => {
    await expect(resolveTableByToken('nope')).resolves.toBeNull()
    await expect(resolveTableByToken('')).resolves.toBeNull()
    await expect(
      resolveTableByToken("'; drop table dining_tables;--"),
    ).resolves.toBeNull()
  })

  /**
   * The central claim. Holding one token must reveal one table — not a list,
   * and not a neighbour.
   */
  it('reveals exactly one table, never a list', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.qr_token', ${alphaToken}, true)`,
      )
      return tx.select().from(diningTables)
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].qrToken).toBe(alphaToken)
  })

  it('does not expose another restaurant’s table', async () => {
    const scanned = await resolveTableByToken(betaToken)
    expect(scanned?.restaurantName).not.toContain('QR Alpha')
    expect(scanned?.branchName).toBe('Beta Main')
  })

  it('exposes nothing when no QR token is set', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.qr_token', '', true)`)
      return tx.select().from(diningTables)
    })

    expect(rows).toHaveLength(0)
  })

  it('grants no write access through the QR context', async () => {
    // The QR policy is SELECT-only, so an UPDATE finds no row to change.
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.qr_token', ${alphaToken}, true)`,
      )
      return tx
        .update(diningTables)
        .set({ capacity: 999 })
        .where(eq(diningTables.qrToken, alphaToken))
        .returning({ id: diningTables.id })
    })

    expect(result).toHaveLength(0)
  })

  it('grants no delete access through the QR context', async () => {
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.qr_token', ${alphaToken}, true)`,
      )
      return tx
        .delete(diningTables)
        .where(eq(diningTables.qrToken, alphaToken))
        .returning({ id: diningTables.id })
    })

    expect(result).toHaveLength(0)
  })

  it('invalidates the old token after rotation', async () => {
    const { qrToken: rotated } = await rotateTableQr(
      { restaurantId: alphaId, userId: alphaOwnerId },
      alphaTableId,
    )

    expect(rotated).not.toBe(alphaToken)
    await expect(resolveTableByToken(alphaToken)).resolves.toBeNull()
    await expect(resolveTableByToken(rotated)).resolves.not.toBeNull()

    alphaToken = rotated
  })
})
