import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { MAX_FAVORITES, MemoryContactDirectory, RateLimiter } from './contacts.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'

const jean = { id: 'jdupont', displayName: 'Jean Dupont', numbers: [{ type: 'work' as const, number: '+33123456701' }], department: 'Support' }
const bob = { id: 'bdurand', displayName: 'Bob Durand', numbers: [{ type: 'mobile' as const, number: '+33612345603' }], department: 'Support' }

const appWith = async (contacts?: MemoryContactDirectory, store = new MemoryStore(), limiter?: RateLimiter) => {
  process.env.AUTH_MODE = 'dev'
  return buildApp(new ProviderRegistry([]), { store, ...(contacts ? { contacts } : {}), ...(limiter ? { directorySearchLimiter: limiter } : {}) })
}
const as = (user: string, tenant = 'dev') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })

describe('directory routes', () => {
  it('answers 501 when no directory is configured, says so in /me, and favourites stay empty', async () => {
    const store = new MemoryStore()
    await store.addFavorite('dev', 'alice', 'leftover')
    const app = await appWith(undefined, store)
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })).statusCode).toBe(501)
    expect((await app.inject({ url: '/api/v1/me', headers: as('alice') })).json().features).toEqual({ directory: false, admin: false })
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [] })
  })

  it('serves only the tenant of the directory', async () => {
    const dir = Object.assign(new MemoryContactDirectory([jean]), { servesTenant: (t: string) => t === 'acme' })
    const app = await appWith(dir)
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice', 'acme') })).json().items).toEqual([jean])
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice', 'other') })).statusCode).toBe(501)
    expect((await app.inject({ url: '/api/v1/me', headers: as('alice', 'other') })).json().features).toEqual({ directory: false, admin: false })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/jdupont', headers: as('alice', 'other') })).statusCode).toBe(501)
  })

  it('searches, validates the query and the limit', async () => {
    const app = await appWith(new MemoryContactDirectory([jean, bob]))
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })).json()).toEqual({ items: [jean], truncated: false })
    expect((await app.inject({ url: '/api/v1/directory?q=support&limit=1', headers: as('alice') })).json()).toEqual({ items: [jean], truncated: true })
    expect((await app.inject({ url: '/api/v1/directory', headers: as('alice') })).json()).toEqual({ items: [], truncated: false })
    expect((await app.inject({ url: `/api/v1/directory?q=${'a'.repeat(101)}`, headers: as('alice') })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/v1/directory?q=a&limit=0', headers: as('alice') })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/v1/directory?q=a&limit=51', headers: as('alice') })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/v1/directory?q=a' })).statusCode).toBe(401)
  })

  it('slows down a user who searches too fast, per user', async () => {
    const app = await appWith(new MemoryContactDirectory([jean]), new MemoryStore(), new RateLimiter(2, 60_000))
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })).statusCode).toBe(429)
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('bob') })).statusCode).toBe(200)
  })

  it('hides how the directory failed: 503 without the cause', async () => {
    const broken = new MemoryContactDirectory([])
    broken.search = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:636 filter (&(objectClass=inetOrgPerson))')
    }
    const app = await appWith(broken)
    const res = await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toMatch(/10\.0\.0\.5|objectClass/)
  })

  it('returns one contact, or 404', async () => {
    const app = await appWith(new MemoryContactDirectory([jean]))
    expect((await app.inject({ url: '/api/v1/directory/jdupont', headers: as('alice') })).json()).toEqual(jean)
    expect((await app.inject({ url: '/api/v1/directory/ghost', headers: as('alice') })).statusCode).toBe(404)
  })

  it('keeps favourites per user, only for contacts the directory knows, up to a cap', async () => {
    const app = await appWith(new MemoryContactDirectory([jean, bob]))
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/ghost', headers: as('alice') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/bdurand', headers: as('alice') })).statusCode).toBe(204)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/jdupont', headers: as('alice') })).statusCode).toBe(204)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [bob, jean] })
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('bob') })).json()).toEqual({ items: [] })
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice', 'other') })).json()).toEqual({ items: [] })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/favorites/bdurand', headers: as('alice') })).statusCode).toBe(204)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [jean] })
    // Ids up to 256 characters reach the Gateway (unknown here: 404); longer ones are refused by the router (414).
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/favorites/${'x'.repeat(256)}`, headers: as('alice') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/favorites/${'x'.repeat(257)}`, headers: as('alice') })).statusCode).toBe(414)
  })

  it('caps the number of favourites, but still accepts one already there', async () => {
    const store = new MemoryStore()
    const known = [...Array(MAX_FAVORITES).keys()].map(i => ({ id: `c${i}`, displayName: `C ${i}`, numbers: [] }))
    for (const c of known) await store.addFavorite('dev', 'alice', c.id)
    const app = await appWith(new MemoryContactDirectory([...known, jean]), store)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/jdupont', headers: as('alice') })).statusCode).toBe(409)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/c0', headers: as('alice') })).statusCode).toBe(204)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json().items).toHaveLength(MAX_FAVORITES)
  })

  it('drops a favourite the directory no longer knows', async () => {
    const store = new MemoryStore()
    await store.addFavorite('dev', 'alice', 'gone')
    await store.addFavorite('dev', 'alice', 'jdupont')
    const app = await appWith(new MemoryContactDirectory([jean]), store)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [jean] })
  })
})

describe('RateLimiter', () => {
  it('counts events in a sliding window', () => {
    let t = 0
    const l = new RateLimiter(2, 100, () => t)
    expect([l.allow('a'), l.allow('a'), l.allow('a')]).toEqual([true, true, false])
    t = 101
    expect(l.allow('a')).toBe(true)
  })
})
