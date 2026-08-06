import { z } from 'zod'

export const createShiftSchema = z
  .object({
    branchId: z.uuid(),
    userId: z.uuid(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    position: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((input) => new Date(input.endsAt) > new Date(input.startsAt), {
    message: 'A shift has to end after it starts',
    path: ['endsAt'],
  })

export const publishRosterSchema = z.object({
  branchId: z.uuid(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
})

export const clockActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('in'), branchId: z.uuid() }),
  z.object({
    action: z.literal('out'),
    breakMinutes: z.number().int().min(0).max(600).default(0),
  }),
])

export const editPunchSchema = z.object({
  clockInAt: z.iso.datetime().optional(),
  clockOutAt: z.iso.datetime().nullable().optional(),
  breakMinutes: z.number().int().min(0).max(600).optional(),
  reason: z.string().trim().min(1, 'Give a reason').max(200),
})
