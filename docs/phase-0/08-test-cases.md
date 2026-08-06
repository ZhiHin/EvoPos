# Phase 0 — Test Cases

## Running

```powershell
npm test                        # 38 unit tests, no database required
$env:RUN_DB_TESTS=1; npm test   # adds 15 integration tests against Postgres
```

Integration tests skip rather than fail when `RUN_DB_TESTS` is unset, so the
unit suite stays runnable on a machine with no database.

## Status

| Suite | File | Tests | Status |
| --- | --- | --- | --- |
| Password hashing | `src/modules/auth/password.test.ts` | 5 | ✅ passing |
| Opaque tokens | `src/modules/auth/tokens.test.ts` | 5 | ✅ passing |
| Audit redaction | `src/modules/audit/audit.test.ts` | 5 | ✅ passing |
| Permission registry | `src/modules/rbac/permissions.test.ts` | 7 | ✅ passing |
| Rate limiter | `src/lib/rate-limit.test.ts` | 7 | ✅ passing |
| Input validation | `src/modules/auth/auth.validation.test.ts` | 9 | ✅ passing |
| **Tenant isolation** | `tests/rls.integration.test.ts` | 15 | ✅ passing |

**53 of 53 executed and passing** against PostgreSQL 17.10.

## Unit coverage

### Password hashing
Correct password verifies; wrong password (including case change) rejects;
same input hashes differently each time (distinct salts, so the table does not
reveal which accounts share a password); output is `$argon2id$`; a corrupt or
empty hash returns `false` rather than throwing — a damaged row must read as a
failed login, not a 500 that tells an attacker something.

### Opaque tokens
500 generated tokens are unique and URL-safe; each is 43 characters (32 bytes
base64url = 256 bits); hashing is deterministic so the digest can serve as the
lookup key; different tokens produce different digests; **the hash is never
equal to the plaintext** — that last one guards against a refactor accidentally
making hashing an identity function and putting usable session tokens in the
database.

### Audit redaction
Secret-bearing keys redact regardless of case; nested objects and arrays are
covered (payloads are built from whole entities, so the secret is usually
several levels down); primitives pass through; a 20-level structure does not
hang the request trying to write the row.

### Permission registry
No duplicate codes; codes match `module.action` and the naming pattern; role
keys are unique; **every template references a permission that exists** — a
typo here fails at the foreign key during registration, so the first symptom
would be new customers unable to sign up; owner resolves to the full registry;
**no non-owner role carries `role.*`**, since a role that can edit roles can
grant itself everything.

### Rate limiter
Allows up to the limit; blocks past it with a retry hint; reports remaining
budget; throws `RateLimitError`; `reset` clears the budget so a successful
login is not penalised for earlier typos; a lapsed window starts fresh;
budgets are per-key, so one account under attack does not lock out everyone.

### Input validation
Email lowercases and trims; malformed and over-length addresses reject;
password enforces 12–128 with no composition rules; a passphrase with no
special characters is accepted; register trims and normalises every field;
whitespace-only restaurant name rejects; **login does not impose the length
policy**, which would otherwise lock out anyone whose password predates it.

## Integration coverage (pending execution)

Every case below runs as `evoapp` against two real tenants.

| # | Case | Asserts |
| --- | --- | --- |
| 1 | Runtime role is subject to RLS | If this fails, every case below is meaningless |
| 2 | Tenant sees only its own branches | Baseline isolation |
| 3 | **Asking for another tenant's row by primary key returns nothing** | Simulates an IDOR bug in application code — the database refuses regardless of what the SQL asked |
| 4 | Another tenant's restaurant row is invisible | Tenant root isolation |
| 5 | **UPDATE moving a row to another tenant is rejected** | `WITH CHECK` — data cannot be walked across the boundary by a write |
| 6 | INSERT of a row belonging to another tenant is rejected | `WITH CHECK` on insert |
| 7 | DELETE targeting another tenant affects nothing | Destructive isolation |
| 8 | No tenant context yields no rows | Fail closed |
| 9 | Empty-string tenant id yields no rows, not an error | The `NULLIF` guard |
| 10 | Tenant context does not survive the transaction | Pooled connections cannot leak context between requests |
| 11 | A user lists their own restaurants with no tenant selected | The three self-read policies working together |
| 12 | Restaurants without membership are not listed | Self-read is scoped |
| 13 | Membership cannot be resolved in a foreign tenant | Guard layer |
| 14 | Owner receives the full permission set | Seeding |
| 15 | Another tenant's memberships are invisible | RBAC isolation |

Cases 3, 5 and 9 are the ones worth reading. Case 3 is the whole argument for
RLS: application code asks for the wrong thing and gets nothing anyway. Case 5
is the one that a `USING`-only policy would fail. Case 9 covers a failure mode
that produces a 500 rather than a leak, but is easy to miss in review.

## Not yet covered

| Area | Why not | When |
| --- | --- | --- |
| Google OAuth end-to-end | Requires live Google credentials; the verification that matters is inside `openid-client` | Phase 1, with a mocked issuer |
| Route handlers | Would test framework plumbing more than behaviour; logic lives in tested services | Phase 1, via HTTP-level tests |
| Concurrent reset-token redemption | The conditional UPDATE is the defence and is correct by construction; proving the race needs a harness | Phase 1 |
| UI components | No meaningful logic in Phase 0 screens | When forms grow conditional behaviour |
| Load and soak | No throughput requirement yet | Phase 12 |

## Manual verification (after PostgreSQL is installed)

1. `npm run db:migrate && npm run db:seed && npm run db:verify`
2. Register a restaurant → lands on dashboard, permissions listed, audit shows
   `restaurant.created`
3. Register a second restaurant with a different email
4. In DBeaver as `evoapp`: `SELECT * FROM branches;` → **0 rows** without
   tenant context. Then `SELECT set_config('app.tenant_id','<id>',false);` and
   repeat → only that tenant's rows
5. Sign out → confirm the `sessions` row is gone, not just the cookie
6. Request a password reset → link appears in the server console; use it;
   confirm every prior session is revoked
7. Point `DATABASE_URL` at `evoadmin` and start → boot assertion fires
