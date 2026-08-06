# Phase 8 — Kitchen & Printing

Kitchen display with stations and queues, order status transitions, station
routing, and ticket/receipt content generation.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 6 new codes — 73 total |
| Stations | Per branch, typed food/beverage/dessert, one default |
| Routing | Item → category → branch default, resolved and frozen per line |
| KDS | Queue grouped by table, age timers, start/ready/served |
| Transitions | Forward-only with timestamps at each step |
| Renderer | Kitchen tickets and receipts to fixed-width text, 27 unit tests |
| Printers | Modelled with connection and column width |
| Receipt templates | Header, footer, tax line, QR caption, width |

One migration: `0011_kitchen`. **41 tables, 68 RLS policies, 73 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 82 routes
RUN_DB_TESTS=1 npm test  ✅ 367/367 (120 integration)
```

## The boundary I did not cross

**Physical printing is not implemented, and cannot be from here.** Sending
bytes to a thermal printer needs an on-site agent talking to hardware over USB
or the local network — a driver, not a web application.

What exists is everything up to that line: printers are modelled with a
`connection` string and column width, and `renderKitchenTicket` /
`renderReceipt` produce the exact text that would be sent. An agent that reads
a print queue and pushes to a device is a separate, small program, and the
content it needs is now fully determined.

Rendering is pure, so the exact characters a customer will be handed can be
asserted in a test rather than discovered on paper. 27 tests cover wrapping,
right-aligned amounts, width limits at 32/42/48 columns, and the awkward cases
— an over-long dish name, a fully comped bill, inclusive versus added tax.

## Routing, and why the station is frozen

A dish is routed by its own station, else its category's, else the branch
default. Two details matter more than the order:

**A station configured on the menu belongs to one branch, but the menu is
shared across all of them.** Ordering the same dish at a different branch
falls through to *that* branch's default rather than routing a ticket to a
kitchen in another building.

**The resolved station is snapshotted onto the order line.** If someone
re-routes desserts mid-service, tickets already on the pastry screen must not
silently jump elsewhere, leaving a half-made dish on a queue nobody is
watching. An integration test re-routes an item after ordering and asserts the
existing line has not moved.

**An unrouted line is not an error.** A restaurant that has not configured
stations still sees every order on one board. Blocking an order because the
KDS was not set up would be the wrong trade entirely.

## A ticket is not a table

The KDS queue is a *view* over `order_lines` filtered by station and status.
There is no tickets table. Duplicating lines into one would create two answers
to "is this cooked yet", and they would eventually disagree.

Lines are grouped by session because a kitchen works a table at a time —
plating two dishes for one party together is the difference between food
arriving hot and arriving separately.

## Transitions are forward-only

`pending → preparing → ready → served`, and `pending → ready` directly.

That shortcut is deliberate: a drink poured in ten seconds never meaningfully
passes through "preparing", and forcing a second tap for it trains staff to
double-tap everything. A line jumped straight to ready still records
`startedAt`, so preparation time is never a null nobody can explain.

Going backwards is refused. An un-served line would make its timestamps
meaningless, and those timestamps are what any later question about kitchen
speed depends on.

## Timers are derived, never stored

Age comes from `placedAt` at render time. A "late" flag in the database would
need a background job to maintain and would be wrong between runs — the clock
is the only thing that actually knows. The card re-renders every 30 seconds so
the number moves without a server round trip.

## Two bugs caught while building

**A uuid column compared to an empty string.** The queue's station filter used
`or(isNull(stationId), ne(stationId, ''))` when no station was chosen —
Postgres would have rejected the comparison outright. The fix was simpler than
the bug: when no station is chosen, the condition is simply absent.

**Broken scaffolding in the test file.** I left a nonsense `tx.execute` block
in the setup while sketching how to route a category. It typechecked as
`never` and would have silently done nothing, making the category-routing test
pass for the wrong reason.

## Known gaps

- **No real-time push.** The KDS revalidates every 15 seconds. SSE or
  WebSockets would be better and is the obvious next step; polling is honest,
  needs no infrastructure, and a 15-second lag on an 8-minute dish is not what
  loses a service. Swapping it changes one line.
- **No printer or template admin UI.** Both tables, their policies and the
  renderer are complete; configuring them currently needs an API call or
  DBeaver. The KDS itself is built.
- **No station picker on the menu form.** `kitchenStationId` exists on items
  and categories and routing reads it, but the menu editor has no control for
  it yet.
- **No receipt endpoint.** `renderReceipt` is complete and tested but nothing
  calls it — a `GET /api/receipts/:sessionId` returning text, and a diner-
  facing digital receipt, are small additions on top.
- **No notification system.** The spec lists new-order, kitchen-ready and
  low-stock alerts. Kitchen-ready is now expressible from the data; the
  delivery mechanism is the same real-time work above.

## Next: Phase 9 — Promotions & Loyalty

Rule-driven discounts with stacking and priority, vouchers, membership tiers,
points and rewards. The manual discount from Phase 5 stays as the human
override; this is the engine that decides them automatically.
