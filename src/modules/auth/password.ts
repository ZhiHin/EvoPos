import { hash, verify, type Algorithm } from '@node-rs/argon2'

/**
 * Argon2id. Spelled as a literal because the library declares `Algorithm` as
 * an ambient const enum, which `isolatedModules` forbids reading as a value.
 * It is stated explicitly rather than left to the library default: which
 * Argon2 variant hashes a password is not something a reader should have to
 * take on trust.
 */
const ARGON2ID: Algorithm = 2

/**
 * Argon2id parameters, at OWASP's recommended floor for the 19 MiB profile:
 * m = 19456 KiB, t = 2, p = 1.
 *
 * Memory cost is the parameter that actually resists GPU and ASIC cracking;
 * raising `timeCost` while leaving memory low buys much less than it appears
 * to. Tune upward on production hardware, not downward.
 *
 * No pepper. Adding one would strengthen the database-disclosure case, but it
 * permanently couples every stored hash to a secret that then cannot be
 * rotated without invalidating every password in the system. That trade is
 * worth revisiting deliberately -- not worth inheriting by accident.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS)
}

/**
 * Returns false rather than throwing on a malformed or corrupt hash, so a bad
 * row in the database reads as "wrong password" instead of a 500 that tells
 * an attacker something interesting about the account.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS)
  } catch {
    return false
  }
}

/**
 * Burns roughly the same CPU as a real verification.
 *
 * Called when login is attempted against an address with no account, or
 * against an account that only has Google sign-in. Without it, "no such user"
 * returns in microseconds while a real failed password takes ~50ms, and that
 * gap alone lets anyone enumerate which email addresses are registered.
 */
const DUMMY_HASH_PLAINTEXT = 'ros-timing-equalisation-placeholder'
let dummyHash: string | null = null

export async function equaliseTiming(): Promise<void> {
  dummyHash ??= await hashPassword(DUMMY_HASH_PLAINTEXT)
  await verifyPassword(dummyHash, 'not-the-right-password')
}
