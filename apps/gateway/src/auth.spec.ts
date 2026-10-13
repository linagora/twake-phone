import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { CozyAuthenticator, DevAuthenticator, JwtAuthenticator, TicketStore, authenticatorFromEnv, hostAwareFetch } from './auth.js'

const req = (headers: Record<string, string> = {}, query: Record<string, string> = {}) => ({ headers, query }) as never
const cozyOk = (attrs: Record<string, string>) => vi.fn(async () => new Response(JSON.stringify({ data: { attributes: attrs } }), { status: 200 }))

describe('CozyAuthenticator', () => {
  const base = { instancePattern: /^https:\/\/[a-z0-9-]+\.twake\.local$/, defaultTenant: 'dev' }

  it('asks the instance who the token belongs to', async () => {
    const fetchImpl = cozyOk({ oidc_id: 'user1', public_name: 'User One', org_id: '' })
    const id = await new CozyAuthenticator({ ...base, fetchImpl }).authenticate(req({ authorization: 'Bearer tok', 'x-cozy-instance': 'https://user1.twake.local' }))
    expect(id).toEqual({ userId: 'user1', tenantId: 'dev', displayName: 'User One' })
    expect(fetchImpl).toHaveBeenCalledWith('https://user1.twake.local/settings/instance', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer tok' }) }))
  })

  it('takes the tenant from the organisation of the instance', async () => {
    const id = await new CozyAuthenticator({ ...base, fetchImpl: cozyOk({ oidc_id: 'a', org_id: 'acme' }) }).authenticate(req({ authorization: 'Bearer t', 'x-cozy-instance': 'https://a.twake.local' }))
    expect(id.tenantId).toBe('acme')
  })

  it('refuses a token the stack does not recognise', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(new CozyAuthenticator({ ...base, fetchImpl }).authenticate(req({ authorization: 'Bearer bad', 'x-cozy-instance': 'https://user1.twake.local' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('treats the 400 that cozy-stack answers to an unknown token as unauthenticated, not as an outage', async () => {
    const fetchImpl = vi.fn(async () => new Response('Invalid JWT token', { status: 400 }))
    await expect(new CozyAuthenticator({ ...base, fetchImpl }).authenticate(req({ authorization: 'Bearer bad', 'x-cozy-instance': 'https://user1.twake.local' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('answers 503 when the stack itself fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    await expect(new CozyAuthenticator({ ...base, fetchImpl }).authenticate(req({ authorization: 'Bearer t', 'x-cozy-instance': 'https://user1.twake.local' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('never contacts a host outside the allowed pattern', async () => {
    const fetchImpl = cozyOk({ oidc_id: 'x' })
    await expect(new CozyAuthenticator({ ...base, fetchImpl }).authenticate(req({ authorization: 'Bearer t', 'x-cozy-instance': 'https://evil.example.com' }))).rejects.toMatchObject({ statusCode: 401 })
    await expect(new CozyAuthenticator({ ...base, fetchImpl }).authenticate(req({ authorization: 'Bearer t', 'x-cozy-instance': 'https://user1.twake.local.evil.com' }))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires both a token and an instance', async () => {
    const a = new CozyAuthenticator({ ...base, fetchImpl: cozyOk({}) })
    await expect(a.authenticate(req({ authorization: 'Bearer t' }))).rejects.toMatchObject({ statusCode: 401 })
    await expect(a.authenticate(req({ 'x-cozy-instance': 'https://user1.twake.local' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('caches a verified token briefly, then asks again', async () => {
    let t = 0
    const fetchImpl = cozyOk({ oidc_id: 'user1' })
    const a = new CozyAuthenticator({ ...base, fetchImpl, cacheMs: 1000, now: () => t })
    const r = () => req({ authorization: 'Bearer t', 'x-cozy-instance': 'https://user1.twake.local' })
    await a.authenticate(r()); await a.authenticate(r())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    t = 2000
    await a.authenticate(r())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reaches the stack through an internal URL while naming the instance in the Host header', async () => {
    const fetchImpl = cozyOk({ oidc_id: 'user1' })
    await new CozyAuthenticator({ ...base, internalUrl: 'http://cozyt:8080', fetchImpl }).authenticate(req({ authorization: 'Bearer t', 'x-cozy-instance': 'https://user1.twake.local' }))
    expect(fetchImpl).toHaveBeenCalledWith('http://cozyt:8080/settings/instance', expect.objectContaining({ headers: expect.objectContaining({ host: 'user1.twake.local' }) }))
  })

  it('answers 503, not 401, when the stack cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down') })
    await expect(new CozyAuthenticator({ ...base, fetchImpl }).authenticate(req({ authorization: 'Bearer t', 'x-cozy-instance': 'https://user1.twake.local' }))).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('hostAwareFetch', () => {
  it('sends the Host header it is given, unlike fetch', async () => {
    let seen = ''
    const server = createServer((req, res) => { seen = String(req.headers.host); res.end('{"ok":true}') })
    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    const res = await hostAwareFetch(`http://127.0.0.1:${port}/x`, { headers: { host: 'user3.twake.local' } })
    server.close()
    expect(seen).toBe('user3.twake.local')
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('JwtAuthenticator', () => {
  const make = async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }
    const sign = (claims: object, opts: { iss?: string; aud?: string; exp?: string } = {}) =>
      new SignJWT(claims as never).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(opts.iss ?? 'https://auth.twake.local').setAudience(opts.aud ?? 'phone').setExpirationTime(opts.exp ?? '5m').sign(privateKey)
    const auth = new JwtAuthenticator({ keys: createLocalJWKSet({ keys: [jwk] }), issuer: 'https://auth.twake.local', audience: 'phone', tenantClaim: 'org', defaultTenant: 'dev' })
    return { sign, auth }
  }

  it('accepts a valid token and reads user and tenant from the claims', async () => {
    const { sign, auth } = await make()
    const id = await auth.authenticate(req({ authorization: `Bearer ${await sign({ preferred_username: 'alice', org: 'acme', name: 'Alice' })}` }))
    expect(id).toEqual({ userId: 'alice', tenantId: 'acme', displayName: 'Alice' })
  })

  it('rejects wrong issuer, wrong audience, expired and unsigned tokens', async () => {
    const { sign, auth } = await make()
    for (const token of [await sign({ sub: 'a' }, { iss: 'https://evil' }), await sign({ sub: 'a' }, { aud: 'other' }), await sign({ sub: 'a' }, { exp: '-1m' }), 'not.a.jwt']) {
      await expect(auth.authenticate(req({ authorization: `Bearer ${token}` }))).rejects.toMatchObject({ statusCode: 401 })
    }
  })
})

describe('TicketStore', () => {
  it('is single-use and short-lived', () => {
    let t = 0
    const store = new TicketStore(1000, () => t)
    const id = { userId: 'u', tenantId: 'x' }
    const ticket = store.issue(id)
    expect(store.consume(ticket)).toEqual(id)
    expect(store.consume(ticket)).toBeNull()
    const late = store.issue(id)
    t = 2000
    expect(store.consume(late)).toBeNull()
    expect(store.consume('made-up')).toBeNull()
  })
})

describe('DevAuthenticator and configuration', () => {
  it('accepts the dev token and rejects an anonymous call', async () => {
    const a = new DevAuthenticator()
    expect(await a.authenticate(req({ authorization: 'Bearer dev:user1' }))).toEqual({ userId: 'user1', tenantId: 'dev', email: 'user1@twake.local' })
    await expect(a.authenticate(req())).rejects.toMatchObject({ statusCode: 401 })
  })

  it('refuses to start in cozy mode without an instance allow-list, and on an unknown mode', () => {
    expect(() => authenticatorFromEnv({ AUTH_MODE: 'cozy' } as never)).toThrow(/COZY_INSTANCE_PATTERN/)
    expect(() => authenticatorFromEnv({ AUTH_MODE: 'nope' } as never)).toThrow(/Unknown AUTH_MODE/)
    expect(() => authenticatorFromEnv({ AUTH_MODE: 'jwt' } as never)).toThrow(/JWT_JWKS_URL/)
  })
})
