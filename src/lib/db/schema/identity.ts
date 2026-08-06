import { relations } from 'drizzle-orm'
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { timestamps } from './_shared'

/**
 * Identity layer.
 *
 * These tables are intentionally NOT row-level-security protected. Every one
 * of them is read or written before a tenant context can exist:
 *
 *   - login must find a user by email before we know which restaurant they
 *     are acting in;
 *   - session lookup must resolve the cookie before we know the actor;
 *   - password reset operates on a logged-out user entirely.
 *
 * A tenant policy here would make authentication impossible. Isolation is
 * enforced one layer up, on the tenant-scoped business tables in tenancy.ts,
 * rbac.ts and audit.ts. Access to these tables is confined to the auth
 * service (src/modules/auth) and must never be exposed through a generic
 * tenant-facing repository.
 *
 * A user is global to the platform, not owned by a restaurant. One person
 * with one email can be an Owner of one restaurant and a Cashier at another;
 * that relationship lives in `memberships`.
 */

export const userStatus = pgEnum('user_status', [
  'active',
  'suspended',
  'deleted',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Always stored lowercase and trimmed. Normalising in the application
     * rather than relying on the `citext` extension keeps the schema portable
     * and keeps the unique index a plain btree.
     */
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

    /**
     * Argon2id hash. Null for accounts that have only ever signed in through
     * Google -- such an account has no password to verify, and the login
     * handler must reject password attempts against it rather than comparing
     * against an empty hash.
     */
    passwordHash: text('password_hash'),

    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    status: userStatus('status').notNull().default('active'),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
)

export const oauthProvider = pgEnum('oauth_provider', ['google'])

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProvider('provider').notNull(),
    /** The provider's stable subject identifier (`sub` for Google). */
    providerAccountId: text('provider_account_id').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('oauth_accounts_provider_account_key').on(
      t.provider,
      t.providerAccountId,
    ),
    index('oauth_accounts_user_id_idx').on(t.userId),
  ],
)

/**
 * Server-side sessions. The cookie carries a random token; only the HMAC of
 * that token is stored here, so a database disclosure does not hand an
 * attacker a set of usable session cookies.
 *
 * `activeRestaurantId` is the tenant the session is currently operating in.
 * It is the value promoted into `app.tenant_id` for RLS on every request,
 * and it is re-validated against `memberships` rather than trusted directly.
 */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    activeRestaurantId: uuid('active_restaurant_id'),
    activeBranchId: uuid('active_branch_id'),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
)

/**
 * Single-use tokens for password reset and email verification.
 *
 * Stored as an HMAC of the emailed token for the same reason as sessions.
 * `usedAt` is set on redemption instead of deleting the row, so a replayed
 * link is distinguishable from an expired one and can be audited.
 */
export const verificationPurpose = pgEnum('verification_purpose', [
  'password_reset',
  'email_verification',
])

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: verificationPurpose('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('verification_tokens_user_purpose_idx').on(t.userId, t.purpose),
    index('verification_tokens_expires_at_idx').on(t.expiresAt),
  ],
)

export const usersRelations = relations(users, ({ many }) => ({
  oauthAccounts: many(oauthAccounts),
  sessions: many(sessions),
  verificationTokens: many(verificationTokens),
}))

export const oauthAccountsRelations = relations(oauthAccounts, ({ one }) => ({
  user: one(users, {
    fields: [oauthAccounts.userId],
    references: [users.id],
  }),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}))
