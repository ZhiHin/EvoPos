import { z } from 'zod'

export const createFloorSchema = z.object({
  name: z.string().trim().min(1, 'Floor name is required').max(80),
  displayOrder: z.number().int().min(0).max(999).default(0),
})

export const updateFloorSchema = createFloorSchema.partial()

export type CreateFloorInput = z.infer<typeof createFloorSchema>
export type UpdateFloorInput = z.infer<typeof updateFloorSchema>
