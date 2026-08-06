# Phase 0 — Functional Requirements

## Scope

Phase 0 delivers the foundation every later phase stands on: identity, tenancy,
authorisation, and the audit trail. It ships no restaurant-operational feature,
and that is deliberate — a menu built before tenant isolation exists is a menu
that has to be re-secured later.

**In scope**

| Ref | Requirement |
| --- | --- |
| F-01 | A person can register, creating their account and first restaurant together |
| F-02 | A person can sign in with email and password |
| F-03 | A person can sign in with Google, when configured |
| F-04 | A person can sign out, invalidating the session server-side |
| F-05 | A person can request a password reset and set a new password |
| F-06 | A signed-in person can change their password with their current one |
| F-07 | A person belonging to several restaurants can choose and switch between them |
| F-08 | A person signed in with no restaurant can create one (onboarding) |
| F-09 | Each restaurant is provisioned with seven default roles |
| F-10 | Permissions resolve per request from the member's role |
| F-11 | Security-relevant actions are written to an append-only audit trail |
| F-12 | Data belonging to one restaurant is unreachable from another |
| F-13 | The interface supports light and dark themes |

**Out of scope** — branches (Phase 1), menus (Phase 2), any ordering or billing
(Phases 4–7). Phase 0 defines the `branches` table because tenancy and RBAC
reference it, but ships no branch management UI.

## Actors

| Actor | Description |
| --- | --- |
| Visitor | Unauthenticated |
| User | Authenticated, global to the platform; may belong to several restaurants |
| Member | A user within one restaurant, holding exactly one role there |
| Owner | Seeded role with every permission; cannot be edited or deleted |
| System | Scheduled jobs and webhooks — an actor with no user |

## Key flows

### F-01 Registration

1. Visitor submits name, email, password, restaurant name.
2. Server validates; rejects a duplicate email.
3. In **one transaction**: create user → establish tenant context → create
   restaurant → seed seven roles and their permissions → create owner
   membership → write audit entry.
4. Issue session, set the new restaurant active, redirect to dashboard.

Atomicity matters here beyond tidiness: a partial failure that left a user row
behind would consume an email address the person could then never register
again, with no way to recover it themselves.

### F-02 Sign in

1. Rate limit by IP and by email address, separately.
2. Look up by normalised email; verify Argon2id hash.
3. Reject suspended accounts.
4. Issue session. One membership → select it. Several → tenant picker.

All failure modes — unknown address, Google-only account, wrong password —
return the same message and consume comparable CPU.

### F-07 Tenant switching

1. Signed-in user requests a restaurant.
2. Server re-verifies active membership against the database.
3. On success, session's `active_restaurant_id` is updated.

The identifier arrives from the client and is therefore a request, not a fact.

### F-11 Audit trail

Every entry records tenant, actor, action, entity, before/after state, IP and
user agent. Secrets are redacted before write. The application role holds
INSERT and SELECT but no UPDATE or DELETE, so entries cannot be altered or
erased through the application.

## Acceptance criteria

- [x] Registration provisions user, restaurant, roles, membership atomically
- [x] Passwords hashed with Argon2id at OWASP parameters
- [x] Sessions stored server-side; only an HMAC of the token is persisted
- [x] Sign-out deletes the session row, not just the cookie
- [x] Password reset revokes every existing session
- [x] Reset tokens are single-use and expire in one hour
- [x] Google linking to an existing account requires a Google-verified email
- [x] A tenant cannot read, update, insert or delete another tenant's rows
- [x] Absent tenant context yields no rows (fail closed)
- [x] Owner role holds every permission and cannot be edited
- [x] Audit entries cannot be updated or deleted by the application
- [x] The app refuses to boot in production if connected as an RLS-bypassing role
- [ ] Verified against a live database (blocked: PostgreSQL not yet installed)
