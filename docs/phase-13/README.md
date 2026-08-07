# Phase 13 — AI Restaurant Manager

Recommendations across sales, menu, inventory, operations, customers and
finance — each carrying the figures it came from, what to do about it, and how
much weight the evidence can bear.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 2 new codes — 117 total |
| Menu engineering | Stars, plowhorses, puzzles and dogs — 9 unit tests |
| Insight engine | 20 rules across 6 domains — 42 unit tests |
| Evidence gatherer | Reads menu, stock, wastage, cost drift, kitchen, customers, payments |
| Narrator | Deterministic by default; Claude-written briefing where configured |
| Dismissals | Answer a recommendation with a reason, permanently or on a snooze |
| Advisor page | Findings grouped by urgency, evidence beside each one |

One migration: `0018_advisor`. **60 tables, 88 RLS policies, 117 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 92 API routes, 27 pages
RUN_DB_TESTS=1 npm test  ✅ 689/689 (218 integration)
```

## Where the intelligence actually lives

The phase is named for AI, so it is worth being exact about what does the work.

**Every number, threshold and conclusion is computed by a pure function.**
`insights.ts` and `menu-engineering.ts` are arithmetic over figures the system
recorded, with 51 unit tests between them. No model is consulted to decide
whether wastage is high, which dish is a dog, or what a margin is.

**A language model writes the opening paragraph, and only that.** It is handed
conclusions that were already drawn and asked to introduce them. It has no
database access, no tools, and is not even shown the evidence figures — a test
asserts that.

The reason for the split is the shape of the failure. A model that gets a
number wrong does not produce something that looks wrong; it produces a fluent,
confident sentence about a margin nobody calculated, and an owner has no way to
tell it from a sentence about a margin that was. Keeping the model on the far
side of the arithmetic makes that failure unavailable rather than unlikely.

The narrator is optional. With no `ANTHROPIC_API_KEY` the briefing is assembled
from the same findings by ordinary string handling — plainer prose, identical
facts — and the page says which wrote it. Nothing on the page depends on a
model being reachable.

## Refusing to advise is the feature

The engine checks first whether there is enough trade to say anything, and if
there is not, it says exactly that and stops. A restaurant with eleven bills
does not need to be told its discount rate rose 40%.

Stock rules run either way. A negative on-hand quantity is a counting error
whatever the week's trade was, and a new restaurant is exactly where a
receiving mistake is most likely — so the refusal names what it is withholding
and why, then reports the shelf anyway.

Most individual rules can also decline. A station is not slow unless another
station is measured to compare it against. A dish that sold twice is not
unpopular, it is unmeasured. One person accounting for 100% of voids is not a
finding when they are the only person who voided anything. An advisor that
always has an opinion is one whose opinions are worth nothing.

## Every finding carries its evidence

The shape of an insight is fixed and enforced by tests: a **finding** (what is
true), a **recommendation** (what to do), the **evidence** it was derived from,
and a **basis** stating what the confidence rests on.

Finding and recommendation are separate fields and separate blocks on screen,
because they are judged separately — a manager can accept that Rice is thin and
still disagree about repricing it.

Confidence comes from sample size and is shown on every card, including the
confident ones. If only the weak findings were labelled, the absence of a label
would come to mean "this one is certain", which is a stronger claim than the
engine ever makes.

## Two decisions worth naming

**Margin coverage is raised first and raised loudly.** When less than 75% of
sales come from dishes with a recipe, the advisor leads with that — because an
owner acting on "remove these dogs" while half the menu is uncosted is being
told to remove the dishes that happen to have recipes. The food-cost rule
refuses to fire at all below that threshold: a food cost percentage of an
unknown fraction of the business is a number someone would act on, and it does
not mean what it says.

**The menu's profit line is the median, not the mean.** One expensive steak
drags a mean far enough to reclassify half the menu as unprofitable, and
"remove these fourteen dishes" is exactly the confident nonsense that stops
anyone reading the recommendations again.

## Points are counted, not valued

The loyalty rule reports points outstanding as *points*, and says in its own
evidence that no redemption rate is on file.

Phase 9 records what a point is earned for and never records what one is worth
— redemption is in points, and what those buy is decided outside this system.
Putting a currency figure on the liability would mean inventing a rate and then
reporting it as though it had been measured. The finding instead observes that
the balance only grows, which is the shape of a scheme customers are enrolled
in and do not use, and recommends deciding what a point buys.

## Voids are a question, not an accusation

The concentration rule fires when one person accounts for most voided value —
and is phrased as something worth a look rather than an alarm, because
concentration is precisely what you would expect from whoever works the till
most. A tool that implies theft from an ordinary roster pattern is a tool that
gets switched off, and then the real case is never caught either.

## Dismissing is its own permission

`insight.view` and `insight.dismiss` are separate, and the manager template
holds only the first. Dismissing is how an inconvenient finding is made to
disappear: "that recommendation is wrong" and "I do not want that
recommendation seen" look identical from the outside.

So a reason is required by the API rather than by the form, the act is audited,
and dismissed findings that came up again this period are still listed on the
page — hidden, but on the record. Snoozing exists alongside permanent dismissal
because offering only the latter turns every temporary annoyance into a
permanent blind spot.

Dismissals key on the insight's stable id, never its wording. A key that moved
with the numbers would resurrect every dismissal the moment anything changed —
which is exactly when it is least welcome and most repeated. A test dismisses a
finding, makes the underlying numbers worse, and asserts it stays hidden.

## Known gaps

**The advisor holds no history.** Every recommendation is recomputed on each
read, so a finding can never outlive its fact — but it also means "wastage has
been high for three weeks" is not something it can say. Trend-over-trend
findings need the findings themselves stored, which reintroduces exactly the
staleness this design avoids, and deserves a deliberate decision rather than a
default.

**Nothing measures whether a recommendation helped.** Acting on one and seeing
the number move is the loop that would make the advisor trustworthy over time,
and there is no closing of it here.

**The target food cost is a constant, not a setting.** 35% is the conventional
full-service figure; a bar runs far below it and a steakhouse above. It is one
column and one field when someone disagrees with it.

**Labour is absent.** Attendance records hours but no pay rates, so labour cost
as a share of sales — one of the two numbers that actually decides whether a
restaurant survives — cannot be computed honestly. Hours per cover would be
possible and is not built.

**The model narrator has no test against a live model.** The prompt boundary is
tested (what the model is shown, and that it is never shown a figure), and the
fallback path is tested, but no test asserts what a real response looks like.
That needs a key and a network, and a test that silently passes when neither is
present would be worse than none.

**No per-branch advice.** The page filters by branch, but the rules compare a
branch against nothing — "the Bangsar kitchen is slower than Damansara" is not
a finding it can make.

**Cost drift compares against the period's first movement**, not against a true
historical cost, because no such column exists. It is accurate for a period
containing a delivery and silent for one that does not.

## Next: Phase 14 — SaaS & integrations

Plan metering and gating, the franchise dashboard, third-party integrations,
and deployment hardening — including the items Phase 0 named and never closed:
in-process rate limiting, and no email provider.
