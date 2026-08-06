# Phase 11 — CRM, Reservations & Staff

Bookings with real availability, a waiting list, customer profiles, the roster
and the time clock — and the piece Phase 9 deliberately left unwired.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 13 new codes — 112 total |
| Booking engine | Interval overlap, table fit, alternatives, wait quoting — 24 unit tests |
| Timesheet engine | Worked minutes, lateness, shift matching, roster conflicts — 24 unit tests |
| Reservations | Availability, booking, rescheduling, seating into a bill, no-shows |
| Waiting list | Join with a quoted wait, notify, seat, derived position |
| Customers | Search by name or phone, profile with visits and spend |
| **Loyalty accrual** | **Wired into settlement — the Phase 9 gap, closed** |
| Roster | Draft and published shifts, conflict-checked publishing |
| Time clock | Clock in/out, lateness against the roster, timesheets, audited corrections |

One migration: `0015_crm`. **58 tables, 86 RLS policies, 112 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 84 API routes, 25 pages
RUN_DB_TESTS=1 npm test  ✅ 558/558 (191 integration)
```

## The Phase 9 gap, closed

Phase 9 shipped `earnPointsForSession` — written, tested, idempotent — and
could not call it. A bill had no customer to award points to. That was named
as a gap rather than papered over, and this phase is where it closes.

Three things had to exist:

**A link from a bill to a member.** `dining_sessions.customer_id`, nullable,
and null on the overwhelming majority of bills.

**A way to put it there.** A search-and-attach panel on the bill, and
automatic carry-over when a booking made under a membership is seated — a
regular who books as a member should not be asked again at the till.

**A call at settlement.** `settleAndCloseSession` now reads the attached
customer and awards points on `settlement.paidMinor` — what was *actually
paid*, not the bill total. A comped or discounted meal earns on the discounted
figure, because that is what the customer spent. Awarding on the pre-discount
total would let a generous manager mint points out of nothing.

An integration test books, seats, orders RM 30.00, pays, settles, and asserts
the balance moved from 0 to 30. Two more assert that an anonymous bill settles
without failing, and that attaching a member to an already-closed bill is
refused — attaching after the fact would mean either awarding points for a
visit already reconciled or quietly awarding none.

## Two bugs the tests caught, one of them silent

**The correlated subquery that could never match.** `readCustomerProfile`
summed spend with a subquery correlating `payments.session_id` to the session
id. Drizzle inlines subquery columns *unaliased*, so the unqualified `"id"`
resolved against the subquery's own `FROM` — `payments.id`, not the session.
The correlation matched nothing and every customer's lifetime spend was zero.

It surfaced only because a wrong enum value (`'captured'` for what is actually
`'succeeded'`) made the query throw first. Fix the enum alone and the query
returns a plausible, permanently wrong answer. Both are now a left join with
an explicit `groupBy`.

**The fan-out that nearly replaced it.** The first fix joined the points
ledger *and* the visit history in one statement. A customer with three ledger
entries and two visits produces six rows, and `sum(points)` doubles.
`count(distinct)` survives that; a sum does not, and the inflated number still
looks plausible. Aggregates are now loaded in two scoped queries and merged in
code.

## Availability is checked twice, deliberately

The dialog calls an availability endpoint as the form is filled in. That
answer is advisory and says so in the code — `createReservation` re-checks
inside its own transaction.

Two people on two phones can both be told a table is free a moment before one
of them takes it. The transactional re-check is what makes the second one
lose, and an integration test asserts exactly that.

Touching intervals do not clash: a table freed at 19:30 is available at 19:30.
Treating that as a conflict would lose a full turn every evening on every
table, and there is a test for it.

The engine returns a *reason*, not a boolean. "The largest table seats 6" is
something the person on the phone can say out loud; `false` leaves them
guessing. Alternative times are offered only when the time is the problem — a
party too large for any table will be too large at every other time too, and
suggesting four of them is a worse answer than none.

## Position is derived, never stored

The waiting list numbers parties from arrival order at read time. A stored
position has to be renumbered every time anyone is seated or leaves, and the
one time that renumbering is missed the queue silently reorders itself —
which is unfair to a real person standing by the door.

The quoted wait *is* stored, because it is a promise. "You said twenty
minutes" deserves an honest answer an hour later, and recomputing it would
answer a different question.

Quoting counts only the parties ahead who compete for the same size of table.
A queue of six two-tops does not delay a party of eight if the large tables
are turning; modelling one undifferentiated queue is why quoted waits are
usually wrong in both directions at once.

## Draft rosters do not leak

`listShifts` is for managers and shows drafts. `listMyShifts` is for staff and
filters on `published_at`. They are two functions rather than one with a flag,
because a shared query with a forgotten check would leak next week's draft to
everybody in it — and that mistake is invisible until someone plans a week
around a shift that then moves. Tests assert both sides.

Conflicts are checked at publish, not at save. Blocking each save would make
moving one shift past another impossible without deleting it first. A conflict
stops the publish outright and returns *names*: "two conflicts" sends a
manager hunting, "Ana is rostered twice" tells them where to look.

Back-to-back shifts publish fine. A double is gruelling but not impossible,
and it is not the software's call.

## The time clock never takes a user id

`clockIn` and `clockOut` use the authenticated actor. There is no user field
in the request body and there will not be one — clocking in for a colleague
running late is buddy-punching, and the way to stop it is to make it
unexpressible rather than to guard it with a permission.

A partial unique index enforces one open punch per person, so a double-tap
cannot open two that later clock-outs close arbitrarily.

Lateness is snapshotted at clock-in. Recomputing it later would let a manager
move a rostered start and retroactively make someone punctual — or late.

An open punch counts as **zero** worked minutes, not as time accruing to now.
A timesheet that grows while it is read cannot be checked, and someone who
forgot to clock out three days ago would otherwise show four thousand minutes.

## A React purity fix worth naming

The waiting-list row shows how long someone has actually been waiting, which
has to tick. Reading `Date.now()` during render makes output depend on when
React happened to re-render, and makes server and client disagree on first
paint.

The KDS has had the same pattern since Phase 8 and passes lint only because
the call is hidden inside a helper function — a blind spot, not a fix. Rather
than copy it, this phase adds `useNow`, a `useSyncExternalStore` subscription
with a snapshot bucketed to the tick interval (an unbucketed `Date.now()`
changes on every call and re-renders forever). The KDS is a candidate to move
onto it.

## Known gaps

**The KDS still reads the clock during render.** `useNow` exists and is the
right home for it; switching the ticket card over is a small, separate change
that deserves its own eyes on the timer thresholds.

**No customer profile page.** `readCustomerProfile` returns visits, spend,
averages and upcoming bookings, and only the summary list is on screen. The
data is there; the page is not.

**Turn time is per booking, not per party size.** A two-top and a party of ten
both default to 90 minutes. Real restaurants scale it. It is a column and a
lookup when someone asks.

**No booking confirmations.** Nothing emails or texts a guest — no delivery
mechanism exists yet, and a "confirmation sent" flag that sends nothing is
worse than no flag at all. Same for waiting-list notification: `notify` marks
the entry, it does not message anyone.

**No online booking page.** Bookings are taken by staff. A public page would
need its own rate limiting, spam handling and a captcha decision.

**Shifts cannot be edited, only created and deleted.** Deleting a published
shift is audited; editing one is not yet possible.

**Reservations do not block walk-ins.** A table booked for 19:00 can still be
seated by a walk-in at 18:45 through the floor screen. The floor view does not
consult the booking book, which is the next honest step and needs a decision
about how hard a warning should be.

## Next: Phase 12 — Dashboard & Reporting

Real-time operations, sales, profit and tax reports, and export. It picks up
COGS from Phase 10, which records the value of every consumption movement but
has nowhere yet to report gross margin.
