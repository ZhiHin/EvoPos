# Roadmap

Ordered by hard dependency, not by perceived importance. The Smart Bill engine
is the product's reason to exist, and it still cannot come early: splitting a
bill requires orders, orders require a dining session, and settling requires
payments. Building it before those exist would mean building it twice.

Each phase ships ten artifacts: functional requirements, database design, ER
diagram, API specification, business rules, UI/UX screens, validation rules,
security considerations, test cases, documentation.

| # | Phase | Delivers | Depends on |
| --- | --- | --- | --- |
| **0** | **Foundation** ✅ | Scaffold, Postgres + RLS, auth, RBAC, tenancy, audit trail, module conventions | — |
| **1** | **Restaurant structure** ✅ | Branches, floors, tables, QR token engine, settings (profile/tax/service charge) | 0 |
| **2** | **Universal Menu Engine** ✅ | Nested categories, items, custom attributes, tags/allergens, availability, branch overrides | 1 |
| **3** | **Modifiers & Combos** ✅ | Modifier groups, selection rules, combo builder, pure pricing engine | 2 |
| **4** | **Dining Session & QR ordering** ✅ | The core business object; join table, diner context, order lines with frozen prices, call waiter | 1, 3 |
| **5** | **Order & POS** ✅ | Dine-in / takeaway / delivery, merge, transfer, discounts, bill engine, floor view | 4 |
| **6** | **Smart Bill Engine** ✅ | Exact-to-the-cent splitting: by owner / evenly / by percentage / by item, shared items, locked shares for leave-early | 5 |
| **7** | **Payments** ✅ | Cash, terminal card/e-wallet, transfer, mixed payment, idempotency, voids, refunds, reconciliation. Online gateway deferred | 6 |
| **8** | **Kitchen & printing** ✅ | KDS with stations, queues and timers, forward-only transitions, station routing, ticket/receipt rendering. Physical printing needs an on-site agent | 5 |
| **9** | **Promotions & Loyalty** ✅ | Pure rule engine, stacking and priority, usage caps, vouchers, membership tiers, points ledger. Accrual wires into settlement once Phase 11 attaches a member to a bill | 5 |
| **10** | **Inventory & Suppliers** ✅ | Ingredients, recipes on items and modifiers, auto-deduction and return on void, movement ledger with a proven reconciler, suppliers, purchase orders with partial receiving and weighted-average costing | 2, 5 |
| **11** | **CRM, Reservations, Staff** ✅ | Bookings with transactional availability, waiting list, customer profiles, roster with conflict-checked publishing, time clock. Closes Phase 9's loyalty accrual | 4 |
| 12 | Dashboard & Reporting | Real-time operations, sales/profit/tax reports, PDF/Excel/CSV export | 5, 7 |
| 13 | AI Restaurant Manager | Recommendations with explanations across sales, inventory, ops, customers, finance | 12 |
| 14 | SaaS & integrations | Plan metering and gating, franchise dashboard, third-party integrations, deploy hardening | all |

## Why this order

**Sessions before orders (4 → 5).** The Dining Session is the object every
workflow hangs from. Building orders first would mean an order model that has
to be retrofitted onto sessions afterwards.

**Smart Bill after payments groundwork but before gateways (6 → 7).** The
engine decides *who owes what*; the gateway decides *how it is collected*.
Keeping the split logic independent of any provider means adding a new payment
method later never touches billing arithmetic.

**Promotions after orders (9).** A discount rule is only testable against a
real order total. Building the rule engine against a hypothetical one produces
a rule engine that does not fit.

**Inventory after menu and orders (10).** Automatic stock deduction is defined
by recipe-to-menu-item mapping and consumption at order time. Both must exist.

**AI last but one (13).** Recommendations need history. An AI manager with no
data to manage is a demo.

## Cross-cutting, delivered continuously

Not phases — they are conditions of every phase:

- Multi-tenant isolation (established in Phase 0, extended by each new table)
- Server-side calculation of every price, discount, tax and total
- Audit logging on security- and money-relevant actions
- Configuration over hard-coding: business rules belong in the admin panel
- Mobile-first, touch-friendly, light and dark
