import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { restaurants } from './tenancy'
import { users } from './identity'
import {
  appRole,
  currentApiKeyHash,
  tenantPolicy,
  timestamps,
} from './_shared'

/**
 * The SaaS surface: programmatic access, outbound integrations, and the
 * shared-state rate limiter.
 */

/**
 * Keys for machine access.
 *
 * Only the HMAC is stored, exactly as for sessions — a dump of this table
 * yields nothing that can be presented back to the server. What is kept in
 * plaintext is a short prefix, so a customer with six keys can tell which one
 * a log line refers to without the value being reconstructible from it.
 *
 * A key carries its own permission set rather than impersonating a member.
 * Tying integration access to a person means the integration dies when they
 * leave, and quietly inherits every permission they are later granted.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** First characters of the key, for identification only. */
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),

    /**
     * Permission codes this key may exercise, from the same registry staff
     * roles draw on. An empty array is a key that can authenticate and do
     * nothing, which is a legitimate thing to create while testing.
     */
    permissions: text('permissions').array().notNull().default([]),

    /**
     * Written on use, and deliberately coarse — updated at most once a minute
     * so a busy integration does not turn every read into a write.
     */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('api_keys_token_hash_key').on(t.tokenHash),
    index('api_keys_restaurant_idx').on(t.restaurantId),

    tenantPolicy('api_keys_tenant_isolation', t.restaurantId),

    /**
     * Bootstraps a machine's identity from the token it presented, exactly as
     * `dining_tables_qr_lookup` does for a scan.
     *
     * Without this the key could never be resolved at all: the tenant policy
     * compares against `app.tenant_id`, and the whole point of the lookup is
     * that no tenant context exists yet. Presenting one hash reveals one row,
     * so the table still cannot be enumerated.
     *
     * SELECT only. A key cannot read or write any other key, including its
     * own last-used timestamp — that update runs against the id afterwards,
     * under a context the key has by then established.
     */
    pgPolicy('api_keys_token_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.tokenHash} = ${currentApiKeyHash()}`,
    }),
  ],
)

export const webhookEventType = pgEnum('webhook_event_type', [
  'order.placed',
  'bill.settled',
  'payment.refunded',
  'reservation.created',
  'stock.low',
])

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    url: text('url').notNull(),
    description: text('description'),

    /**
     * The signing secret, stored in plaintext.
     *
     * Unlike an API key, this is a shared secret: both ends must compute the
     * same HMAC over the same body, so it cannot be one-way hashed here. It is
     * shown once at creation and treated as a credential everywhere else.
     */
    secret: text('secret').notNull(),

    /** Which events this endpoint wants. Empty means none, not all. */
    events: webhookEventType('events').array().notNull().default([]),

    isActive: boolean('is_active').notNull().default(true),

    /**
     * Set when deliveries have failed repeatedly.
     *
     * An endpoint that has been dead for a week should stop being retried, but
     * disabling it silently would mean an integration that quietly stopped
     * working with nothing to explain it. The timestamp is what the UI shows.
     */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),

    ...timestamps,
  },
  (t) => [
    index('webhook_endpoints_restaurant_idx').on(t.restaurantId),
    tenantPolicy('webhook_endpoints_tenant_isolation', t.restaurantId),
  ],
)

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'abandoned',
])

/**
 * One attempt to tell somebody something happened.
 *
 * A queue rather than an inline HTTP call, because a customer's slow endpoint
 * must not be able to make settling a bill slow — or, worse, fail. The payload
 * is frozen at enqueue time so a retry three hours later says what was true
 * when the event happened, not what is true now.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),

    eventType: webhookEventType('event_type').notNull(),
    /** The event's own id, so a receiver can discard a duplicate. */
    eventId: uuid('event_id').notNull().defaultRandom(),
    payload: jsonb('payload').notNull(),

    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),

    /** When the next attempt becomes due. Null once it is finished. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    /** The index the drain worker reads through: what is due, oldest first. */
    index('webhook_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
    index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt),

    tenantPolicy('webhook_deliveries_tenant_isolation', t.restaurantId),
  ],
)

/**
 * The rate limiter's shared state.
 *
 * Phase 0 counted attempts in process memory and said plainly that behind more
 * than one instance the effective limit multiplies by the instance count. This
 * table closes that: the counter lives where every instance can see it.
 *
 * Postgres rather than Redis because the database is already here, already
 * backed up, and already the thing that goes down if anything does. A second
 * piece of infrastructure whose failure mode is "authentication stops being
 * rate limited" is not obviously an improvement.
 *
 * Deliberately NOT tenant-scoped and NOT RLS-protected: the rows it holds are
 * for login attempts against an email that may belong to any restaurant, or
 * none. It is written by the migrator-owned path before any tenant context
 * exists, in the same way the identity tables are.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    /** e.g. `login:ip:203.0.113.4`. The full key, hashed by the caller. */
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /** Lets expired rows be swept in one indexed delete. */
    index('rate_limit_buckets_reset_idx').on(t.resetAt),
  ],
)

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [apiKeys.restaurantId],
    references: [restaurants.id],
  }),
}))

export const webhookEndpointsRelations = relations(
  webhookEndpoints,
  ({ many }) => ({
    deliveries: many(webhookDeliveries),
  }),
)

export const webhookDeliveriesRelations = relations(
  webhookDeliveries,
  ({ one }) => ({
    endpoint: one(webhookEndpoints, {
      fields: [webhookDeliveries.endpointId],
      references: [webhookEndpoints.id],
    }),
  }),
)
