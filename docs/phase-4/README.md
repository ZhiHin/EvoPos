# Phase 4 — Dining Session & QR Ordering

The core business object. A diner scans a table, joins a session, orders from
their phone, and sees what they owe — without an account, and without the
server ever handing them tenant access.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 9 new codes — 53 total |
| Dining sessions | One live session per table, opened by staff or by first scan |
| Members | Anonymous diners with short-lived, session-scoped tokens |
| Order lines | Placed via the Phase 3 pricing engine, every price frozen |
| Shared items | Attributed to the table rather than a person |
| Service requests | Call waiter, request bill, deduplicated per type |
| Diner UI | Join screen, menu with modifier selection, cart, live bill |

One migration: `0006_dining_sessions`. **33 tables, 54 RLS policies, 53 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 59 routes
RUN_DB_TESTS=1 npm test  ✅ 193/193 (67 integration)
```

## Scope reconciliation

The roadmap put "Order + POS" in Phase 5, but QR ordering cannot exist without
orders. The split that actually works:

- **Phase 4 owns the order-line model.** An order line belongs to a dining
  session; it is a session concern.
- **Phase 5 owns the staff POS workflows** on top — hold, merge, transfer
  table, takeaway and delivery, order status transitions.

Without this, Phase 4 would deliver a menu you can look at and not order from.

## The fourth database context

Three existed before this phase: tenant (staff), actor (tenant-less staff),
and QR token (anonymous scan, read-only). Phase 4 adds the diner.

```
app.member_token     proves who you are; reveals exactly your member row
app.member_id        your identity, once proven
app.session_id       scopes you to one table's bill
app.diner_tenant_id  read-only menu access, and nothing else
```

**`withDiner` deliberately never sets `app.tenant_id`.** Every tenant policy
in the system compares against that variable, so setting it for someone who
scanned a sticker would hand an anonymous stranger the whole restaurant. An
integration test asserts it stays null inside diner context, because this is
the kind of thing a well-meaning refactor "fixes" by adding one line.

Bootstrapping is two steps in one transaction, mirroring the Phase 1 QR
pattern: set the token variable, let `dining_session_members_token_lookup`
reveal exactly that one row, read it, then set the identity variables the
remaining policies use.

A diner may **SELECT** their session, its members, its lines and its service
requests; **INSERT** order lines and service requests into their own session;
and **SELECT** their restaurant's menu. There is deliberately no member UPDATE
or DELETE policy anywhere — removing an item from a bill is a void, which is
staff work and audited.

### Ten diner-read policies on the menu tables

A diner needs to see a menu to order from it, and the menu tables had only
tenant policies. Rather than granting tenant context for a read, each gained
an explicit SELECT-only policy keyed on `app.diner_tenant_id`. More policies,
but the invariant "a diner request never sets tenant_id" survives intact.

## Price freezing

**Every price is recomputed server-side and then frozen onto the line.** The
client sends item ids, quantities and modifier choices — never amounts. A
price arriving from a phone is a request, not a fact.

`order_lines` stores `nameSnapshot`, `unitPriceMinor` and `lineTotalMinor`;
`order_line_modifiers` stores the group and option names alongside the delta.
`menuItemId` is kept for reporting but is not what the bill is computed from,
and `ON DELETE SET NULL` means deleting a menu item cannot erase the history
of it having been sold.

A test repriced an item from 12.00 to 99.00 after an order was placed and
asserted the line total did not move.

## One live session per table

Enforced by a partial unique index, not by application code:

```sql
CREATE UNIQUE INDEX dining_sessions_one_open_per_table
  ON dining_sessions (table_id)
  WHERE status in ('open', 'bill_requested');
```

Two diners scanning the same QR within milliseconds is the ordinary case, not
an edge case. A check-then-insert lets both succeed and splits one table
across two bills. Here the second insert loses, and the service turns that
into "join the existing session" — which is what the diner wanted anyway.

## Personal totals stop short of splitting

`personalTotalMinor` covers a member's own lines. It deliberately does **not**
include a share of the shared items.

How a shared dish is divided — evenly, by who ate it, by percentage, by one
person paying for another — is the entire substance of Smart Bill in Phase 6.
Inventing an answer here would bake one policy in before that design exists,
so shared items are reported separately and the UI says plainly that the split
is settled when you pay.

## A bug caught before shipping

The diner cookie was first scoped to `Path=/t`, reasoning that a diner
credential has no business travelling with staff requests. It does not work:
the ordering endpoints live at `/api/diner/*`, so the browser would never send
it and **every order would have failed with "session ended"**.

Fixed to `Path=/`. What actually protects the token is unchanged — httpOnly,
SameSite=Lax, a six-hour lifetime, and the fact that presenting it grants only
member context.

## Known gaps

- **No staff floor view.** `listLiveSessions` is written and tested but has no
  screen; waiter calls currently land in the database with nothing displaying
  them. This is the first thing Phase 5 should build.
- **No combo ordering.** Combos are modelled, priced and API-complete, but the
  diner screen offers only single items. `placeDinerOrder` handles
  `menuItemId` and would need a combo branch.
- **Menu loading is N+1.** `loadDinerMenu` fetches modifier rules per item.
  Fine for a demo menu, wrong for a few hundred items — deferred to Phase 5
  where the POS loads the same data under real load and the cost is
  measurable rather than guessed at.
- **Order status never advances.** Lines are created `pending` and stay there;
  `preparing`/`ready`/`served` transitions belong to the KDS in Phase 8.
- **Branch-level modifier availability still unread.** The table and policy
  exist from Phase 3; the engine has the branch context now but does not yet
  filter by it.

## Next: Phase 5 — Order & POS

Staff-side ordering, hold and resume, merge orders, transfer table, takeaway
and delivery. Plus the floor view this phase leaves missing.
