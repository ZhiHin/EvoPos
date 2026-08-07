# Restaurant Operating System (ROS)

A multi-tenant restaurant operating system. Not a till with reports bolted on —
the Dining Session is the core object, and the Smart Bill engine is the reason
the product exists.

**Status: all 15 phases complete.** Tenancy and row-level security, the menu
engine, dining sessions and QR ordering, Smart Bill splitting, payments, the
kitchen display, promotions and loyalty, inventory and purchasing, CRM,
reservations and staff, reporting, the advisor, and the SaaS surface.

**64 tables, 92 RLS policies, 121 permissions, 767 tests.**

Each phase has its own README covering what it delivers, what was verified,
and — at the end of every one — the gaps it deliberately left open. Start with
[`docs/ROADMAP.md`](docs/ROADMAP.md).

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
createdb -U postgres evopos
psql -U postgres -d evopos -f scripts/bootstrap.sql
```

`bootstrap.sql` creates two roles, and the split between them is the backbone
of tenant isolation:

- **`evoadmin`** — owns the tables, runs migrations. Exempt from RLS, as table
  owners always are.
- **`evoapp`** — what the running application connects as. Owns nothing,
  creates nothing, and every query it issues is filtered by policy.

Change both passwords before using this anywhere but your own machine, and keep
them in sync with `.env`.

### 3. Configure environment

Create a `.env` in the project root. It is gitignored and never committed.

`src/lib/env.ts` validates these at import, so the app refuses to start rather
than failing later on the first request that happens to need a missing value.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | no | `development` (default), `test` or `production` |
| `APP_URL` | **yes** | Public base URL. Builds OAuth redirects and QR payloads |
| `DATABASE_URL` | **yes** | Runtime connection, as `evoapp` — subject to RLS |
| `DATABASE_URL_MIGRATOR` | **yes** | Migration connection, as `evoadmin` — owns the tables |
| `AUTH_SECRET` | **yes** | HMAC key for session and one-time tokens. Min 32 chars |
| `GOOGLE_CLIENT_ID` | no | Google sign-in. Both blank disables it |
| `GOOGLE_CLIENT_SECRET` | no | Must be set together with the ID |
| `ANTHROPIC_API_KEY` | no | Lets the advisor's summary paragraph be written by Claude. Every figure and recommendation is computed without it |
| `SMTP_URL` | no | `smtps://user:pass@host:465`. Must be set with `SMTP_FROM` |
| `SMTP_FROM` | no | The From address. Without both, production refuses to send rather than dropping mail |
| `WEBHOOK_DRAIN_SECRET` | no | Bearer token a scheduler presents to `/api/webhooks/drain`. Unset closes the endpoint |

```
NODE_ENV=development
APP_URL=http://localhost:3000

DATABASE_URL=postgresql://evoapp:<app-password>@localhost:5432/evopos
DATABASE_URL_MIGRATOR=postgresql://evoadmin:<admin-password>@localhost:5432/evopos

AUTH_SECRET=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

ANTHROPIC_API_KEY=

SMTP_URL=
SMTP_FROM=
WEBHOOK_DRAIN_SECRET=
```

Passwords are the ones you set in `scripts/bootstrap.sql`. Generate a secret
with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**The two connection strings must use different roles.** Pointing
`DATABASE_URL` at `evoadmin` silently disables every row-level security policy
— see [Setup step 2](#2-create-the-database-and-roles). `npm run db:verify`
checks this, and the app refuses to boot in production if it is wrong.

Google login is optional. Leave both credentials blank to disable it; the
button disappears from the sign-in page.

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
| `npm run db:migrate` | Apply migrations as `evoadmin` |
| `npm run db:seed` | Sync the permission registry |
| `npm run db:studio` | Drizzle Studio |
| `npm run db:verify` | Assert the runtime role is subject to RLS |
| `npm run db:counts` | Count tables, RLS policies and permissions |

Integration tests need a live database and are skipped otherwise:

```powershell
$env:RUN_DB_TESTS=1; npm test
```

Use **DBeaver** against `localhost:5432/evopos` to inspect data. Connect as
`evoadmin` to see everything, or as `evoapp` to see exactly what the
application sees — a fast way to sanity-check a policy.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | All 15 phases and their dependencies |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module conventions, layering, how to add a module |
| [`docs/phase-0/`](docs/phase-0/) | Phase 0 artifacts: requirements, ER diagram, API spec, business rules, screens, validation, security, tests |
| `docs/phase-1/` … [`docs/phase-14/`](docs/phase-14/) | One README per shipped phase: what it delivers, what was verified, and the gaps it left open |

---

## Known limitations

Stated plainly rather than discovered later. The first two were named in
Phase 0 and closed in Phase 14; the rest are still open.

- ~~**Rate limiting is in-process.**~~ **Closed in Phase 14.** The counter now
  lives in Postgres, so the limit means the same thing behind any number of
  instances.
- ~~**No email provider.**~~ **Closed in Phase 14.** SMTP, via `SMTP_URL`.
  With none configured, production still refuses to send rather than silently
  dropping mail.
- **No payment provider.** Plans are selected and enforced; nothing charges a
  card. See [`docs/phase-14/`](docs/phase-14/).
- **The webhook queue needs an external scheduler.** Next.js has no process to
  own a background worker. Something must POST to `/api/webhooks/drain`.
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
