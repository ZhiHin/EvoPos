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
 * token, and everything a stranger can learn from reading the sticker is
 * nothing.
 */
export function qrPayloadUrl(token: string): string {
  return new URL(`/t/${token}`, env.APP_URL).toString()
}

/**
 * Rejects anything not shaped like one of our tokens before it reaches the
 * database, so malformed scans cost no query and no transaction.
 */
export function isWellFormedQrToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(token)
}
