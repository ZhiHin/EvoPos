/**
 * Typed application errors.
 *
 * Route handlers map these to status codes in one place (src/lib/api.ts), so
 * services can throw meaningfully without importing anything HTTP-shaped --
 * which is what keeps them reusable from server actions, background jobs and
 * tests alike.
 */

export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number
  /** Field-level messages, shaped for form rendering. */
  readonly details?: Record<string, string[]>

  constructor(
    code: AppErrorCode,
    message: string,
    status: number,
    details?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** No valid session. The caller should be sent to sign in. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'You must be signed in to do that.') {
    super('UNAUTHENTICATED', message, 401)
    this.name = 'UnauthenticatedError'
  }
}

/** Authenticated, but not permitted. Distinct from 401 on purpose. */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.') {
    super('FORBIDDEN', message, 403)
    this.name = 'ForbiddenError'
  }
}

/**
 * Also used where a record exists but belongs to another tenant.
 *
 * Returning 404 rather than 403 in that case is deliberate: a 403 would
 * confirm that the id is real, which leaks the existence of another
 * restaurant's data to anyone willing to enumerate ids.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super('NOT_FOUND', message, 404)
    this.name = 'NotFoundError'
  }
}

export class ValidationError extends AppError {
  constructor(
    message = 'Some of the information provided is not valid.',
    details?: Record<string, string[]>,
  ) {
    super('VALIDATION_FAILED', message, 422, details)
    this.name = 'ValidationError'
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That conflicts with something that already exists.') {
    super('CONFLICT', message, 409)
    this.name = 'ConflictError'
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many attempts. Try again shortly.') {
    super('RATE_LIMITED', message, 429)
    this.name = 'RateLimitError'
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
