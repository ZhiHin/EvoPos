import { z } from 'zod'

import { priceMinorSchema } from '@/modules/menu/menu.validation'

/**
 * Client-supplied idempotency key.
 *
 * Required, not optional-with-a-default. A generated fallback would be unique
 * per request and therefore useless — the whole point is that a retry of the
 * *same* action carries the *same* key.
 */
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, 'Idempotency key is too short')
  .max(100)

export const takePaymentSchema = z
  .object({
    method: z.enum([
      'cash',
      'card_terminal',
      'ewallet_terminal',
      'bank_transfer',
      'other',
    ]),
    /** Major units, converted to minor at the edge. */
    amount: priceMinorSchema,
    /** Cash only. What the customer physically handed over. */
    tendered: priceMinorSchema.optional(),
    /** Settle one person's share instead of the whole bill. */
    splitShareId: z.uuid().optional(),
    reference: z.string().trim().max(120).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine((v) => v.method !== 'cash' || v.tendered !== undefined, {
    message: 'Enter the amount tendered for a cash payment',
    path: ['tendered'],
  })
  .refine((v) => v.method === 'cash' || v.tendered === undefined, {
    message: 'Amount tendered only applies to cash',
    path: ['tendered'],
  })

export const voidPaymentSchema = z.object({
  /**
   * Required. A voided payment with no stated reason is the exact record
   * nobody can account for when the drawer does not balance.
   */
  reason: z.string().trim().min(1, 'Give a reason').max(200),
})

export const refundSchema = z.object({
  amount: priceMinorSchema,
  reason: z.string().trim().min(1, 'Give a reason for the refund').max(200),
  idempotencyKey: idempotencyKeySchema,
})

export type TakePaymentInput = z.infer<typeof takePaymentSchema>
export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>
export type RefundInput = z.infer<typeof refundSchema>
