# Phase 6 — Smart Bill Engine

The product's stated reason to exist: dividing a table's bill between the
people at it, exactly, and freezing the result so nobody is charged a number
they never agreed to.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 4 new codes — 62 total |
| Allocation engine | Largest-remainder, exact to the cent, 31 unit tests |
| Strategies | By owner, evenly, by percentage, by item (incl. per-quantity) |
| Shared items | Divided across whoever is still at the table |
| Charges | Discount, service charge and tax allocated proportionally |
| Locking | Frozen shares, one live split per session, stale-bill guard |
| Voiding | Reason required, row survives |
| Diner view | Every share on their table, scoped by RLS |

One migration: `0009_bill_splits`. **36 tables, 60 RLS policies, 62 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 75 routes
RUN_DB_TESTS=1 npm test  ✅ 278/278 (92 integration)
```

## The one invariant

> **The shares must sum to exactly the bill total — never a cent over, never a
> cent under.**

RM 10.00 split three ways is 333.33 cents each. Three lots of 333 is 999, and
that missing cent has to land somewhere deterministic. `allocate` uses the
largest-remainder method: everyone gets the floor of their exact share, then
the leftover cents go one each to whoever was cut hardest by that flooring,
ties broken by index.

Determinism is not a nicety. A number shown on screen and a number written to
the database a second later must agree, or a customer sees one figure and is
charged another.

Three defences, deliberately overlapping:

1. `allocate` is exact by construction.
2. Allocation happens **per line**, not on the grand total — so every share can
   show which dishes it came from, and if each line divides exactly, so does
   their sum.
3. `assertSplitBalances` re-checks the finished split and throws before
   anything is persisted. Cheap, and it means an arithmetic regression fails
   at the till rather than quietly on a customer's card.

A brute-force test sweeps strategies × party sizes × tax modes × awkward
prices and asserts the invariant on every combination.

## Strategies

| Strategy | Behaviour |
| --- | --- |
| `by_owner` | You pay for what you ordered; shared dishes divide evenly |
| `even` | The whole bill divides equally, regardless of who ordered |
| `by_percentage` | Fixed proportions in basis points; must total exactly 100% |
| `by_item` | Explicit line assignments, optionally by quantity; anything unassigned falls to the table |

Two fallbacks worth naming, both chosen so money never disappears:

- **An owner who has left** still has their dish paid for — it falls back to
  the table rather than dropping off the bill.
- **An unassigned item under `by_item`** divides evenly rather than going
  unpaid. A forgotten dish becomes shared, not free.

## Tax, service charge and discounts

Allocated in proportion to each person's share of the subtotal, using the same
exact-remainder method — so the parts of a split add up the same way the parts
of a bill do.

The split takes the totals **already computed by the Phase 5 bill engine**
rather than recomputing them. A split can therefore never disagree with the
bill it came from: the discount, service charge and tax being divided are
exactly the ones printed at the bottom of the receipt.

Tax-inclusive mode is mirrored, not reimplemented: the tax is already inside
the line prices, so it is reported per person but never added to their total.
Adding it would charge it twice and the shares would exceed the bill.

## Locking, and why "leave early" works

A locked split is a record of an agreement, not a cached calculation. Once
locked the amounts never move again — which is what makes leave-early
settlement possible. Someone agrees RM 42.30 and walks out, and a later round
of drinks cannot retroactively change what they already settled.

Two guards, both about a bill shifting underneath someone:

- **`expectedBillTotalMinor`.** The cashier sends the total they were looking
  at. If an order landed in between, the server refuses rather than committing
  customers to amounts derived from a bill nobody saw — the classic
  lost-update problem, with money attached.
- **One locked split per session**, enforced by a partial unique index rather
  than a check-then-insert. Two cashiers splitting the same table concurrently
  would otherwise produce two authoritative-looking answers.

When items are ordered after a split is locked, `readLockedSplit` reports the
live total alongside the frozen one. The gap is money nobody has been asked
for, and staff see it on screen rather than discovering it at the end of the
night.

## A lint rule that improved the design

`react-hooks/set-state-in-effect` flagged the split panel fetching its preview
on mount. The fix was not to silence it: the page already had the data
server-side, so the default split is now computed there and passed in. The
effect disappeared entirely, the amounts are on screen in the first paint, and
changing strategy — a user action — lives in a handler where it belongs.

## Known gaps

- **`by_percentage` and `by_item` have no UI.** Both are fully implemented,
  validated and tested through the engine and API, but each needs its own
  editor — per-person sliders, per-dish assignment. The panel offers only the
  two strategies that need no further input, rather than shipping a
  half-built editor.
- **No settlement.** A locked split records who owes what; marking it paid is
  Phase 7. A "settled" flag with no money behind it would be the same
  dishonest state the Phase 5 close button refused to fake.
- **Pay-for-others is expressible but not exposed.** `by_percentage` with one
  person at 100% is exactly "I'll get this" — it just needs the editor above.
- **No partial settlement tracking.** Once payments exist, a share needs a
  paid/outstanding state; the schema is ready for it but does not model it yet.

## Next: Phase 7 — Payments

Cash, card, e-wallets, DuitNow QR, gateway webhooks, mixed payment,
reconciliation. Everything it needs now exists: an exact bill, an exact split,
and shares to attach money to.
