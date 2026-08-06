import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { getRequestMetadata, withRoute } from '@/lib/api'
import { env } from '@/lib/env'
import { ForbiddenError } from '@/lib/errors'
import { exchangeGoogleCode, resolveGoogleUser } from '@/modules/auth/google'
import { listTenantsForUser } from '@/modules/rbac/rbac.repository'
import {
  createSession,
  setActiveTenant,
  setSessionCookie,
} from '@/modules/auth/session'
import { hashToken } from '@/modules/auth/tokens'
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
} from '../route'

/**
 * Completes the Google flow.
 *
 * Errors redirect to the sign-in page with a short code rather than
 * rendering a JSON body, because the user arrives here by browser navigation
 * and a raw error object is not a sign-in page.
 */
function failure(reason: string): NextResponse {
  const url = new URL('/login', env.APP_URL)
  url.searchParams.set('error', reason)
  return NextResponse.redirect(url)
}

export const GET = withRoute(async (request: Request) => {
  const store = await cookies()

  const state = store.get(OAUTH_STATE_COOKIE)?.value
  const nonce = store.get(OAUTH_NONCE_COOKIE)?.value
  const codeVerifier = store.get(OAUTH_VERIFIER_COOKIE)?.value

  // Consumed regardless of outcome, so a failed or abandoned attempt cannot
  // be replayed with the same state.
  store.delete(OAUTH_STATE_COOKIE)
  store.delete(OAUTH_NONCE_COOKIE)
  store.delete(OAUTH_VERIFIER_COOKIE)

  if (!state || !nonce || !codeVerifier) {
    // Expired, or a callback that never had a matching start -- which is what
    // a CSRF attempt against this endpoint looks like.
    return failure('oauth_expired')
  }

  let userId: string
  try {
    const identity = await exchangeGoogleCode(new URL(request.url), {
      state,
      nonce,
      codeVerifier,
    })
    const resolved = await resolveGoogleUser(identity)
    userId = resolved.userId
  } catch (error) {
    if (error instanceof ForbiddenError) {
      console.warn('Google sign-in rejected:', error.message)
      return failure('oauth_rejected')
    }
    console.error('Google sign-in failed:', error)
    return failure('oauth_failed')
  }

  const session = await createSession(userId, getRequestMetadata(request))
  await setSessionCookie(session.token, session.expiresAt)

  const tenants = await listTenantsForUser(userId)

  /**
   * A Google account with no membership is someone who has signed in but does
   * not yet belong to a restaurant -- they need onboarding, not a dashboard.
   * With exactly one, skip the picker.
   */
  if (tenants.length === 0) {
    return NextResponse.redirect(new URL('/onboarding', env.APP_URL))
  }

  if (tenants.length === 1) {
    await setActiveTenant(hashToken(session.token), tenants[0].id)
    return NextResponse.redirect(new URL('/dashboard', env.APP_URL))
  }

  return NextResponse.redirect(new URL('/select-restaurant', env.APP_URL))
})
