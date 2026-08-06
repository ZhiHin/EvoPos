/**
 * The permission registry.
 *
 * This is the one part of the access-control system that is deliberately NOT
 * configurable at runtime. A permission code is a promise that some code path
 * actually enforces it; letting an owner invent "menu.superuser" in the admin
 * panel would produce a checkbox that grants nothing, which is worse than no
 * checkbox at all.
 *
 * What owners *do* configure is roles: which of these codes each role carries.
 * That covers the real requirement ("configure business rules without asking
 * for software changes") without lying about what the software enforces.
 *
 * Codes are `module.resource.action` and must remain stable once shipped --
 * they are persisted in role_permissions. Renaming one is a data migration.
 * Rows are synced into the `permissions` table by `npm run db:seed`.
 */

export interface PermissionDefinition {
  code: string
  module: string
  action: string
  description: string
}

function define(
  module: string,
  entries: Record<string, string>,
): PermissionDefinition[] {
  return Object.entries(entries).map(([action, description]) => ({
    /**
     * `action` is the whole suffix, not just its last segment. Modules with
     * nested resources use dotted actions like `category.view`, and taking
     * only the final segment would make `menu.category.view` claim an action
     * of `view` — breaking the `code === module.action` invariant the
     * registry tests rely on, and colliding with `menu.item.view`.
     */
    code: `${module}.${action}`,
    module,
    action,
    description,
  }))
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  ...define('restaurant', {
    view: 'View restaurant profile and settings',
    update: 'Edit restaurant profile, currency, timezone and tax settings',
  }),
  ...define('branch', {
    view: 'View branches',
    create: 'Create a branch',
    update: 'Edit a branch',
    delete: 'Deactivate or delete a branch',
  }),
  ...define('floor', {
    view: 'View floors within a branch',
    create: 'Create a floor',
    update: 'Rename or reorder a floor',
    delete: 'Delete a floor',
  }),
  ...define('table', {
    view: 'View tables and their status',
    create: 'Create a table',
    update: 'Edit a table’s code, capacity, floor or position',
    delete: 'Delete a table',
    rotate_qr:
      'Issue a new QR code for a table, invalidating the printed one',
  }),
  /**
   * Menu permissions are split by resource rather than lumped into a single
   * `menu.*`. Editing a price and defining a new custom attribute are
   * different kinds of act — a supervisor should be able to mark an item
   * unavailable without being able to restructure the menu's shape.
   */
  ...define('menu', {
    'category.view': 'View menu categories',
    'category.create': 'Create a menu category',
    'category.update': 'Edit or move a menu category',
    'category.delete': 'Delete a menu category',
    'item.view': 'View menu items and prices',
    'item.create': 'Create a menu item',
    'item.update': 'Edit a menu item, including its price',
    'item.delete': 'Delete a menu item',
    'tag.manage': 'Manage tags, allergens and dietary labels',
    'attribute.manage':
      'Define the custom fields available on menu items',
    'modifier.view': 'View modifier groups and their options',
    'modifier.create': 'Create a modifier group',
    'modifier.update': 'Edit modifier groups, options and their prices',
    'modifier.delete': 'Delete a modifier group',
    'combo.view': 'View combos and set meals',
    'combo.create': 'Create a combo',
    'combo.update': 'Edit a combo, its slots and its pricing',
    'combo.delete': 'Delete a combo',
  }),
  ...define('session', {
    view: 'View dining sessions and who is at each table',
    open: 'Open a dining session on a table',
    manage: 'Rename, reassign or remove diners from a session',
    close: 'Close a dining session',
  }),
  ...define('order', {
    view: 'View order lines on a session',
    create: 'Add items to a session on a diner’s behalf',
    /** Voiding removes an item from a bill, so it is its own capability. */
    void: 'Void an order line',
  }),
  ...define('bill', {
    view: 'View a bill and how it has been split',
    split: 'Split a bill between the people at a table',
    /**
     * Locking freezes what each person owes. Separate from `split` because
     * previewing a split changes nothing, while locking one creates an
     * amount a customer will be held to.
     */
    lock: 'Lock a split so the amounts stop moving',
    void: 'Void a locked split and start again',
  }),
  ...define('pos', {
    takeaway: 'Create takeaway and delivery orders',
    merge: 'Merge two bills into one',
    transfer: 'Move a session to a different table',
  }),
  /**
   * Discounts are their own module, not part of `order`.
   *
   * Comping a dish reduces what the restaurant is paid, and the person who
   * may take an order is very often not the person who may decide it is free.
   */
  ...define('discount', {
    apply: 'Apply a manual discount to a bill',
    remove: 'Remove a manual discount from a bill',
  }),
  ...define('service', {
    view: 'See waiter calls and bill requests',
    resolve: 'Mark a waiter call or bill request as handled',
  }),
  ...define('staff', {
    view: 'View staff members and their roles',
    invite: 'Invite a person to join this restaurant',
    update: 'Change a staff member’s role or branch assignment',
    remove: 'Remove a staff member from this restaurant',
  }),
  ...define('role', {
    view: 'View roles and their permissions',
    create: 'Create a custom role',
    update: 'Change the permissions attached to a role',
    delete: 'Delete a custom role',
  }),
  ...define('audit', {
    view: 'Read the audit trail',
  }),
  ...define('settings', {
    view: 'View the settings centre',
    update: 'Change system settings',
  }),
] as const

export const PERMISSION_CODES: readonly string[] = PERMISSIONS.map(
  (p) => p.code,
)

const PERMISSION_CODE_SET = new Set(PERMISSION_CODES)

export function isKnownPermission(code: string): boolean {
  return PERMISSION_CODE_SET.has(code)
}

/**
 * Seed roles created for every new restaurant.
 *
 * `owner` is intentionally absent from this list's permission arrays -- it is
 * pinned to the complete registry at seed time and re-pinned whenever new
 * permissions ship, so a restaurant can never end up with an owner who cannot
 * administer their own account after an upgrade.
 *
 * The rest are starting points, not constraints: they exist so a new
 * restaurant is usable on day one, and every one of them is editable
 * afterwards.
 */
export interface RoleTemplate {
  key: string
  name: string
  description: string
  /** `'*'` means the full registry, re-expanded on every upgrade. */
  permissions: readonly string[] | '*'
}

export const SYSTEM_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access to everything, including billing and roles.',
    permissions: '*',
  },
  {
    key: 'manager',
    name: 'Manager',
    description:
      'Runs day-to-day operations. Cannot alter roles or restaurant-level billing.',
    permissions: [
      'restaurant.view',
      'branch.view',
      'branch.update',
      'floor.view',
      'floor.create',
      'floor.update',
      'floor.delete',
      'table.view',
      'table.create',
      'table.update',
      'table.delete',
      'table.rotate_qr',
      'menu.category.view',
      'menu.category.create',
      'menu.category.update',
      'menu.category.delete',
      'menu.item.view',
      'menu.item.create',
      'menu.item.update',
      'menu.item.delete',
      'menu.tag.manage',
      'menu.attribute.manage',
      'menu.modifier.view',
      'menu.modifier.create',
      'menu.modifier.update',
      'menu.modifier.delete',
      'menu.combo.view',
      'menu.combo.create',
      'menu.combo.update',
      'menu.combo.delete',
      'session.view',
      'session.open',
      'session.manage',
      'session.close',
      'order.view',
      'order.create',
      'order.void',
      'bill.view',
      'bill.split',
      'bill.lock',
      'bill.void',
      'pos.takeaway',
      'pos.merge',
      'pos.transfer',
      'discount.apply',
      'discount.remove',
      'service.view',
      'service.resolve',
      'staff.view',
      'staff.invite',
      'staff.update',
      'audit.view',
      'settings.view',
    ],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    description: 'Operates the point of sale and settles bills.',
    permissions: [
      'restaurant.view',
      'branch.view',
      'floor.view',
      'table.view',
      // A cashier must read the menu — including modifiers and combos — to
      // ring up an order, and must never be able to change what anything
      // costs.
      'menu.category.view',
      'menu.item.view',
      'menu.modifier.view',
      'menu.combo.view',
      // Settling a bill is the cashier's job, so they need the session and
      // its lines — but not the ability to void one, which changes what a
      // customer owes.
      'session.view',
      'session.open',
      'session.close',
      'order.view',
      'order.create',
      // Splitting a bill is the core of what a cashier does at settlement.
      'bill.view',
      'bill.split',
      'bill.lock',
      'pos.takeaway',
      'pos.merge',
      // Not `discount.apply`, and not `bill.void`: a cashier takes payment, a
      // manager decides something costs less or undoes an agreed split.
      'service.view',
      'service.resolve',
    ],
  },
  {
    key: 'waiter',
    name: 'Waiter',
    description: 'Takes orders and manages tables on the floor.',
    /**
     * `table.update` is floor work, not administration: marking a table
     * occupied, seated or available is what a waiter does all shift. Creating
     * and deleting tables is not.
     */
    permissions: [
      'restaurant.view',
      'branch.view',
      'floor.view',
      'table.view',
      'table.update',
      'menu.category.view',
      'menu.item.view',
      'menu.modifier.view',
      'menu.combo.view',
      // The floor is where waiter calls land and where orders are taken.
      'session.view',
      'session.open',
      'session.manage',
      'order.view',
      'order.create',
      'bill.view',
      'pos.transfer',
      'service.view',
      'service.resolve',
    ],
  },
  {
    key: 'kitchen',
    name: 'Kitchen Staff',
    description: 'Works the kitchen display and updates ticket status.',
    /**
     * Kitchen staff read the menu to know what a ticket refers to — and
     * modifiers especially, since "no ice, extra chilli" is the part of the
     * ticket they actually act on.
     */
    permissions: [
      'branch.view',
      'menu.category.view',
      'menu.item.view',
      'menu.modifier.view',
      'menu.combo.view',
    ],
  },
  {
    key: 'inventory',
    name: 'Inventory Staff',
    description: 'Manages stock, suppliers and goods receiving.',
    permissions: ['branch.view'],
  },
  {
    key: 'customer',
    name: 'Customer',
    description:
      'A diner ordering through QR. Holds no staff permissions; their access is scoped to their own dining session.',
    permissions: [],
  },
] as const

export function resolveTemplatePermissions(
  template: RoleTemplate,
): readonly string[] {
  return template.permissions === '*'
    ? PERMISSION_CODES
    : template.permissions
}
