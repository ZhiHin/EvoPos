import { z } from 'zod'

export const tableCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .min(1, 'Table code is required')
      .max(10, 'Table code must be at most 10 characters')
      .regex(/^[A-Z0-9-]+$/, 'Use letters, digits and hyphens only'),
  )

export const createTableSchema = z.object({
  code: tableCodeSchema,
  name: z.string().trim().max(80).optional(),
  /** Two covers is the commonest table; 40 covers a large banquet round. */
  capacity: z.number().int().min(1, 'Capacity must be at least 1').max(40),
  floorId: z.uuid().nullable().optional(),
  positionX: z.number().int().min(0).max(10_000).nullable().optional(),
  positionY: z.number().int().min(0).max(10_000).nullable().optional(),
})

export const updateTableSchema = createTableSchema.partial().extend({
  status: z
    .enum(['available', 'occupied', 'reserved', 'out_of_service'])
    .optional(),
})

export type CreateTableInput = z.infer<typeof createTableSchema>
export type UpdateTableInput = z.infer<typeof updateTableSchema>
