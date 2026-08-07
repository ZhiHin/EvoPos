import { z } from 'zod'

import { WEBHOOK_EVENTS } from './webhook'

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name').max(120),
  /**
   * Validated against the registry in the service, not here. A schema enum of
   * 121 codes would have to be regenerated every time a permission ships, and
   * would drift from the registry the first time someone forgot.
   */
  permissions: z.array(z.string().trim().min(1)).max(200),
  /**
   * Optional, and unbounded expiry is allowed — an integration that stops
   * working at 3am because a key silently expired is worse than one that never
   * expires, provided revocation is easy. Which it is.
   */
  expiresInDays: z.number().int().min(1).max(3_650).nullish(),
})

export const createWebhookEndpointSchema = z.object({
  url: z.url('Enter a valid URL').max(2_000),
  description: z.string().trim().max(200).optional(),
  events: z
    .array(z.enum(WEBHOOK_EVENTS as [string, ...string[]]))
    .min(1, 'Choose at least one event'),
})

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>
export type CreateWebhookEndpointInput = z.infer<
  typeof createWebhookEndpointSchema
>
