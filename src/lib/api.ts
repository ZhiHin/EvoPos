import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { AppError, ForbiddenError, isAppError } from './errors'
import { env, isProduction } from './env'

/**
 * Shared plumbing for route handlers: error shaping, request metadata, and
 * the same-origin check.
 */

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: Record<string, string[]>
  }
}

/**
 * Maps a thrown value to a response.
 *
 * Anything that is not a recognised AppError is logged in full and reported
 * as a bare 500. Echoing an unexpected error's message back to the client is
 * how connection strings, file paths and SQL fragments end up in a browser.
 */
export function toErrorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof ZodError) {
    const details: Record<string, string[]> = {}
    for (const issue of error.issues) {
      const key = issue.path.join('.') || '_'
      ;(details[key] ??= []).push(issue.message)
    }
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the information provided is not valid.',
          details,
        },
      },
      { status: 422 },
    )
  }

  if (isAppError(error)) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    )
  }

  console.error('Unhandled error in route handler:', error)

  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong. Please try again.',
      },
    },
    { status: 500 },
  )
}

/** Wraps a handler so every thrown AppError becomes a proper response. */
export function withRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args)
    } catch (error) {
      return toErrorResponse(error)
    }
  }
}

/**
 * CSRF defence for state-changing route handlers.
 *
 * The session cookie is SameSite=Lax, which already blocks cross-site POSTs,
 * but Lax is a browser behaviour rather than a server-side guarantee -- it
 * does nothing for a non-browser client replaying a captured cookie, and it
 * has historically had gaps. Comparing Origin against the configured APP_URL
 * is the server-side half of the pair.
 *
 * A missing Origin header is rejected on state-changing requests: browsers
 * always send it on POST, so its absence means the caller is not the browser
 * flow this endpoint is written for.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin')

  if (!origin) {
    throw new ForbiddenError('Missing Origin header.')
  }

  const allowed = new URL(env.APP_URL).origin
  if (origin !== allowed) {
    throw new ForbiddenError('Cross-origin request rejected.')
  }
}

/**
 * Client IP and user agent, for rate limiting and the audit trail.
 *
 * `x-forwarded-for` is only trustworthy behind a proxy that overwrites it.
 * Directly exposed, it is attacker-controlled -- which for rate limiting
 * means anyone can rotate the header and get a fresh budget on every
 * request. Treat these values as a hint, never as identity.
 */
export function getRequestMetadata(request: Request): {
  ipAddress: string | null
  userAgent: string | null
} {
  const forwarded = request.headers.get('x-forwarded-for')
  const ipAddress =
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null

  return {
    ipAddress,
    userAgent: request.headers.get('user-agent'),
  }
}

/** Rejects non-JSON bodies before parsing. */
export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Expected a JSON request body.',
      415,
    )
  }
  return (await request.json()) as T
}

export { isProduction }
