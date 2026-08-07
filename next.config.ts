import type { NextConfig } from 'next'

/**
 * Response headers, applied to everything.
 *
 * Set here rather than in the proxy so they cover static assets and API
 * responses too — a Content-Security-Policy that only covers pages leaves the
 * routes that return JSON uncovered, and those are the ones an attacker would
 * rather reach.
 */
const securityHeaders = [
  /**
   * Stops a browser second-guessing a Content-Type. Without it a JSON response
   * containing attacker-controlled text can be sniffed as HTML and executed as
   * a page on this origin.
   */
  { key: 'X-Content-Type-Options', value: 'nosniff' },

  /**
   * Clickjacking. A POS runs on a screen somebody walks past; framing it
   * inside another site to capture a till action is a real shape of attack,
   * not a theoretical one.
   */
  { key: 'X-Frame-Options', value: 'DENY' },

  /**
   * A referrer carries the URL — which in this app includes session ids and
   * table ids. Send the origin off-site and nothing more.
   */
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

  /**
   * Nothing here needs a camera, a microphone or a location, so nothing here
   * should be able to ask for one. Denying by default means a future
   * dependency cannot quietly start.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },

  /**
   * HSTS. Two years, subdomains included.
   *
   * `preload` is deliberately absent: it is effectively irreversible, and
   * committing someone else's domain to a browser-baked list is not a decision
   * a framework config should make on their behalf. A deployment that wants it
   * can add it knowingly.
   */
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
]

const nextConfig: NextConfig = {
  poweredByHeader: false,

  headers() {
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }])
  },
}

export default nextConfig
