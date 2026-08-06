import { z } from 'zod'

export const createRestaurantSchema = z.object({
  restaurantName: z
    .string()
    .trim()
    .min(1, 'Restaurant name is required')
    .max(120, 'Restaurant name is too long'),
})

export type CreateRestaurantInput = z.infer<typeof createRestaurantSchema>
