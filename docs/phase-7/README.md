# Phase 7 — Payments

Cash, terminal card, e-wallet and transfer settlement; voids, refunds,
mixed payment, and daily reconciliation. Real money, offline methods only —
the online gateway layer is designed for but deliberately not wired.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 5 new codes — 67 total |
| Settlement engine | Outstanding, cash tender and change, guards — 34 unit tests |
| Payments | Cash, card terminal, e-wallet, transfer, other |
| Idempotency | Client-supplied key, unique per restaurant |
| Mixed payment | Any number of payments per bill or per split share |
| Voids | Payment recorded in error, reason required, row survives |
| Refunds | Partial or full, own table, own permission |
| Close guard | A bill with anything outstanding cannot be closed |
| Reconciliation | Daily takings by method, expected cash drawer |

One migration: `0010_payments`. **38 tables, 64 RLS policies, 67 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 79 routes
RUN_DB_TESTS=1 npm test  ✅ 328/328 (108 integration)
```

## What is and is not real

**Real, working, needs nothing from anyone:** cash with tender and change,
card and e-wallet recorded from a physical terminal, bank transfer, mixed
payment, voids, refunds, reconciliation.

**Not built:** the online gateway. `gateway` exists in the method enum and
`gatewayProvider` / `gatewayPaymentId` / `gatewayPayload` exist as columns,
but `takePayment` explicitly **refuses** to record one:

> Online payments cannot be recorded manually. They are confirmed by the
> payment provider.

That refusal is the point. A gateway payment is only real once its webhook
arrives and its signature verifies — the browser saying "payment succeeded" is
a hint, not evidence. Leaving the door open to record one by hand would make
the eventual webhook implementation optional, which is how a restaurant serves
food it never gets paid for.

The columns are present so adding a provider is a service change rather than a
migration during a phase where money is already moving.

## Idempotency, from the first payment

Every payment and refund carries a client-supplied key, unique per restaurant
by database index. A retry — a double-clicked button, a mobile connection that
dropped after the write but before the response — returns the original record
with `wasReplay: true` rather than taking money twice.

The UI generates the key **once per dialog opening**, not per submit.
Regenerating per attempt would make the mechanism decorative, which is a
subtle and common way to ship idempotency that does nothing.

## Two asymmetries that matter

**Cash may exceed the balance; a card may not.** Cash overpayment is what
change is for. A card has no mechanism to hand back the difference, so an
over-amount becomes a refund the customer has to chase — refused at the
counter, where a cashier can simply retype the figure.

**Cash is capped at what is owed.** A customer handing RM 50 for a RM 10 bill
is paying 10 and receiving 40 back. Recording the tender as the payment would
overstate takings and leave the drawer short when counted.

## Void is not refund

| | Means | Row |
| --- | --- | --- |
| **Void** | The payment never really happened — wrong amount, wrong method | `status = 'voided'`, reason required |
| **Refund** | It did happen, and money went back | New row in `payment_refunds` |

A payment that has been partly refunded **cannot** be voided: it is
unambiguously in the second category, and voiding would leave a refund
pointing at a payment that denies existing.

Refunds are their own table rather than negative payments. Folding them in
would make every takings query remember to filter by sign, and one that forgot
would silently under-report.

## A bill cannot close while it owes money

`settleAndCloseSession` refuses while anything is outstanding. An unpaid bill
quietly closing is how money goes missing without anyone noticing — the table
is free, the screen is clear, and nobody can say what happened to the forty
ringgit.

`closeSession` remains the low-level primitive, used by tests and by future
flows that legitimately close an unpaid bill (a walkout, written off
deliberately). The till uses the guarded wrapper.

## A bug the integration tests caught

Taking payment on an already-settled bill returned *"Enter an amount greater
than zero"* — because cash is capped at the outstanding balance, that cap was
zero, and the generic amount check fired before the settled check. A cashier
who had just typed 10.00 would have been told their amount was zero.

The settled check now runs first. The lesson generalises: when several guards
can reject the same input, the one that explains *why* has to come before the
one that merely notices *something* is wrong.

## Reconciliation

Takings are bounded by **when payment was taken**, not by when a table opened.
A party seated at 23:30 and paid at 00:15 belongs to the day the money moved,
because that is the day someone counts the drawer.

`expectedCashMinor` is broken out on its own because it is the only figure
checkable against something physical. Card and e-wallet totals reconcile
against the terminal's own settlement report; cash reconciles against counting
the drawer, and a discrepancy there is the one a manager needs the same night.

## Known gaps

- **No online gateway.** Deliberate — see above. Adding one means: a provider
  SDK, a `pending` payment on checkout, a webhook route that verifies the
  signature before flipping to `succeeded`, and a reconciliation job for
  payments whose webhook never arrived.
- **No receipt.** Digital and printed receipts depend on the template builder
  and printer routing, both Phase 8. Every number a receipt needs is now
  recorded, including the cash rounding adjustment.
- **No refund UI.** `issueRefund` and its route are complete and tested; there
  is no button. The take-payment and void paths have UI.
- **No split-share payment UI.** `splitShareId` is supported end to end and
  tested at the service level, but the split panel does not yet offer "take
  payment for this person".
- **No tips or surcharges.** Neither appears in the spec; both would be
  additional line types on the bill rather than payment concerns.
- **Cash rounding is fixed at 5 sen.** Correct for Malaysia, and configurable
  per restaurant when a second market needs it.

## Next: Phase 8 — Kitchen & printing

KDS with stations and queues, order status transitions, printer routing
rules, receipt templates, and the notification layer. Order lines have carried
a `status` column since Phase 4 waiting for exactly this.
