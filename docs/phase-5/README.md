# Phase 5 — Order & POS

Staff-side ordering, takeaway and delivery, merge and transfer, manual
discounts, the bill calculation engine — and the floor view Phase 4 left
missing.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 5 new codes — 58 total |
| Fulfilment types | Dine-in, takeaway, delivery as one session model |
| Bill engine | Subtotal → discount → service charge → tax, 29 unit tests |
| Merge | Move every referencing row onto one bill, close the source |
| Transfer | Move a session to a free table, with branch and occupancy guards |
| Discounts | Manual, reasoned, permissioned, soft-removed |
| Voids | Status change, never a delete, reason required |
| Floor view | Live sessions, totals, waiter calls with resolve |
| Session detail | Itemised bill, running totals, void and close |

One migration: `0007_pos`. **34 tables, 56 RLS policies, 58 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 71 routes
RUN_DB_TESTS=1 npm test  ✅ 236/236 (81 integration)
```

## Takeaway is a session without a table

Rather than a parallel order model, `dining_sessions` gained a `type` and
`tableId` became nullable. One bill model means Phase 6 splits a delivery
order with the same code it splits a dinner table.

Two consequences worth stating:

**Hold/Resume needs no state.** For dine-in, the table *is* the hold. For
takeaway, an open session with no table already *is* a parked transaction. The
partial unique index keeps working unchanged, because NULL table ids are
distinct and unlimited takeaway sessions coexist.

**The floor view join had to become LEFT.** Typecheck caught this the moment
`tableId` became nullable — an inner join would have silently dropped every
takeaway and delivery order from the floor screen while leaving them payable
in the database. An integration test now asserts table-less sessions appear.

## The bill engine

Pure, like the Phase 3 pricing engine, and for the same reason: Phases 6 and 7
depend on it totally.

Order of operations is a business decision, not an implementation detail:

1. **Subtotal** — sum of line totals.
2. **Discount** — against the subtotal.
3. **Service charge** — on the *discounted* subtotal. Charging 10% service on
   an amount the customer is not paying is hard to defend to them.
4. **Tax** — on the discounted subtotal *plus* the service charge, because a
   service charge is itself taxable in the jurisdictions this targets.

In tax-inclusive mode nothing is added: service charge applies to the
inclusive amount and tax is *extracted* from the total for display. The
`taxIsIncluded` flag exists so a receipt can say "inclusive of 6% SST" rather
than listing a charge that was never added — a wording difference that is not
cosmetic.

**Multiple discounts are computed against the original subtotal and summed**,
never applied sequentially to a shrinking balance. Sequential application
makes the order matter, so "10% off then RM5 off" and "RM5 off then 10% off"
disagree and nobody can say which the till chose.

Two smaller decisions with real consequences: `extractIncludedTax` computes
the net and returns `gross - net` rather than rounding twice, so a receipt's
lines always add up to its total; and `roundForCash` returns the adjustment
separately, because a total that silently differs from the sum of its parts is
the fastest way to lose trust at the counter.

## Merge moves everything

Order lines, their frozen modifiers, members, discounts and open service
requests all move to the surviving session. A line left behind would vanish
from both bills — ordered, cooked, and charged to nobody.

Members move rather than being dropped. An order line points at the member who
ordered it, and losing that would turn every attributed dish on the absorbed
bill into a shared one, silently changing who owes what — precisely what Phase
6 must be able to rely on.

## Money-affecting actions are separated

`discount.apply` is its own permission, not part of `order`. The person who
may take an order is very often not the person who may decide something is
free — the cashier template gets `pos.merge` and `pos.takeaway` but not
`discount.apply`.

Discount rows are never deleted; removal sets `removedAt`. "Who comped this,
and who took it back off" is the first question asked when the till does not
balance. Voids work the same way: the line stays with `status = 'voided'` and
a required reason.

## Known gaps

- **No payment.** Phase 5 closes a session without recording money taken.
  Payment is Phase 7, and a "paid" flag with nothing behind it would be worse
  than an honest gap — the button on the session screen says so rather than
  being a dead control.
- **No staff order-entry screen.** `placeStaffOrder` is complete and tested,
  and the API works, but there is no POS keypad UI; staff ordering currently
  goes through the API. The floor and bill screens are built.
- **No merge or transfer UI.** Same position: services and routes tested, no
  buttons yet.
- **Vouchers are not built.** The spec lists them alongside discounts, but a
  voucher is a redeemable instrument with a lifecycle, not a manual
  adjustment. It belongs with the promotion engine in Phase 9.
- **Floor totals are computed per session.** Fine at a realistic floor size,
  wrong for a chain running hundreds of concurrent sessions on one screen —
  worth changing against a measurement rather than a guess.
- **Receipts are not built.** Digital receipt and printing are listed under
  POS in the spec but depend on the receipt template builder and printer
  routing, both Phase 8.

## Next: Phase 6 — Smart Bill Engine

The product's reason to exist. Split evenly, by item, by quantity, by
percentage; shared item handling; pay for others; partial settlement; leave
early. Everything it needs now exists: sessions, members, attributed lines,
and a bill engine that agrees with itself.
