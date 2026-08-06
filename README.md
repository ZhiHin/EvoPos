# Restaurant Operating System (ROS)

A multi-tenant restaurant operating system. Not a till with reports bolted on —
the Dining Session is the core object, and the Smart Bill engine is the reason
the product exists.

**Status: Phase 0 (Foundation) complete.** Authentication, tenancy, RBAC and the
audit trail work end to end. Menus, orders, kitchen and Smart Bill are later
phases — see [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 16 (App Router), React 19 | Server components keep authorisation server-side by default |
| Language | TypeScript (strict) | — |
| Styling | Tailwind v4, shadcn/ui (Radix) | Light/dark, touch-friendly for POS terminals |
| Database | PostgreSQL | Row-level security is the tenant boundary |
| Data layer | Drizzle ORM | Direct connection control, which RLS session variables require |
| Auth | Custom sessions + `openid-client` | DB-backed sessions revoke instantly; OIDC verification not hand-rolled |
| Hashing | Argon2id (`@node-rs/argon2`) | OWASP-recommended parameters |
| Tests | Vitest | — |

---

## Setup

### 1. Install PostgreSQL

Nothing is bundled — install PostgreSQL 17 locally:

```powershell
winget install -e --id PostgreSQL.PostgreSQL.17
```

Accept the source agreement if winget prompts. Reopen your terminal afterwards
so `psql` is on `PATH` (it installs to `C:\Program Files\PostgreSQL\17\bin`;
add it manually if it isn't). Verify:

```powershell
psql --version
```

### 2. Create the database and roles

```powershell
createdb -U postgres ros
psql -U postgres -d ros -f scripts/bootstrap.sql
```

`bootstrap.sql` creates two roles, and the split between them is the backbone
of tenant isolation:

- **`ros_owner`** — owns the tables, runs migrations. Exempt from RLS, as table
  owners always are.
- **`ros_app`** — what the running application connects as. Owns nothing,
  creates nothing, and every query it issues is filtered by policy.

Change both passwords before using this anywhere but your own machine, and keep
them in sync with `.env`.

### 3. Configure environment

A `.env` was generated for you with a random `AUTH_SECRET`. Update the two
connection strings to match the passwords you set:

```
DATABASE_URL=postgresql://ros_app:...@localhost:5432/ros
DATABASE_URL_MIGRATOR=postgresql://ros_owner:...@localhost:5432/ros
```

Google login is optional. Leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
blank to disable it; the button disappears from the sign-in page.

### 4. Migrate, seed, verify

```powershell
npm run db:migrate   # creates tables, enables RLS, installs 11 policies
npm run db:seed      # syncs the permission registry — required before first signup
npm run db:verify    # asserts the app role cannot bypass RLS
```

`db:verify` is not ceremony. Pointing `DATABASE_URL` at the owner role produces
no error and no visible symptom — the app works perfectly while every tenant
boundary is silently gone. This is the check that catches it.

### 5. Run

```powershell
npm run dev
```

Open http://localhost:3000 and register. That creates your user, your
restaurant, its seven default roles, and your owner membership in one
transaction.

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (no database needed) |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations as `ros_owner` |
| `npm run db:seed` | Sync the permission registry |
| `npm run db:studio` | Drizzle Studio |
| `npm run db:verify` | Assert the runtime role is subject to RLS |

Integration tests need a live database and are skipped otherwise:

```powershell
$env:RUN_DB_TESTS=1; npm test
```

Use **DBeaver** against `localhost:5432/ros` to inspect data. Connect as
`ros_owner` to see everything, or as `ros_app` to see exactly what the
application sees — a fast way to sanity-check a policy.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | All 15 phases and their dependencies |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module conventions, layering, how to add a module |
| [`docs/phase-0/`](docs/phase-0/) | Phase 0 artifacts: requirements, ER diagram, API spec, business rules, screens, validation, security, tests |

---

## Known limitations in Phase 0

Stated plainly rather than discovered later:

- **Rate limiting is in-process.** Behind more than one instance the effective
  limit multiplies by instance count, and a deploy resets every window. Swap
  `src/lib/rate-limit.ts` for Redis before scaling horizontally.
- **No email provider.** `ConsoleEmailTransport` prints reset links to the
  server log. Production throws rather than silently dropping mail.
- **Identity tables are not RLS-protected.** `users`, `sessions`,
  `oauth_accounts` and `verification_tokens` are read before a tenant context
  can exist. Deliberate, and explained in
  [`docs/phase-0/07-security.md`](docs/phase-0/07-security.md).
- **Branch-level scoping is application-enforced**, not RLS-enforced — it
  depends on the membership rather than on a column of the row being read.
- **4 moderate `npm audit` findings**, all from `drizzle-kit`'s nested legacy
  esbuild. Dev-only, never in the production bundle; the "fix" downgrades
  drizzle-kit from 0.31 to 0.18.
- **The project lives in a OneDrive folder.** OneDrive syncing `node_modules`
  causes file-locking and performance problems. Consider moving the repo
  outside OneDrive, or excluding it from sync.
