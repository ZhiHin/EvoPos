import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { withRoute } from '@/lib/api'
import { isProduction } from '@/lib/env'
import { buildGoogleAuthRequest } from '@/modules/auth/google'

/**
 * Starts the Google sign-in redirect.
 *
 * The PKCE verifier, state and nonce have to survive a round trip through
 * Google, so they are parked in short-lived httpOnly cookies. They are
 * secrets for the duration of the flow -- a readable verifier would defeat
 * the point of PKCE -- and the ten minute lifetime bounds how long a
 * half-finished flow stays resumable.
 */

const FLOW_TTL_SECONDS = 10 * 60

export const OAUTH_STATE_COOKIE = 'ros_oauth_state'
export const OAUTH_NONCE_COOKIE = 'ros_oauth_nonce'
export const OAUTH_VERIFIER_COOKIE = 'ros_oauth_verifier'

export const GET = withRoute(async () => {
  const flow = await buildGoogleAuthRequest()
  const store = await cookies()

  const options = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: FLOW_TTL_SECONDS,
  }

  store.set(OAUTH_STATE_COOKIE, flow.state, options)
  store.set(OAUTH_NONCE_COOKIE, flow.nonce, options)
  store.set(OAUTH_VERIFIER_COOKIE, flow.codeVerifier, options)

  return NextResponse.redirect(flow.url)
})
