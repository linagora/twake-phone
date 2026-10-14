// The HTTP response policy of the app: Content Security Policy and the other security headers. Exported on its own
// so the policy can be tested without a server, and read by whoever fronts the app with another server.

const origin = url => new URL(url).origin
const wsOrigin = url => origin(url).replace(/^http/, 'ws')

/**
 * The policy the served page runs under. Scripts, styles and fonts are the build's only; the page connects to the
 * Gateway (REST and WebSocket) and to the identity provider, plus what `connectSrc` adds (the SIP WebSocket of step 3);
 * `frameAncestors` says who may embed the app ("'none'" by default; the Twake origins once Twake Chat shows it).
 */
export const contentSecurityPolicy = ({ gatewayUrl, oidcAuthority, frameAncestors = ["'none'"], connectSrc = [] }) => {
  for (const [name, value] of Object.entries({ gatewayUrl, oidcAuthority })) {
    if (typeof value !== 'string' || !/^https?:\/\//.test(value)) throw new Error(`${name} must be an http(s) URL`)
  }
  const connect = [...new Set(["'self'", origin(gatewayUrl), wsOrigin(gatewayUrl), origin(oidcAuthority), ...connectSrc])]
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors.join(' ')}`
  ].join('; ')
}

/** Headers of every answer. X-Frame-Options only when nobody may frame the app: with ancestors allowed, the CSP decides. */
export const securityHeaders = ({ csp, frameAncestors = ["'none'"], hstsMaxAge }) => ({
  'content-security-policy': csp,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // Step 3 needs the microphone, for this origin only; nothing else.
  'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
  ...(frameAncestors.length === 1 && frameAncestors[0] === "'none'" ? { 'x-frame-options': 'DENY' } : {}),
  ...(hstsMaxAge ? { 'strict-transport-security': `max-age=${hstsMaxAge}; includeSubDomains` } : {})
})

/** A space- or comma-separated list from the environment. */
export const parseList = value => (value ?? '').split(/[\s,]+/).filter(Boolean)

/**
 * What the server needs, from the environment: the runtime config.json it serves (GATEWAY_URL, OIDC_AUTHORITY,
 * OIDC_CLIENT_ID, optional OIDC_SCOPE, OIDC_PROMPT, OIDC_RESOURCE), and the policy (FRAME_ANCESTORS, CONNECT_SRC,
 * HSTS_MAX_AGE). A missing value is a deployment error, named.
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
  return {
    config,
    policy: { ...(frameAncestors.length ? { frameAncestors } : {}), connectSrc: parseList(env.CONNECT_SRC), ...(hstsMaxAge ? { hstsMaxAge } : {}) },
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0'
  }
}
