import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { users } from './identity'
import { branches, restaurants } from './tenancy'
import { appRole, currentActorId, tenantPolicy, timestamps } from './_shared'

/**
 * Role-based access control.
 *
 * Permissions are a fixed, code-defined registry -- they name capabilities the
 * software actually implements, so a restaurant owner inventing a new one at
 * runtime would name something no code path checks. Roles, by contrast, are
 * per-tenant rows: owners freely create roles and choose which permissions
 * each one carries, which is the configurability the spec asks for without
 * pretending permissions are user-authorable.
 */

/** Global registry, seeded from src/modules/rbac/permissions.ts. No RLS. */
export const permissions = pgTable(
  'permissions',
  {
    /** Stable dotted identifier, e.g. "menu.item.update". */
    code: text('code').primaryKey(),
    module: text('module').notNull(),
    action: text('action').notNull(),
    description: text('description').notNull(),
  },
  (t) => [index('permissions_module_idx').on(t.module)],
)

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    /** Stable per-tenant identifier, e.g. "owner". */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),

    /**
     * System roles are seeded for every new restaurant and cannot be deleted;
     * their permissions may still be edited, except for `owner`, which the
     * service layer pins to the full permission set so a tenant cannot lock
     * itself out of its own account.
     */
    isSystem: boolean('is_system').notNull().default(false),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('roles_restaurant_key_key').on(t.restaurantId, t.key),
    index('roles_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('roles_tenant_isolation', t.restaurantId),

    /**
     * Counterpart to `memberships_self_read`, and required for the tenant
     * switcher to work at all.
     *
     * The switcher runs with no tenant context and joins memberships to roles
     * to show "Owner at Kopi Corner". Without this policy the tenant policy
     * above filters every role row out, the inner join matches nothing, and
     * the user is told they belong to no restaurants -- locked out of an
     * account they legitimately own.
     *
     * Scoped to roles the actor is actually assigned. The subquery is
     * satisfied by `memberships_self_read`, which matches on user_id and does
     * not reference `roles`, so there is no policy recursion.
     */
    pgPolicy('roles_member_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`exists (
        select 1
        from memberships m
        where m.role_id = ${t.id}
          and m.user_id = ${currentActorId()}
          and m.status = 'active'
      )`,
    }),
  ],
)

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
    /**
     * Denormalised from `roles`. A policy can only reference columns on its
     * own table, so without this the join table could not be tenant-filtered
     * without a subquery on every row.
     */
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionCode] }),
    index('role_permissions_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('role_permissions_tenant_isolation', t.restaurantId),
  ],
)

export const membershipStatus = pgEnum('membership_status', [
  'invited',
  'active',
  'suspended',
])

/** Binds a global user to one restaurant with one role. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),

    status: membershipStatus('status').notNull().default('invited'),

    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('memberships_restaurant_user_key').on(
      t.restaurantId,
      t.userId,
    ),
    index('memberships_user_id_idx').on(t.userId),
    index('memberships_restaurant_id_idx').on(t.restaurantId),

    tenantPolicy('memberships_tenant_isolation', t.restaurantId),

    /**
     * Lets a user read their own memberships with no tenant context set,
     * which is what makes the post-login tenant switcher possible. SELECT
     * only -- a user can see which restaurants they belong to but cannot
     * write a membership outside the active tenant.
     */
    pgPolicy('memberships_self_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.userId} = ${currentActorId()}`,
    }),
  ],
)

/**
 * Optional branch scoping. No rows for a membership means restaurant-wide
 * access; one or more rows confines the member to those branches.
 *
 * Modelled as a join table rather than a nullable `branch_id` on membership
 * so multi-branch managers work without a schema change later.
 */
export const membershipBranches = pgTable(
  'membership_branches',
  {
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.branchId] }),
    index('membership_branches_branch_id_idx').on(t.branchId),
    index('membership_branches_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('membership_branches_tenant_isolation', t.restaurantId),
  ],
)

export const rolesRelations = relations(roles, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [roles.restaurantId],
    references: [restaurants.id],
  }),
  rolePermissions: many(rolePermissions),
  memberships: many(memberships),
}))

export const rolePermissionsRelations = relations(
  rolePermissions,
  ({ one }) => ({
    role: one(roles, {
      fields: [rolePermissions.roleId],
      references: [roles.id],
    }),
    permission: one(permissions, {
      fields: [rolePermissions.permissionCode],
      references: [permissions.code],
    }),
  }),
)

export const membershipsRelations = relations(
  memberships,
  ({ one, many }) => ({
    restaurant: one(restaurants, {
      fields: [memberships.restaurantId],
      references: [restaurants.id],
    }),
    user: one(users, {
      fields: [memberships.userId],
      references: [users.id],
    }),
    role: one(roles, {
      fields: [memberships.roleId],
      references: [roles.id],
    }),
    branches: many(membershipBranches),
  }),
)

export const membershipBranchesRelations = relations(
  membershipBranches,
  ({ one }) => ({
    membership: one(memberships, {
      fields: [membershipBranches.membershipId],
      references: [memberships.id],
    }),
    branch: one(branches, {
      fields: [membershipBranches.branchId],
      references: [branches.id],
    }),
  }),
)
