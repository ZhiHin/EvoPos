# Phase 1 — Restaurant Structure

Branches, floors, tables, the QR token engine, and the settings that configure
tax and service charge. First phase with real tenant-scoped CRUD, so it is
where the module conventions from [ARCHITECTURE.md](../ARCHITECTURE.md) get
their first exercise.

Plan: [`docs/superpowers/plans/2026-08-06-phase-1-restaurant-structure.md`](../superpowers/plans/2026-08-06-phase-1-restaurant-structure.md)

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 9 new codes (`floor.*`, `table.*`, `table.rotate_qr`) — 26 total |
| Branches | Full CRUD, deactivate-not-delete, per-restaurant unique codes |
| Floors | CRUD, per-branch unique names, tables survive floor deletion |
| Tables | CRUD, capacity, status, floor assignment, per-branch unique codes |
| QR engine | Opaque rotatable tokens, scan-scoped RLS, public scan page |
| Settings | Profile, currency, timezone, locale, tax and service charge |
| Navigation | Permission-filtered sidebar |
| Maintenance | `npm run db:repin-owners` |

Three migrations: `0001_floors`, `0002_dining_tables`, `0003_settings`.
**14 tables, RLS on 9, 16 policies** (Phase 0 left 11; Phase 1 added
`floors_tenant_isolation`, `dining_tables_tenant_isolation`,
`dining_tables_qr_lookup`, `branches_qr_lookup`, `restaurants_qr_lookup`).

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅
RUN_DB_TESTS=1 npm test  ✅ 93/93 (25 integration)
```

End-to-end against a live server:

- `bsr1` → `BSR1`, `t12` → `T12` (normalise-before-validate)
- Duplicate branch code → readable 409, not a 500
- **Unauthenticated scan** of `/t/<token>` renders restaurant, branch and
  table name — all three `*_qr_lookup` policies resolving
- Rotation: old token → **404**, new token → **200**
- 6% / 10% stored as **600 / 1000** basis-point integers
- 600% rejected; `Mars/Olympus` rejected
- Audit trail: `branch.created`, `table.created`, `table.qr_rotated`,
  `settings.updated`

## The QR design

The spec asks for tokens that are "secure, random, and time-limited". A
printed sticker on a table cannot be time-limited — no restaurant reprints
tables nightly. The requirement is met by splitting the token in two:

| | Table token (Phase 1) | Session token (Phase 4) |
| --- | --- | --- |
| Lives | On the printed sticker | In the diner's browser |
| Lifetime | Until deliberately rotated | Short, time-limited |
| Grants | Nothing — it *names* a table | Ordering on a dining session |
| Stored | Plaintext | Hashed |

The table token is stored in plaintext, unlike session tokens, because a
restaurant must be able to reprint a damaged sticker without invalidating the
table — a one-way hash makes that impossible. Safe precisely because it
confers no authority.

### Enumeration is blocked by the database, not by code

The scan endpoint is unauthenticated. Rather than trusting application code
never to over-fetch, `withQrToken` sets `app.qr_token` as a session variable
and three policies scope reads to the single row bearing it:

```sql
CREATE POLICY dining_tables_qr_lookup ON dining_tables
  FOR SELECT TO ros_app
  USING (qr_token = nullif(current_setting('app.qr_token', true), ''));
```

Holding one token reveals one table. Holding none reveals nothing. `SELECT`
only, so a scan can never write. Proven by 10 integration tests, including
that `UPDATE` and `DELETE` through the QR context affect zero rows.

`withQrToken` explicitly clears tenant and actor context rather than leaving
them alone — on a pooled connection they would otherwise be whatever the
previous transaction set, silently widening what an anonymous scan can see.

**The three policies must be added as a set.** The scan query inner-joins
`dining_tables`, `branches` and `restaurants`; a missing policy on any one
makes the join match nothing. That is the same failure `roles_member_read` was
added to fix in Phase 0.

## Money and rates

- **Money**: integer minor units (Phase 5 onward)
- **Rates**: integer basis points — 6% = `600`

Never floats. A 6% tax on RM 23.45 in floating point lands a cent out often
enough that a day's takings fail to reconcile, and reconciliation failures are
how a restaurant stops trusting its POS.

Rates are capped at 100%, which catches the commonest typo: entering `600`
while thinking in basis points. Without the cap that silently becomes a 600%
tax on every bill.

## Two bugs found by running it

**`bootstrap.sql` never granted `ros_owner` CREATE on the database.** Drizzle's
migrator keeps its journal in a `drizzle` schema it creates on first run, so
`db:migrate` failed on its first statement with "permission denied for
database". `createdb -U postgres ros` leaves `postgres` as owner, and owning
the `public` schema does not confer the right to create sibling schemas. This
would have failed on **every machine**; no code review would have caught it.

**`repinOwnerRoles` could not see any roles.** The maintenance script
originally used `db` from `@/lib/db`, which connects as `ros_app` — RLS
filtered every role row, so it found nothing and reported success while
leaving owners without new permissions. It now opens its own `ros_owner`
connection. Verified properly by stripping two permissions and watching them
come back: 26 → 24 → repin → 26.

The second is the more instructive one: "nothing to do" and "blind to
everything" produce identical output. Any maintenance script that legitimately
spans tenants needs the owner connection and needs a test that proves it acted.

## Settings scope

The spec's Settings Centre lists ~19 categories. Phase 1 ships three:
restaurant profile, tax/service charge, and the role management already built
in Phase 0.

The rest configure subsystems that do not exist yet, and a settings form that
saves values nothing reads is worse than no form:

| Deferred | Arrives in |
| --- | --- |
| Receipt templates, printer rules | Phase 8 |
| Payment gateways | Phase 7 |
| Loyalty and promotion rules | Phase 9 |
| Kitchen rules | Phase 8 |
| QR design | Phase 4 |
| Notification rules | Phase 8 |
| AI configuration | Phase 13 |
| Integrations, backup, plan | Phase 14 |

## Known gaps

- **No floor management UI.** The API and service are complete and tested;
  tables assign to floors through a dropdown. A dedicated floor screen waits
  until there is a floor plan to arrange.
- **Table positions are stored but unused.** `positionX`/`positionY` exist so
  a drag-and-drop layout needs no migration later. Phase 1 ships a grid.
- **Branch-level scoping is application-enforced** via `assertBranchAccess`,
  not RLS — it depends on the membership, not on a column of the row.

## Next: Phase 2 — Universal Menu Engine

Nested categories, menu items, unlimited custom attributes, availability
schedules and branch overrides. First phase where configurability is the
feature rather than a property of it.
