// The HTTP response policy of the app: Content Security Policy and the other security headers. Exported on its own
// so the policy can be tested without a server, and read by whoever fronts the app with another server.

const origin = url => new URL(url).origin
const wsOrigin = url => origin(url).replace(/^http/, 'ws')

/** One CSP source: a keyword, a scheme, a host (with optional scheme, port and wildcard). Nothing that could end the directive. */
const SOURCE = /^('self'|'none'|[a-z][a-z0-9+.-]*:|(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*\.)?[a-z0-9.-]+(?::(?:\d+|\*))?)$/i
const sources = (name, list) => {
  for (const item of list) if (!SOURCE.test(item)) throw new Error(`${name}: ${JSON.stringify(item)} is not a CSP source (an origin such as https://chat.example.org, or 'none')`)
  return list
}

/**
 * The policy the served page runs under. Scripts, styles and fonts are the build's only; the page connects to the
 * Gateway (REST and WebSocket) and to the identity provider, plus what `connectSrc` adds (the SIP WebSocket of step 3);
 * `frameAncestors` says who may embed the app ("'none'" by default; the Twake origins once Twake Chat shows it).
 */
export const contentSecurityPolicy = ({ gatewayUrl, oidcAuthority, frameAncestors = ["'none'"], connectSrc = [] }) => {
  for (const [name, value] of Object.entries({ gatewayUrl, oidcAuthority })) {
    if (typeof value !== 'string' || !/^https?:\/\//.test(value)) throw new Error(`${name} must be an http(s) URL`)
  }
  const connect = [...new Set(["'self'", origin(gatewayUrl), wsOrigin(gatewayUrl), origin(oidcAuthority), ...sources('connectSrc', connectSrc)])]
  sources('frameAncestors', frameAncestors)
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    // The service worker of the notifications (public/sw.js, step 5): ours only.
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors.join(' ')}`
  ].join('; ')
}

/** Headers of every answer. X-Frame-Options only when nobody may frame the app: with ancestors allowed, the CSP decides. */
export const securityHeaders = ({ csp, frameAncestors = ["'none'"], hstsMaxAge, hstsIncludeSubDomains = false }) => ({
  'content-security-policy': csp,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // Step 3 needs the microphone, for this origin only; nothing else.
  'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
  ...(frameAncestors.length === 1 && frameAncestors[0] === "'none'" ? { 'x-frame-options': 'DENY' } : {}),
  // max-age=0 retracts a policy sent earlier; subdomains only on request, when every one of them is served over TLS.
  ...(hstsMaxAge !== undefined ? { 'strict-transport-security': `max-age=${hstsMaxAge}${hstsIncludeSubDomains ? '; includeSubDomains' : ''}` } : {})
})

/** A space- or comma-separated list from the environment. */
export const parseList = value => (value ?? '').split(/[\s,]+/).filter(Boolean)

/**
 * What the server needs, from the environment: the runtime config.json it serves (GATEWAY_URL, OIDC_AUTHORITY,
 * OIDC_CLIENT_ID, optional OIDC_SCOPE, OIDC_PROMPT, OIDC_RESOURCE), and the policy (FRAME_ANCESTORS, CONNECT_SRC,
 * HSTS_MAX_AGE, HSTS_INCLUDE_SUBDOMAINS=1). A missing or malformed value is a deployment error, named.
 */
export const settingsFromEnv = env => {
  const need = name => {
    if (!env[name]) throw new Error(`${name} is required`)
    return env[name]
  }
  const config = {
    gatewayUrl: need('GATEWAY_URL'),
    oidc: {
      authority: need('OIDC_AUTHORITY'),
      clientId: need('OIDC_CLIENT_ID'),
      ...(env.OIDC_SCOPE ? { scope: env.OIDC_SCOPE } : {}),
      ...(env.OIDC_PROMPT !== undefined ? { prompt: env.OIDC_PROMPT } : {}),
      ...(env.OIDC_RESOURCE ? { resource: env.OIDC_RESOURCE } : {})
    }
  }
  const frameAncestors = parseList(env.FRAME_ANCESTORS)
  const hstsMaxAge = env.HSTS_MAX_AGE ? Number(env.HSTS_MAX_AGE) : undefined
  if (hstsMaxAge !== undefined && !(Number.isInteger(hstsMaxAge) && hstsMaxAge >= 0)) throw new Error('HSTS_MAX_AGE must be a number of seconds')
  const policy = {
    ...(frameAncestors.length ? { frameAncestors } : {}),
    connectSrc: parseList(env.CONNECT_SRC),
    ...(hstsMaxAge !== undefined ? { hstsMaxAge, hstsIncludeSubDomains: env.HSTS_INCLUDE_SUBDOMAINS === '1' } : {})
  }
  // Checked now, so a bad value stops the start, not a page.
  contentSecurityPolicy({ gatewayUrl: config.gatewayUrl, oidcAuthority: config.oidc.authority, ...policy })
  return {
    config,
    policy,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0'
  }
}
