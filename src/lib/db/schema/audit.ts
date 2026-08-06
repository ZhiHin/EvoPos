import { relations, sql } from 'drizzle-orm'
import {
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { users } from './identity'
import { restaurants } from './tenancy'
import { appRole, currentTenantId } from './_shared'

/**
 * Append-only audit trail for security-relevant and financially-relevant
 * actions.
 *
 * Note the deliberate absence of UPDATE and DELETE policies. Postgres denies
 * anything a policy does not explicitly permit, so `ros_app` can insert and
 * read audit rows but cannot alter or remove them -- an attacker who reaches
 * application-level code still cannot erase their own trail. Retention
 * trimming is an operational job run as `ros_owner`, outside the app.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    /**
     * Nullable: some audited events have no human actor (scheduled jobs,
     * gateway webhooks) and some have an actor whose account was later
     * deleted. Losing the trail because the user row went away would defeat
     * the point, hence `set null` rather than `cascade`.
     */
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    /** Dotted verb, e.g. "membership.role_changed". */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),

    /**
     * State before and after. Both nullable -- a create has no before, a
     * delete has no after. Secrets and password hashes must be redacted by
     * the audit service before they reach these columns.
     */
    before: jsonb('before'),
    after: jsonb('after'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_log_restaurant_created_idx').on(t.restaurantId, t.createdAt),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_idx').on(t.actorUserId),

    pgPolicy('audit_log_tenant_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.restaurantId} = ${currentTenantId()}`,
    }),

    pgPolicy('audit_log_tenant_insert', {
      as: 'permissive',
      for: 'insert',
      to: appRole,
      withCheck: sql`${t.restaurantId} = ${currentTenantId()}`,
    }),
  ],
)

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [auditLog.restaurantId],
    references: [restaurants.id],
  }),
  actor: one(users, {
    fields: [auditLog.actorUserId],
    references: [users.id],
  }),
}))
