# Phase 0 — API Specification

All endpoints are JSON over HTTPS. State-changing endpoints require a matching
`Origin` header and reject the request otherwise.

## Error envelope

Every failure returns the same shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human-readable, safe to display",
    "details": { "email": ["Enter a valid email address"] }
  }
}
```

| Code | Status | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | Absent — **or** present but owned by another tenant |
| `CONFLICT` | 409 | Collides with existing state |
| `VALIDATION_FAILED` | 422 | Input failed schema validation |
| `RATE_LIMITED` | 429 | Budget exhausted |
| `INTERNAL` | 500 | Unexpected; details are logged, never returned |

404-instead-of-403 for another tenant's record is deliberate. A 403 confirms
the id exists, which leaks the existence of other restaurants' data to anyone
willing to enumerate.

---

## `POST /api/auth/register`

Creates a user and their first restaurant.

```json
{ "name": "Ali", "email": "ali@kopi.com", "password": "min 12 chars", "restaurantName": "Kopi Corner" }
```

**201** `{ "restaurantId": "uuid" }`, plus a session cookie.

| Failure | Code |
| --- | --- |
| Email already registered | 409 `CONFLICT` |
| Validation failed | 422 |
| More than 5 registrations from one IP per hour | 429 |

---

## `POST /api/auth/login`

```json
{ "email": "ali@kopi.com", "password": "…" }
```

**200** `{ "restaurantId": "uuid" | null }`, plus a session cookie.
`null` means several memberships — the client must send the user to
`/select-restaurant`.

| Failure | Code |
| --- | --- |
| Wrong credentials, unknown account, or Google-only account | 401, identical message for all three |
| Suspended account | 403 |
| 20/15min per IP, or 8/15min per email | 429 |

The three 401 cases are indistinguishable by message *and* by timing — a
dummy Argon2 verification runs when no hash is available, so "no such user"
does not return measurably faster than "wrong password".

---

## `POST /api/auth/logout`

Empty body. **200** always, whether or not a session existed. Deletes the
session row and clears the cookie.

---

## `POST /api/auth/forgot-password`

```json
{ "email": "ali@kopi.com" }
```

**200** always, with the same message whether or not the address is
registered. Differentiating would make this endpoint a membership oracle.
Limited to 5 per address per hour.

---

## `POST /api/auth/reset-password`

```json
{ "token": "from the emailed link", "password": "min 12 chars" }
```

**200** on success. Revokes **every** session for that user.

**422** if the token is unknown, expired, or already used — one message for all
three, so a used token cannot be distinguished from a fabricated one.

---

## `POST /api/auth/switch-tenant`

Requires a session.

```json
{ "restaurantId": "uuid" }
```

**200** `{ "restaurantId": "uuid" }`. Membership is re-verified server-side;
**404** if the user holds no active membership there.

---

## `POST /api/onboarding`

Requires a session. For users with no restaurant — the Google sign-up path.

```json
{ "restaurantName": "Kopi Corner" }
```

**201** `{ "restaurantId": "uuid" }`, and the new restaurant becomes active.

**409** if the user already belongs to one. Creating additional restaurants is
a billing-bearing action and belongs to the plan-aware flow in Phase 14;
leaving this endpoint open would make it a free way to mint unlimited tenants.

---

## `GET /api/auth/google`

Redirects to Google. Sets three short-lived httpOnly cookies (PKCE verifier,
state, nonce), each 10 minutes.

**501** if Google is not configured.

## `GET /api/auth/google/callback`

Consumes those cookies regardless of outcome, so a failed attempt cannot be
replayed. Verifies the ID token's signature against Google's JWKS along with
`iss`, `aud`, `exp` and `nonce`.

Redirects: `/dashboard` (one membership), `/select-restaurant` (several),
`/onboarding` (none). On failure, `/login?error=…` with `oauth_expired`,
`oauth_rejected`, or `oauth_failed`.

---

## Session cookie

| Property | Value |
| --- | --- |
| Name | `__Host-ros_session` in production, `ros_session` in development |
| `HttpOnly` | Yes — an XSS bug cannot read it |
| `Secure` | Production only |
| `SameSite` | `Lax` |
| `Path` | `/` |
| Lifetime | 30 days, sliding past the halfway mark |

`__Host-` is browser-enforced: the cookie is refused unless it is Secure,
Path=/, and has no Domain — so a subdomain cannot overwrite the parent site's
session. It cannot be used over plain HTTP, hence the development fallback.

`SameSite=Lax` rather than `Strict` because `Strict` drops the cookie on the
top-level navigation back from Google, breaking the OAuth callback. The
server-side `Origin` check covers what `Lax` does not.

---

## Conventions for later phases

- Tenant-scoped resources take no tenant id in the path or body. It comes from
  the session, because a client-supplied tenant id is a request to be verified,
  not a fact.
- Mutations require an explicit permission via `requirePermission`.
- List endpoints paginate by cursor, not offset.
- Money is integer minor units, with the currency alongside it.
