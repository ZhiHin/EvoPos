# Phase 0 — Foundation

Identity, tenancy, authorisation and the audit trail. No restaurant-operational
feature ships in this phase, deliberately: a menu built before tenant isolation
exists is a menu that has to be re-secured afterwards.

## Artifacts

| # | Document |
| --- | --- |
| 1 | [Functional Requirements](01-functional-requirements.md) |
| 2–3 | [Database Design & ER Diagram](02-database-design.md) |
| 4 | [API Specification](03-api-specification.md) |
| 5 | [Business Rules](04-business-rules.md) |
| 6 | [UI/UX Screens](05-ui-ux.md) |
| 7 | [Validation Rules](06-validation-rules.md) |
| 8 | [Security Considerations](07-security.md) |
| 9 | [Test Cases](08-test-cases.md) |
| 10 | [Architecture & conventions](../ARCHITECTURE.md) · [Setup](../../README.md) |

## What shipped

- Next.js 16 + React 19 + Tailwind v4 + shadcn/ui, TypeScript strict
- PostgreSQL via Drizzle, 12 tables, RLS on 7 of them, 11 policies
- Two-role database model (`ros_owner` / `ros_app`) with a boot-time assertion
  that the app cannot bypass RLS
- Email + password auth (Argon2id), Google OIDC, server-side sessions
- Password reset and change, both revoking all sessions
- Configurable per-tenant RBAC over a code-defined permission registry
- Append-only audit trail with secret redaction
- Multi-restaurant membership with a tenant switcher
- Light/dark UI, 8 screens
- 38 passing unit tests; 15 integration tests written and pending a database

## Verified

```
npm run typecheck   ✅ clean
npm test            ✅ 38/38
npm run build       ✅ 18 routes
npx drizzle-kit generate  ✅ 11 policies emitted
```

## Verified against a live database

PostgreSQL 17.10, local install:

```
npm run db:migrate       ✅ 12 tables, RLS on 7, 11 policies
npm run db:seed          ✅ 17 permissions
npm run db:verify        ✅ ros_app is subject to RLS
RUN_DB_TESTS=1 npm test  ✅ 53/53
```

Cross-tenant writes are refused by the database with SQLSTATE **42501**,
`new row violates row-level security policy`. Tenant isolation is
demonstrated, not argued.

## Three bugs found during the build

Recorded because all three were the kind that ship silently:

**`roles` needed a self-read policy.** `listTenantsForUser` joins `memberships`
to `roles` with no tenant context. `roles` had only a tenant policy, so every
role row filtered out, the inner join matched nothing, and the query returned
zero restaurants — a user who legitimately owned a restaurant would have been
told they belonged to none, locked out with no in-app way back. Fixed by adding
`roles_member_read` before the migration was ever applied.

**Email validation ran before normalisation.** `z.email().transform(trim)`
validates the raw input, so a copy-pasted or autofilled `" owner@cafe.com "`
was rejected as malformed. Caught by a unit test. Fixed by piping a trimmed,
lowercased string into the email check.

**`bootstrap.sql` never granted `ros_owner` CREATE on the database.** Drizzle's
migrator keeps its journal in a separate `drizzle` schema and creates it on
first run, so `npm run db:migrate` failed at its very first statement with
"permission denied for database". `createdb -U postgres ros` leaves `postgres`
as the database owner, and owning the `public` schema does not confer the right
to create sibling schemas. This one could only surface by actually running the
migration — no amount of review would have caught it, which is precisely the
argument for Task 0 existing as a gate.

## A test that was passing for the wrong reason

Two isolation tests asserted `rejects.toThrow(/row-level security|violates/i)`.
Drizzle wraps driver errors, so its `.message` is only `"Failed query: insert
into ..."` — the real reason lives on `.cause`. The regex therefore matched
nothing and the tests failed, which was the lucky outcome.

The unlucky version is worth noting: had the pattern been slightly looser, say
`/failed/i`, both tests would have **passed for any error at all** — a
misspelled column, a dropped connection, a unique-key clash — while appearing
to prove tenant isolation. A security test that cannot distinguish "refused by
policy" from "broke for an unrelated reason" is worse than no test, because it
manufactures confidence.

Both now assert SQLSTATE `42501` on the cause explicitly.

## Next: Phase 1 — Restaurant Structure

Branches, floors, tables, the QR token engine, and the settings centre. First
phase with real tenant-scoped CRUD, so it is where the module conventions in
[ARCHITECTURE.md](../ARCHITECTURE.md) get their first real exercise.
