# Phase 9 — Promotions & Loyalty

Rule-driven promotions evaluated against live bills, voucher codes, customer
records, and a points ledger with tiers.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 12 new codes — 85 total |
| Engine | Pure evaluation of 4 discount kinds against 11 conditions, 39 unit tests |
| Promotions | Priority ordering, stackability, usage caps, time and day windows |
| Vouchers | Bearer or named codes, redemption limits, expiry |
| Customers | Lookup-or-create by phone, audited |
| Loyalty | Append-only ledger, accrual on settlement, redemption, manual adjustment |
| Tiers | Threshold-based, recomputed from lifetime points |
| Till UI | Check promotions and redeem a code from the bill |
| Admin UI | Promotions list and creation form |

One migration: `0012_promotions`. **47 tables, 75 RLS policies, 85 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 82 routes
RUN_DB_TESTS=1 npm test  ✅ 421/421 (135 integration)
```

## The engine decides; the service only supplies facts

`src/modules/promotion/engine.ts` is pure. It takes promotion definitions and
a bill context — lines, subtotal, branch, time, tier, which vouchers are
unlocked — and returns what applies, what does not, and why.

Keeping it pure is what makes the awkward cases testable without a database:
a window that crosses midnight, a promotion whose last use was claimed a
moment ago, a non-stackable promotion displacing three others. 39 unit tests
cover them.

`checkEligibility` returns a *reason*, not a boolean. A manager asking "why
didn't the happy hour apply?" gets `Bill is RM 18.00, below the RM 25.00
minimum` rather than silence. When a non-stackable promotion takes the bill,
the ones it displaced are recorded as `Superseded by "X", which cannot be
combined` — otherwise they would vanish from the explanation entirely and the
answer would look like a bug.

## Nothing the browser sends is trusted

The apply endpoint takes no amount. It takes a session id, re-reads the lines,
re-evaluates every rule server-side, and writes the result itself. A discount
arriving from a client is a request to re-check, not a figure to honour — the
same rule prices, splits and taxes already follow.

Voucher redemption returns the same message for an unknown code, an inactive
one and an expired one. A differentiated error turns the endpoint into an
oracle: guess codes until "expired" comes back instead of "unknown", and you
have learned which prefixes are real. An integration test asserts the two
messages are byte-identical, so a future refactor that helpfully distinguishes
them fails.

## The usage cap is a conditional UPDATE, not a read-then-write

A `select` to check remaining uses followed by an `update` to spend one is two
statements with a gap between them, and two tills can both pass the check.

```sql
update promotions set usage_count = usage_count + 1
where id = $1 and (max_usage_total is null or usage_count < max_usage_total)
returning id
```

An empty `returning` means someone else took the last use. Skipping is the
correct response: the customer simply does not get that one. An integration
test applies a single-use promotion to two bills and asserts the counter
lands on exactly 1 — an overshoot would mean the claim is not doing its job.

## The ledger is the only balance

There is no `points_balance` column on `customers`. A cached total is a second
answer to the same question, and the two drift the first time a write path
forgets to update it — which is the write path that matters, because it is
always the unusual one.

Every movement is a signed row with a reason. The balance is the sum; lifetime
points are the sum of the positive rows only. Accrual is idempotent on the
session, so a retried settlement does not pay out twice.

Tiers are computed from **lifetime**, not current balance. Spending points
must not demote someone — a tier is recognition of what they have spent, and
taking it away because they used a reward is the fastest way to make the
reward feel like a punishment. A test earns to gold, spends 500 points, and
asserts the tier holds.

## The bug this phase caught in itself

`applyPromotions` recorded redemptions in `promotion_redemptions`, and
`computeSessionTotals` read discounts from `session_discounts`. Both were
correct in isolation. Nothing joined them.

The result: the till would report "Applied Happy Hour −RM 1.00", show it in
the promotions list, write an audit entry — and charge the customer the full
RM 10.00. Every layer looked right, and the money was wrong.

The integration test caught it on the first run because it asserted the
**total**, not the return value. `expect(applied[0].discountMinor).toBe(100)`
passed. `expect(await totalOf(sessionId)).toBe(900)` did not.

The fix routes promotions through the same discount pipeline as manual
discounts, so they land before service charge and tax like every other
reduction. A separate path would be a second order of operations, and the two
would disagree the first time either changed.

Each entry now carries `source: 'manual' | 'promotion'`, because the remove
button on the bill deletes a `session_discounts` row — offered against a
promotion it would have called an endpoint with an id that does not exist.

## Prices are frozen, here too

BOGO and cheapest-item-free are computed against `unitPriceMinor` on the order
line, not against the current menu. A discount derived from a price that has
since changed would take an amount off the bill that the customer never saw on
it.

The engine resolves each promotion to an exact minor-unit figure, and that
figure is what enters the bill — a stored percentage re-derived at settlement
would round a second time against a subtotal the engine never evaluated.

## Known gaps

**No promotion editing or deletion in the UI.** The service and permissions
exist (`promotion.update`, `promotion.delete`); the admin screen only creates
and lists. Pausing a promotion currently means editing the row.

**No voucher issuance UI.** Codes are created directly in the database.
Bulk generation for a campaign — with a prefix, a count, and an expiry — is a
small screen and is deferred rather than half-built.

**Points accrual is not yet wired into settlement automatically.**
`earnPointsForSession` is written, tested and idempotent, but the payment flow
does not call it because a bill has no customer attached until Phase 11 gives
the till a member lookup. Attaching one is a field on the session and a call
in `settleAndCloseSession`.

**Category and item conditions are not exposed in the create form.** They work
— the engine checks them and the columns are there — but selecting from the
full menu needs a picker rather than a list of UUIDs.

**The earn rate is a constant**, not a per-restaurant setting. One point per
major unit. Making it configurable before anyone has asked for a different
rate would be a settings screen nobody opens, and it is a single column when
they do.

## Next: Phase 10 — Inventory & Suppliers

Stock levels per branch, recipe-level deduction on order, purchase orders,
suppliers, low-stock alerts, and wastage recording.
