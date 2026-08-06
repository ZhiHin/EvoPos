/**
 * Browser-side fetch helper.
 *
 * Unwraps the error envelope produced by src/lib/api.ts so forms can render
 * field-level messages without every component reimplementing the shape.
 */

export class ApiClientError extends Error {
  readonly code: string
  readonly details?: Record<string, string[]>

  constructor(
    message: string,
    code = 'INTERNAL',
    details?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.details = details
  }

  /** First message for a field, for inline display under an input. */
  fieldError(field: string): string | undefined {
    return this.details?.[field]?.[0]
  }
}

async function send<TResponse>(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<TResponse> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    // Same-origin credentials are the default, but stating it makes the
    // session cookie requirement explicit at the call site.
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new ApiClientError(
      payload?.error?.message ?? 'Something went wrong. Please try again.',
      payload?.error?.code ?? 'INTERNAL',
      payload?.error?.details,
    )
  }

  return payload as TResponse
}

export function postJson<TResponse>(
  url: string,
  body: unknown,
): Promise<TResponse> {
  return send<TResponse>('POST', url, body)
}

export function patchJson<TResponse>(
  url: string,
  body: unknown,
): Promise<TResponse> {
  return send<TResponse>('PATCH', url, body)
}

/**
 * A body is still sent, because `assertSameOrigin` requires an Origin header
 * and `readJson` requires a JSON content type on every state-changing route.
 */
export function deleteJson<TResponse>(url: string): Promise<TResponse> {
  return send<TResponse>('DELETE', url)
}
