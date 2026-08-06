# Phase 1: Restaurant Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the physical structure of a restaurant — branches, floors and tables — with a QR token engine that identifies a table without exposing any database identifier, plus the settings that configure tax and service charge.

**Architecture:** Extends the Phase 0 modular monolith. Three new tenant-scoped tables (`floors`, `dining_tables`, plus columns on `restaurants`), each carrying an RLS policy exactly like every Phase 0 table. The QR engine introduces a third database context alongside `withTenant`/`withActor`: `withQrToken`, where a scanned token is set as a Postgres session variable and a policy reveals only the single row bearing that token — so the public scan endpoint physically cannot enumerate tables.

**Tech Stack:** Next.js 16.3.0 (App Router), React 19.2.8, TypeScript strict, Tailwind v4, shadcn/ui (Radix), Drizzle ORM 0.45.2, PostgreSQL with row-level security, Vitest 4.

## Global Constraints

These apply to every task. Each task's requirements implicitly include this section.

- **Node 24.18**, npm 11. Windows / PowerShell. Project root: `C:\Users\zhinf\OneDrive\Desktop\pos system`.
- **Every new tenant-scoped table** gets a `restaurantId` column referencing `restaurants.id` with `onDelete: 'cascade'`, and `tenantPolicy('<table>_tenant_isolation', t.restaurantId)` in its table config. No exceptions.
- **Every new table must be exported** from `src/lib/db/schema/index.ts`. A table missing from that barrel is silently dropped from migrations.
- **After every schema change:** run `npm run db:generate`, then *read the generated SQL* and confirm the policies are present before applying.
- **Money is integer minor units. Rates are integer basis points.** Never a float, never `numeric` in application code. 6% = `600` basis points.
- **All prices, taxes, totals and permission checks are computed server-side.** The client is never the source of a number or a permission.
- **Every mutating route handler opens with `requirePermission(...)`** from `@/lib/auth/context`, and every state-changing route calls `assertSameOrigin(request)`.
- **A record belonging to another tenant is reported as `NotFoundError` (404), never `ForbiddenError` (403).** A 403 confirms the id is real.
- **Validation:** one zod schema per input in `<module>.validation.ts`, parsed server-side. Normalise *before* validating (`z.string().trim().pipe(...)`), never after.
- **New permission codes** go in `src/modules/rbac/permissions.ts` and require `npm run db:seed` to reach the database. The owner role picks them up automatically.
- **Commit after every task.** Conventional commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- **Definition of done for every task:** `npm run typecheck`, `npx eslint .`, and `npm test` all clean.

---

## File Structure

**New schema**

| File | Responsibility |
| --- | --- |
| `src/lib/db/schema/structure.ts` | `floors` and `dining_tables` tables, `table_status` enum, QR lookup policies |
| `src/lib/db/schema/_shared.ts` (modify) | Add `currentQrToken()` helper |
| `src/lib/db/schema/tenancy.ts` (modify) | Add tax/service-charge columns to `restaurants`; add QR lookup policies to `restaurants` and `branches` |
| `src/lib/db/schema/index.ts` (modify) | Export the new module |
| `src/lib/db/index.ts` (modify) | Add `withQrToken` context helper |

**New modules**

| File | Responsibility |
| --- | --- |
| `src/modules/branch/branch.repository.ts` | Tenant-scoped branch queries |
| `src/modules/branch/branch.service.ts` | Branch business rules + audit |
| `src/modules/branch/branch.validation.ts` | Branch input schemas |
| `src/modules/branch/ui/` | Branch list, form |
| `src/modules/floor/floor.repository.ts` | Floor queries, scoped to branch |
| `src/modules/floor/floor.service.ts` | Floor rules + audit |
| `src/modules/floor/floor.validation.ts` | Floor input schemas |
| `src/modules/floor/ui/` | Floor list, form |
| `src/modules/table/table.repository.ts` | Table queries |
| `src/modules/table/table.service.ts` | Table rules, QR rotation, audit |
| `src/modules/table/table.validation.ts` | Table input schemas |
| `src/modules/table/qr.ts` | Token generation, QR payload URL, token resolution |
| `src/modules/table/ui/` | Table grid, form, QR dialog |
| `src/modules/settings/settings.service.ts` | Restaurant profile + tax settings |
| `src/modules/settings/settings.validation.ts` | Settings input schemas |
| `src/modules/settings/ui/` | Settings form |

**Shared**

| File | Responsibility |
| --- | --- |
| `src/components/app-sidebar.tsx` | Navigation — now that more than one destination exists |
| `src/components/app-shell.tsx` (modify) | Host the sidebar |

Split by responsibility, not by layer: a branch's repository, service, validation and UI live together, so a change to how branches work touches one directory.

---

## Task 0: Prove Phase 0 against a live database

Phase 0 is code-complete but was never run against PostgreSQL. Its 15 row-level-security integration tests have never executed. **Nothing in this plan may be built on an unverified isolation boundary** — if a policy is wrong, every table added on top inherits the flaw, and the whole phase would need re-auditing.

This task writes no application code. Its deliverable is a passing test suite.

**Files:**
- Modify: `docs/phase-0/README.md` (record the verification result)

**Interfaces:**
- Consumes: nothing
- Produces: a migrated, seeded database at `localhost:5432/ros` with roles `ros_owner` and `ros_app`, which every later task requires

- [ ] **Step 1: Install PostgreSQL 17**

This needs interactive consent, so run it yourself in the terminal:

```powershell
winget install -e --id PostgreSQL.PostgreSQL.17
```

Accept the source agreement if prompted. Note the superuser password you set during installation.

- [ ] **Step 2: Reopen the terminal and verify psql is on PATH**

```powershell
psql --version
```

Expected: `psql (PostgreSQL) 17.x`

If "not recognized", add `C:\Program Files\PostgreSQL\17\bin` to PATH and reopen again.

- [ ] **Step 3: Create the database**

```powershell
createdb -U postgres ros
```

Expected: no output. If it prompts for a password, that is the superuser password from Step 1.

- [ ] **Step 4: Create the two roles**

```powershell
psql -U postgres -d ros -f scripts/bootstrap.sql
```

Expected: a series of `DO`, `ALTER SCHEMA`, `REVOKE`, `GRANT` acknowledgements with no `ERROR` lines.

- [ ] **Step 5: Point .env at the database**

Open `.env`. The two connection strings must match the passwords in `scripts/bootstrap.sql` (`change_me_app` and `change_me_owner` unless you edited them):

```
DATABASE_URL=postgresql://ros_app:change_me_app@localhost:5432/ros
DATABASE_URL_MIGRATOR=postgresql://ros_owner:change_me_owner@localhost:5432/ros
```

Leave `AUTH_SECRET` as generated.

- [ ] **Step 6: Apply migrations**

```powershell
npm run db:migrate
```

Expected: `Running migrations...` then `Migrations complete.`

- [ ] **Step 7: Seed the permission registry**

```powershell
npm run db:seed
```

Expected: `Syncing permission registry...`, `17 permissions in registry.`, `Seed complete.`

This must run before any registration — `role_permissions` has a foreign key to `permissions.code`, so seeding roles against an empty registry fails outright.

- [ ] **Step 8: Verify the app role cannot bypass RLS**

```powershell
npm run db:verify
```

Expected: `OK: DATABASE_URL connects as a role that is subject to RLS.`

If this fails, **stop**. It means `DATABASE_URL` points at a role that can see through every policy, and no isolation test below would mean anything.

- [ ] **Step 9: Run the full suite including integration tests**

```powershell
$env:RUN_DB_TESTS=1; npm test
```

Expected: `Test Files 7 passed (7)`, `Tests 53 passed (53)`.

If any of the 15 RLS tests fail, fix the policy in `src/lib/db/schema/` before continuing. Do not proceed with a failing isolation test.

- [ ] **Step 10: Manually confirm isolation in DBeaver**

Connect to `localhost:5432/ros` as `ros_app`. Run:

```sql
SELECT * FROM branches;
```

Expected: **0 rows** — no tenant context is set, so policies filter everything. This is the fail-closed behaviour working.

- [ ] **Step 11: Record the result**

In `docs/phase-0/README.md`, replace the "Not verified" section with:

```markdown
## Verified against a live database

```
npm run db:migrate  ✅
npm run db:seed     ✅ 17 permissions
npm run db:verify   ✅ ros_app is subject to RLS
RUN_DB_TESTS=1 npm test  ✅ 53/53
```

Tenant isolation is demonstrated, not merely argued.
```

- [ ] **Step 12: Commit**

```powershell
git add docs/phase-0/README.md
git commit -m "docs: record Phase 0 verification against live PostgreSQL"
```

---

## Task 1: Extend the permission registry

Phase 1 introduces floors, tables and QR rotation as things a role can be allowed to do. Permissions are code-defined (see `docs/phase-0/04-business-rules.md`, BR-18), so they must exist before any service can guard on them.

**Files:**
- Modify: `src/modules/rbac/permissions.ts`
- Test: `src/modules/rbac/permissions.test.ts` (existing tests must still pass)

**Interfaces:**
- Consumes: `define(module, entries)`, `PERMISSIONS`, `SYSTEM_ROLE_TEMPLATES` from `src/modules/rbac/permissions.ts`
- Produces: permission codes `floor.view`, `floor.create`, `floor.update`, `floor.delete`, `table.view`, `table.create`, `table.update`, `table.delete`, `table.rotate_qr` — consumed by Tasks 4, 6, 7

- [ ] **Step 1: Write the failing test**

Add to the end of `src/modules/rbac/permissions.test.ts`:

```ts
describe('phase 1 permissions', () => {
  it('registers floor and table permissions', () => {
    for (const code of [
      'floor.view',
      'floor.create',
      'floor.update',
      'floor.delete',
      'table.view',
      'table.create',
      'table.update',
      'table.delete',
      'table.rotate_qr',
    ]) {
      expect(isKnownPermission(code), `missing permission "${code}"`).toBe(true)
    }
  })

  it('lets floor staff read the room but not restructure it', () => {
    // A waiter needs to see tables to work the floor. Letting them delete a
    // table mid-service is not a capability anyone asked for.
    const waiter = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === 'waiter')!
    const granted = resolveTemplatePermissions(waiter)

    expect(granted).toContain('table.view')
    expect(granted).toContain('floor.view')
    expect(granted).not.toContain('table.delete')
    expect(granted).not.toContain('table.create')
  })

  it('does not give cashiers QR rotation', () => {
    // Rotating a QR invalidates every printed sticker on that table.
    const cashier = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === 'cashier')!
    expect(resolveTemplatePermissions(cashier)).not.toContain('table.rotate_qr')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

```powershell
npx vitest run src/modules/rbac/permissions.test.ts
```

Expected: FAIL — `missing permission "floor.view"`

- [ ] **Step 3: Add the permissions**

In `src/modules/rbac/permissions.ts`, insert into the `PERMISSIONS` array immediately after the `branch` block:

```ts
  ...define('floor', {
    view: 'View floors within a branch',
    create: 'Create a floor',
    update: 'Rename or reorder a floor',
    delete: 'Delete a floor',
  }),
  ...define('table', {
    view: 'View tables and their status',
    create: 'Create a table',
    update: 'Edit a table’s code, capacity, floor or position',
    delete: 'Delete a table',
    rotate_qr: 'Issue a new QR code for a table, invalidating the printed one',
  }),
```

- [ ] **Step 4: Grant them to the right role templates**

In the same file, update these `SYSTEM_ROLE_TEMPLATES` entries. Replace the `permissions` array of `manager`:

```ts
    permissions: [
      'restaurant.view',
      'branch.view',
      'branch.update',
      'floor.view',
      'floor.create',
      'floor.update',
      'floor.delete',
      'table.view',
      'table.create',
      'table.update',
      'table.delete',
      'table.rotate_qr',
      'staff.view',
      'staff.invite',
      'staff.update',
      'audit.view',
      'settings.view',
    ],
```

Replace the `permissions` array of `cashier`:

```ts
    permissions: ['restaurant.view', 'branch.view', 'floor.view', 'table.view'],
```

Replace the `permissions` array of `waiter`:

```ts
    permissions: [
      'restaurant.view',
      'branch.view',
      'floor.view',
      'table.view',
      'table.update',
    ],
```

The waiter keeps `table.update` because marking a table occupied or available is floor work, not administration.

- [ ] **Step 5: Run the tests**

```powershell
npx vitest run src/modules/rbac/permissions.test.ts
```

Expected: PASS, all cases including the pre-existing "only references permissions that exist in the registry" and "does not grant role administration to non-owner roles".

- [ ] **Step 6: Sync the registry to the database**

```powershell
npm run db:seed
```

Expected: `26 permissions in registry.`

- [ ] **Step 7: Re-pin existing owner roles**

The restaurant created during Task 0 has an owner role that predates these nine permissions. Confirm the re-pin path works:

```powershell
npx tsx -e "import('dotenv/config').then(async()=>{const {db}=await import('./src/lib/db');const {repinOwnerRoles}=await import('./src/modules/rbac/rbac.service');await db.transaction(t=>repinOwnerRoles(t));console.log('owner roles re-pinned');process.exit(0)})"
```

Expected: `owner roles re-pinned`

- [ ] **Step 8: Commit**

```powershell
git add src/modules/rbac/permissions.ts src/modules/rbac/permissions.test.ts
git commit -m "feat: add floor and table permissions to the registry"
```

---

## Task 2: Branch repository and service

`branches` already exists as a table (Phase 0 defined it because RBAC references it) but has no CRUD. This task builds the data and business layer, with no HTTP or UI.

**Files:**
- Create: `src/modules/branch/branch.validation.ts`
- Create: `src/modules/branch/branch.repository.ts`
- Create: `src/modules/branch/branch.service.ts`
- Test: `src/modules/branch/branch.validation.test.ts`

**Interfaces:**
- Consumes: `withTenant(ctx, fn)`, `Transaction` from `@/lib/db`; `branches` from `@/lib/db/schema`; `recordAuditIn` from `@/modules/audit/audit.service`; `ConflictError`, `NotFoundError` from `@/lib/errors`
- Produces:
  - `createBranchSchema`, `updateBranchSchema`, `CreateBranchInput`, `UpdateBranchInput`
  - `listBranches(restaurantId, userId): Promise<BranchSummary[]>`
  - `getBranch(restaurantId, userId, branchId): Promise<BranchSummary>` — throws `NotFoundError`
  - `createBranch(ctx, input): Promise<{ id: string }>`
  - `updateBranch(ctx, branchId, input): Promise<void>`
  - `deactivateBranch(ctx, branchId): Promise<void>`
  - `interface BranchSummary { id, name, code, city, phone, status, timezone, createdAt }`
  - `interface BranchActorContext { restaurantId: string; userId: string; ipAddress?: string | null; userAgent?: string | null }`

  All consumed by Task 3.

- [ ] **Step 1: Write the validation schema**

Create `src/modules/branch/branch.validation.ts`:

```ts
import { z } from 'zod'

/**
 * Branch code appears on receipts and in reports, so it is constrained to
 * something a person can read aloud over a phone: letters and digits only,
 * uppercased for consistency.
 *
 * Uppercased before validation, not after — otherwise "kl01" fails the
 * pattern check before the transform ever runs.
 */
export const branchCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .min(1, 'Branch code is required')
      .max(12, 'Branch code must be at most 12 characters')
      .regex(/^[A-Z0-9]+$/, 'Use letters and digits only'),
  )

export const createBranchSchema = z.object({
  name: z.string().trim().min(1, 'Branch name is required').max(120),
  code: branchCodeSchema,
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  /** IANA zone. Empty means inherit the restaurant's. */
  timezone: z.string().trim().max(64).optional(),
})

export const updateBranchSchema = createBranchSchema.partial()

export type CreateBranchInput = z.infer<typeof createBranchSchema>
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>
```

- [ ] **Step 2: Write the failing validation test**

Create `src/modules/branch/branch.validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { branchCodeSchema, createBranchSchema } from './branch.validation'

describe('branch code', () => {
  it('uppercases before validating', () => {
    // Normalise-then-validate: "kl01" must be accepted, not rejected for
    // failing an uppercase-only pattern it was never given a chance to meet.
    expect(branchCodeSchema.parse(' kl01 ')).toBe('KL01')
  })

  it('rejects punctuation', () => {
    expect(branchCodeSchema.safeParse('KL-01').success).toBe(false)
  })

  it('rejects an empty code', () => {
    expect(branchCodeSchema.safeParse('   ').success).toBe(false)
  })

  it('rejects a code longer than 12 characters', () => {
    expect(branchCodeSchema.safeParse('A'.repeat(13)).success).toBe(false)
  })
})

describe('createBranchSchema', () => {
  it('accepts a minimal branch', () => {
    const result = createBranchSchema.safeParse({
      name: '  Bangsar  ',
      code: 'bsr1',
    })

    expect(result.success).toBe(true)
    expect(result.data?.name).toBe('Bangsar')
    expect(result.data?.code).toBe('BSR1')
  })

  it('rejects a whitespace-only name', () => {
    expect(
      createBranchSchema.safeParse({ name: '   ', code: 'A1' }).success,
    ).toBe(false)
  })
})
```

- [ ] **Step 3: Run it**

```powershell
npx vitest run src/modules/branch/branch.validation.test.ts
```

Expected: PASS (schema written in Step 1).

- [ ] **Step 4: Write the repository**

Create `src/modules/branch/branch.repository.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import { branches } from '@/lib/db/schema'

export interface BranchSummary {
  id: string
  name: string
  code: string
  city: string | null
  phone: string | null
  status: 'active' | 'inactive'
  timezone: string | null
  createdAt: Date
}

const SUMMARY_COLUMNS = {
  id: branches.id,
  name: branches.name,
  code: branches.code,
  city: branches.city,
  phone: branches.phone,
  status: branches.status,
  timezone: branches.timezone,
  createdAt: branches.createdAt,
} as const

export async function listBranches(
  restaurantId: string,
  userId: string,
): Promise<BranchSummary[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(SUMMARY_COLUMNS)
      .from(branches)
      .where(eq(branches.restaurantId, restaurantId))
      .orderBy(asc(branches.name)),
  )
}

/**
 * Reads one branch inside an existing transaction.
 *
 * The `restaurantId` predicate is redundant with the RLS policy on purpose:
 * if this query is ever refactored wrongly, the database still refuses to
 * return another tenant's row.
 */
export async function findBranchIn(
  tx: Transaction,
  restaurantId: string,
  branchId: string,
): Promise<BranchSummary | null> {
  const [row] = await tx
    .select(SUMMARY_COLUMNS)
    .from(branches)
    .where(
      and(eq(branches.id, branchId), eq(branches.restaurantId, restaurantId)),
    )
    .limit(1)

  return row ?? null
}

export async function findBranchByCodeIn(
  tx: Transaction,
  restaurantId: string,
  code: string,
): Promise<{ id: string } | null> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(
      and(eq(branches.restaurantId, restaurantId), eq(branches.code, code)),
    )
    .limit(1)

  return row ?? null
}
```

- [ ] **Step 5: Write the service**

Create `src/modules/branch/branch.service.ts`:

```ts
import { and, eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { branches } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import {
  findBranchByCodeIn,
  findBranchIn,
  listBranches,
  type BranchSummary,
} from './branch.repository'
import type { CreateBranchInput, UpdateBranchInput } from './branch.validation'

export interface BranchActorContext {
  restaurantId: string
  userId: string
  ipAddress?: string | null
  userAgent?: string | null
}

export { listBranches }
export type { BranchSummary }

export async function getBranch(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<BranchSummary> {
  const branch = await withTenant({ restaurantId, userId }, (tx) =>
    findBranchIn(tx, restaurantId, branchId),
  )

  // 404 rather than 403: a 403 would confirm this branch id exists somewhere.
  if (!branch) throw new NotFoundError('Branch not found.')
  return branch
}

export async function createBranch(
  ctx: BranchActorContext,
  input: CreateBranchInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    /**
     * Checked explicitly as well as by the unique index. The index is the
     * real guarantee, but a duplicate-key error surfaces as an opaque 500,
     * and "code KL01 is already used" is what the person filling in the form
     * needs to read.
     */
    const clash = await findBranchByCodeIn(tx, ctx.restaurantId, input.code)
    if (clash) {
      throw new ConflictError(
        `Branch code "${input.code}" is already used by another branch.`,
      )
    }

    const [created] = await tx
      .insert(branches)
      .values({
        restaurantId: ctx.restaurantId,
        name: input.name,
        code: input.code,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postalCode: input.postalCode ?? null,
        country: input.country ?? null,
        phone: input.phone ?? null,
        timezone: input.timezone || null,
      })
      .returning({ id: branches.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'branch.created',
      entityType: 'branch',
      entityId: created.id,
      after: { name: input.name, code: input.code },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateBranch(
  ctx: BranchActorContext,
  branchId: string,
  input: UpdateBranchInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!existing) throw new NotFoundError('Branch not found.')

    if (input.code && input.code !== existing.code) {
      const clash = await findBranchByCodeIn(tx, ctx.restaurantId, input.code)
      if (clash) {
        throw new ConflictError(
          `Branch code "${input.code}" is already used by another branch.`,
        )
      }
    }

    await tx
      .update(branches)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.addressLine1 !== undefined
          ? { addressLine1: input.addressLine1 || null }
          : {}),
        ...(input.addressLine2 !== undefined
          ? { addressLine2: input.addressLine2 || null }
          : {}),
        ...(input.city !== undefined ? { city: input.city || null } : {}),
        ...(input.state !== undefined ? { state: input.state || null } : {}),
        ...(input.postalCode !== undefined
          ? { postalCode: input.postalCode || null }
          : {}),
        ...(input.country !== undefined
          ? { country: input.country || null }
          : {}),
        ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
        ...(input.timezone !== undefined
          ? { timezone: input.timezone || null }
          : {}),
      })
      .where(
        and(
          eq(branches.id, branchId),
          eq(branches.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'branch.updated',
      entityType: 'branch',
      entityId: branchId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Deactivates rather than deletes.
 *
 * A branch is referenced by memberships, and will be referenced by orders and
 * payments from Phase 5. Deleting one would either cascade away financial
 * history or fail on a foreign key. Neither is what "close this branch" means
 * — the branch stops operating, its records stay.
 */
export async function deactivateBranch(
  ctx: BranchActorContext,
  branchId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!existing) throw new NotFoundError('Branch not found.')

    await tx
      .update(branches)
      .set({ status: 'inactive' })
      .where(
        and(
          eq(branches.id, branchId),
          eq(branches.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'branch.deactivated',
      entityType: 'branch',
      entityId: branchId,
      before: { status: existing.status },
      after: { status: 'inactive' },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
```

- [ ] **Step 6: Verify**

```powershell
npm run typecheck; npx eslint .; npx vitest run
```

Expected: clean typecheck, no lint errors, all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/modules/branch
git commit -m "feat: branch repository, service and validation"
```

---

## Task 3: Branch API, navigation and UI

**Files:**
- Create: `src/app/api/branches/route.ts`
- Create: `src/app/api/branches/[branchId]/route.ts`
- Create: `src/components/app-sidebar.tsx`
- Modify: `src/components/app-shell.tsx`
- Create: `src/app/(app)/branches/page.tsx`
- Create: `src/modules/branch/ui/branch-list.tsx`
- Create: `src/modules/branch/ui/branch-form-dialog.tsx`

**Interfaces:**
- Consumes: everything Task 2 produced; `requirePermission` from `@/lib/auth/context`; `assertSameOrigin`, `getRequestMetadata`, `readJson`, `withRoute` from `@/lib/api`; `postJson`, `ApiClientError` from `@/lib/client/api`
- Produces:
  - `POST /api/branches`, `PATCH /api/branches/[branchId]`, `DELETE /api/branches/[branchId]`
  - `<AppSidebar />` — consumed by Tasks 4, 6, 8 for their nav entries

- [ ] **Step 1: Add the shadcn components this task needs**

```powershell
npx shadcn@latest add dialog select switch textarea tabs -y
```

Expected: five files created under `src/components/ui/`.

- [ ] **Step 2: Create the collection route handler**

Create `src/app/api/branches/route.ts`:

```ts
import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { createBranch } from '@/modules/branch/branch.service'
import { createBranchSchema } from '@/modules/branch/branch.validation'

export const POST = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('branch.create')
  const input = createBranchSchema.parse(await readJson(request))

  const branch = await createBranch(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json(branch, { status: 201 })
})
```

- [ ] **Step 3: Create the item route handler**

Create `src/app/api/branches/[branchId]/route.ts`:

```ts
import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import {
  deactivateBranch,
  updateBranch,
} from '@/modules/branch/branch.service'
import { updateBranchSchema } from '@/modules/branch/branch.validation'

interface RouteContext {
  params: Promise<{ branchId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('branch.update')
    const { branchId } = await params
    const input = updateBranchSchema.parse(await readJson(request))

    await updateBranch(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('branch.delete')
    const { branchId } = await params

    await deactivateBranch(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
    )

    return NextResponse.json({ ok: true })
  },
)
```

- [ ] **Step 4: Create the sidebar**

Create `src/components/app-sidebar.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Building2, LayoutDashboard, Settings, Table2 } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Navigation appears in Phase 1 rather than Phase 0 because until now there
 * was exactly one destination. Navigation designed around a single page is
 * shaped by nothing.
 *
 * Entries are filtered server-side by permission before being passed in —
 * hiding a link is a usability affordance, never an access control.
 */
export interface NavItem {
  href: string
  label: string
  icon: 'dashboard' | 'branches' | 'tables' | 'settings'
}

const ICONS = {
  dashboard: LayoutDashboard,
  branches: Building2,
  tables: Table2,
  settings: Settings,
} as const

export function AppSidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Main"
      className="flex gap-1 overflow-x-auto border-b px-4 py-2 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:px-3 md:py-4"
    >
      {items.map((item) => {
        const Icon = ICONS[item.icon]
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`)

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              'min-h-11 md:min-h-9',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
```

- [ ] **Step 5: Host the sidebar in the shell**

In `src/components/app-shell.tsx`, add to the imports:

```tsx
import { AppSidebar, type NavItem } from '@/components/app-sidebar'
```

Add `navItems` to the props interface:

```tsx
interface AppShellProps {
  user: { name: string; email: string }
  tenant: { name: string; roleName: string }
  canSwitchTenant: boolean
  /** Pre-filtered by permission on the server. */
  navItems: NavItem[]
  children: ReactNode
}
```

Add it to the destructured parameters:

```tsx
export function AppShell({
  user,
  tenant,
  canSwitchTenant,
  navItems,
  children,
}: AppShellProps) {
```

Then replace the `<main>` element and its wrapper with:

```tsx
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col md:flex-row">
        <aside className="md:w-56 md:shrink-0">
          <AppSidebar items={navItems} />
        </aside>

        <main className="min-w-0 flex-1 px-4 py-8">{children}</main>
      </div>
```

- [ ] **Step 6: Pass the filtered nav from the layout**

In `src/app/(app)/layout.tsx`, replace the `return` block with:

```tsx
  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' as const },
    ...(ctx.tenant.permissions.has('branch.view')
      ? [{ href: '/branches', label: 'Branches', icon: 'branches' as const }]
      : []),
    ...(ctx.tenant.permissions.has('table.view')
      ? [{ href: '/tables', label: 'Tables', icon: 'tables' as const }]
      : []),
    ...(ctx.tenant.permissions.has('settings.view')
      ? [{ href: '/settings', label: 'Settings', icon: 'settings' as const }]
      : []),
  ]

  return (
    <AppShell
      user={{ name: ctx.user.name, email: ctx.user.email }}
      tenant={{ name: ctx.tenant.restaurantName, roleName: ctx.tenant.roleName }}
      canSwitchTenant={tenants.length > 1}
      navItems={navItems}
    >
      {children}
    </AppShell>
  )
```

- [ ] **Step 7: Create the branch form dialog**

Create `src/modules/branch/ui/branch-form-dialog.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, postJson } from '@/lib/client/api'

export interface BranchFormValues {
  id?: string
  name: string
  code: string
  city?: string | null
  phone?: string | null
}

export function BranchFormDialog({
  trigger,
  branch,
}: {
  trigger: React.ReactNode
  branch?: BranchFormValues
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editing = Boolean(branch?.id)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const body = {
      name: form.get('name'),
      code: form.get('code'),
      city: form.get('city') || undefined,
      phone: form.get('phone') || undefined,
    }

    try {
      if (editing) {
        const response = await fetch(`/api/branches/${branch!.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          throw new ApiClientError(
            payload?.error?.message ?? 'Could not save the branch.',
            payload?.error?.code,
            payload?.error?.details,
          )
        }
      } else {
        await postJson('/api/branches', body)
      }

      toast.success(editing ? 'Branch updated' : 'Branch created')
      setOpen(false)
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit branch' : 'New branch'}</DialogTitle>
            <DialogDescription>
              The branch code appears on receipts and reports. Keep it short.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Branch name</Label>
              <Input
                id="name"
                name="name"
                required
                maxLength={120}
                defaultValue={branch?.name}
                placeholder="Bangsar"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                name="code"
                required
                maxLength={12}
                defaultValue={branch?.code}
                placeholder="BSR1"
                className="font-mono uppercase"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  name="city"
                  maxLength={120}
                  defaultValue={branch?.city ?? ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  name="phone"
                  maxLength={40}
                  defaultValue={branch?.phone ?? ''}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create branch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 8: Create the branch list**

Create `src/modules/branch/ui/branch-list.tsx`:

```tsx
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { BranchSummary } from '@/modules/branch/branch.repository'
import { BranchFormDialog } from './branch-form-dialog'

export function BranchList({
  branches,
  canEdit,
}: {
  branches: BranchSummary[]
  canEdit: boolean
}) {
  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          No branches yet. Create one to start setting up floors and tables.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Code</TableHead>
            <TableHead className="hidden sm:table-cell">City</TableHead>
            <TableHead>Status</TableHead>
            {canEdit && <TableHead className="w-20" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {branches.map((branch) => (
            <TableRow key={branch.id}>
              <TableCell className="font-medium">{branch.name}</TableCell>
              <TableCell className="font-mono text-xs">{branch.code}</TableCell>
              <TableCell className="hidden sm:table-cell">
                {branch.city ?? '—'}
              </TableCell>
              <TableCell>
                <Badge
                  variant={branch.status === 'active' ? 'secondary' : 'outline'}
                >
                  {branch.status}
                </Badge>
              </TableCell>
              {canEdit && (
                <TableCell>
                  <BranchFormDialog
                    branch={branch}
                    trigger={
                      <Button variant="ghost" size="sm">
                        Edit
                      </Button>
                    }
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 9: Create the page**

Create `src/app/(app)/branches/page.tsx`:

```tsx
import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { requirePermission } from '@/lib/auth/context'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchFormDialog } from '@/modules/branch/ui/branch-form-dialog'
import { BranchList } from '@/modules/branch/ui/branch-list'

export const metadata: Metadata = { title: 'Branches' }

export default async function BranchesPage() {
  // The guard is the enforcement. The sidebar hiding this link is not.
  const ctx = await requirePermission('branch.view')

  const branches = await listBranches(ctx.tenant.restaurantId, ctx.user.id)
  const canCreate = ctx.tenant.permissions.has('branch.create')
  const canEdit = ctx.tenant.permissions.has('branch.update')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Branches</h1>
          <p className="text-sm text-muted-foreground">
            Each branch has its own floors, tables and staff assignments.
          </p>
        </div>

        {canCreate && (
          <BranchFormDialog trigger={<Button>New branch</Button>} />
        )}
      </div>

      <BranchList branches={branches} canEdit={canEdit} />
    </div>
  )
}
```

- [ ] **Step 10: Verify and exercise it**

```powershell
npm run typecheck; npx eslint .; npm run build
```

Then:

```powershell
npm run dev
```

Sign in, open `/branches`, create a branch named "Bangsar" code "bsr1". Confirm the code is stored uppercase as `BSR1`, and that creating a second branch with the same code shows "Branch code BSR1 is already used…" rather than a 500.

- [ ] **Step 11: Commit**

```powershell
git add src/app/api/branches src/app/'(app)'/branches src/components/app-sidebar.tsx src/components/app-shell.tsx src/app/'(app)'/layout.tsx src/modules/branch/ui src/components/ui
git commit -m "feat: branch management API, navigation sidebar and UI"
```

---

## Task 4: Floors

A floor groups tables within a branch — "Ground Floor", "Rooftop", "Private Rooms". Small enough to build end to end in one task.

**Files:**
- Create: `src/lib/db/schema/structure.ts`
- Modify: `src/lib/db/schema/index.ts`
- Create: `src/modules/floor/floor.validation.ts`
- Create: `src/modules/floor/floor.repository.ts`
- Create: `src/modules/floor/floor.service.ts`
- Create: `src/app/api/branches/[branchId]/floors/route.ts`
- Create: `src/app/api/floors/[floorId]/route.ts`
- Test: `src/modules/floor/floor.validation.test.ts`

**Interfaces:**
- Consumes: `tenantPolicy`, `timestamps` from `@/lib/db/schema/_shared`; `branches`, `restaurants` from `@/lib/db/schema/tenancy`; `assertBranchAccess`, `requirePermission` from `@/lib/auth/context`
- Produces:
  - `floors` table (columns: `id`, `restaurantId`, `branchId`, `name`, `displayOrder`, `createdAt`, `updatedAt`)
  - `createFloorSchema`, `updateFloorSchema`, `CreateFloorInput`, `UpdateFloorInput`
  - `listFloors(restaurantId, userId, branchId): Promise<FloorSummary[]>`
  - `createFloor(ctx, branchId, input): Promise<{ id: string }>`
  - `updateFloor(ctx, floorId, input): Promise<void>`
  - `deleteFloor(ctx, floorId): Promise<void>`
  - `interface FloorSummary { id, branchId, name, displayOrder }`

  Consumed by Tasks 5 and 6.

- [ ] **Step 1: Create the schema file**

Create `src/lib/db/schema/structure.ts`:

```ts
import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { branches, restaurants } from './tenancy'
import { tenantPolicy, timestamps } from './_shared'

/**
 * Physical structure within a branch.
 *
 *   restaurant -> branch -> floor -> table
 *
 * `restaurantId` is carried on every table here even though it is derivable
 * from `branchId`. An RLS policy can only reference columns on its own table,
 * so without it each row would need a subquery to be tenant-filtered.
 */
export const floors = pgTable(
  'floors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Ascending. Ties broken by name. */
    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('floors_branch_name_key').on(t.branchId, t.name),
    index('floors_branch_id_idx').on(t.branchId),
    index('floors_restaurant_id_idx').on(t.restaurantId),
    tenantPolicy('floors_tenant_isolation', t.restaurantId),
  ],
)

export const floorsRelations = relations(floors, ({ one }) => ({
  branch: one(branches, {
    fields: [floors.branchId],
    references: [branches.id],
  }),
}))
```

- [ ] **Step 2: Export it from the barrel**

In `src/lib/db/schema/index.ts`, add after the `tenancy` export:

```ts
export * from './structure'
```

A table missing from this barrel is silently dropped from migrations — this line is not optional.

- [ ] **Step 3: Generate the migration**

```powershell
npm run db:generate
```

Expected: a new file `drizzle/0001_*.sql`.

- [ ] **Step 4: Read the generated SQL and confirm the policy**

```powershell
Select-String -Path drizzle/0001_*.sql -Pattern "POLICY|ROW LEVEL"
```

Expected two lines:
- `ALTER TABLE "floors" ENABLE ROW LEVEL SECURITY;`
- `CREATE POLICY "floors_tenant_isolation" ON "floors" AS PERMISSIVE FOR ALL TO "ros_app" USING (...) WITH CHECK (...)`

If either is missing, the policy did not reach the migration and every floor would be readable across tenants. Fix the schema and regenerate before applying.

- [ ] **Step 5: Apply it**

```powershell
npm run db:migrate
```

Expected: `Migrations complete.`

- [ ] **Step 6: Write the validation schema**

Create `src/modules/floor/floor.validation.ts`:

```ts
import { z } from 'zod'

export const createFloorSchema = z.object({
  name: z.string().trim().min(1, 'Floor name is required').max(80),
  displayOrder: z.number().int().min(0).max(999).default(0),
})

export const updateFloorSchema = createFloorSchema.partial()

export type CreateFloorInput = z.infer<typeof createFloorSchema>
export type UpdateFloorInput = z.infer<typeof updateFloorSchema>
```

- [ ] **Step 7: Write the failing test**

Create `src/modules/floor/floor.validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createFloorSchema, updateFloorSchema } from './floor.validation'

describe('createFloorSchema', () => {
  it('trims the name and defaults the order', () => {
    const result = createFloorSchema.parse({ name: '  Rooftop  ' })
    expect(result.name).toBe('Rooftop')
    expect(result.displayOrder).toBe(0)
  })

  it('rejects a whitespace-only name', () => {
    expect(createFloorSchema.safeParse({ name: '  ' }).success).toBe(false)
  })

  it('rejects a fractional display order', () => {
    expect(
      createFloorSchema.safeParse({ name: 'Ground', displayOrder: 1.5 })
        .success,
    ).toBe(false)
  })

  it('rejects a negative display order', () => {
    expect(
      createFloorSchema.safeParse({ name: 'Ground', displayOrder: -1 }).success,
    ).toBe(false)
  })
})

describe('updateFloorSchema', () => {
  it('accepts a partial update', () => {
    expect(updateFloorSchema.safeParse({ name: 'Mezzanine' }).success).toBe(
      true,
    )
  })

  it('accepts an empty object', () => {
    expect(updateFloorSchema.safeParse({}).success).toBe(true)
  })
})
```

- [ ] **Step 8: Run it**

```powershell
npx vitest run src/modules/floor/floor.validation.test.ts
```

Expected: PASS.

- [ ] **Step 9: Write the repository**

Create `src/modules/floor/floor.repository.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm'

import { withTenant, type Transaction } from '@/lib/db'
import { floors } from '@/lib/db/schema'

export interface FloorSummary {
  id: string
  branchId: string
  name: string
  displayOrder: number
}

const SUMMARY_COLUMNS = {
  id: floors.id,
  branchId: floors.branchId,
  name: floors.name,
  displayOrder: floors.displayOrder,
} as const

export async function listFloors(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<FloorSummary[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(SUMMARY_COLUMNS)
      .from(floors)
      .where(
        and(eq(floors.restaurantId, restaurantId), eq(floors.branchId, branchId)),
      )
      .orderBy(asc(floors.displayOrder), asc(floors.name)),
  )
}

export async function findFloorIn(
  tx: Transaction,
  restaurantId: string,
  floorId: string,
): Promise<FloorSummary | null> {
  const [row] = await tx
    .select(SUMMARY_COLUMNS)
    .from(floors)
    .where(and(eq(floors.id, floorId), eq(floors.restaurantId, restaurantId)))
    .limit(1)

  return row ?? null
}
```

- [ ] **Step 10: Write the service**

Create `src/modules/floor/floor.service.ts`:

```ts
import { and, eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { floors } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { findBranchIn } from '@/modules/branch/branch.repository'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { findFloorIn, listFloors, type FloorSummary } from './floor.repository'
import type { CreateFloorInput, UpdateFloorInput } from './floor.validation'

export { listFloors }
export type { FloorSummary }

export async function createFloor(
  ctx: BranchActorContext,
  branchId: string,
  input: CreateFloorInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    // Confirms the branch exists *and* belongs to this tenant. 404, not 403.
    const branch = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!branch) throw new NotFoundError('Branch not found.')

    const [existing] = await tx
      .select({ id: floors.id })
      .from(floors)
      .where(and(eq(floors.branchId, branchId), eq(floors.name, input.name)))
      .limit(1)

    if (existing) {
      throw new ConflictError(
        `This branch already has a floor called "${input.name}".`,
      )
    }

    const [created] = await tx
      .insert(floors)
      .values({
        restaurantId: ctx.restaurantId,
        branchId,
        name: input.name,
        displayOrder: input.displayOrder,
      })
      .returning({ id: floors.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'floor.created',
      entityType: 'floor',
      entityId: created.id,
      after: { branchId, name: input.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id }
  })
}

export async function updateFloor(
  ctx: BranchActorContext,
  floorId: string,
  input: UpdateFloorInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findFloorIn(tx, ctx.restaurantId, floorId)
    if (!existing) throw new NotFoundError('Floor not found.')

    if (input.name && input.name !== existing.name) {
      const [clash] = await tx
        .select({ id: floors.id })
        .from(floors)
        .where(
          and(
            eq(floors.branchId, existing.branchId),
            eq(floors.name, input.name),
          ),
        )
        .limit(1)

      if (clash) {
        throw new ConflictError(
          `This branch already has a floor called "${input.name}".`,
        )
      }
    }

    await tx
      .update(floors)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayOrder !== undefined
          ? { displayOrder: input.displayOrder }
          : {}),
      })
      .where(
        and(eq(floors.id, floorId), eq(floors.restaurantId, ctx.restaurantId)),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'floor.updated',
      entityType: 'floor',
      entityId: floorId,
      before: existing,
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Hard delete, unlike branches.
 *
 * A floor is a grouping label with no financial history attached. Tables
 * reference it with `ON DELETE SET NULL`, so deleting a floor leaves its
 * tables intact and unassigned rather than destroying them.
 */
export async function deleteFloor(
  ctx: BranchActorContext,
  floorId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findFloorIn(tx, ctx.restaurantId, floorId)
    if (!existing) throw new NotFoundError('Floor not found.')

    await tx
      .delete(floors)
      .where(
        and(eq(floors.id, floorId), eq(floors.restaurantId, ctx.restaurantId)),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'floor.deleted',
      entityType: 'floor',
      entityId: floorId,
      before: existing,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
```

- [ ] **Step 11: Create the route handlers**

Create `src/app/api/branches/[branchId]/floors/route.ts`:

```ts
import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { assertBranchAccess, requirePermission } from '@/lib/auth/context'
import { createFloor } from '@/modules/floor/floor.service'
import { createFloorSchema } from '@/modules/floor/floor.validation'

interface RouteContext {
  params: Promise<{ branchId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('floor.create')
    const { branchId } = await params

    // Branch scoping is not expressible as an RLS policy — it depends on the
    // membership, not on a column of the row. Enforced here instead.
    assertBranchAccess(ctx, branchId)

    const input = createFloorSchema.parse(await readJson(request))

    const floor = await createFloor(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
      input,
    )

    return NextResponse.json(floor, { status: 201 })
  },
)
```

Create `src/app/api/floors/[floorId]/route.ts`:

```ts
import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteFloor, updateFloor } from '@/modules/floor/floor.service'
import { updateFloorSchema } from '@/modules/floor/floor.validation'

interface RouteContext {
  params: Promise<{ floorId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('floor.update')
    const { floorId } = await params
    const input = updateFloorSchema.parse(await readJson(request))

    await updateFloor(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      floorId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('floor.delete')
    const { floorId } = await params

    await deleteFloor(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      floorId,
    )

    return NextResponse.json({ ok: true })
  },
)
```

- [ ] **Step 12: Verify**

```powershell
npm run typecheck; npx eslint .; npx vitest run
```

Expected: all clean.

- [ ] **Step 13: Commit**

```powershell
git add src/lib/db/schema/structure.ts src/lib/db/schema/index.ts drizzle src/modules/floor src/app/api/branches src/app/api/floors
git commit -m "feat: floors schema, service and API"
```

---

## Task 5: Table schema and QR token engine

The interesting task. Tables carry a QR token that identifies them publicly, and the spec requires that a QR "never expose restaurant IDs or table IDs directly".

**Design decision, stated explicitly because it is easy to get wrong:**

The spec also says QR tokens must be "time-limited". A printed sticker on a physical table cannot rotate on a timer — reprinting every table nightly is not a thing any restaurant will do. These two requirements are reconciled by splitting the token in two:

- **The table token** (this task) is long-lived, opaque, and rotatable on demand. It identifies *which table this is* and nothing more. Possessing it grants no authority.
- **The dining-session token** (Phase 4) is short-lived and is what actually authorises ordering. It is minted when someone scans and joins.

So the printed sticker stays valid until deliberately rotated, and the time-limited credential is the one that carries power.

The token is stored in plaintext, not hashed — unlike session tokens. A restaurant must be able to reprint a damaged sticker without invalidating the table, which a hash makes impossible. This is acceptable precisely because the token confers no authority on its own.

Enumeration is prevented at the database, not in application code: a dedicated RLS policy reveals only the row whose token matches a session variable, so even the public scan endpoint physically cannot list tables.

**Files:**
- Modify: `src/lib/db/schema/_shared.ts`
- Modify: `src/lib/db/schema/structure.ts`
- Modify: `src/lib/db/schema/tenancy.ts`
- Modify: `src/lib/db/index.ts`
- Create: `src/modules/table/qr.ts`
- Create: `src/modules/table/table.validation.ts`
- Create: `src/modules/table/table.repository.ts`
- Create: `src/modules/table/table.service.ts`
- Test: `src/modules/table/qr.test.ts`
- Test: `tests/qr-isolation.integration.test.ts`

**Interfaces:**
- Consumes: `currentTenantId`, `tenantPolicy`, `timestamps`, `appRole` from `@/lib/db/schema/_shared`; `floors` from `@/lib/db/schema/structure`
- Produces:
  - `currentQrToken(): SQL` in `_shared.ts`
  - `withQrToken(token, fn)` in `@/lib/db`
  - `dining_tables` table, `table_status` enum
  - `generateQrToken(): string`, `qrPayloadUrl(token: string): string`
  - `createTableSchema`, `updateTableSchema`, `CreateTableInput`, `UpdateTableInput`
  - `listTables(restaurantId, userId, branchId): Promise<TableSummary[]>`
  - `createTable(ctx, branchId, input): Promise<{ id: string; qrToken: string }>`
  - `updateTable(ctx, tableId, input): Promise<void>`
  - `deleteTable(ctx, tableId): Promise<void>`
  - `rotateTableQr(ctx, tableId): Promise<{ qrToken: string }>`
  - `resolveTableByToken(token): Promise<ScannedTable | null>`
  - `interface TableSummary { id, branchId, floorId, code, name, capacity, status, qrToken, positionX, positionY }`
  - `interface ScannedTable { tableId, tableCode, tableName, branchName, restaurantName }`

  Consumed by Tasks 6 and 7.

- [ ] **Step 1: Add the QR session-variable helper**

In `src/lib/db/schema/_shared.ts`, add after `currentActorId`:

```ts
/**
 * The QR token a public scan request is presenting.
 *
 * A third context alongside tenant and actor. Set by `withQrToken`, read only
 * by the QR lookup policies, and never set on an authenticated request.
 *
 * Same NULLIF guard as the others: absent or empty means NULL, and `column =
 * NULL` is NULL, so nothing matches. Fail closed.
 */
export const currentQrToken = (): SQL =>
  sql`nullif(current_setting('app.qr_token', true), '')`
```

- [ ] **Step 2: Add the tables schema**

In `src/lib/db/schema/structure.ts`, add to the imports:

```ts
import { pgEnum, pgPolicy } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole, currentQrToken } from './_shared'
```

Then append to the file:

```ts
export const tableStatus = pgEnum('table_status', [
  'available',
  'occupied',
  'reserved',
  'out_of_service',
])

export const diningTables = pgTable(
  'dining_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    /**
     * Deleting a floor unassigns its tables rather than destroying them --
     * a floor is a grouping label, and losing the label should not lose the
     * furniture.
     */
    floorId: uuid('floor_id').references(() => floors.id, {
      onDelete: 'set null',
    }),

    /** Short human identifier printed on the table, e.g. "T12". */
    code: text('code').notNull(),
    name: text('name'),
    capacity: integer('capacity').notNull().default(2),
    status: tableStatus('status').notNull().default('available'),

    /**
     * The value encoded in the printed QR. Opaque, globally unique, and
     * rotatable. Stored in plaintext rather than hashed, unlike session
     * tokens: a restaurant must be able to reprint a damaged sticker without
     * invalidating the table, which a one-way hash makes impossible.
     *
     * Safe because the token confers no authority. It names a table; it does
     * not authenticate anyone. Ordering requires a dining-session token
     * (Phase 4), which is short-lived and issued only on a successful join.
     */
    qrToken: text('qr_token').notNull(),
    qrRotatedAt: timestamps.createdAt,

    /** Floor-plan coordinates. Null until someone arranges the layout. */
    positionX: integer('position_x'),
    positionY: integer('position_y'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('dining_tables_qr_token_key').on(t.qrToken),
    uniqueIndex('dining_tables_branch_code_key').on(t.branchId, t.code),
    index('dining_tables_branch_id_idx').on(t.branchId),
    index('dining_tables_floor_id_idx').on(t.floorId),
    index('dining_tables_restaurant_id_idx').on(t.restaurantId),

    tenantPolicy('dining_tables_tenant_isolation', t.restaurantId),

    /**
     * Public scan lookup.
     *
     * This is what makes the QR endpoint safe to expose unauthenticated. The
     * policy reveals exactly the row whose token matches the session
     * variable — so a caller who holds one token sees one table, and a caller
     * who holds none sees nothing. Enumeration is impossible at the database
     * level rather than prevented by careful application code.
     *
     * SELECT only: scanning a QR never writes.
     */
    pgPolicy('dining_tables_qr_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.qrToken} = ${currentQrToken()}`,
    }),
  ],
)

export const diningTablesRelations = relations(diningTables, ({ one }) => ({
  branch: one(branches, {
    fields: [diningTables.branchId],
    references: [branches.id],
  }),
  floor: one(floors, {
    fields: [diningTables.floorId],
    references: [floors.id],
  }),
}))
```

- [ ] **Step 3: Let the scan read the branch and restaurant names**

A scanned page must say "Kopi Corner · Bangsar · Table 12". Both parent rows need matching lookup policies, or the join returns nothing — the same failure that bit `roles` in Phase 0.

In `src/lib/db/schema/tenancy.ts`, add to the `restaurants` table config, after `restaurants_member_read`:

```ts
    /**
     * Lets a QR scan read the restaurant name for the one table it holds a
     * token for. Scoped through `dining_tables`, whose own QR policy matches
     * on the token and does not reference `restaurants` — so no recursion.
     */
    pgPolicy('restaurants_qr_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`exists (
        select 1
        from dining_tables dt
        where dt.restaurant_id = ${t.id}
          and dt.qr_token = ${currentQrToken()}
      )`,
    }),
```

Add to the `branches` table config, after `tenantPolicy(...)`:

```ts
    pgPolicy('branches_qr_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`exists (
        select 1
        from dining_tables dt
        where dt.branch_id = ${t.id}
          and dt.qr_token = ${currentQrToken()}
      )`,
    }),
```

Update the imports at the top of `tenancy.ts`:

```ts
import {
  appRole,
  currentActorId,
  currentQrToken,
  tenantPolicy,
  timestamps,
} from './_shared'
```

- [ ] **Step 4: Add the `withQrToken` database context**

In `src/lib/db/index.ts`, add after `withActor`:

```ts
/**
 * Public QR scan context.
 *
 * Sets neither tenant nor actor — a person scanning a table is not signed in
 * and belongs to no tenant. Only the three `*_qr_lookup` policies match here,
 * and each is scoped to the single table bearing this token.
 *
 * The token travels as a bind parameter through `set_config`, never
 * interpolated into SQL, exactly as tenant ids do.
 */
export async function withQrToken<T>(
  token: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.tenant_id', '', true),
        set_config('app.user_id', '', true),
        set_config('app.qr_token', ${token}, true)
    `)
    return fn(tx)
  })
}
```

- [ ] **Step 5: Generate the migration**

```powershell
npm run db:generate
```

- [ ] **Step 6: Read the SQL and confirm all four policies**

```powershell
Select-String -Path drizzle/0002_*.sql -Pattern "CREATE POLICY"
```

Expected four:
- `dining_tables_tenant_isolation`
- `dining_tables_qr_lookup`
- `restaurants_qr_lookup`
- `branches_qr_lookup`

If `restaurants_qr_lookup` or `branches_qr_lookup` is missing, the scan page will resolve the table but render blank names. Fix before applying.

- [ ] **Step 7: Apply**

```powershell
npm run db:migrate
```

- [ ] **Step 8: Write the QR module**

Create `src/modules/table/qr.ts`:

```ts
import { randomBytes } from 'node:crypto'

import { env } from '@/lib/env'

/**
 * QR token generation and payload construction.
 *
 * The token is 24 bytes of CSPRNG output, base64url-encoded to 32 characters.
 * Sized as a compromise: long enough that guessing is hopeless, short enough
 * that the resulting QR stays low-density and scans reliably from a phone
 * held at arm's length across a table in poor light.
 */

const TOKEN_BYTES = 24

export function generateQrToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * The URL encoded into the printed QR.
 *
 * Deliberately short and containing no identifier: no restaurant id, no
 * branch id, no table id, no slug. Everything the server needs is the opaque
 * token, and everything a stranger can learn from the sticker is nothing.
 */
export function qrPayloadUrl(token: string): string {
  return new URL(`/t/${token}`, env.APP_URL).toString()
}

/**
 * Rejects anything that is not shaped like one of our tokens before it
 * reaches the database, so malformed scans cost no query.
 */
export function isWellFormedQrToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(token)
}
```

- [ ] **Step 9: Write the failing QR test**

Create `src/modules/table/qr.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { generateQrToken, isWellFormedQrToken, qrPayloadUrl } from './qr'

describe('QR token generation', () => {
  it('produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateQrToken))
    expect(tokens.size).toBe(1000)
  })

  it('produces 32 URL-safe characters', () => {
    // 24 bytes base64url-encoded. Long enough to be unguessable, short enough
    // to keep the printed QR low-density and easy to scan.
    const token = generateQrToken()
    expect(token).toHaveLength(32)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('accepts its own tokens as well-formed', () => {
    expect(isWellFormedQrToken(generateQrToken())).toBe(true)
  })

  it('rejects malformed tokens without touching the database', () => {
    expect(isWellFormedQrToken('')).toBe(false)
    expect(isWellFormedQrToken('short')).toBe(false)
    expect(isWellFormedQrToken('a'.repeat(33))).toBe(false)
    expect(isWellFormedQrToken('has spaces in it aaaaaaaaaaaaaaa')).toBe(false)
    expect(isWellFormedQrToken("'; drop table dining_tables;--")).toBe(false)
  })
})

describe('QR payload URL', () => {
  it('embeds only the token', () => {
    const token = generateQrToken()
    const url = qrPayloadUrl(token)

    expect(url).toBe(`http://localhost:3000/t/${token}`)
  })

  it('leaks no identifier', () => {
    // The spec requires that a QR never exposes restaurant or table ids. The
    // whole payload is one opaque token and a fixed path.
    const url = qrPayloadUrl(generateQrToken())
    expect(url).not.toMatch(/restaurant|branch|table|id=/i)
  })
})
```

- [ ] **Step 10: Run it**

```powershell
npx vitest run src/modules/table/qr.test.ts
```

Expected: PASS.

- [ ] **Step 11: Write the validation schema**

Create `src/modules/table/table.validation.ts`:

```ts
import { z } from 'zod'

export const tableCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .min(1, 'Table code is required')
      .max(10, 'Table code must be at most 10 characters')
      .regex(/^[A-Z0-9-]+$/, 'Use letters, digits and hyphens only'),
  )

export const createTableSchema = z.object({
  code: tableCodeSchema,
  name: z.string().trim().max(80).optional(),
  /** Two covers is the commonest table; 40 covers a large banquet round. */
  capacity: z.number().int().min(1, 'Capacity must be at least 1').max(40),
  floorId: z.uuid().nullable().optional(),
  positionX: z.number().int().min(0).max(10_000).nullable().optional(),
  positionY: z.number().int().min(0).max(10_000).nullable().optional(),
})

export const updateTableSchema = createTableSchema.partial().extend({
  status: z
    .enum(['available', 'occupied', 'reserved', 'out_of_service'])
    .optional(),
})

export type CreateTableInput = z.infer<typeof createTableSchema>
export type UpdateTableInput = z.infer<typeof updateTableSchema>
```

- [ ] **Step 12: Write the repository**

Create `src/modules/table/table.repository.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm'

import { withQrToken, withTenant, type Transaction } from '@/lib/db'
import { branches, diningTables, restaurants } from '@/lib/db/schema'
import { isWellFormedQrToken } from './qr'

export interface TableSummary {
  id: string
  branchId: string
  floorId: string | null
  code: string
  name: string | null
  capacity: number
  status: 'available' | 'occupied' | 'reserved' | 'out_of_service'
  qrToken: string
  positionX: number | null
  positionY: number | null
}

export interface ScannedTable {
  tableId: string
  tableCode: string
  tableName: string | null
  branchName: string
  restaurantName: string
}

const SUMMARY_COLUMNS = {
  id: diningTables.id,
  branchId: diningTables.branchId,
  floorId: diningTables.floorId,
  code: diningTables.code,
  name: diningTables.name,
  capacity: diningTables.capacity,
  status: diningTables.status,
  qrToken: diningTables.qrToken,
  positionX: diningTables.positionX,
  positionY: diningTables.positionY,
} as const

export async function listTables(
  restaurantId: string,
  userId: string,
  branchId: string,
): Promise<TableSummary[]> {
  return withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select(SUMMARY_COLUMNS)
      .from(diningTables)
      .where(
        and(
          eq(diningTables.restaurantId, restaurantId),
          eq(diningTables.branchId, branchId),
        ),
      )
      .orderBy(asc(diningTables.code)),
  )
}

export async function findTableIn(
  tx: Transaction,
  restaurantId: string,
  tableId: string,
): Promise<TableSummary | null> {
  const [row] = await tx
    .select(SUMMARY_COLUMNS)
    .from(diningTables)
    .where(
      and(
        eq(diningTables.id, tableId),
        eq(diningTables.restaurantId, restaurantId),
      ),
    )
    .limit(1)

  return row ?? null
}

/**
 * Resolves a scanned QR token to its table.
 *
 * Runs with no tenant and no actor. The only reason this returns anything is
 * the `*_qr_lookup` policies, each scoped to the single row bearing this
 * token — so a valid token yields one table and an invalid one yields
 * nothing. There is no query shape here that could list tables.
 */
export async function resolveTableByToken(
  token: string,
): Promise<ScannedTable | null> {
  // Cheap rejection before opening a transaction.
  if (!isWellFormedQrToken(token)) return null

  return withQrToken(token, async (tx) => {
    const [row] = await tx
      .select({
        tableId: diningTables.id,
        tableCode: diningTables.code,
        tableName: diningTables.name,
        branchName: branches.name,
        restaurantName: restaurants.name,
      })
      .from(diningTables)
      .innerJoin(branches, eq(branches.id, diningTables.branchId))
      .innerJoin(restaurants, eq(restaurants.id, diningTables.restaurantId))
      .where(eq(diningTables.qrToken, token))
      .limit(1)

    return row ?? null
  })
}
```

- [ ] **Step 13: Write the service**

Create `src/modules/table/table.service.ts`:

```ts
import { and, eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { diningTables } from '@/lib/db/schema'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import { findBranchIn } from '@/modules/branch/branch.repository'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import { findFloorIn } from '@/modules/floor/floor.repository'
import { generateQrToken } from './qr'
import {
  findTableIn,
  listTables,
  resolveTableByToken,
  type TableSummary,
} from './table.repository'
import type { CreateTableInput, UpdateTableInput } from './table.validation'

export { listTables, resolveTableByToken }
export type { TableSummary }

export async function createTable(
  ctx: BranchActorContext,
  branchId: string,
  input: CreateTableInput,
): Promise<{ id: string; qrToken: string }> {
  return withTenant(ctx, async (tx) => {
    const branch = await findBranchIn(tx, ctx.restaurantId, branchId)
    if (!branch) throw new NotFoundError('Branch not found.')

    if (input.floorId) {
      const floor = await findFloorIn(tx, ctx.restaurantId, input.floorId)
      // Also catches a floor that belongs to a *different branch* of the same
      // restaurant, which RLS would happily allow.
      if (!floor || floor.branchId !== branchId) {
        throw new NotFoundError('Floor not found in this branch.')
      }
    }

    const [clash] = await tx
      .select({ id: diningTables.id })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.branchId, branchId),
          eq(diningTables.code, input.code),
        ),
      )
      .limit(1)

    if (clash) {
      throw new ConflictError(
        `This branch already has a table "${input.code}".`,
      )
    }

    const qrToken = generateQrToken()

    const [created] = await tx
      .insert(diningTables)
      .values({
        restaurantId: ctx.restaurantId,
        branchId,
        floorId: input.floorId ?? null,
        code: input.code,
        name: input.name ?? null,
        capacity: input.capacity,
        qrToken,
        positionX: input.positionX ?? null,
        positionY: input.positionY ?? null,
      })
      .returning({ id: diningTables.id })

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.created',
      entityType: 'table',
      entityId: created.id,
      // No qrToken in the payload — the audit trail is undeletable, and a
      // capability that outlives its own rotation does not belong in it.
      after: { branchId, code: input.code, capacity: input.capacity },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { id: created.id, qrToken }
  })
}

export async function updateTable(
  ctx: BranchActorContext,
  tableId: string,
  input: UpdateTableInput,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findTableIn(tx, ctx.restaurantId, tableId)
    if (!existing) throw new NotFoundError('Table not found.')

    if (input.floorId) {
      const floor = await findFloorIn(tx, ctx.restaurantId, input.floorId)
      if (!floor || floor.branchId !== existing.branchId) {
        throw new NotFoundError('Floor not found in this branch.')
      }
    }

    if (input.code && input.code !== existing.code) {
      const [clash] = await tx
        .select({ id: diningTables.id })
        .from(diningTables)
        .where(
          and(
            eq(diningTables.branchId, existing.branchId),
            eq(diningTables.code, input.code),
          ),
        )
        .limit(1)

      if (clash) {
        throw new ConflictError(
          `This branch already has a table "${input.code}".`,
        )
      }
    }

    await tx
      .update(diningTables)
      .set({
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name || null } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.floorId !== undefined ? { floorId: input.floorId } : {}),
        ...(input.positionX !== undefined
          ? { positionX: input.positionX }
          : {}),
        ...(input.positionY !== undefined
          ? { positionY: input.positionY }
          : {}),
      })
      .where(
        and(
          eq(diningTables.id, tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.updated',
      entityType: 'table',
      entityId: tableId,
      before: { ...existing, qrToken: undefined },
      after: input,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

/**
 * Issues a new token, invalidating every printed sticker for this table.
 *
 * Separate from `updateTable` and behind its own permission because the
 * consequence is physical: someone has to walk the floor and replace a
 * sticker. It must never be a side effect of editing a capacity.
 */
export async function rotateTableQr(
  ctx: BranchActorContext,
  tableId: string,
): Promise<{ qrToken: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await findTableIn(tx, ctx.restaurantId, tableId)
    if (!existing) throw new NotFoundError('Table not found.')

    const qrToken = generateQrToken()

    await tx
      .update(diningTables)
      .set({ qrToken, qrRotatedAt: new Date() })
      .where(
        and(
          eq(diningTables.id, tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.qr_rotated',
      entityType: 'table',
      entityId: tableId,
      // Records that rotation happened, never which token. Both the old and
      // the new value stay out of an undeletable table.
      after: { code: existing.code, rotatedAt: new Date().toISOString() },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return { qrToken }
  })
}

export async function deleteTable(
  ctx: BranchActorContext,
  tableId: string,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await findTableIn(tx, ctx.restaurantId, tableId)
    if (!existing) throw new NotFoundError('Table not found.')

    await tx
      .delete(diningTables)
      .where(
        and(
          eq(diningTables.id, tableId),
          eq(diningTables.restaurantId, ctx.restaurantId),
        ),
      )

    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'table.deleted',
      entityType: 'table',
      entityId: tableId,
      before: { ...existing, qrToken: undefined },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}
```

- [ ] **Step 14: Write the QR isolation integration test**

This is the security test for the whole task. Create `tests/qr-isolation.integration.test.ts`:

```ts
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db, withTenant } from '@/lib/db'
import { branches, diningTables, restaurants, users } from '@/lib/db/schema'
import { provisionRestaurant } from '@/modules/tenancy/tenancy.service'
import { syncPermissionRegistry } from '@/modules/rbac/rbac.service'
import { createTable } from '@/modules/table/table.service'
import { resolveTableByToken } from '@/modules/table/table.repository'

/**
 * The public QR scan path is the only unauthenticated route that touches
 * tenant data. These tests exist to prove it cannot be turned into a way to
 * enumerate tables or reach a second restaurant.
 *
 *   npm run db:migrate && npm run db:seed
 *   $env:RUN_DB_TESTS=1; npm test
 */

const enabled = process.env.RUN_DB_TESTS === '1'

describe.skipIf(!enabled)('QR scan isolation', () => {
  let alphaId: string
  let betaId: string
  let alphaOwnerId: string
  let betaOwnerId: string
  let alphaToken: string
  let betaToken: string

  beforeAll(async () => {
    await syncPermissionRegistry()
    const suffix = randomUUID().slice(0, 8)

    const [alphaOwner] = await db
      .insert(users)
      .values({ email: `qr-alpha-${suffix}@test.local`, name: 'Alpha' })
      .returning({ id: users.id })
    const [betaOwner] = await db
      .insert(users)
      .values({ email: `qr-beta-${suffix}@test.local`, name: 'Beta' })
      .returning({ id: users.id })

    alphaOwnerId = alphaOwner.id
    betaOwnerId = betaOwner.id

    alphaId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, alphaOwnerId, `QR Alpha ${suffix}`),
      )
    ).restaurantId
    betaId = (
      await db.transaction((tx) =>
        provisionRestaurant(tx, betaOwnerId, `QR Beta ${suffix}`),
      )
    ).restaurantId

    const alphaBranch = await withTenant(
      { restaurantId: alphaId, userId: alphaOwnerId },
      (tx) =>
        tx
          .insert(branches)
          .values({ restaurantId: alphaId, name: 'Alpha Main', code: 'A1' })
          .returning({ id: branches.id }),
    )
    const betaBranch = await withTenant(
      { restaurantId: betaId, userId: betaOwnerId },
      (tx) =>
        tx
          .insert(branches)
          .values({ restaurantId: betaId, name: 'Beta Main', code: 'B1' })
          .returning({ id: branches.id }),
    )

    alphaToken = (
      await createTable(
        { restaurantId: alphaId, userId: alphaOwnerId },
        alphaBranch[0].id,
        { code: 'T1', capacity: 4 },
      )
    ).qrToken

    betaToken = (
      await createTable(
        { restaurantId: betaId, userId: betaOwnerId },
        betaBranch[0].id,
        { code: 'T1', capacity: 2 },
      )
    ).qrToken
  })

  afterAll(async () => {
    await withTenant({ restaurantId: alphaId, userId: alphaOwnerId }, (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, alphaId)),
    )
    await withTenant({ restaurantId: betaId, userId: betaOwnerId }, (tx) =>
      tx.delete(restaurants).where(eq(restaurants.id, betaId)),
    )
    await db.delete(users).where(eq(users.id, alphaOwnerId))
    await db.delete(users).where(eq(users.id, betaOwnerId))
  })

  it('resolves a valid token to its table', () => {
    return expect(resolveTableByToken(alphaToken)).resolves.toMatchObject({
      tableCode: 'T1',
      branchName: 'Alpha Main',
    })
  })

  it('reads the restaurant name through the QR lookup policies', async () => {
    // If restaurants_qr_lookup were missing, the inner join would match
    // nothing and this would be null rather than merely blank.
    const scanned = await resolveTableByToken(alphaToken)
    expect(scanned?.restaurantName).toContain('QR Alpha')
  })

  it('returns null for an unknown token', async () => {
    await expect(resolveTableByToken('z'.repeat(32))).resolves.toBeNull()
  })

  it('returns null for a malformed token without querying', async () => {
    await expect(resolveTableByToken('nope')).resolves.toBeNull()
    await expect(resolveTableByToken('')).resolves.toBeNull()
  })

  /**
   * The central claim. Holding one token must reveal one table — not a list,
   * and not a neighbour.
   */
  it('reveals exactly one table, never a list', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.qr_token', ${alphaToken}, true)`,
      )
      return tx.select().from(diningTables)
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].qrToken).toBe(alphaToken)
  })

  it('does not expose another restaurant’s table', async () => {
    const scanned = await resolveTableByToken(betaToken)
    expect(scanned?.restaurantName).not.toContain('QR Alpha')
  })

  it('exposes nothing when no QR token is set', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.qr_token', '', true)`)
      return tx.select().from(diningTables)
    })

    expect(rows).toHaveLength(0)
  })

  it('grants no write access through the QR context', async () => {
    // The QR policy is SELECT-only. An UPDATE finds no row to change.
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.qr_token', ${alphaToken}, true)`,
      )
      return tx
        .update(diningTables)
        .set({ capacity: 999 })
        .where(eq(diningTables.qrToken, alphaToken))
        .returning({ id: diningTables.id })
    })

    expect(result).toHaveLength(0)
  })

  it('invalidates the old token after rotation', async () => {
    const { rotateTableQr } = await import('@/modules/table/table.service')
    const scanned = await resolveTableByToken(alphaToken)
    expect(scanned).not.toBeNull()

    const { qrToken: rotated } = await rotateTableQr(
      { restaurantId: alphaId, userId: alphaOwnerId },
      scanned!.tableId,
    )

    await expect(resolveTableByToken(alphaToken)).resolves.toBeNull()
    await expect(resolveTableByToken(rotated)).resolves.not.toBeNull()

    alphaToken = rotated
  })
})
```

- [ ] **Step 15: Run the integration test**

```powershell
$env:RUN_DB_TESTS=1; npx vitest run tests/qr-isolation.integration.test.ts
```

Expected: 9 passed.

If "reveals exactly one table, never a list" fails with more than one row, the `dining_tables_qr_lookup` policy is wrong and the scan endpoint is an enumeration vector. Stop and fix it.

- [ ] **Step 16: Verify everything**

```powershell
npm run typecheck; npx eslint .; $env:RUN_DB_TESTS=1; npm test
```

Expected: 62+ tests passing.

- [ ] **Step 17: Commit**

```powershell
git add src/lib/db src/modules/table drizzle tests/qr-isolation.integration.test.ts
git commit -m "feat: dining tables schema and QR token engine with scan-scoped RLS"
```

---

## Task 6: Table management API and UI

**Files:**
- Create: `src/app/api/branches/[branchId]/tables/route.ts`
- Create: `src/app/api/tables/[tableId]/route.ts`
- Create: `src/app/(app)/tables/page.tsx`
- Create: `src/modules/table/ui/table-grid.tsx`
- Create: `src/modules/table/ui/table-form-dialog.tsx`
- Create: `src/modules/branch/ui/branch-switcher.tsx`

**Interfaces:**
- Consumes: everything Task 5 produced; `listFloors` from Task 4; `listBranches` from Task 2; `<AppSidebar />` from Task 3
- Produces: `POST /api/branches/[branchId]/tables`, `PATCH|DELETE /api/tables/[tableId]`; `/tables` page — extended by Task 7

- [ ] **Step 1: Create the collection route**

Create `src/app/api/branches/[branchId]/tables/route.ts`:

```ts
import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { assertBranchAccess, requirePermission } from '@/lib/auth/context'
import { createTable } from '@/modules/table/table.service'
import { createTableSchema } from '@/modules/table/table.validation'

interface RouteContext {
  params: Promise<{ branchId: string }>
}

export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.create')
    const { branchId } = await params
    assertBranchAccess(ctx, branchId)

    const input = createTableSchema.parse(await readJson(request))

    const table = await createTable(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      branchId,
      input,
    )

    return NextResponse.json(table, { status: 201 })
  },
)
```

- [ ] **Step 2: Create the item route**

Create `src/app/api/tables/[tableId]/route.ts`:

```ts
import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { deleteTable, updateTable } from '@/modules/table/table.service'
import { updateTableSchema } from '@/modules/table/table.validation'

interface RouteContext {
  params: Promise<{ tableId: string }>
}

export const PATCH = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.update')
    const { tableId } = await params
    const input = updateTableSchema.parse(await readJson(request))

    await updateTable(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tableId,
      input,
    )

    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.delete')
    const { tableId } = await params

    await deleteTable(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tableId,
    )

    return NextResponse.json({ ok: true })
  },
)
```

- [ ] **Step 3: Create the branch switcher**

Create `src/modules/branch/ui/branch-switcher.tsx`:

```tsx
'use client'

import { useRouter, useSearchParams } from 'next/navigation'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Selects which branch the tables page is showing.
 *
 * Kept in the URL rather than component state so the view survives a refresh
 * and can be linked — a manager sending "look at Bangsar's layout" should be
 * able to paste a URL.
 */
export function BranchSwitcher({
  branches,
  value,
}: {
  branches: { id: string; name: string }[]
  value: string
}) {
  const router = useRouter()
  const params = useSearchParams()

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const query = new URLSearchParams(params.toString())
        query.set('branch', next)
        router.push(`?${query.toString()}`)
      }}
    >
      <SelectTrigger className="w-[220px]" aria-label="Branch">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {branches.map((branch) => (
          <SelectItem key={branch.id} value={branch.id}>
            {branch.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

- [ ] **Step 4: Create the table form dialog**

Create `src/modules/table/ui/table-form-dialog.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiClientError, postJson } from '@/lib/client/api'

export interface TableFormValues {
  id?: string
  code: string
  name?: string | null
  capacity: number
  floorId?: string | null
}

const NO_FLOOR = '__none__'

export function TableFormDialog({
  trigger,
  branchId,
  floors,
  table,
}: {
  trigger: React.ReactNode
  branchId: string
  floors: { id: string; name: string }[]
  table?: TableFormValues
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [floorId, setFloorId] = useState(table?.floorId ?? NO_FLOOR)

  const editing = Boolean(table?.id)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const body = {
      code: form.get('code'),
      name: form.get('name') || undefined,
      capacity: Number(form.get('capacity')),
      floorId: floorId === NO_FLOOR ? null : floorId,
    }

    try {
      if (editing) {
        const response = await fetch(`/api/tables/${table!.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          throw new ApiClientError(
            payload?.error?.message ?? 'Could not save the table.',
            payload?.error?.code,
          )
        }
      } else {
        await postJson(`/api/branches/${branchId}/tables`, body)
      }

      toast.success(editing ? 'Table updated' : 'Table created')
      setOpen(false)
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit table' : 'New table'}</DialogTitle>
            <DialogDescription>
              A QR code is generated automatically when the table is created.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="code">Table code</Label>
                <Input
                  id="code"
                  name="code"
                  required
                  maxLength={10}
                  defaultValue={table?.code}
                  placeholder="T12"
                  className="font-mono uppercase"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="capacity">Seats</Label>
                <Input
                  id="capacity"
                  name="capacity"
                  type="number"
                  required
                  min={1}
                  max={40}
                  defaultValue={table?.capacity ?? 2}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Name (optional)</Label>
              <Input
                id="name"
                name="name"
                maxLength={80}
                defaultValue={table?.name ?? ''}
                placeholder="Window booth"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="floor">Floor</Label>
              <Select value={floorId} onValueChange={setFloorId}>
                <SelectTrigger id="floor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FLOOR}>Unassigned</SelectItem>
                  {floors.map((floor) => (
                    <SelectItem key={floor.id} value={floor.id}>
                      {floor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create table'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 5: Create the table grid**

Create `src/modules/table/ui/table-grid.tsx`:

```tsx
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { TableSummary } from '@/modules/table/table.repository'
import { TableFormDialog } from './table-form-dialog'

const STATUS_VARIANT = {
  available: 'secondary',
  occupied: 'default',
  reserved: 'outline',
  out_of_service: 'destructive',
} as const

/**
 * A grid rather than a drag-and-drop floor plan.
 *
 * `positionX`/`positionY` exist in the schema, so a spatial layout can be
 * built later without a migration. Shipping the grid first means tables are
 * usable in Phase 1 instead of waiting on a layout editor nobody can use
 * until there are tables to arrange.
 */
export function TableGrid({
  tables,
  floors,
  branchId,
  canEdit,
}: {
  tables: TableSummary[]
  floors: { id: string; name: string }[]
  branchId: string
  canEdit: boolean
}) {
  if (tables.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          No tables in this branch yet.
        </p>
      </div>
    )
  }

  const floorName = new Map(floors.map((f) => [f.id, f.name]))

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tables.map((table) => (
        <Card key={table.id}>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-lg font-semibold">
                  {table.code}
                </div>
                {table.name && (
                  <div className="truncate text-xs text-muted-foreground">
                    {table.name}
                  </div>
                )}
              </div>
              <Badge variant={STATUS_VARIANT[table.status]}>
                {table.status.replace(/_/g, ' ')}
              </Badge>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {table.capacity} seat{table.capacity === 1 ? '' : 's'}
              </span>
              <span>
                {table.floorId
                  ? (floorName.get(table.floorId) ?? 'Unknown floor')
                  : 'Unassigned'}
              </span>
            </div>

            {canEdit && (
              <TableFormDialog
                branchId={branchId}
                floors={floors}
                table={table}
                trigger={
                  <Button variant="outline" size="sm" className="w-full">
                    Edit
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Create the page**

Create `src/app/(app)/tables/page.tsx`:

```tsx
import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { requirePermission } from '@/lib/auth/context'
import { listBranches } from '@/modules/branch/branch.service'
import { BranchSwitcher } from '@/modules/branch/ui/branch-switcher'
import { listFloors } from '@/modules/floor/floor.service'
import { listTables } from '@/modules/table/table.service'
import { TableFormDialog } from '@/modules/table/ui/table-form-dialog'
import { TableGrid } from '@/modules/table/ui/table-grid'

export const metadata: Metadata = { title: 'Tables' }

export default async function TablesPage({
  searchParams,
}: PageProps<'/tables'>) {
  const ctx = await requirePermission('table.view')

  const branches = await listBranches(ctx.tenant.restaurantId, ctx.user.id)

  if (branches.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Create a branch before adding tables.
        </p>
      </div>
    )
  }

  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null

  // Falls back to the first branch when the query names one this member
  // cannot see, rather than erroring.
  const branch = branches.find((b) => b.id === requested) ?? branches[0]

  const [floors, tables] = await Promise.all([
    listFloors(ctx.tenant.restaurantId, ctx.user.id, branch.id),
    listTables(ctx.tenant.restaurantId, ctx.user.id, branch.id),
  ])

  const canCreate = ctx.tenant.permissions.has('table.create')
  const canEdit = ctx.tenant.permissions.has('table.update')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tables</h1>
          <p className="text-sm text-muted-foreground">
            {tables.length} table{tables.length === 1 ? '' : 's'} in{' '}
            {branch.name}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <BranchSwitcher branches={branches} value={branch.id} />
          {canCreate && (
            <TableFormDialog
              branchId={branch.id}
              floors={floors}
              trigger={<Button>New table</Button>}
            />
          )}
        </div>
      </div>

      <TableGrid
        tables={tables}
        floors={floors}
        branchId={branch.id}
        canEdit={canEdit}
      />
    </div>
  )
}
```

- [ ] **Step 7: Verify and exercise**

```powershell
npm run typecheck; npx eslint .; npm run build
npm run dev
```

Open `/tables`. Create tables `T1`, `T2`, `T3`. Confirm a duplicate code within the same branch shows "This branch already has a table T1." Switch branches and confirm the same code is accepted there — table codes are unique per branch, not per restaurant.

- [ ] **Step 8: Commit**

```powershell
git add src/app/api/tables src/app/api/branches src/app/'(app)'/tables src/modules/table/ui src/modules/branch/ui/branch-switcher.tsx
git commit -m "feat: table management API and grid UI"
```

---

## Task 7: QR display, rotation and the public scan page

**Files:**
- Create: `src/app/api/tables/[tableId]/qr/route.ts`
- Create: `src/modules/table/ui/qr-dialog.tsx`
- Create: `src/app/t/[token]/page.tsx`
- Modify: `src/modules/table/ui/table-grid.tsx`
- Modify: `src/proxy.ts`

**Interfaces:**
- Consumes: `rotateTableQr`, `resolveTableByToken` from Task 5; `qrPayloadUrl` from Task 5; `<TableGrid />` from Task 6
- Produces: `POST /api/tables/[tableId]/qr`; public route `/t/[token]` — extended into the join flow in Phase 4

- [ ] **Step 1: Install a QR renderer**

```powershell
npm install qrcode
npm install -D @types/qrcode
```

`qrcode` renders to an SVG string server-side, so the QR is part of the HTML rather than something the browser has to fetch or generate — which also means it prints correctly from the browser's print dialog.

- [ ] **Step 2: Create the rotation route**

Create `src/app/api/tables/[tableId]/qr/route.ts`:

```ts
import { NextResponse } from 'next/server'

import { assertSameOrigin, getRequestMetadata, withRoute } from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { rotateTableQr } from '@/modules/table/table.service'
import { qrPayloadUrl } from '@/modules/table/qr'

interface RouteContext {
  params: Promise<{ tableId: string }>
}

/**
 * Rotation only. There is no GET here that returns the current token: the
 * table list already carries it for members who may see it, and a dedicated
 * read endpoint would be one more surface guarding a value that identifies a
 * physical table.
 */
export const POST = withRoute(
  async (request: Request, { params }: RouteContext) => {
    assertSameOrigin(request)

    const ctx = await requirePermission('table.rotate_qr')
    const { tableId } = await params

    const { qrToken } = await rotateTableQr(
      {
        restaurantId: ctx.tenant.restaurantId,
        userId: ctx.user.id,
        ...getRequestMetadata(request),
      },
      tableId,
    )

    return NextResponse.json({ qrToken, url: qrPayloadUrl(qrToken) })
  },
)
```

- [ ] **Step 3: Create the QR dialog**

Create `src/modules/table/ui/qr-dialog.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ApiClientError, postJson } from '@/lib/client/api'

export function QrDialog({
  trigger,
  tableId,
  tableCode,
  svg,
  url,
  canRotate,
}: {
  trigger: React.ReactNode
  tableId: string
  tableCode: string
  /** Pre-rendered server-side so printing works without a client library. */
  svg: string
  url: string
  canRotate: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

  async function rotate() {
    setPending(true)
    try {
      await postJson(`/api/tables/${tableId}/qr`, {})
      toast.success('New QR issued — reprint and replace the old sticker')
      setConfirming(false)
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not rotate the QR code.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>QR code for {tableCode}</DialogTitle>
          <DialogDescription>
            Print this and place it on the table. Diners scan it to open the
            menu and order.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div
            className="mx-auto w-48 rounded-lg bg-white p-3 [&>svg]:h-auto [&>svg]:w-full"
            // Rendered by the `qrcode` library from our own token, server-side.
            // No user-supplied content reaches this markup.
            dangerouslySetInnerHTML={{ __html: svg }}
          />

          <p className="break-all text-center font-mono text-xs text-muted-foreground">
            {url}
          </p>

          {confirming && (
            <Alert variant="destructive">
              <AlertDescription>
                Issuing a new QR code invalidates the sticker currently on this
                table. Anyone scanning the old one will see nothing until you
                replace it.
              </AlertDescription>
            </Alert>
          )}
        </div>

        {canRotate && (
          <DialogFooter>
            {confirming ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={rotate}
                  disabled={pending}
                >
                  {pending ? 'Issuing…' : 'Yes, issue a new QR'}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setConfirming(true)}>
                Issue new QR code
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Render the QR in the grid**

In `src/modules/table/ui/table-grid.tsx`, add to the imports:

```tsx
import QRCode from 'qrcode'

import { qrPayloadUrl } from '@/modules/table/qr'
import { QrDialog } from './qr-dialog'
```

Change the component signature to async and add `canRotate`:

```tsx
export async function TableGrid({
  tables,
  floors,
  branchId,
  canEdit,
  canRotate,
}: {
  tables: TableSummary[]
  floors: { id: string; name: string }[]
  branchId: string
  canEdit: boolean
  canRotate: boolean
}) {
```

Immediately after the `floorName` map, add:

```tsx
  // Rendered on the server so the SVG is in the HTML — it prints correctly
  // and needs no client-side library.
  const qrByTable = new Map(
    await Promise.all(
      tables.map(
        async (table) =>
          [
            table.id,
            {
              svg: await QRCode.toString(qrPayloadUrl(table.qrToken), {
                type: 'svg',
                margin: 1,
                errorCorrectionLevel: 'M',
              }),
              url: qrPayloadUrl(table.qrToken),
            },
          ] as const,
      ),
    ),
  )
```

Then replace the `{canEdit && (...)}` block at the bottom of the card with:

```tsx
            <div className="flex gap-2">
              <QrDialog
                tableId={table.id}
                tableCode={table.code}
                svg={qrByTable.get(table.id)!.svg}
                url={qrByTable.get(table.id)!.url}
                canRotate={canRotate}
                trigger={
                  <Button variant="outline" size="sm" className="flex-1">
                    QR
                  </Button>
                }
              />

              {canEdit && (
                <TableFormDialog
                  branchId={branchId}
                  floors={floors}
                  table={table}
                  trigger={
                    <Button variant="outline" size="sm" className="flex-1">
                      Edit
                    </Button>
                  }
                />
              )}
            </div>
```

- [ ] **Step 5: Pass canRotate from the page**

In `src/app/(app)/tables/page.tsx`, add after `canEdit`:

```tsx
  const canRotate = ctx.tenant.permissions.has('table.rotate_qr')
```

And add the prop to `<TableGrid ... canRotate={canRotate} />`.

- [ ] **Step 6: Create the public scan page**

Create `src/app/t/[token]/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { resolveTableByToken } from '@/modules/table/table.service'

export const metadata: Metadata = { title: 'Table' }

/**
 * The public QR landing page. No authentication, no session, no tenant.
 *
 * `resolveTableByToken` runs under `withQrToken`, where the only policies
 * that match are the three scoped to this exact token — so this page can
 * render one table and has no query shape capable of reaching a second.
 *
 * Phase 1 confirms the token resolves. Phase 4 turns this into the join flow:
 * the diner enters a name, a Dining Session member is created, and a
 * short-lived session token is issued. That short-lived token is the
 * "time-limited" credential the spec asks for; this printed one only names
 * the table.
 */
export default async function ScanPage({ params }: PageProps<'/t/[token]'>) {
  const { token } = await params
  const table = await resolveTableByToken(token)

  // 404 for unknown, expired and malformed alike. Distinguishing them would
  // tell someone probing tokens whether they had found a real one.
  if (!table) notFound()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardDescription>{table.restaurantName}</CardDescription>
          <CardTitle className="text-2xl">
            {table.tableName ?? `Table ${table.tableCode}`}
          </CardTitle>
          <CardDescription>{table.branchName}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Ordering opens here soon. Please ask a member of staff in the
            meantime.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 7: Let the scan route through the proxy**

`/t/[token]` is public. The proxy currently redirects nothing at that path, but make the exemption explicit so a later edit to `PROTECTED_PREFIXES` cannot accidentally capture it.

In `src/proxy.ts`, add at the top of the `proxy` function, immediately after `const { pathname } = request.nextUrl`:

```ts
  // Public QR scan. Deliberately reachable with no session — a diner
  // scanning a table has no account and needs none.
  if (pathname.startsWith('/t/')) return NextResponse.next()
```

- [ ] **Step 8: Verify end to end**

```powershell
npm run typecheck; npx eslint .; npm run build
npm run dev
```

Then:
1. Open `/tables`, click **QR** on a table. Confirm a QR renders and the URL beneath contains no restaurant, branch, or table id — only `/t/<32 chars>`.
2. Copy the URL into a private browsing window (no session). Confirm the table page renders with the correct restaurant, branch and table.
3. Change one character of the token. Confirm a 404, not an error page.
4. Back in the app, click **Issue new QR code** and confirm. Reload the private window on the old URL — expect a 404. The new URL works.

- [ ] **Step 9: Run the full suite**

```powershell
$env:RUN_DB_TESTS=1; npm test
```

Expected: all passing, including "invalidates the old token after rotation".

- [ ] **Step 10: Commit**

```powershell
git add src/app/api/tables src/app/t src/modules/table/ui src/app/'(app)'/tables/page.tsx src/proxy.ts package.json package-lock.json
git commit -m "feat: QR display, rotation and public scan page"
```

---

## Task 8: Settings centre — profile, tax and service charge

The spec's Settings Centre lists ~19 categories. Most configure subsystems that do not exist yet (receipt templates, printer routing, payment gateways, loyalty rules), and a settings screen for a subsystem with no behaviour is a form that saves values nothing reads. This task ships the settings that have something to configure today; the rest arrive with their phases.

**Files:**
- Modify: `src/lib/db/schema/tenancy.ts`
- Create: `src/modules/settings/settings.validation.ts`
- Create: `src/modules/settings/settings.service.ts`
- Create: `src/app/api/settings/route.ts`
- Create: `src/app/(app)/settings/page.tsx`
- Create: `src/modules/settings/ui/settings-form.tsx`
- Test: `src/modules/settings/settings.validation.test.ts`

**Interfaces:**
- Consumes: `restaurants` from `@/lib/db/schema`; `requirePermission`; `recordAuditIn`
- Produces:
  - Columns `taxRateBasisPoints`, `serviceChargeBasisPoints`, `taxInclusive` on `restaurants`
  - `updateSettingsSchema`, `UpdateSettingsInput`
  - `percentToBasisPoints(percent: number): number`, `basisPointsToPercent(bp: number): number`
  - `getSettings(restaurantId, userId): Promise<RestaurantSettings>`
  - `updateSettings(ctx, input): Promise<void>`
  - `interface RestaurantSettings { name, currency, timezone, locale, taxRateBasisPoints, serviceChargeBasisPoints, taxInclusive }`

- [ ] **Step 1: Add the columns**

In `src/lib/db/schema/tenancy.ts`, add `integer` and `boolean` to the `drizzle-orm/pg-core` import, then add these columns to `restaurants` immediately after `locale`:

```ts
    /**
     * Tax and service charge as integer basis points: 600 = 6.00%.
     *
     * Not a float and not `numeric`. A 6% tax on a RM 23.45 bill computed in
     * floating point produces a figure that is off by a cent often enough to
     * make a day's takings fail to reconcile — and reconciliation failures
     * are how a restaurant loses trust in a POS. Integers throughout, with
     * rounding decided explicitly at the point of calculation in Phase 6.
     */
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull().default(0),
    serviceChargeBasisPoints: integer('service_charge_basis_points')
      .notNull()
      .default(0),

    /**
     * True when menu prices already include tax, as is normal in Malaysia.
     * Changes whether tax is added to the subtotal or extracted from it, so
     * it must be explicit rather than assumed.
     */
    taxInclusive: boolean('tax_inclusive').notNull().default(false),
```

- [ ] **Step 2: Generate and inspect the migration**

```powershell
npm run db:generate
Select-String -Path drizzle/0003_*.sql -Pattern "ADD COLUMN"
```

Expected three `ALTER TABLE "restaurants" ADD COLUMN` lines. Confirm each has `NOT NULL DEFAULT` — adding a NOT NULL column without a default to a table with rows fails.

- [ ] **Step 3: Apply**

```powershell
npm run db:migrate
```

- [ ] **Step 4: Write the validation and conversion**

Create `src/modules/settings/settings.validation.ts`:

```ts
import { z } from 'zod'

/**
 * People think in percent; the database stores basis points. Converting at
 * the edge keeps every internal calculation on integers.
 */
export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100)
}

export function basisPointsToPercent(basisPoints: number): number {
  return basisPoints / 100
}

/**
 * Accepts a percentage from the form and converts it.
 *
 * Capped at 100%: a tax rate above that is always a typo (entering 600 while
 * thinking in basis points), and silently accepting it would put a bill ten
 * times too large in front of a customer.
 */
const percentageSchema = z
  .number()
  .min(0, 'Cannot be negative')
  .max(100, 'Cannot exceed 100%')
  .transform(percentToBasisPoints)

export const updateSettingsSchema = z.object({
  name: z.string().trim().min(1, 'Restaurant name is required').max(120),
  /** ISO 4217, three uppercase letters. */
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code')),
  /** IANA zone, validated against the runtime's own database. */
  timezone: z.string().trim().min(1).max(64),
  locale: z.string().trim().min(2).max(10),
  taxRatePercent: percentageSchema,
  serviceChargePercent: percentageSchema,
  taxInclusive: z.boolean(),
})

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>
```

- [ ] **Step 5: Write the failing test**

Create `src/modules/settings/settings.validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  basisPointsToPercent,
  percentToBasisPoints,
  updateSettingsSchema,
} from './settings.validation'

describe('percent / basis point conversion', () => {
  it('converts whole percentages', () => {
    expect(percentToBasisPoints(6)).toBe(600)
    expect(percentToBasisPoints(10)).toBe(1000)
    expect(percentToBasisPoints(0)).toBe(0)
  })

  it('converts fractional percentages exactly', () => {
    // 8.25% is a real rate. It must not land on 824 or 826.
    expect(percentToBasisPoints(8.25)).toBe(825)
    expect(percentToBasisPoints(0.5)).toBe(50)
  })

  it('round-trips', () => {
    for (const percent of [0, 0.5, 6, 8.25, 10, 100]) {
      expect(basisPointsToPercent(percentToBasisPoints(percent))).toBe(percent)
    }
  })

  it('rounds rather than truncating', () => {
    // 6.005% cannot be represented; rounding up loses less than truncating.
    expect(percentToBasisPoints(6.005)).toBe(601)
  })
})

const VALID = {
  name: 'Kopi Corner',
  currency: 'myr',
  timezone: 'Asia/Kuala_Lumpur',
  locale: 'en',
  taxRatePercent: 6,
  serviceChargePercent: 10,
  taxInclusive: true,
}

describe('updateSettingsSchema', () => {
  it('uppercases the currency and converts the rates', () => {
    const result = updateSettingsSchema.parse(VALID)

    expect(result.currency).toBe('MYR')
    expect(result.taxRatePercent).toBe(600)
    expect(result.serviceChargePercent).toBe(1000)
  })

  it('rejects a malformed currency code', () => {
    expect(
      updateSettingsSchema.safeParse({ ...VALID, currency: 'RINGGIT' }).success,
    ).toBe(false)
  })

  it('rejects a rate above 100%', () => {
    // Guards the commonest typo: entering 600 while thinking in basis points.
    expect(
      updateSettingsSchema.safeParse({ ...VALID, taxRatePercent: 600 }).success,
    ).toBe(false)
  })

  it('rejects a negative rate', () => {
    expect(
      updateSettingsSchema.safeParse({ ...VALID, taxRatePercent: -1 }).success,
    ).toBe(false)
  })

  it('accepts zero for both rates', () => {
    expect(
      updateSettingsSchema.safeParse({
        ...VALID,
        taxRatePercent: 0,
        serviceChargePercent: 0,
      }).success,
    ).toBe(true)
  })
})
```

- [ ] **Step 6: Run it**

```powershell
npx vitest run src/modules/settings/settings.validation.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 7: Write the service**

Create `src/modules/settings/settings.service.ts`:

```ts
import { eq } from 'drizzle-orm'

import { withTenant } from '@/lib/db'
import { restaurants } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { recordAuditIn } from '@/modules/audit/audit.service'
import type { BranchActorContext } from '@/modules/branch/branch.service'
import type { UpdateSettingsInput } from './settings.validation'

export interface RestaurantSettings {
  name: string
  currency: string
  timezone: string
  locale: string
  taxRateBasisPoints: number
  serviceChargeBasisPoints: number
  taxInclusive: boolean
}

export async function getSettings(
  restaurantId: string,
  userId: string,
): Promise<RestaurantSettings> {
  const [row] = await withTenant({ restaurantId, userId }, (tx) =>
    tx
      .select({
        name: restaurants.name,
        currency: restaurants.currency,
        timezone: restaurants.timezone,
        locale: restaurants.locale,
        taxRateBasisPoints: restaurants.taxRateBasisPoints,
        serviceChargeBasisPoints: restaurants.serviceChargeBasisPoints,
        taxInclusive: restaurants.taxInclusive,
      })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1),
  )

  if (!row) throw new NotFoundError('Restaurant not found.')
  return row
}

/**
 * Confirms a timezone against the runtime's own IANA database rather than a
 * hand-maintained list, which would drift as zones are added and renamed.
 * An invalid zone would break every date shown on a receipt.
 */
function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
  } catch {
    throw new ValidationError('That is not a recognised time zone.', {
      timezone: ['Use an IANA zone such as Asia/Kuala_Lumpur'],
    })
  }
}

export async function updateSettings(
  ctx: BranchActorContext,
  input: UpdateSettingsInput,
): Promise<void> {
  assertValidTimezone(input.timezone)

  await withTenant(ctx, async (tx) => {
    const before = await getSettingsIn(tx, ctx.restaurantId)

    await tx
      .update(restaurants)
      .set({
        name: input.name,
        currency: input.currency,
        timezone: input.timezone,
        locale: input.locale,
        taxRateBasisPoints: input.taxRatePercent,
        serviceChargeBasisPoints: input.serviceChargePercent,
        taxInclusive: input.taxInclusive,
      })
      .where(eq(restaurants.id, ctx.restaurantId))

    /**
     * Tax and service charge changes are money changes. They appear on every
     * bill until changed again, so "who set this rate, and when" is a
     * question an accountant will eventually ask.
     */
    await recordAuditIn(tx, {
      restaurantId: ctx.restaurantId,
      actorUserId: ctx.userId,
      action: 'settings.updated',
      entityType: 'restaurant',
      entityId: ctx.restaurantId,
      before,
      after: {
        name: input.name,
        currency: input.currency,
        timezone: input.timezone,
        locale: input.locale,
        taxRateBasisPoints: input.taxRatePercent,
        serviceChargeBasisPoints: input.serviceChargePercent,
        taxInclusive: input.taxInclusive,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  })
}

async function getSettingsIn(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  restaurantId: string,
): Promise<RestaurantSettings | null> {
  const [row] = await tx
    .select({
      name: restaurants.name,
      currency: restaurants.currency,
      timezone: restaurants.timezone,
      locale: restaurants.locale,
      taxRateBasisPoints: restaurants.taxRateBasisPoints,
      serviceChargeBasisPoints: restaurants.serviceChargeBasisPoints,
      taxInclusive: restaurants.taxInclusive,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)

  return row ?? null
}
```

- [ ] **Step 8: Create the route handler**

Create `src/app/api/settings/route.ts`:

```ts
import { NextResponse } from 'next/server'

import {
  assertSameOrigin,
  getRequestMetadata,
  readJson,
  withRoute,
} from '@/lib/api'
import { requirePermission } from '@/lib/auth/context'
import { updateSettings } from '@/modules/settings/settings.service'
import { updateSettingsSchema } from '@/modules/settings/settings.validation'

export const PATCH = withRoute(async (request: Request) => {
  assertSameOrigin(request)

  const ctx = await requirePermission('settings.update')
  const input = updateSettingsSchema.parse(await readJson(request))

  await updateSettings(
    {
      restaurantId: ctx.tenant.restaurantId,
      userId: ctx.user.id,
      ...getRequestMetadata(request),
    },
    input,
  )

  return NextResponse.json({ ok: true })
})
```

- [ ] **Step 9: Create the settings form**

Create `src/modules/settings/ui/settings-form.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiClientError } from '@/lib/client/api'
import type { RestaurantSettings } from '@/modules/settings/settings.service'
import { basisPointsToPercent } from '@/modules/settings/settings.validation'

export function SettingsForm({
  settings,
  readOnly,
}: {
  settings: RestaurantSettings
  readOnly: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [taxInclusive, setTaxInclusive] = useState(settings.taxInclusive)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: form.get('name'),
          currency: form.get('currency'),
          timezone: form.get('timezone'),
          locale: form.get('locale'),
          taxRatePercent: Number(form.get('taxRatePercent')),
          serviceChargePercent: Number(form.get('serviceChargePercent')),
          taxInclusive,
        }),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new ApiClientError(
          payload?.error?.message ?? 'Could not save settings.',
          payload?.error?.code,
          payload?.error?.details,
        )
      }

      toast.success('Settings saved')
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-8">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-4">
        <h2 className="text-sm font-medium">Restaurant</h2>

        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            required
            maxLength={120}
            defaultValue={settings.name}
            disabled={readOnly}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <Input
              id="currency"
              name="currency"
              required
              maxLength={3}
              defaultValue={settings.currency}
              disabled={readOnly}
              className="font-mono uppercase"
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="timezone">Time zone</Label>
            <Input
              id="timezone"
              name="timezone"
              required
              maxLength={64}
              defaultValue={settings.timezone}
              disabled={readOnly}
              placeholder="Asia/Kuala_Lumpur"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="locale">Language</Label>
          <Input
            id="locale"
            name="locale"
            required
            maxLength={10}
            defaultValue={settings.locale}
            disabled={readOnly}
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Tax and service charge</h2>
          <p className="text-xs text-muted-foreground">
            Applied to every bill. Changes are recorded in the audit trail.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="taxRatePercent">Tax rate (%)</Label>
            <Input
              id="taxRatePercent"
              name="taxRatePercent"
              type="number"
              required
              min={0}
              max={100}
              step={0.01}
              defaultValue={basisPointsToPercent(settings.taxRateBasisPoints)}
              disabled={readOnly}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="serviceChargePercent">Service charge (%)</Label>
            <Input
              id="serviceChargePercent"
              name="serviceChargePercent"
              type="number"
              required
              min={0}
              max={100}
              step={0.01}
              defaultValue={basisPointsToPercent(
                settings.serviceChargeBasisPoints,
              )}
              disabled={readOnly}
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5 pr-4">
            <Label htmlFor="taxInclusive">Menu prices include tax</Label>
            <p className="text-xs text-muted-foreground">
              On: tax is extracted from the price shown. Off: tax is added at
              checkout.
            </p>
          </div>
          <Switch
            id="taxInclusive"
            checked={taxInclusive}
            onCheckedChange={setTaxInclusive}
            disabled={readOnly}
          />
        </div>
      </section>

      {!readOnly && (
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
      )}
    </form>
  )
}
```

- [ ] **Step 10: Create the page**

Create `src/app/(app)/settings/page.tsx`:

```tsx
import type { Metadata } from 'next'

import { requirePermission } from '@/lib/auth/context'
import { getSettings } from '@/modules/settings/settings.service'
import { SettingsForm } from '@/modules/settings/ui/settings-form'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const ctx = await requirePermission('settings.view')

  const settings = await getSettings(ctx.tenant.restaurantId, ctx.user.id)
  // Viewing and editing are separate permissions; a manager may read the tax
  // rate without being able to change it.
  const readOnly = !ctx.tenant.permissions.has('settings.update')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          {readOnly
            ? 'You can view these settings but not change them.'
            : 'Applies across every branch of this restaurant.'}
        </p>
      </div>

      <SettingsForm settings={settings} readOnly={readOnly} />
    </div>
  )
}
```

- [ ] **Step 11: Verify end to end**

```powershell
npm run typecheck; npx eslint .; npm run build
$env:RUN_DB_TESTS=1; npm test
npm run dev
```

Open `/settings`. Set tax to `6` and service charge to `10`. Save. Verify in DBeaver:

```sql
SELECT tax_rate_basis_points, service_charge_basis_points FROM restaurants;
```

Expected: `600` and `1000` — percentages converted to basis points, stored as integers.

Then enter `600` in the tax field and confirm the form rejects it with "Cannot exceed 100%" rather than storing a 600% tax rate.

- [ ] **Step 12: Update the documentation**

Create `docs/phase-1/README.md` following the structure of `docs/phase-0/README.md`, covering the same ten artifacts. Record:

- The QR two-token design and why a printed token cannot be time-limited
- Why the table token is stored in plaintext while session tokens are hashed
- The three `*_qr_lookup` policies and why they must be added as a set
- Basis points for rates, minor units for money
- Which Settings Centre categories were deferred, and to which phase

Update `docs/ROADMAP.md` to mark Phase 1 complete.

- [ ] **Step 13: Commit**

```powershell
git add src/lib/db/schema/tenancy.ts drizzle src/modules/settings src/app/api/settings src/app/'(app)'/settings docs
git commit -m "feat: settings centre with tax and service charge in basis points"
```

---

## Self-Review

**1. Spec coverage.** The roadmap scopes Phase 1 as "Branches, floors, tables, QR token engine, settings centre."

| Roadmap item | Task |
| --- | --- |
| Branches | 2, 3 |
| Floors | 4 |
| Tables | 5, 6 |
| QR token engine | 5, 7 |
| Settings centre | 8 |

From the master spec's "Restaurant Structure" section: QR code ✅ (Tasks 5, 7), capacity ✅ (Task 5), status ✅ (Task 5), active dining session — Phase 4, correctly deferred since `dining_sessions` does not exist.

From "Security Requirements": secure QR tokens ✅ (Task 5 — random, opaque, rotatable, scan-scoped RLS), authorisation on every protected API ✅ (every route opens with `requirePermission`), audit logging ✅ (every mutating service writes an entry), never trust frontend input ✅ (all input zod-parsed server-side).

**Gap found and closed:** the spec requires QR tokens be "time-limited", which a printed sticker cannot be. Rather than silently dropping the requirement, Task 5 documents the two-token split — the printed token names a table and carries no authority; the time-limited credential is the dining-session token issued on scan in Phase 4.

**Deliberate deferral, stated rather than hidden:** the spec's Settings Centre lists 19 categories. Task 8 ships 3 (restaurant profile, tax/service charge, and the existing role management from Phase 0). The other 16 configure subsystems that do not exist yet; Task 8 Step 12 records which and where they land.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the actual code. Every test step carries the actual test. Every command is runnable PowerShell.

**3. Type consistency.** Checked across tasks:

- `BranchActorContext` is defined once in Task 2 and reused by Tasks 4, 5 and 8 — imported from `@/modules/branch/branch.service` in each.
- `findBranchIn(tx, restaurantId, branchId)` — defined Task 2, called Tasks 4 and 5 with matching arity.
- `findFloorIn(tx, restaurantId, floorId)` returns `FloorSummary` carrying `branchId`, which Task 5 relies on for the cross-branch floor check.
- `TableSummary.qrToken` is produced by Task 5's repository and consumed by Task 7's grid rendering.
- `currentQrToken()` — defined Task 5 Step 1 in `_shared.ts`, used in Steps 2 and 3 across two schema files; both import it.
- `AppShell` gains `navItems` in Task 3 Step 5, and Task 3 Step 6 updates the only call site.
- `TableGrid` gains `canRotate` in Task 7 Step 4, and Step 5 updates its only call site.

One inconsistency found and fixed while reviewing: Task 5's `diningTables` originally declared `qrRotatedAt` as a bare timestamp while `TableSummary` omitted it; the column now reuses `timestamps.createdAt`'s definition and stays out of the summary type, since nothing reads it yet.

---

## Verification Gate

Phase 1 is complete when all of these pass:

```powershell
npm run typecheck                 # clean
npx eslint .                      # clean
npm run build                     # succeeds
npm run db:verify                 # ros_app is subject to RLS
$env:RUN_DB_TESTS=1; npm test     # every test, including QR isolation
```

Plus the manual check that matters most, in a private browsing window with no session: a QR URL resolves to exactly one table, an altered token 404s, and a rotated token invalidates the old sticker.
