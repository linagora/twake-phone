/**
 * Response headers every answer of the Gateway carries. The Gateway is an API: nothing it serves is meant to be
 * rendered or framed, and nothing it answers is meant to be cached by a browser (every answer is personal).
 * The OpenAPI UI under /docs is the one page it serves: it keeps a policy that lets it run.
 */
export interface SecurityOptions {
  /** Strict-Transport-Security max-age in seconds, once the Gateway is served over TLS (HSTS_MAX_AGE); 0 retracts it. Absent: no HSTS. */
  hstsMaxAge?: number
  /** Extends HSTS to the subdomains (HSTS_INCLUDE_SUBDOMAINS=1): only when every one of them is served over TLS. */
  hstsIncludeSubDomains?: boolean
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'"
/** The OpenAPI UI loads its own scripts from /docs/static and sets its styles inline. */
export const DOCS_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"

export const securityHeadersFor = (path: string, opts: SecurityOptions = {}): Record<string, string> => {
  const docs = path === '/docs' || path.startsWith('/docs/')
  return {
    'content-security-policy': docs ? DOCS_CSP : API_CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...(docs ? {} : { 'cache-control': 'no-store' }),
    ...(opts.hstsMaxAge !== undefined ? { 'strict-transport-security': `max-age=${opts.hstsMaxAge}${opts.hstsIncludeSubDomains ? '; includeSubDomains' : ''}` } : {})
  }
}
