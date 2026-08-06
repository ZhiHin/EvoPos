import { NextResponse, type NextRequest } from 'next/server'

/**
 * Redirect convenience ONLY. This is not a security boundary.
 *
 * (Next 16 renamed this file convention from `middleware` to `proxy`; the
 * semantics are unchanged.)
 *
 * Proxy runs on the edge runtime, where the database is unreachable, so it
 * can see that a cookie exists but cannot tell whether it names a live
 * session, an expired one, or a value someone typed by hand. Treating that as
 * authentication would mean any string in the right cookie grants entry.
 *
 * Real enforcement lives in `requireAuth` / `requireTenant` /
 * `requirePermission` (src/lib/auth/context.ts), which every protected layout,
 * page and route handler calls. What happens here only saves a signed-out
 * visitor a render before they are bounced to /login.
 */

const SESSION_COOKIES = ['__Host-ros_session', 'ros_session']

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/settings',
  '/staff',
  '/branches',
  '/select-restaurant',
  '/onboarding',
]

const AUTH_PAGES = ['/login', '/register']

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  /**
   * Public QR scan. Deliberately reachable with no session — a diner scanning
   * a table has no account and needs none.
   *
   * Stated explicitly rather than relying on it simply not matching
   * PROTECTED_PREFIXES, so a later edit to that list cannot accidentally
   * capture it and break every printed QR in the estate.
   */
  if (pathname.startsWith('/t/')) return NextResponse.next()

  const hasSessionCookie = SESSION_COOKIES.some((name) =>
    request.cookies.has(name),
  )

  if (
    !hasSessionCookie &&
    PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    const url = new URL('/login', request.url)
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (hasSessionCookie && AUTH_PAGES.includes(pathname)) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the API. API routes run their own
     * guards and must return JSON 401s rather than a redirect to an HTML
     * page, which is what a fetch() caller can actually handle.
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
