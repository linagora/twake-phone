import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { MemoryContactDirectory } from './contacts.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'

const jean = { id: 'jdupont', displayName: 'Jean Dupont', numbers: [{ type: 'work' as const, number: '+33123456701' }], department: 'Support' }
const bob = { id: 'bdurand', displayName: 'Bob Durand', numbers: [{ type: 'mobile' as const, number: '+33612345603' }], department: 'Support' }

const appWith = async (contacts?: MemoryContactDirectory, store = new MemoryStore()) => {
  process.env.AUTH_MODE = 'dev'
  return buildApp(new ProviderRegistry([]), { store, ...(contacts ? { contacts } : {}) })
}
const as = (user: string, tenant = 'dev') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })

describe('directory routes', () => {
  it('answers 501 when no directory is configured, and favourites stay empty', async () => {
    const app = await appWith()
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })).statusCode).toBe(501)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [] })
  })

  it('searches, validates the query and the limit', async () => {
    const app = await appWith(new MemoryContactDirectory([jean, bob]))
    expect((await app.inject({ url: '/api/v1/directory?q=dup', headers: as('alice') })).json()).toEqual({ items: [jean] })
    expect((await app.inject({ url: '/api/v1/directory?q=support&limit=1', headers: as('alice') })).json().items).toHaveLength(1)
    expect((await app.inject({ url: '/api/v1/directory', headers: as('alice') })).json()).toEqual({ items: [] })
    expect((await app.inject({ url: `/api/v1/directory?q=${'a'.repeat(101)}`, headers: as('alice') })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/v1/directory?q=a&limit=0', headers: as('alice') })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/v1/directory?q=a&limit=51', headers: as('alice') })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/v1/directory?q=a' })).statusCode).toBe(401)
  })

  it('returns one contact, or 404', async () => {
    const app = await appWith(new MemoryContactDirectory([jean]))
    expect((await app.inject({ url: '/api/v1/directory/jdupont', headers: as('alice') })).json()).toEqual(jean)
    expect((await app.inject({ url: '/api/v1/directory/ghost', headers: as('alice') })).statusCode).toBe(404)
  })

  it('keeps favourites per user, only for contacts the directory knows', async () => {
    const app = await appWith(new MemoryContactDirectory([jean, bob]))
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/ghost', headers: as('alice') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/bdurand', headers: as('alice') })).statusCode).toBe(204)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favorites/jdupont', headers: as('alice') })).statusCode).toBe(204)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [bob, jean] })
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('bob') })).json()).toEqual({ items: [] })
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice', 'other') })).json()).toEqual({ items: [] })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/favorites/bdurand', headers: as('alice') })).statusCode).toBe(204)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [jean] })
    // Fastify caps path parameters at 100 characters (414) before the Gateway's own 256 limit (400) is reached.
    expect([400, 414]).toContain((await app.inject({ method: 'PUT', url: `/api/v1/me/favorites/${'x'.repeat(257)}`, headers: as('alice') })).statusCode)
  })

  it('drops a favourite the directory no longer knows', async () => {
    const store = new MemoryStore()
    await store.addFavorite('dev', 'alice', 'gone')
    await store.addFavorite('dev', 'alice', 'jdupont')
    const app = await appWith(new MemoryContactDirectory([jean]), store)
    expect((await app.inject({ url: '/api/v1/me/favorites', headers: as('alice') })).json()).toEqual({ items: [jean] })
  })
})
