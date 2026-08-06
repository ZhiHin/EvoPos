# Phase 10 — Inventory & Suppliers

Ingredients, recipes, automatic deduction when an order is placed, wastage and
counts, suppliers, and purchase orders with partial goods receiving.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 14 new codes — 99 total; the `inventory` role is no longer a stub |
| Engine | Recipe explosion, shortfalls, weighted-average cost, reorder suggestions — 33 unit tests |
| Ingredients | Unit, cost, reorder point and quantity, preferred supplier |
| Recipes | Per menu item **and** per modifier option |
| Deduction | Automatic on both the staff and QR order paths, reversed on void |
| Stock | Per-branch levels, append-only movement ledger, counts, wastage, transfers |
| Suppliers | Contacts and payment terms |
| Purchasing | Draft → approved → partially received → received, with over-receipt refused |
| Costing | Weighted average recalculated on every receipt |
| UI | Stock screen with counts and wastage, purchase order list and detail |

Two migrations: `0013_inventory`, `0014_inventory_po_fk`.
**54 tables, 82 RLS policies, 99 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 71 API routes, 22 pages
RUN_DB_TESTS=1 npm test  ✅ 473/473 (154 integration)
```

## Milli-units, for the same reason money is in minor units

Every quantity is an integer count of thousandths of the stock unit. A recipe
using 0.1 kg three times must consume exactly 0.3 kg, and `0.1 + 0.1 + 0.1 !==
0.3` in IEEE 754. An ingredient held in kilograms stores 250 g as `250`; one
held as `each` stores 3 pieces as `3000`.

Cost is held as minor currency units per **whole** stock unit — RM 12.00/kg is
`1200`. Consuming 250 milli costs `250 × 1200 / 1000`, rounded once at the
end. Holding cost per milli-unit instead would mean sub-cent storage and a
rounding decision on every single component.

## The one place this phase caches, and why

Loyalty deliberately has no cached balance: the ledger is the only answer.
Inventory has `stock_levels.quantity_milli`, which is a cache. That is a
change of access pattern, not a change of principle, and it is worth being
explicit about rather than quietly inconsistent.

A customer's loyalty ledger is tens of rows, read while they stand at the
till. An ingredient's ledger grows by a row per order line per service, and it
is read on **every** order to check availability. Summing it each time would
make ordering slower the longer the restaurant had been open — the failure
mode where the software degrades precisely as the business succeeds.

The cache is defensible only because of two things:

**One write path.** Everything that moves stock — consumption, returns,
wastage, counts, transfers, receipts — goes through `recordMovement`, which
inserts the ledger row and updates the level in the same transaction. The
update is an upsert with `quantity_milli + excluded`, not a read-then-write:
two orders consuming the same ingredient concurrently would otherwise both
read the same level and both write their own total, losing one deduction
entirely.

**A reconciler, and a test that proves it works.** `reconcileStock` recomputes
every level from the ledger and reports drift. One integration test runs a
delivery, five orders, a void, wastage, a count and a transfer, then asserts
zero drift. A second test corrupts a level directly, bypassing
`recordMovement`, and asserts the reconciler catches it — because a checker
that always returns "fine" would make the first test meaningless.

## Shortfalls are reported, never enforced

An order that would take stock negative goes through, and returns what it fell
short of.

Refusing would mean the POS declines food the kitchen is willing to make. A
kitchen that has run out mid-service substitutes, or tells the table — it does
not stop cooking because the software says so. The immediate workaround for a
POS that blocks orders is to stop recording stock at all, which costs far more
than a negative balance ever does.

The same logic applies to wastage: writing off more than the system believes
is on hand is allowed. The bin does not care what the books said.

## Modifiers consume ingredients too

"Extra cheese" is a real 20 g of cheese leaving the fridge. Recipes attach to
modifier options as well as menu items, and `explodeRequirements` adds them on
top of the dish's own — merging where both use the same ingredient, so one
deduction is recorded rather than two.

Ignoring modifiers is the quiet way an inventory system drifts: the counts
look plausible for months and are wrong by exactly the volume of every upsell.

Requirements come back sorted by ingredient id. Two concurrent orders touching
the same ingredients then lock rows in the same sequence and cannot deadlock
against each other.

## Separation of duties is enforced in the service

`approvePurchaseOrder` refuses when the approver is the person who raised the
order — not by hiding a button, but by checking `created_by_user_id` before it
writes. One person raising, authorising and receiving their own goods is how
invoices for deliveries nobody saw get paid, and a rule enforced only in the
UI is not enforced.

The `inventory` role can raise, receive and cancel purchase orders but holds
no `purchase.approve`. Only managers and owners do.

Kitchen staff hold `stock.waste` and `stock.view`. Whoever burns the sauce is
the only person who can say so at the moment it happens; routing it through a
manager means it gets written off days later, or not at all.

## Receiving is the only thing that changes cost

Weighted average, recalculated on every receipt: 1 kg on hand at RM 10.00 plus
3 kg delivered at RM 14.00 gives RM 13.00/kg, not RM 12.00.

FIFO would be more accurate and needs every receipt kept as a separately
costed layer that consumption draws down in order — a materially larger model
for a restaurant whose stock turns over in days. Weighted average is the
standard for exactly this case, and moving to FIFO later is a new table rather
than a rewrite.

The movement itself is costed at the **invoice** price, not the new average:
the average is what remaining stock is worth, while this delivery is worth
what was paid for it. Each movement snapshots its cost, so last month's
consumption is not revalued when a delivery changes the average and a closed
month's food cost does not move after it was reported.

Partial receipts are the normal case. Suppliers short a case, substitute a
size, deliver over two days. Over-receipt is refused, because a delivery
larger than the order is either a supplier error or a typo and both want a
human looking before stock and the payable move.

## Counting asks for the shelf, not the difference

`recordCount` takes the quantity physically present and derives the
adjustment. Someone holding a clipboard knows there are 4 kg; making them work
out that this is 1.4 kg less than the system thinks is asking for arithmetic
under time pressure, and those mistakes go straight into the books.

A count that finds no discrepancy still stamps `last_counted_at`. "Checked,
and it was right" is a fact worth keeping — without it the shelf looks like it
was never counted at all.

## Known gaps

**A voided line always returns its stock, even if the dish was cooked.** For a
line voided before the kitchen starts, returning is correct. For one voided
after it was made, the ingredients are genuinely gone and the honest record is
wastage. The order-line status is available at that point, so the fix is small
— but choosing the cut-off is a decision for whoever runs the kitchen, not a
default worth guessing.

**No recipe editor in the UI.** `setRecipe` is written, validated and tested,
and the permission exists, but attaching ingredients to a dish still means
calling the service. It needs a picker on the menu item screen rather than a
list of UUIDs.

**No ingredient editing or deactivation in the UI.** Creation only; changing a
reorder point means editing the row.

**Ingredient units cannot change once stock has moved**, and nothing enforces
that yet. Switching an ingredient from kg to each would silently reinterpret
every historical quantity by a factor of a thousand.

**COGS is recorded but not reported.** Every consumption movement carries its
signed value, so gross margin per dish is a query away — it belongs with the
rest of the reporting in Phase 12 rather than as a one-off screen here.

**Transfers are immediate, with no in-transit state.** Stock leaves one branch
and arrives at the other in the same transaction. For vans crossing a city
that is fine; for stock that takes a day to arrive it under-states one branch
and over-states the other for that day.

## Next: Phase 11 — CRM, Reservations & Staff

Customer profiles and segmentation, bookings and waitlist, staff shifts and
attendance. It also carries the piece Phase 9 left open: attaching a member to
a bill, which is what lets loyalty points accrue automatically at settlement.
