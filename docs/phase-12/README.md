# Phase 12 — Dashboard & Reporting

Sales, profit, tax and loss reports; a live operations dashboard; CSV, Excel
and PDF export. And one table that decides whether any of it can be believed.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 3 new codes — 115 total |
| Reporting engine | Trading days, bucketing, summarisation, margin, growth — 30 unit tests |
| Export writers | RFC 4180 CSV and a real `.xlsx` — 23 unit tests |
| **Sales snapshot** | **An immutable financial record per settled bill** |
| Sales report | Summary vs previous period, series, branch, type, method, hour |
| Item report | Per-dish quantity, revenue, cost, margin and category rollup |
| Tax report | Grouped by the rate that was actually charged |
| Loss report | Comps, promotions, voids and refunds, named by who applied them |
| Live dashboard | Open bills, covers, queue depth, today's trade, alerts |
| Trading day | A configurable cutoff so a bar's night is one day, not two |

Two migrations: `0016_reporting`, `0017_order_line_cost`.
**59 tables, 87 RLS policies, 115 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 90 API routes, 26 pages
RUN_DB_TESTS=1 npm test  ✅ 627/627 (207 integration)
```

## The decision this phase turns on

Every figure on a bill — service charge, tax, the total — is computed by
`calculateBill` from the restaurant's **current** settings. A report that
recomputed history from order lines would therefore apply today's tax rate to
last quarter's trade.

Raise SST from 6% to 8% and every report filed in March quietly says something
different in April. Nothing in the system changed, nobody edited a bill, and
there is no record that the number moved. That is not a reporting bug; it is a
report that cannot be relied on for the one purpose reports exist.

So `sales_records` is written once, when a bill settles, and never updated. It
carries the bill's figures **and the rates that produced them**, so the
arithmetic can be re-derived years later rather than trusted. A closed period
is closed.

The headline test raises the tax rate after a bill is settled and asserts the
tax report does not move. A second one settles bills either side of a rate
change and asserts the period reports **two lines**, each with the tax
genuinely charged under it — not one blended figure at whichever rate happens
to be configured today.

`onConflictDoNothing`, not `onConflictDoUpdate`. The first record is the true
one; a later pass would overwrite it with whatever is current, reintroducing
exactly the drift the table exists to stop.

## Two bases, and the difference is not pedantry

**Takings** (Phase 7) is on a **cash** basis: bounded by when money moved,
because that is the day someone counts the drawer.

**Reports** (this phase) are on a **sales** basis: a bill counts towards the
day it settled, and a refund reduces the period of the *original sale* —
because that is the month whose revenue was overstated.

Both are correct answers to different questions. A manager comparing them
without knowing which is which concludes the software is broken, so the reports
page says so on the page rather than in a manual.

The consequence, stated plainly: a period is final only once its refund window
closes.

## A refund does not put the food back

Summarising sales, a refund reduces revenue and leaves cost alone. The dish was
cooked, plated and is gone; refunding the customer does not return the
ingredients to the shelf.

Treating a refund as cancelling the sale would leave a fully refunded meal
showing a healthy margin, which is exactly backwards. A refunded meal is a
total loss, and the arithmetic says so — the integration test asserts a gross
profit of **minus** the food cost. Tax and service charge *are* reduced
proportionally, because those genuinely were returned.

## Margin, and what it is a margin of

A margin computed over a partly-costed menu is a margin on the costed part. An
owner reading 85% needs to know whether that is 85% of the whole menu or 85% of
a fifth of it.

So every summary carries **recipe coverage** alongside the margin, and the UI
puts it in the same sentence rather than a footnote. An item with no recipe
shows a blank cost, never a zero — zero claims the dish is free to make, which
is a statement about the business rather than a gap in the data. Its margin is
null, and the report says "no recipe" out loud.

## Where per-dish cost had to come from

The obvious source was the stock ledger, and it does not work. Phase 10 merges
a whole order's requirements into **one movement per ingredient**, deliberately,
so concurrent orders lock ingredient rows in the same sequence and cannot
deadlock. That merge is worth keeping, and it is precisely why the ledger
cannot say which dish consumed what.

The first implementation joined `stock_movements.order_line_id` and silently
returned nothing costed — every margin blank, every coverage zero. The bill
totals were right, so the failure was invisible anywhere except the item
report.

The fix puts cost where every other snapshot on an order line already lives:
`order_lines.cost_minor`, frozen when the line is ordered, from the recipe and
the ingredient cost then in force. NULL means no recipe. The ledger remains the
truth about what left the shelf; the line is the truth about which dish
consumed it.

Two sources for one number is a standing invitation to drift, so an integration
test asserts they agree rather than assuming it.

## "Today" is a fact about the restaurant

`new Date('2026-08-07T00:00:00')` parses in the **server's** local zone. On a
UTC host that is 08:00 in Kuala Lumpur, so a day's takings would run from
breakfast to breakfast and every daily figure would be wrong by one morning's
trade — plausibly, consistently, and without any error.

`src/lib/time.ts` resolves wall-clock times in a named zone using the IANA
database the runtime already ships with. No dependency: it stays current with
the runtime rather than with whenever a package was last published. Offsets are
solved by iteration, because the offset needed is the offset *at the answer*,
which is not known until the answer exists. Tests pin both sides of a British
daylight-saving boundary so the arithmetic is actually exercised.

And the trading day itself is configurable. A bar closing at 02:00 does not
have two trading days either side of midnight; it has one night. Splitting it
makes both halves look like a bad night and leaves nothing to reconcile the
drawer against. `business_day_start_minutes` is capped below twelve hours —
a day starting at 14:00 no longer names the day it belongs to, and that
ambiguity would be silent.

## Exports that are actually the format they claim

**CSV** is RFC 4180 with a UTF-8 byte order mark, because Excel on Windows
otherwise reads the file as the system code page and turns a menu of local dish
names into mojibake.

It also defuses **CSV injection**. A customer called `=cmd|'/c calc'!A1` is a
name someone can type into a booking form; the application never interprets it,
but the spreadsheet on the finance manager's machine does. Dangerous leading
characters get an apostrophe — except when the cell is a plain number, since
prefixing every negative figure would fill a refunds column with text that
cannot be summed, trading a real risk for a spreadsheet that silently totals
zero.

**Excel** is a real `.xlsx`: a stored ZIP of SpreadsheetML, written directly.
The common alternative — a CSV renamed `.xls` — works only because Excel
guesses, warns the user the file is corrupt, and loses every number as text. It
is not an Excel export; it is a CSV wearing a hat.

Numbers are written as numeric cells so a totals row can sum them. Text is
written as an inline string, which is also why this format cannot carry a
formula injection: a cell is a formula only when it holds an explicit `<f>`
element, and the writer never emits one.

The tests read the archive back through an independent parser — walking the
central directory, checking every CRC against the extracted bytes — rather than
asserting on the writer's own output shape, which would prove nothing. Output
is byte-identical across runs, which is what makes those assertions meaningful:
there are no timestamps anywhere, and `Date.now()` inside a pure function is a
purity violation looking for somewhere to happen.

**PDF** is the browser's own print-to-PDF against a print stylesheet. A
server-rendered PDF would mean either a headless browser in the deployment or a
hand-rolled writer, and neither lays out a table better than the engine already
rendering the page.

## Reporting is three permissions, not one

`report.view` is operational: covers, item performance, when the rush is. A
head chef needs it and it reveals nothing about turnover.

`report.financial` is revenue, tax, cost and margin. Food cost percentage is
the number an owner is most reluctant to show, and a supplier-facing manager
who knows it is in a different negotiation. The loss report lives here too,
because it names the people who comped and voided.

`report.export` is separate from both, because **downloading is not reading**. A
report on screen is bounded by the session; a spreadsheet leaves with whoever
downloaded it and outlives their employment. The export route checks both, so
nobody can download a report they could not open.

Only the manager template gets any of them by default.

## Two bugs found on the way

**`sql<Date>` is a type assertion, not a conversion.** Drizzle parses
timestamps in its *column* mapper, which a raw SQL fragment never reaches — so
`sql<Date | null>\`min(placed_at)\`` arrives as a string while the compiler
swears it is a `Date`. `.getTime()` threw at runtime on a value TypeScript had
guaranteed. The same pattern was already in `customer.service.ts` from Phase 11,
where it happened to render correctly only because the page wrapped it in
`new Date(...)`. Both now use `.mapWith(column)`.

**The kitchen queue counted closed bills.** A settled bill can still carry a
line that was never advanced past `pending` — nobody tapped "served" before the
customer paid and left. The dashboard queue would climb all week and never
fall, at which point the number stops being read at all.

## Known gaps

**No scheduled or emailed reports.** Everything is pull. There is still no
email transport (Phase 0's gap), and a "report sent" flag that sends nothing is
worse than no flag.

**No backfill for bills settled before this phase.** `sales_records` starts
empty, so reports cover only trade settled from now on. A backfill is possible
— the order lines and payments are all still there — but it would have to
reconstruct each bill against *some* tax rate, and choosing one would be
inventing history rather than recording it.

**Per-dish cost is only frozen for orders placed from now on.** Existing order
lines have a null `cost_minor` and will report as uncosted. This is the honest
outcome: nobody knows what an ingredient cost the day those lines were placed.

**Percentage discounts are counted but not totalled** in the loss report. They
are stored as a rate rather than an amount, so summing them would mean
recomputing each against its bill — which is the recomputation this phase
exists to avoid. The count still shows they exist.

**A report is bounded at 400 days.** Every report loads its records into memory
to summarise them. Someone who genuinely wants five years wants an export
pipeline, not a web page, and is told so rather than left watching a spinner.

**Refunds are not decomposed per item.** A partial refund reduces a bill's tax
and service proportionally, which is right for a whole bill and approximate for
"they sent back the fish". Item-level refunds would need refunds to reference
order lines.

**No cover count on takeaway.** Average-per-cover is meaningful for dine-in and
silently dilutes when takeaway bills are in the same period, since they
contribute revenue and no covers.

**The dashboard's open-bill value is a subtotal**, before tax and service.
Running the full bill engine over every open table on each refresh is not what
that engine is for. The card says so; a manager wanting the real total opens
the bill.

**No comparison against budget or forecast.** Every comparison is against the
immediately preceding period of the same length. A target to measure against is
a different feature and needs somewhere to enter one.

## Next: Phase 13 — AI Restaurant Manager

Recommendations with explanations across sales, inventory, operations,
customers and finance. It has data to work with for the first time: this phase
is what gives an AI manager something to manage.
