import { z } from 'zod'

const partySizeSchema = z
  .number()
  .int()
  .min(1, 'A booking needs at least one guest')
  .max(100)

export const availabilitySchema = z.object({
  branchId: z.uuid(),
  startsAt: z.iso.datetime(),
  partySize: partySizeSchema,
  turnMinutes: z.number().int().min(15).max(480).optional(),
  ignoreReservationId: z.uuid().optional(),
})

export const createReservationSchema = z.object({
  branchId: z.uuid(),
  guestName: z.string().trim().min(1, 'Enter a name').max(120),
  guestPhone: z.string().trim().max(40).optional(),
  guestEmail: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  customerId: z.uuid().optional(),
  partySize: partySizeSchema,
  startsAt: z.iso.datetime(),
  turnMinutes: z.number().int().min(15).max(480).optional(),
  tableId: z.uuid().optional(),
  notes: z.string().trim().max(500).optional(),
  occasion: z.string().trim().max(120).optional(),
})

export const rescheduleReservationSchema = z.object({
  startsAt: z.iso.datetime().optional(),
  partySize: partySizeSchema.optional(),
  tableId: z.uuid().nullable().optional(),
})

export const cancelReservationSchema = z.object({
  outcome: z.enum(['cancelled', 'no_show']),
  reason: z.string().trim().max(200).optional(),
})

export const joinWaitlistSchema = z.object({
  branchId: z.uuid(),
  guestName: z.string().trim().min(1, 'Enter a name').max(120),
  guestPhone: z.string().trim().max(40).optional(),
  partySize: partySizeSchema,
  customerId: z.uuid().optional(),
  notes: z.string().trim().max(500).optional(),
})

export const waitlistActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('notify') }),
  z.object({ action: z.literal('left') }),
  z.object({ action: z.literal('seat'), tableId: z.uuid() }),
])

export const attachCustomerSchema = z.object({
  customerId: z.uuid(),
})
