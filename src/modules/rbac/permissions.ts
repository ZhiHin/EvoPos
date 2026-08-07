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
  ...define('promotion', {
    view: 'View promotions and how they are configured',
    create: 'Create a promotion',
    update: 'Edit a promotion, including its discount and rules',
    delete: 'Delete a promotion',
  }),
  ...define('voucher', {
    view: 'View voucher codes and their redemptions',
    issue: 'Issue voucher codes',
    redeem: 'Redeem a voucher code against a bill',
  }),
  ...define('customer', {
    view: 'View customer records and their loyalty balance',
    manage: 'Create and edit customer records',
  }),
  ...define('loyalty', {
    view: 'View loyalty tiers and point history',
    manage: 'Configure tiers and earning rules',
    /** Manual adjustment is a money-adjacent act, so it stands alone. */
    adjust: 'Manually add or remove loyalty points',
  }),
  ...define('kitchen', {
    view: 'View the kitchen display',
    /** Advancing a ticket: started, ready, served. */
    advance: 'Move a ticket through preparation',
    'station.manage': 'Create and configure kitchen stations',
  }),
  ...define('reservation', {
    view: 'View bookings',
    create: 'Take a booking',
    update: 'Change a booking’s time, size or table',
    /** Seating turns a booking into a live bill, so it stands alone. */
    seat: 'Seat a booking and open its table',
    cancel: 'Cancel a booking or mark it a no-show',
  }),
  ...define('waitlist', {
    view: 'View the waiting list',
    manage: 'Add, quote, notify and seat people waiting',
  }),
  ...define('shift', {
    view: 'View the roster',
    manage: 'Create and edit shifts',
    /**
     * Publishing is what staff actually see. Kept apart from editing so a
     * half-built roster is not a message to everyone about next week.
     */
    publish: 'Publish the roster to staff',
  }),
  ...define('attendance', {
    view: 'View timesheets and who is on shift',
    /** Clocking yourself in and out. Held by every working role. */
    clock: 'Clock in and out',
    /**
     * Editing a timesheet changes what someone is paid. It is the one
     * capability here that moves money, so it is nobody's by default.
     */
    edit: 'Correct a timesheet entry',
  }),
  ...define('ingredient', {
    view: 'View ingredients and what they cost',
    manage: 'Create and edit ingredients',
    /** A recipe decides what an order consumes, so it moves real stock. */
    'recipe.manage': 'Set what each menu item consumes',
  }),
  ...define('stock', {
    view: 'View stock levels and movements',
    /**
     * Counting corrects the books to match the shelf. It is the one movement
     * with no document behind it, which is exactly why it is separated from
     * receiving and kept away from anyone who can also order goods.
     */
    count: 'Record a stock count and correct the level',
    /** Wastage writes off value, so it is not merged with counting. */
    waste: 'Record wastage, spoilage or breakage',
    transfer: 'Move stock between branches',
  }),
  ...define('supplier', {
    view: 'View suppliers and their terms',
    manage: 'Create and edit suppliers',
  }),
  ...define('purchase', {
    view: 'View purchase orders',
    create: 'Raise a purchase order',
    /**
     * Approving commits the restaurant to a spend. Kept apart from raising
     * one so a single person cannot both order and authorise.
     */
    approve: 'Approve a purchase order and send it to the supplier',
    receive: 'Receive goods against a purchase order',
    cancel: 'Cancel a purchase order',
  }),
  ...define('printer', {
    manage: 'Configure printers and where each ticket is sent',
  }),
  ...define('receipt', {
    view: 'View and reprint receipts',
    'template.manage': 'Design receipt templates',
  }),
  ...define('payment', {
    view: 'View payments taken against a bill',
    take: 'Take a payment',
    /**
     * Voiding cancels a payment recorded in error — a mistyped amount, the
     * wrong method. Distinct from refunding, which returns money that was
     * genuinely taken.
     */
    void: 'Void a payment recorded in error',
  }),
  ...define('refund', {
    issue: 'Refund money to a customer',
  }),
  ...define('reconciliation', {
    view: 'View takings and reconcile the drawer',
  }),
  /**
   * Reporting is split three ways, because the three are different acts.
   *
   * `view` is operational: how many covers, which dishes sell, when the rush
   * is. A head chef needs it and it reveals nothing about money.
   *
   * `financial` is revenue, tax, cost and margin — what the business earns and
   * what it earns it on. Food cost percentage is the number an owner is most
   * reluctant to show, and a supplier-facing manager who knows it is in a
   * different negotiation.
   *
   * `export` is separate from both because downloading is not reading. A
   * report on screen is bounded by the session; a spreadsheet leaves with
   * whoever downloaded it and outlives their employment.
   */
  ...define('report', {
    view: 'View operational reports: covers, item performance, busy periods',
    financial: 'View revenue, tax, cost and margin reports',
    export: 'Download a report as a file',
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
      'promotion.view',
      'promotion.create',
      'promotion.update',
      'promotion.delete',
      'voucher.view',
      'voucher.issue',
      'voucher.redeem',
      'customer.view',
      'customer.manage',
      'loyalty.view',
      'loyalty.manage',
      'loyalty.adjust',
      'kitchen.view',
      'kitchen.advance',
      'kitchen.station.manage',
      'printer.manage',
      'receipt.view',
      'receipt.template.manage',
      'payment.view',
      'payment.take',
      'payment.void',
      'refund.issue',
      'reconciliation.view',
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
      'ingredient.view',
      'ingredient.manage',
      'ingredient.recipe.manage',
      'stock.view',
      'stock.count',
      'stock.waste',
      'stock.transfer',
      'supplier.view',
      'supplier.manage',
      'purchase.view',
      'purchase.create',
      'purchase.approve',
      'purchase.receive',
      'purchase.cancel',
      'reservation.view',
      'reservation.create',
      'reservation.update',
      'reservation.seat',
      'reservation.cancel',
      'waitlist.view',
      'waitlist.manage',
      'shift.view',
      'shift.manage',
      'shift.publish',
      'attendance.view',
      'attendance.clock',
      'attendance.edit',
      /**
       * A manager runs the reports and takes the numbers to a meeting, so all
       * three land here. No other template gets any of them by default —
       * reporting is a management act, and a role that needs it can be given
       * it deliberately rather than inheriting it by accident.
       */
      'report.view',
      'report.financial',
      'report.export',
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
      // Taking payment and splitting a bill is the whole of a cashier's job.
      'payment.view',
      'payment.take',
      'reconciliation.view',
      // A cashier redeems a voucher and looks up a member at the till, but
      // does not decide what promotions exist or adjust anyone's points.
      'promotion.view',
      'voucher.view',
      'voucher.redeem',
      'customer.view',
      /**
       * Added in Phase 11, when attaching a member to a bill became a till
       * action. "Are you a member?" is answered at the counter, and a cashier
       * who can look someone up but not sign them up would have to turn away
       * the person standing in front of them.
       */
      'customer.manage',
      'loyalty.view',
      'bill.view',
      'bill.split',
      'bill.lock',
      'pos.takeaway',
      'pos.merge',
      // Not `discount.apply`, and not `bill.void`: a cashier takes payment, a
      // manager decides something costs less or undoes an agreed split.
      'service.view',
      'service.resolve',
      // The phone at the till is where bookings are taken.
      'reservation.view',
      'reservation.create',
      'reservation.seat',
      'waitlist.view',
      'waitlist.manage',
      'shift.view',
      'attendance.clock',
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
      // A waiter watches the pass for what is ready to run, and marks it
      // served once it reaches the table.
      'kitchen.view',
      'kitchen.advance',
      'service.view',
      'service.resolve',
      // Walking a booking to its table, and the waiting list at the door.
      'reservation.view',
      'reservation.seat',
      'waitlist.view',
      'waitlist.manage',
      'shift.view',
      'attendance.clock',
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
      // The kitchen display is the whole of this role's job.
      'kitchen.view',
      'kitchen.advance',
      /**
       * The kitchen is where things get dropped, burnt and left out. Whoever
       * ruins the ingredient is the only person who can say so at the moment
       * it happens; routing it through a manager means it gets written off
       * days later, or not at all.
       */
      'stock.view',
      'stock.waste',
      // Everyone who works a shift can see the roster and clock themselves
      // in. Neither is an administrative act.
      'shift.view',
      'attendance.clock',
    ],
  },
  {
    key: 'inventory',
    name: 'Inventory Staff',
    description: 'Manages stock, suppliers and goods receiving.',
    /**
     * Raises purchase orders but cannot approve them. The separation is the
     * point: one person ordering, authorising and receiving their own goods
     * is how invoices for deliveries nobody saw get paid.
     */
    permissions: [
      'branch.view',
      'ingredient.view',
      'ingredient.manage',
      'ingredient.recipe.manage',
      'stock.view',
      'stock.count',
      'stock.waste',
      'stock.transfer',
      'supplier.view',
      'supplier.manage',
      'purchase.view',
      'purchase.create',
      'purchase.receive',
      'purchase.cancel',
      'shift.view',
      'attendance.clock',
    ],
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
