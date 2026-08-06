# Phase 0 — Business Rules

Every rule here is enforced server-side. Where the UI also reflects a rule,
that is presentation, not enforcement.

## Identity

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-01 | Email is unique platform-wide, stored lowercased and trimmed | One person, one account, many memberships |
| BR-02 | Normalisation happens before validation, not after | Otherwise a pasted `" a@b.com "` is rejected as malformed |
| BR-03 | An account may have no password (Google-only) | Password login against it must fail like any wrong credential |
| BR-04 | Suspended or deleted accounts cannot authenticate | Checked on every request, not only at login |
| BR-05 | Changing a password revokes every session | Otherwise an attacker keeps the session the victim changed the password to stop |

## Sessions

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-06 | Sessions are database rows; only an HMAC of the token is stored | A database dump yields no usable cookies |
| BR-07 | Lifetime 30 days, extended on use past the halfway point | Sliding expiry without a write on every request |
| BR-08 | Expiry is filtered in SQL, not compared in JavaScript | Clock skew between app and database must not widen the window |
| BR-09 | Sign-out deletes the row | Clearing only the cookie leaves a working token behind |
| BR-10 | A session naming a restaurant the user no longer belongs to has it cleared | Revocation takes effect on next request |

## Tenancy

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-11 | A restaurant is the tenant; its id is the RLS context | No second table to fall out of sync |
| BR-12 | Registration creates user, restaurant, roles and membership in one transaction | A partial failure would strand an email address permanently |
| BR-13 | Slugs carry a random suffix | Guessable slugs hand out valid tenant identifiers |
| BR-14 | A user may belong to many restaurants, but acts in exactly one at a time | The active tenant is session state |
| BR-15 | One membership → auto-select; several → the user must choose | Guessing risks opening the wrong restaurant's till |
| BR-16 | Switching tenants re-verifies membership server-side | The id comes from the client |
| BR-17 | Onboarding only serves users with zero restaurants | Additional restaurants are billing-bearing (Phase 14) |

## Authorisation

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-18 | Permissions are code-defined and not runtime-authorable | A permission code is a promise that some code path enforces it |
| BR-19 | Roles are per-tenant and freely editable — that is the configurability | Owners compose roles from real capabilities |
| BR-20 | Every restaurant is seeded with seven system roles | Usable on day one |
| BR-21 | The owner role always holds every permission and cannot be edited | One mistaken save must not lock a paying customer out of their account |
| BR-22 | Owner roles are re-pinned when new permissions ship | Otherwise older restaurants have owners who cannot use new features |
| BR-23 | System roles cannot be deleted; their permissions (except owner) can be changed | Deleting a role in use would orphan memberships |
| BR-24 | No non-owner default role carries `role.*` permissions | A role that can edit roles can grant itself everything |
| BR-25 | Permission sync is additive; codes are never deleted | Deleting cascades into tenants' custom roles and silently strips capability |
| BR-26 | Empty branch assignment means restaurant-wide, not "no access" | The common case needs no rows |

## Isolation

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-27 | Tenant-scoped tables carry an RLS policy on `restaurant_id` | The database, not application discipline, is the boundary |
| BR-28 | Policies specify `WITH CHECK` as well as `USING` | Without it a row can be *moved* into another tenant by UPDATE |
| BR-29 | Absent tenant context yields no rows | Fail closed |
| BR-30 | The application connects as a role that owns nothing and cannot bypass RLS | Owners are exempt from their own policies |
| BR-31 | Another tenant's record is reported as 404, never 403 | A 403 confirms the id is real |

## Audit

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-32 | The audit trail is append-only to the application | An attacker in application code cannot erase their trail |
| BR-33 | Audit rows are written in the same transaction as the change | The trail cannot describe something that was rolled back |
| BR-34 | Secrets are redacted at any nesting depth before write | Payloads are built from whole entities, so hashes hide several levels down |
| BR-35 | `actor_user_id` is nullable and survives user deletion (`SET NULL`) | System actions have no actor; losing the trail would defeat the point |

## Rate limiting and enumeration

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-36 | Login is limited per IP *and* per email, separately | Per-IP alone misses distributed attacks; per-email alone lets one IP spray many accounts |
| BR-37 | A successful login clears that account's failure budget | A legitimate user should not be penalised for earlier typos |
| BR-38 | Password reset responds identically for known and unknown addresses | Otherwise it is a membership oracle |
| BR-39 | All login failure modes share one message and comparable CPU cost | Timing alone otherwise reveals which addresses are registered |

## Google sign-in

| Ref | Rule | Rationale |
| --- | --- | --- |
| BR-40 | ID tokens are verified against Google's JWKS with `iss`, `aud`, `exp`, `nonce` | An unverified token is just JSON the client supplied |
| BR-41 | Linking to an existing account requires `email_verified` from Google | **The load-bearing rule.** Without it, anyone can register a Google account claiming an owner's address and be handed their restaurant |
| BR-42 | Signing in via a verified Google address marks the local email verified | Control of the mailbox is proven |
| BR-43 | PKCE verifier, state and nonce are single-use and expire in 10 minutes | Bind the code, the redirect and the token to this one browser and request |
