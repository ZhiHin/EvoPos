# Phase 0 — Validation Rules

Every rule is enforced by a zod schema parsed server-side. Client-side
attributes (`required`, `minLength`) exist to make forms pleasant and are never
what decides whether input is acceptable.

## Field rules

| Field | Rule | Notes |
| --- | --- | --- |
| `email` | Trimmed → lowercased → format-checked, max 254 | Order matters — see below |
| `password` (new) | 12–128 characters, no composition rules | See below |
| `password` (login) | 1–128 characters | Current policy must not lock out older passwords |
| `name` | Trimmed, 1–120 | |
| `restaurantName` | Trimmed, 1–120 | Whitespace-only rejected |
| `restaurantId` | UUID | |
| `token` | Non-empty string | Validity is decided by the database claim, not the schema |

## Two decisions worth stating

### Normalise before validating

```ts
z.string().trim().toLowerCase().pipe(z.email().max(254))
```

Not `z.email().transform(trim)`. The two read almost identically and behave
differently: with `transform`, the format check runs against the **raw** input,
so a copy-pasted or autofilled `" owner@cafe.com "` is rejected as malformed
before the trim ever runs. This was caught by a unit test rather than by a
user, which is the only acceptable way to find it.

Normalisation is also what makes the unique index on `users.email` mean
anything. Without it, `Owner@cafe.com` and `owner@cafe.com` are two accounts.

### Length only, no character classes

NIST SP 800-63B advises against composition requirements. "One uppercase, one
number, one symbol" reliably produces `Password1!` while rejecting
`correct horse battery staple`, which is enormously stronger. A 12-character
minimum with no character rules is the better policy, and it is easier to
comply with honestly.

The 128-character ceiling is a denial-of-service guard: Argon2's cost scales
with input length, so an unbounded password field is a free way to make the
server burn CPU.

## Error shape

Zod issues are flattened to field-keyed arrays:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some of the information provided is not valid.",
    "details": { "password": ["Password must be at least 12 characters"] }
  }
}
```

Forms read `details` to place messages under the right input. The top-level
`message` is the fallback when an error is not field-specific.

## Validation vs. business rules

Schemas answer "is this well-formed?". They do not answer "is this allowed?".

- Schema: is the email a valid address? → `VALIDATION_FAILED` (422)
- Business rule: is that address already registered? → `CONFLICT` (409)
- Business rule: does this user belong to that restaurant? → `NOT_FOUND` (404)

Keeping them separate is what lets services be reused outside HTTP: a schema
failure is a client mistake, a business-rule failure is a domain outcome.

## Beyond the schema

Input validation is one of several layers, and the weakest:

| Layer | Catches |
| --- | --- |
| Zod schema | Malformed input |
| Service rules | Duplicate email, unknown permission code, owner-role edit |
| Database constraints | Unique indexes, foreign keys, enum domains |
| RLS policies | Cross-tenant reads and writes |

A tenant boundary is never defended by validation alone. `role.update` with a
valid UUID for another tenant's role passes every schema — and returns nothing,
because the policy filters it.
