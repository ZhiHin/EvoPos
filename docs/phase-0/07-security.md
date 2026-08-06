# Phase 0 — Security Considerations

## Threat model

The threats that matter for a multi-tenant restaurant platform, roughly by
consequence:

1. **Cross-tenant data access.** One restaurant reading another's data. Total
   loss of product trust; likely unrecoverable commercially.
2. **Account takeover.** Especially an Owner — full control of a business.
3. **Credential disclosure.** Database theft yielding usable passwords or
   sessions.
4. **Privilege escalation.** A cashier acquiring owner capability.
5. **Enumeration.** Learning which addresses have accounts, or which
   restaurants exist.
6. **Audit tampering.** Erasing evidence of any of the above.

## 1. Tenant isolation

Two independent layers, and the redundancy is deliberate.

**Database (primary).** Every tenant-scoped table has RLS enabled with a policy
comparing `restaurant_id` to `current_setting('app.tenant_id')`. The
application connects as `evoapp`: owns nothing, creates nothing, no
`BYPASSRLS`.

Three details carry disproportionate weight:

- **`WITH CHECK`, not just `USING`.** `USING` governs which rows are visible;
  `WITH CHECK` governs which rows may be written. With only `USING`, a tenant
  could UPDATE a row it legitimately owns and set `restaurant_id` to someone
  else's — moving data across the boundary through a write rather than a read.
- **`set_config(..., true)`, not `SET LOCAL`.** `SET LOCAL` cannot take a bind
  parameter, so the tenant id would have to be interpolated into SQL text — an
  injection point on the single value the entire model depends on. `set_config`
  is an ordinary function call, so the id travels as a parameter. The `true`
  makes it transaction-local, so a pooled connection cannot carry stale tenant
  context into the next request.
- **`NULLIF(current_setting(...), '')`.** Absent context yields NULL, and
  `column = NULL` is NULL, so nothing matches — fail closed. The `NULLIF`
  handles the second failure mode: a setting explicitly assigned the empty
  string, where a bare `''::uuid` would raise instead of yielding NULL.

**Boot-time assertion.** `assertRuntimeRoleIsSafe()` runs at server start and
refuses to serve in production if the connected role is a superuser, has
`BYPASSRLS`, or owns tables in `public`.

This check exists because of the specific failure mode: pointing
`DATABASE_URL` at the owner role produces **no error and no symptom**. Policies
simply stop filtering. The application works perfectly while every tenant
boundary is gone — invisible, total, and indistinguishable from correct
operation. It is the worst kind of bug, so it gets its own guard and its own
`npm run db:verify`.

### Deliberate gaps

| Gap | Why | Compensating control |
| --- | --- | --- |
| `users`, `sessions`, `oauth_accounts`, `verification_tokens` have no RLS | Login must find a user by email before any tenant is known; a policy here would make authentication impossible | Access confined to the auth module; these tables hold no tenant business data |
| `permissions` has no RLS | Global registry, identical for every tenant | Read-only in practice; written only by the seed |
| Branch scoping is application-enforced | It depends on the membership, not on a column of the row being read — not expressible as a policy on that row | `assertBranchAccess` in the guard layer |
| `evoadmin` bypasses RLS | Required for migrations and backups | Never in `DATABASE_URL`; asserted at boot |

## 2. Authentication

| Control | Implementation |
| --- | --- |
| Password hashing | Argon2id, m=19456 KiB, t=2, p=1 (OWASP floor) |
| Session storage | Server-side rows; only an HMAC-SHA256 of the token is stored |
| Session transport | httpOnly, Secure, SameSite=Lax, `__Host-` prefixed in production |
| Revocation | Immediate — sessions are rows, not stateless tokens |
| Password change / reset | Revokes every session for that user |
| Reset tokens | 32 random bytes, HMAC-stored, single-use, 1-hour expiry |

**No pepper**, and that is a decision rather than an omission. A pepper would
strengthen the database-disclosure case, but permanently couples every stored
hash to a secret that cannot then be rotated without invalidating every
password in the system. Worth revisiting deliberately; not worth inheriting by
accident.

**HMAC rather than Argon2 for tokens.** These are 256 bits from a CSPRNG, not
user-chosen secrets — there is no dictionary to defend against, so paying
Argon2's cost on every request buys nothing. The *keyed* construction is what
matters: a plain SHA-256 digest could be precomputed against a leaked table
without knowing `AUTH_SECRET`.

**Single-use reset tokens are claimed by conditional UPDATE**, not read-then-
write. The read-then-write shape lets two concurrent requests both succeed;
here the database picks exactly one winner, because only one UPDATE can find
the row still unused.

## 3. Authorisation

Resolved per request from the database — never cached across requests, never
trusted from the client. A member removed from a restaurant loses access on
their **next request**, not at token expiry.

`requirePermission` returns the context it validated, so the caller needs no
second lookup. That is intentional: a guard that costs an extra query is a
guard people work around.

The owner role is pinned to the full permission set and refuses edits. Any role
able to edit roles can grant itself everything, which is why no non-owner
default template carries `role.*` — asserted by a unit test.

## 4. Enumeration resistance

| Surface | Control |
| --- | --- |
| Login | One message for unknown account, Google-only account, and wrong password |
| Login timing | Dummy Argon2 verification when no hash exists, so failures take comparable time |
| Password reset | Identical response and identical UI regardless of whether the address exists |
| Cross-tenant records | 404, never 403 |
| Restaurant slugs | Random suffix, so they cannot be derived from the business name |

Registration still reveals that an email is taken. That is difficult to avoid
without a materially worse signup experience; rate limiting is the mitigation.

## 5. Request integrity

- **CSRF**: `Origin` compared against `APP_URL` on every state-changing route,
  with a missing `Origin` rejected. `SameSite=Lax` is the browser-side half;
  the origin check is the server-side half that also covers non-browser
  clients replaying a captured cookie.
- **OAuth**: PKCE binds the code to the browser, `state` binds the callback to
  the request, `nonce` binds the ID token to the request. All three are
  single-use and expire in 10 minutes.
- **SQL injection**: Drizzle parameterises everything. The one place a value
  reaches a session setting goes through `set_config` as a bind parameter.
- **Error leakage**: unrecognised errors are logged in full and returned as a
  bare 500. Echoing an unexpected message is how connection strings and SQL
  fragments end up in a browser.

## 6. Audit integrity

`audit_log` grants the application INSERT and SELECT only. Postgres denies what
no policy permits, so the **absence** of UPDATE and DELETE policies is the
control: an attacker with application-level code execution can append to their
trail but cannot rewrite or erase it.

Entries are written in the same transaction as the change they describe, so the
trail can never claim something happened that was rolled back. Secrets are
redacted at any depth before write — audit payloads are assembled from whole
entity objects, which is exactly how a password hash ends up permanently
recorded in a table designed to be undeletable.

## Known weaknesses

Stated rather than discovered later:

| Weakness | Impact | Resolution |
| --- | --- | --- |
| Rate limiting is in-process | Limits multiply by instance count; deploys reset windows | Redis-backed limiter behind the same `consume` signature before horizontal scaling |
| `x-forwarded-for` is attacker-controlled without a trusted proxy | IP-based limits can be evaded by header rotation | Terminate behind a proxy that overwrites the header |
| No email verification enforcement | Users can operate with an unverified address | Phase 1, alongside staff invitations |
| No MFA | Owner accounts rest on one factor | Phase 14 |
| No password breach checking | Users may reuse a compromised password | Have I Been Pwned range API, Phase 14 |
| No account lockout | Only rate limiting slows sustained guessing | Deliberate — lockout is a denial-of-service vector against a named account |
| 4 moderate `npm audit` findings | None in production | `drizzle-kit`'s nested legacy esbuild; dev-only, and the "fix" downgrades 0.31 → 0.18 |

## Pre-production checklist

- [ ] `db:verify` passes against production credentials
- [ ] `bootstrap.sql` passwords changed from defaults
- [ ] `AUTH_SECRET` is a fresh 48-byte random value, not the generated dev one
- [ ] TLS terminated; HSTS enabled
- [ ] Rate limiter moved to Redis
- [ ] Email transport configured (production throws rather than dropping mail)
- [ ] `x-forwarded-for` set by a trusted proxy only
- [ ] Backup and restore rehearsed, not merely configured
