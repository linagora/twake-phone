import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, securityHeaders, settingsFromEnv } from './policy.mjs'

describe('contentSecurityPolicy', () => {
  it('lets the app talk to the Gateway (REST and WebSocket) and the identity provider, and nothing else', () => {
    const csp = contentSecurityPolicy({ gatewayUrl: 'https://phone-api.example.org/', oidcAuthority: 'https://auth.example.org/oidc' })
    expect(csp).toContain("connect-src 'self' https://phone-api.example.org wss://phone-api.example.org https://auth.example.org")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    // The service worker of the notifications, from the app's own origin only.
    expect(csp).toContain("worker-src 'self'")
    // The recordings of the mailbox, played from what the page fetched (blob:), nothing from elsewhere.
    expect(csp).toContain("media-src 'self' blob:")
    expect(csp).not.toContain('unsafe')
  })
  it('adds the extra connect origins and the allowed ancestors', () => {
    const csp = contentSecurityPolicy({ gatewayUrl: 'http://127.0.0.1:8080', oidcAuthority: 'http://127.0.0.1:9000', connectSrc: ['wss://sip.example.org'], frameAncestors: ['https://chat.example.org', 'https://example.org'] })
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:8080 ws://127.0.0.1:8080 http://127.0.0.1:9000 wss://sip.example.org")
    expect(csp).toContain('frame-ancestors https://chat.example.org https://example.org')
  })
  it('refuses a Gateway or provider that is not an http(s) URL', () => {
    expect(() => contentSecurityPolicy({ gatewayUrl: 'phone-api', oidcAuthority: 'https://auth.example.org' })).toThrow(/gatewayUrl/)
    expect(() => contentSecurityPolicy({ gatewayUrl: 'https://x', oidcAuthority: '' })).toThrow(/oidcAuthority/)
  })
  it('refuses an extra source that is not a source: nothing from the environment can add a directive', () => {
    const base = { gatewayUrl: 'https://x', oidcAuthority: 'https://y' }
    for (const bad of ['x; default-src *', "'unsafe-inline'", 'https://a b', 'a,b', '*']) {
      expect(() => contentSecurityPolicy({ ...base, connectSrc: [bad] }), bad).toThrow(/connectSrc/)
      expect(() => contentSecurityPolicy({ ...base, frameAncestors: [bad] }), bad).toThrow(/frameAncestors/)
    }
    for (const ok of ["'self'", "'none'", 'https://chat.example.org', 'wss://sip.example.org:5061', '*.example.org', 'https://*.example.org', 'http://localhost:*', 'wss:']) {
      expect(contentSecurityPolicy({ ...base, connectSrc: [ok] }), ok).toContain(ok)
    }
  })
})

describe('securityHeaders', () => {
  it('denies framing by default, and lets the CSP decide once ancestors are allowed', () => {
    const none = securityHeaders({ csp: 'x' })
    expect(none['x-frame-options']).toBe('DENY')
    expect(none['x-content-type-options']).toBe('nosniff')
    expect(none['referrer-policy']).toBe('no-referrer')
    expect(none['permissions-policy']).toContain('microphone=(self)')
    expect(none['strict-transport-security']).toBeUndefined()
    const some = securityHeaders({ csp: 'x', frameAncestors: ['https://chat.example.org'], hstsMaxAge: 63072000 })
    expect(some['x-frame-options']).toBeUndefined()
    expect(some['strict-transport-security']).toBe('max-age=63072000')
    expect(securityHeaders({ csp: 'x', hstsMaxAge: 63072000, hstsIncludeSubDomains: true })['strict-transport-security']).toBe('max-age=63072000; includeSubDomains')
    expect(securityHeaders({ csp: 'x', hstsMaxAge: 0 })['strict-transport-security']).toBe('max-age=0')
  })
})

describe('settingsFromEnv', () => {
  const base = { GATEWAY_URL: 'https://phone-api.example.org', OIDC_AUTHORITY: 'https://auth.example.org', OIDC_CLIENT_ID: 'twakephone' }
  it('builds the config.json and the policy from the environment', () => {
    const s = settingsFromEnv({ ...base, OIDC_RESOURCE: 'https://phone-api.example.org', OIDC_PROMPT: '', FRAME_ANCESTORS: 'https://chat.example.org, https://example.org', CONNECT_SRC: 'wss://sip.example.org', HSTS_MAX_AGE: '31536000', PORT: '3000' })
    expect(s.config).toEqual({ gatewayUrl: 'https://phone-api.example.org', oidc: { authority: 'https://auth.example.org', clientId: 'twakephone', prompt: '', resource: 'https://phone-api.example.org' } })
    expect(s.policy).toEqual({ frameAncestors: ['https://chat.example.org', 'https://example.org'], connectSrc: ['wss://sip.example.org'], hstsMaxAge: 31536000, hstsIncludeSubDomains: false })
    expect(s.port).toBe(3000)
  })
  it('names the missing value, and refuses a bad HSTS age', () => {
    expect(() => settingsFromEnv({})).toThrow(/GATEWAY_URL is required/)
    expect(() => settingsFromEnv({ GATEWAY_URL: 'x' })).toThrow(/OIDC_AUTHORITY is required/)
    expect(() => settingsFromEnv({ ...base, HSTS_MAX_AGE: 'forever' })).toThrow(/HSTS_MAX_AGE/)
    expect(() => settingsFromEnv({ ...base, FRAME_ANCESTORS: 'https://a; script-src *' })).toThrow(/frameAncestors/)
    expect(settingsFromEnv({ ...base, HSTS_MAX_AGE: '0' }).policy).toMatchObject({ hstsMaxAge: 0 })
    expect(settingsFromEnv(base).policy).toEqual({ connectSrc: [] })
  })
})
