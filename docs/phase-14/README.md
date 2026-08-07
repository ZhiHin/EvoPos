# Phase 14 — SaaS, integrations and hardening

Plans and metering, an API surface, outbound webhooks, cross-site comparison —
and the two gaps Phase 0 named on day one and left open ever since.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 4 new codes — 121 total |
| Plan engine | Limits, quotas, downgrade effects — 19 unit tests |
| Group engine | Ranking and outlier detection — 13 unit tests |
| Webhook engine | HMAC signing, replay window, retry policy — 22 unit tests |
| Metering | Usage counted on demand, enforced at the service layer |
| API keys | Hashed, scoped, revocable; authenticate against every existing route |
| Webhooks | Signed, queued, retried, auto-disabled with a reason |
| Group dashboard | Every site ranked, with the outliers named in both directions |
| **Rate limiting** | **Moved to Postgres — Phase 0's multi-instance gap, closed** |
| **Email** | **SMTP transport — Phase 0's "no email provider", closed** |
| Hardening | Security headers, a health check that checks, `poweredByHeader` off |

Two migrations: `0019_saas`, `0020_api_key_lookup_policy`.
**64 tables, 92 RLS policies, 121 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 100 API routes, 30 pages
RUN_DB_TESTS=1 npm test  ✅ 767/767 (241 integration)
```

## A downgrade never destroys anything

This is the decision the whole billing design turns on, and it is worth being
blunt about the alternative. Software that deletes a branch when a plan is
downgraded — or blocks the downgrade until the customer deletes one themselves
— has made reducing spend a destructive act. That is a hostage-taking, not a
billing policy.

So being over quota is a **state**, not an error:

- Nothing is deleted, disabled or hidden.
- Every existing branch, staff member and menu item keeps working.
- The only consequence is that creating **one more** is refused.
- The plan page says exactly that, rather than implying something must go.

An integration test creates three branches on Scale, downgrades to Launch
(which allows one), and asserts all three are still there.

The customer is also told what a change will cost **before** they agree to it:
`previewPlanChange` returns which quotas they would be over and which features
would switch off, and the confirm dialog shows both. Finding out afterwards is
how a billing page loses somebody permanently.

## The one limit that is never enforced

`monthlyBills` is metered, reported, and never refused. Enforcing it would mean
the software declining to settle a bill on a busy Saturday because a billing
threshold was crossed — stopping a restaurant taking money. Going past the
allowance is a conversation; it is not an outage. A limit that could close a
till is not a limit worth having, and the plan page says so on the page rather
than in a contract.

Every other quota is enforced **in the service, not the route**, so the same
ceiling holds whether a branch is created from the UI, from an API key, or from
an import script somebody writes next year.

## API keys act on their own

A key carries its own permission set rather than impersonating a member. Tying
an integration to a person means it dies the day they leave, and silently
inherits every permission they are later granted — neither of which is what
anyone intended when they set up a stock feed.

Only the HMAC is stored, exactly as for sessions; the plaintext exists once, in
the creation response. What is kept in clear is an 8-character prefix, so a
customer with six keys can tell which one a log line refers to without the
value being reconstructible from it.

Keys authenticate against the **existing** routes and reuse every permission
check. A separate `/api/v1` surface with its own authorisation would have been
a second place for a check to be forgotten.

Two consequences that needed thinking about rather than assuming:

**CSRF does not apply to a bearer token.** `assertSameOrigin` exempts requests
carrying an `Authorization` header. CSRF exists because a cookie is *ambient
authority* — the browser attaches it to a cross-site request the user never
intended. Nothing attaches an `Authorization` header automatically, so the
check is inapplicable rather than merely inconvenient; requiring an Origin
header of a machine would make every write endpoint unreachable for no security
gain.

**The bearer token is checked before the session cookie.** A request that
states which identity it wants to act as should get that one. Silently
preferring an ambient cookie would let a browser-authenticated developer
testing a key see results the key itself could never produce.

## A bootstrap policy, not an exemption

Resolving a key hits the problem every credential lookup does: the row has to
be read before any tenant context exists, because the key is what *establishes*
the tenant. Under the tenant policy, that query matches nothing.

The easy answer was to leave `api_keys` outside RLS, the way the identity
tables are. That would have been defensible — only hashes are stored — but it
puts a tenant-scoped table outside the isolation model for the sake of one
query, and the precedent is worse than the query.

Instead, `api_keys_token_lookup` matches on a session variable holding the
presented hash, the same shape as Phase 1's `dining_tables_qr_lookup`: present
one token, reveal one row, and the table still cannot be enumerated. The policy
is SELECT-only, so a key cannot write even its own last-used timestamp while it
is still merely a token — that update runs afterwards, under the tenant the key
has by then established.

## Webhooks are queued, never inline

A customer's slow endpoint must not be able to make settling a bill slow, and
must certainly not be able to make it *fail*. Events are written to a queue in
the same transaction as the thing that caused them — so there is no window
where a webhook describes a bill that was rolled back, or a bill exists that
nobody was told about — and a drain worker sends them.

The signature is the only thing between a customer's endpoint and anyone who
knows its URL, so `verifySignature` is exported as the reference a receiver
should implement, and the tests are its specification. Two details that are
routinely got wrong:

**The timestamp is inside the signature.** Signing the body alone would let
anyone who captured one delivery replay it forever. Binding the time means a
receiver can reject anything outside a five-minute window and know the
timestamp was not edited on the way.

**The comparison is constant-time.** `a === b` on a hex digest leaks, through
timing, how many leading characters were right — enough to forge a signature
one character at a time.

A 4xx is retried like any other failure, because a receiver returning 400
mid-deploy is indistinguishable from one rejecting the payload permanently. The
exception is 410 Gone, which HTTP defines as permanent. After three abandoned
deliveries in a row an endpoint is disabled — **with a reason stored and shown**,
because an integration that quietly stopped working is the worst version of
this failure.

Registered URLs must be public https. A webhook pointed at
`https://169.254.169.254/` would make this server fetch cloud credentials on an
attacker's behalf, so loopback and private ranges are refused by hostname — and
a deployment should restrict egress too, because DNS can be made to resolve a
public name to a private address after the check has run.

## Two Phase 0 gaps, closed

**Rate limiting.** Phase 0 counted attempts in process memory and said plainly
what it cost: behind more than one instance the effective limit multiplies by
the instance count, and a deploy resets every window. The counter now lives in
Postgres, behind the unchanged `consume()` signature — which is why it was kept
behind a function in the first place. A single
`insert … on conflict do update` does the increment, so two instances racing on
one key cannot both read 4 and write 5. A test fires eight concurrent requests
at a limit of five and asserts exactly five are allowed.

Postgres rather than Redis: the database is already here, already backed up,
and already the thing that goes down if anything does. A second piece of
infrastructure whose failure mode is "authentication stops being rate limited"
is not obviously an improvement on none.

The cost is honest and worth stating — the rate limiter's tests are now
integration tests. They needed no dependencies before.

**Email.** SMTP, via a single connection URL, because every provider speaks it
— Resend, Postmark, SES, a customer's own Exchange server. Choosing one
vendor's REST shape would have meant this restaurant's password resets depend
on which SaaS company we happened to like. `SMTP_URL` and `SMTP_FROM` must be
set together, so a deployment cannot end up half-configured and discover it on
the first reset. With neither set, production still refuses to send rather than
dropping mail silently — that was the right behaviour in Phase 0 and still is.

## Health checks that check

`/api/health` does one database round trip and asserts the thing the entire
isolation model rests on: that the runtime role is subject to row-level
security. A deployment that pointed `DATABASE_URL` at the owner role would work
perfectly while every tenant boundary was silently gone, and this refuses to
call that healthy — 503, with the reason.

A check that only proves the process is listening reports healthy while every
request 500s on a dead connection, which is precisely the outage it exists to
catch.

## Known gaps

**No payment provider.** Plans are selected and enforced; nothing charges a
card. Wiring Stripe is a day's work on top of this and deliberately not done —
`changePlan` would become "create a subscription, wait for a webhook, then
change the plan", and building that against no merchant account would be
building it blind.

**No franchise tenancy.** The group dashboard compares *branches within one
restaurant*. A franchisor owning legally separate restaurants has no way to see
across them, because the restaurant IS the tenant — the entire isolation model
is built on that. Grouping tenants means a layer above the tenant, and
retrofitting one is a Phase 0-sized change, not a Phase 14-sized one.

**The webhook drain needs an external scheduler.** Next.js has no process to
own a background worker, and a serverless deployment has no long-lived runtime
at all. Something must POST to `/api/webhooks/drain` with the
`WEBHOOK_DRAIN_SECRET` — a cron job, a Kubernetes CronJob, a platform
scheduler. Until it does, deliveries queue and nothing sends. This is a real
deployment requirement, stated rather than assumed away.

**No delivery replay from the UI.** Failed deliveries are listed with their
status codes, and there is no button to resend one. The data supports it; the
button is not built.

**API keys are not rate limited per key.** A limit is defined
(`RATE_LIMITS.apiKeyPerMinute`) and not yet applied at the authentication path.
A runaway integration can still saturate the database.

**Usage is counted on every check.** Four indexed `count(*)`s per gated create.
Cheap now; a restaurant with a hundred thousand menu items would want a cached
counter and a reconciler, exactly as Phase 10 did for stock.

**No usage history.** The plan page shows what is true now. "You have been over
your branch allowance for two months" is not a sentence it can say, which is
the sentence a billing conversation actually needs.

**The SMTP transport has no test against a live server.** Message construction
is exercised through the existing transport interface; nothing asserts that a
real MTA accepts it. That needs a server and a network, and a test that
silently passes when neither is present would be worse than none.

---

## The roadmap is complete

Fifteen phases, from an empty repository to a multi-tenant restaurant operating
system: tenancy and RLS, the menu engine, the Dining Session, Smart Bill,
payments, the kitchen, promotions and loyalty, inventory, CRM and staff,
reporting, the advisor, and this.

Each phase's README ends with what it deliberately did not build. Those lists
are the honest inventory of what a real deployment would need next, and the
largest items are named above: a payment provider, a scheduler, and a tenancy
layer above the restaurant.
