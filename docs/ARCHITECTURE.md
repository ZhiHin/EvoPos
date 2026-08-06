# Architecture

## Modular monolith

One deployable, many modules. Each module owns its data and exposes behaviour
through a service; nothing reaches into another module's tables directly. That
constraint is what makes a later extraction to a separate service a packaging
change rather than a rewrite.

Microservices are explicitly **not** the starting point. A restaurant chain's
order, kitchen and billing flows are one transaction boundary far more often
than they are three — splitting early would buy distributed-systems problems
before there is any scale to justify them.

## Layering

```
Route handler / Server action / Page   ← HTTP, auth guard, no business logic
        ↓
Service                                ← business rules, transactions, audit
        ↓
Repository                             ← queries, always tenant-scoped
        ↓
Drizzle + Postgres RLS                 ← the boundary that cannot be forgotten
```

Rules that hold across every module:

1. **Route handlers contain no business logic.** They authenticate, authorise,
   parse input, call a service, and shape the response.
2. **Services never import anything HTTP-shaped.** They throw `AppError`
   subclasses. This is what lets the same service back a route handler, a
   server action, a background job and a test.
3. **Repositories take an explicit tenant context** and run inside
   `withTenant`. The WHERE clause and the RLS policy are redundant with each
   other on purpose.
4. **Money is integer minor units.** Never a float. Not yet load-bearing in
   Phase 0, but the convention is set before the first price column exists.
5. **Prices, discounts, tax and totals are computed server-side.** The client
   is never the source of a number that appears on a bill.

## Module layout

```
src/modules/<module>/
  <module>.repository.ts    data access, tenant-scoped
  <module>.service.ts       business rules, transactions, audit writes
  <module>.validation.ts    zod schemas — the input contract
  <module>.types.ts         shared types (optional; often inferred)
  <module>.test.ts          unit tests
  ui/                       React components for this module
```

Route handlers live in `src/app/api/...` per Next.js convention and import the
module's service. Pages import the module's `ui/` components.

Current modules: `auth`, `rbac`, `tenancy`, `audit`.

## Shared infrastructure

| Path | Responsibility |
| --- | --- |
| `src/lib/env.ts` | Validated environment. Throws at import, so misconfiguration fails at boot |
| `src/lib/db/` | Drizzle client, `withTenant`, `withActor`, schema |
| `src/lib/auth/context.ts` | `requireAuth`, `requireTenant`, `requirePermission` |
| `src/lib/errors.ts` | Typed errors mapped to status codes in one place |
| `src/lib/api.ts` | Route wrapper, origin check, request metadata |
| `src/lib/rate-limit.ts` | Fixed-window limiter (in-process — see README limitations) |
| `src/lib/email.ts` | Outbound email port |

## Dependency injection

Deliberately lightweight. There is no container, because a container earns its
keep when construction graphs are deep, and these are not.

Two mechanisms cover the actual need:

- **Ports for external systems.** `EmailTransport` is an interface with a
  swappable implementation (`setEmailTransport`). Anything crossing a network
  boundary to a third party gets this treatment — email now, payment gateways
  and printers later.
- **Transaction passing.** Services accept a `Transaction` so callers compose
  several operations atomically. This is what lets `provisionRestaurant` be
  called both from registration (inside a larger transaction that also creates
  the user) and from onboarding (standalone).

## Tenant isolation

Two independent layers, and the redundancy is the point.

**Database (primary).** Every tenant-scoped table has RLS enabled and a policy
comparing `restaurant_id` against `current_setting('app.tenant_id')`. The
application connects as `ros_app`, which owns nothing and has no `BYPASSRLS`.
A missing WHERE clause in application code leaks nothing, because the database
refuses to return the rows regardless of what the SQL asked for.

**Application (secondary).** Repositories scope queries explicitly and
`requirePermission` gates every mutation.

Setting the context:

```ts
await withTenant({ restaurantId, userId }, async (tx) => {
  // Inside here, every query is filtered by policy.
})
```

`set_config(name, value, true)` rather than `SET LOCAL`, for two reasons:
`SET LOCAL` cannot take a bind parameter (so the tenant id would have to be
interpolated into SQL text — an injection point on the one value the whole
model depends on), and the `true` gives transaction-local scope, so a pooled
connection never carries stale tenant context into the next request.

### What RLS does not cover

- **Identity tables** (`users`, `sessions`, `oauth_accounts`,
  `verification_tokens`) carry no policy. Login must find a user by email
  before any tenant is known. Access is confined to the auth module.
- **Branch scoping** is enforced in `assertBranchAccess`, not by policy — it
  depends on the membership, not on a column of the row being read.
- **The owner role** (`ros_owner`) bypasses RLS by design, for migrations and
  backups. It must never appear in `DATABASE_URL`; `npm run db:verify` checks.

## Adding a module

1. Schema in `src/lib/db/schema/<module>.ts`. Tenant-scoped tables get a
   `restaurantId` column and `tenantPolicy(...)`.
2. Export it from `src/lib/db/schema/index.ts` — a table missing from the
   barrel is silently dropped from migrations.
3. `npm run db:generate`, then **read the generated SQL** and confirm the
   policies are present before applying.
4. Add permission codes to `src/modules/rbac/permissions.ts`. Grant them to
   role templates as appropriate; the owner role picks them up automatically.
5. Repository → service → route handler, in that order.
6. Tests. Anything touching tenant boundaries gets an integration test in
   `tests/`, following `tests/rls.integration.test.ts`.
7. Re-run `npm run db:seed` so new permissions reach the registry.

## Conventions

- **Errors**: throw `AppError` subclasses from services. A record that exists
  but belongs to another tenant is a `NotFoundError`, never a `ForbiddenError`
  — a 403 confirms the id is real.
- **Audit**: security- and money-relevant actions call `recordAuditIn` with the
  same transaction as the change, so the trail cannot describe something that
  was rolled back.
- **Validation**: one zod schema per input, in `<module>.validation.ts`, parsed
  server-side. Client-side validation is a convenience, never the enforcement.
- **Naming**: tables and columns `snake_case`; TypeScript `camelCase`. Drizzle
  is configured with `casing: 'snake_case'` to bridge them.
