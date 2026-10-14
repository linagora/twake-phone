/**
 * Response headers every answer of the Gateway carries. The Gateway is an API: nothing it serves is meant to be
 * rendered or framed, and nothing it answers is meant to be cached by a browser (every answer is personal).
 * The OpenAPI UI under /docs is the one page it serves: it keeps a policy that lets it run.
 */
export interface SecurityOptions {
  /** Strict-Transport-Security max-age in seconds, once the Gateway is served over TLS (HSTS_MAX_AGE). Absent: no HSTS. */
  hstsMaxAge?: number
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'"
export const DOCS_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"

export const securityHeadersFor = (path: string, opts: SecurityOptions = {}): Record<string, string> => {
  const docs = path === '/docs' || path.startsWith('/docs/')
  return {
    'content-security-policy': docs ? DOCS_CSP : API_CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...(docs ? {} : { 'cache-control': 'no-store' }),
    ...(opts.hstsMaxAge ? { 'strict-transport-security': `max-age=${opts.hstsMaxAge}; includeSubDomains` } : {})
  }
}
