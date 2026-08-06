import { eq } from 'drizzle-orm'
import * as client from 'openid-client'

import { db } from '@/lib/db'
import { oauthAccounts, users } from '@/lib/db/schema'
import { env, isGoogleAuthEnabled } from '@/lib/env'
import { AppError, ForbiddenError } from '@/lib/errors'

/**
 * Google sign-in over OpenID Connect.
 *
 * Uses `openid-client` rather than hand-rolled fetch calls specifically for
 * ID token handling: verifying the JWT signature against Google's rotating
 * JWKS, and checking `iss`, `aud`, `exp` and `nonce`. Skipping any of those
 * turns "sign in with Google" into "sign in as anyone", since an unverified
 * token is just a JSON blob the client hands us.
 */

const GOOGLE_ISSUER = new URL('https://accounts.google.com')

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback'

export function googleRedirectUri(): string {
  return new URL(GOOGLE_CALLBACK_PATH, env.APP_URL).toString()
}

/**
 * Discovery result, cached for the process lifetime. Refetching Google's
 * well-known document on every sign-in would add a network round trip to each
 * login and needlessly rate-limit us against Google.
 */
let configPromise: Promise<client.Configuration> | null = null

function getConfig(): Promise<client.Configuration> {
  if (!isGoogleAuthEnabled) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Google sign-in is not configured on this server.',
      501,
    )
  }

  configPromise ??= client.discovery(
    GOOGLE_ISSUER,
    env.GOOGLE_CLIENT_ID!,
    env.GOOGLE_CLIENT_SECRET!,
  )

  return configPromise
}

export interface GoogleAuthRequest {
  url: string
  state: string
  nonce: string
  codeVerifier: string
}

/**
 * Builds the authorization URL along with the three values that must survive
 * until the callback.
 *
 * Each defends a different attack:
 *   - codeVerifier (PKCE) binds the authorization code to this browser, so an
 *     intercepted code cannot be redeemed elsewhere;
 *   - state binds the callback to this request, defeating CSRF on the
 *     redirect;
 *   - nonce binds the ID token to this request, defeating token replay.
 */
export async function buildGoogleAuthRequest(): Promise<GoogleAuthRequest> {
  const config = await getConfig()

  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = client.randomState()
  const nonce = client.randomNonce()

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: googleRedirectUri(),
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })

  return { url: url.toString(), state, nonce, codeVerifier }
}

export interface GoogleIdentity {
  subject: string
  email: string
  emailVerified: boolean
  name: string
  picture: string | null
}

/** Exchanges the code and returns verified claims. */
export async function exchangeGoogleCode(
  currentUrl: URL,
  expected: { state: string; nonce: string; codeVerifier: string },
): Promise<GoogleIdentity> {
  const config = await getConfig()

  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: expected.codeVerifier,
    expectedState: expected.state,
    expectedNonce: expected.nonce,
  })

  const claims = tokens.claims()
  if (!claims) {
    throw new ForbiddenError('Google did not return a valid identity token.')
  }

  const email = typeof claims.email === 'string' ? claims.email : null
  if (!email) {
    throw new ForbiddenError(
      'Your Google account did not share an email address.',
    )
  }

  return {
    subject: claims.sub,
    email: email.trim().toLowerCase(),
    emailVerified: claims.email_verified === true,
    name:
      (typeof claims.name === 'string' ? claims.name : null) ??
      email.split('@')[0],
    picture: typeof claims.picture === 'string' ? claims.picture : null,
  }
}

/**
 * Resolves a Google identity to a local user, creating or linking as needed.
 *
 * The `email_verified` check on the linking path is the load-bearing line in
 * this file. Google issues tokens for accounts whose address it has not
 * verified; linking on an unverified address would let anyone register a
 * Google account claiming owner@somerestaurant.com and be handed that
 * restaurant's existing account. An already-linked subject is unaffected --
 * only the first-time match on email is gated.
 */
export async function resolveGoogleUser(
  identity: GoogleIdentity,
): Promise<{ userId: string; isNewUser: boolean }> {
  return db.transaction(async (tx) => {
    const [linked] = await tx
      .select({ userId: oauthAccounts.userId })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.providerAccountId, identity.subject))
      .limit(1)

    if (linked) {
      return { userId: linked.userId, isNewUser: false }
    }

    const [existing] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.email, identity.email))
      .limit(1)

    if (existing) {
      if (!identity.emailVerified) {
        throw new ForbiddenError(
          'Google has not verified that email address, so it cannot be linked to an existing account. Sign in with your password instead.',
        )
      }

      if (existing.status !== 'active') {
        throw new ForbiddenError('This account has been suspended.')
      }

      await tx.insert(oauthAccounts).values({
        userId: existing.id,
        provider: 'google',
        providerAccountId: identity.subject,
      })

      // Signing in through a verified Google address proves control of the
      // mailbox, so an unverified local account becomes verified here.
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, existing.id))

      return { userId: existing.id, isNewUser: false }
    }

    const [created] = await tx
      .insert(users)
      .values({
        email: identity.email,
        name: identity.name,
        avatarUrl: identity.picture,
        // No passwordHash: this account has no password until one is set.
        emailVerifiedAt: identity.emailVerified ? new Date() : null,
      })
      .returning({ id: users.id })

    await tx.insert(oauthAccounts).values({
      userId: created.id,
      provider: 'google',
      providerAccountId: identity.subject,
    })

    return { userId: created.id, isNewUser: true }
  })
}
