import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import {
  billSplitShares,
  diningSessions,
  paymentRefunds,
  payments,
} from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { computeSessionTotals } from '@/modules/pos/pos.service'
import { closeSession } from '@/modules/session/session.service'
import {
  assertPaymentIsAcceptable,
  assertRefundIsAcceptable,
  calculateCashTender,
  calculateSettlement,
  isSelfConfirming,
  summariseTakings,
  type PaymentMethod,
  type SettlementPayment,
  type SettlementState,
  type TakingsSummary,
} from './settlement'
import type {
  RefundInput,
  TakePaymentInput,
} from './payment.validation'

export interface PaymentRow {
  id: string
  method: PaymentMethod
  status: 'pending' | 'succeeded' | 'failed' | 'voided'
  amountMinor: number
  tenderedMinor: number | null
  changeMinor: number | null
  roundingAdjustmentMinor: number
  reference: string | null
  splitShareId: string | null
  refundedMinor: number
  takenAt: Date
  voidReason: string | null
}

/**
 * Loads a session's payments with their refunded totals.
 *
 * Refunds are summed from their own table rather than kept as a denormalised
 * column. One source of truth for how much came back means a refund can never
 * be recorded without the balance moving with it.
 */
export async function readSessionPayments(
  tx: Transaction,
  sessionId: string,
): Promise<PaymentRow[]> {
  const rows = await tx
    .select({
      id: payments.id,
      method: payments.method,
      status: payments.status,
      amountMinor: payments.amountMinor,
      tenderedMinor: payments.tenderedMinor,
      changeMinor: payments.changeMinor,
      roundingAdjustmentMinor: payments.roundingAdjustmentMinor,
      reference: payments.reference,
      splitShareId: payments.splitShareId,
      takenAt: payments.takenAt,
      voidReason: payments.voidReason,
    })
    .from(payments)
    .where(eq(payments.sessionId, sessionId))
    .orderBy(asc(payments.takenAt))

  if (rows.length === 0) return []

  const refunds = await tx
    .select({
      paymentId: paymentRefunds.paymentId,
      amountMinor: paymentRefunds.amountMinor,
    })
    .from(paymentRefunds)
    .where(
      inArray(
        paymentRefunds.paymentId,
        rows.map((r) => r.id),
      ),
    )

  const refundedByPayment = new Map<string, number>()
  for (const refund of refunds) {
    refundedByPayment.set(
      refund.paymentId,
      (refundedByPayment.get(refund.paymentId) ?? 0) + refund.amountMinor,
    )
  }

  return rows.map((row) => ({
    ...row,
    refundedMinor: refundedByPayment.get(row.id) ?? 0,
  }))
}

function toSettlementPayments(
  rows: readonly PaymentRow[],
): SettlementPayment[] {
  return rows.map((row) => ({
    amountMinor: row.amountMinor,
    status: row.status,
    refundedMinor: row.refundedMinor,
    method: row.method,
  }))
}

/**
 * What is still owed on a session, or on one share of a split bill.
 *
 * When `splitShareId` is given, only that share's amount and the payments
 * against it are considered — which is how "pay my part and leave" works
 * without anyone else's balance moving.
 */
export async function readSettlement(
  tx: Transaction,
  restaurantId: string,
  sessionId: string,
  splitShareId?: string,
): Promise<SettlementState & { payments: PaymentRow[] }> {
  const allPayments = await readSessionPayments(tx, sessionId)

  if (splitShareId) {
    const [share] = await tx
      .select({ totalMinor: billSplitShares.totalMinor })
      .from(billSplitShares)
      .where(eq(billSplitShares.id, splitShareId))
      .limit(1)

    if (!share) throw new NotFoundError('That share was not found.')

    const forShare = allPayments.filter(
      (p) => p.splitShareId === splitShareId,
    )

    return {
      ...calculateSettlement(share.totalMinor, toSettlementPayments(forShare)),
      payments: forShare,
    }
  }

  const totals = await computeSessionTotals(tx, restaurantId, sessionId)

  return {
    ...calculateSettlement(
      totals.totalMinor,
      toSettlementPayments(allPayments),
    ),
    payments: allPayments,
  }
}

export interface TakePaymentResult {
  paymentId: string
  amountMinor: number
  changeMinor: number
  roundingAdjustmentMinor: number
  settlement: SettlementState
  /** True when this call matched an existing key and took no new money. */
  wasReplay: boolean
}

/**
 * Records a payment.
 *
 * Idempotent by key. A retried request — a double-clicked button, a mobile
 * connection that dropped after the write but before the response — returns
 * the original payment rather than taking money twice. This is checked before
 * anything is written and enforced by a unique index behind it, so two
 * genuinely concurrent retries cannot both slip through.
 *
 * Offline methods are recorded as `succeeded` because the confirmation has
 * already happened outside this system: the cash is in the drawer, the
 * terminal printed an approval. Gateway payments are not accepted here at
 * all — they will start `pending` and be confirmed by a verified webhook.
 */
export async function takePayment(
  ctx: BranchActorContext,
  sessionId: string,
  input: TakePaymentInput,
): Promise<TakePaymentResult> {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        id: payments.id,
        amountMinor: payments.amountMinor,
        changeMinor: payments.changeMinor,
        roundingAdjustmentMinor: payments.roundingAdjustmentMinor,
      })
      .from(payments)
      .where(
        and(
          eq(payments.restaurantId, ctx.restaurantId),
          eq(payments.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)

    if (existing) {
      const settlement = await readSettlement(
        tx,
        ctx.restaurantId,
        sessionId,
        input.splitShareId,
      )

      return {
        paymentId: existing.id,
        amountMinor: existing.amountMinor,
        changeMinor: existing.changeMinor ?? 0,
        roundingAdjustmentMinor: existing.roundingAdjustmentMinor,
        settlement,
        wasReplay: true,
      }
    }

    const [session] = await tx
      .select({ id: diningSessions.id, status: diningSessions.status })
      .from(diningSessions)
      .where(
        and(
          eq(diningSessions.id, sessionId),
          eq(diningSessions.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!session) throw new NotFoundError('Session not found.')
    if (session.status === 'closed' || session.status === 'abandoned') {
      throw new ConflictError(
        'That bill is closed. Reopen it before taking payment.',
      )
    }

    if (input.splitShareId) {
      const [share] = await tx
        .select({ id: billSplitShares.id })
        .from(billSplitShares)
        .where(
          and(
            eq(billSplitShares.id, input.splitShareId),
            eq(billSplitShares.sessionId, sessionId),
          ),
        )
        .limit(1)

      // Paying a share that belongs to a different table would credit the
      // wrong bill entirely.
      if (!share) throw new NotFoundError('That share is not on this bill.')
    }

    const before = await readSettlement(
      tx,
      ctx.restaurantId,
      sessionId,
      input.splitShareId,
    )

    /**
     * Checked before the cash arithmetic below, not after.
     *
     * Cash is capped at what is outstanding, so on a settled bill that cap is
     * zero and the generic "enter an amount greater than zero" fires — which
     * tells a cashier who just typed 10.00 nothing useful. The real reason
     * has to come first.
     */
    if (before.isSettled) {
      throw new ConflictError(
        input.splitShareId
          ? 'That share has already been paid in full.'
          : 'This bill has already been settled in full.',
      )
    }

    let amountMinor = input.amount
    let changeMinor = 0
    let roundingAdjustmentMinor = 0

    if (input.method === 'cash') {
      /**
       * Capped at what is actually owed. A customer handing over RM 50 for a
       * RM 30 bill is paying 30 and receiving 20 back — recording it as a
       * 50 payment would overstate takings and leave the drawer short when
       * counted.
       */
      const dueMinor = Math.min(input.amount, before.outstandingMinor)
      const tender = calculateCashTender(dueMinor, input.tendered!)

      amountMinor = tender.payableMinor
      changeMinor = tender.changeMinor
      roundingAdjustmentMinor = tender.roundingAdjustmentMinor
    }

    assertPaymentIsAcceptable(input.method, amountMinor, before)

    if (!isSelfConfirming(input.method)) {
      throw new ConflictError(
        'Online payments cannot be recorded manually. They are confirmed by the payment provider.',
      )
    }

    const [created] = await tx
      .insert(payments)
      .values({
        restaurantId: ctx.restaurantId,
        sessionId,
        splitShareId: input.splitShareId ?? null,
        method: input.method,
        status: 'succeeded',
        amountMinor,
        tenderedMinor: input.tendered ?? null,
        changeMinor: input.method === 'cash' ? changeMinor : null,
        roundingAdjustmentMinor,
        idempotencyKey: input.idempotencyKey,
        reference: input.reference ?? null,
        takenByUserId: ctx.userId,
      })
      .returning({ id: payments.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'payment.taken',
      entityType: 'payment',
      entityId: created.id,
      after: {
        sessionId,
        method: input.method,
        amountMinor,
        splitShareId: input.splitShareId ?? null,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    const settlement = await readSettlement(
      tx,
      ctx.restaurantId,
      sessionId,
      input.splitShareId,
    )

    return {
      paymentId: created.id,
      amountMinor,
      changeMinor,
      roundingAdjustmentMinor,
      settlement,
      wasReplay: false,
    }
  })
}

/**
 * Voids a payment recorded in error — a mistyped amount, the wrong method.
 *
 * Distinct from a refund, which returns money that was genuinely taken. The
 * row survives with `status = 'voided'` and a reason, because a payment that
 * simply vanished is indistinguishable from theft when the drawer is counted.
 */
export async function voidPayment(
  ctx: BranchActorContext,
  paymentId: string,
  reason: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [payment] = await tx
      .select({
        id: payments.id,
        sessionId: payments.sessionId,
        status: payments.status,
        amountMinor: payments.amountMinor,
        method: payments.method,
      })
      .from(payments)
      .where(
        and(
          eq(payments.id, paymentId),
          eq(payments.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!payment) throw new NotFoundError('Payment not found.')
    if (payment.status === 'voided') {
      throw new ConflictError('That payment has already been voided.')
    }

    const [refunded] = await tx
      .select({ id: paymentRefunds.id })
      .from(paymentRefunds)
      .where(eq(paymentRefunds.paymentId, paymentId))
      .limit(1)

    /**
     * Voiding says the payment never really happened; refunding says it did
     * and the money went back. A payment that has been partly refunded is
     * unambiguously in the second category, and letting it be voided would
     * make the refund reference a payment that claims not to exist.
     */
    if (refunded) {
      throw new ConflictError(
        'This payment has been refunded, so it cannot be voided. Refund the remainder instead.',
      )
    }

    await tx
      .update(payments)
      .set({
        status: 'voided',
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: reason,
      })
      .where(eq(payments.id, paymentId))

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'payment.voided',
      entityType: 'payment',
      entityId: paymentId,
      before: payment,
      after: { status: 'voided', reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

export async function issueRefund(
  ctx: BranchActorContext,
  paymentId: string,
  input: RefundInput,
): Promise<{ refundId: string; wasReplay: boolean }> {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: paymentRefunds.id })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.restaurantId, ctx.restaurantId),
          eq(paymentRefunds.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)

    if (existing) return { refundId: existing.id, wasReplay: true }

    const [payment] = await tx
      .select({
        id: payments.id,
        sessionId: payments.sessionId,
        status: payments.status,
        amountMinor: payments.amountMinor,
        method: payments.method,
      })
      .from(payments)
      .where(
        and(
          eq(payments.id, paymentId),
          eq(payments.restaurantId, ctx.restaurantId),
        ),
      )
      .limit(1)

    if (!payment) throw new NotFoundError('Payment not found.')

    const refunds = await tx
      .select({ amountMinor: paymentRefunds.amountMinor })
      .from(paymentRefunds)
      .where(eq(paymentRefunds.paymentId, paymentId))

    const refundedMinor = refunds.reduce((sum, r) => sum + r.amountMinor, 0)

    assertRefundIsAcceptable(
      {
        amountMinor: payment.amountMinor,
        status: payment.status,
        refundedMinor,
        method: payment.method,
      },
      input.amount,
    )

    const [created] = await tx
      .insert(paymentRefunds)
      .values({
        restaurantId: ctx.restaurantId,
        sessionId: payment.sessionId,
        paymentId,
        amountMinor: input.amount,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        issuedByUserId: ctx.userId,
      })
      .returning({ id: paymentRefunds.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'payment.refunded',
      entityType: 'payment',
      entityId: paymentId,
      after: {
        refundId: created.id,
        amountMinor: input.amount,
        reason: input.reason,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { refundId: created.id, wasReplay: false }
  })
}

/**
 * Closes a session only if it has been paid for.
 *
 * `closeSession` in the session module is the low-level primitive and stays
 * that way — it is used by tests and by future flows that legitimately close
 * an unpaid bill (a walkout, written off deliberately). This is the wrapper
 * the till uses, and it refuses rather than letting an unpaid bill quietly
 * disappear, which is how money goes missing without anyone noticing.
 */
export async function settleAndCloseSession(
  ctx: BranchActorContext,
  sessionId: string,
): Promise<void> {
  const settlement = await withTenant(ctx, (tx) =>
    readSettlement(tx, ctx.restaurantId, sessionId),
  )

  if (!settlement.isSettled) {
    throw new ConflictError(
      `This bill still has ${(settlement.outstandingMinor / 100).toFixed(2)} outstanding. Take payment before closing it.`,
    )
  }

  await closeSession(ctx, sessionId)
}

/**
 * Takings for a period, for reconciliation.
 *
 * Bounded by `takenAt` rather than by session, so a table opened before
 * midnight and paid after it lands in the day the money actually moved —
 * which is the day the drawer is counted.
 */
export async function readTakings(
  restaurantId: string,
  userId: string,
  from: Date,
  to: Date,
): Promise<TakingsSummary> {
  return withTenant({ restaurantId, userId }, async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        method: payments.method,
        status: payments.status,
        amountMinor: payments.amountMinor,
      })
      .from(payments)
      .where(
        and(
          eq(payments.restaurantId, restaurantId),
          gte(payments.takenAt, from),
          lt(payments.takenAt, to),
        ),
      )
      .orderBy(desc(payments.takenAt))

    if (rows.length === 0) return summariseTakings([])

    const refunds = await tx
      .select({
        paymentId: paymentRefunds.paymentId,
        amountMinor: paymentRefunds.amountMinor,
      })
      .from(paymentRefunds)
      .where(
        inArray(
          paymentRefunds.paymentId,
          rows.map((r) => r.id),
        ),
      )

    const refundedByPayment = new Map<string, number>()
    for (const refund of refunds) {
      refundedByPayment.set(
        refund.paymentId,
        (refundedByPayment.get(refund.paymentId) ?? 0) + refund.amountMinor,
      )
    }

    return summariseTakings(
      rows.map((row) => ({
        amountMinor: row.amountMinor,
        status: row.status,
        method: row.method,
        refundedMinor: refundedByPayment.get(row.id) ?? 0,
      })),
    )
  })
}
