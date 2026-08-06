import { createHmac, randomBytes } from 'node:crypto'

import { env } from '@/lib/env'

/**
 * Opaque bearer tokens for sessions, password resets and email verification.
 *
 * The plaintext token goes to the user (in a cookie or an emailed link); only
 * its HMAC is written to the database. A dump of the `sessions` or
 * `verification_tokens` table therefore yields nothing an attacker can
 * present back to the server.
 *
 * HMAC-SHA256 rather than a slow hash on purpose: these are 256 bits of
 * output from a CSPRNG, not user-chosen secrets, so there is no dictionary to
 * defend against and no reason to pay Argon2's cost on every request. The
 * keyed construction is what matters -- a plain SHA-256 digest could be
 * precomputed against a leaked table without knowing AUTH_SECRET.
 *
 * Being deterministic, the HMAC doubles as the primary key, so session lookup
 * is a single indexed read.
 */

const TOKEN_BYTES = 32

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export function hashToken(token: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update(token).digest('base64url')
}
