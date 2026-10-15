import { describe, expect, it } from 'vitest'
import { adminPolicyFromEnv, isAdmin } from './admin.js'
import { buildApp } from './app.js'
import { MemoryContactDirectory } from './contacts.js'
import { DirectorySync } from './directory-sync.js'
import { ProviderRegistry } from './registry.js'
import { API_CSP, DOCS_CSP, securityHeadersFor } from './security.js'
import { MemoryStore } from './store/memory.js'
import { parseUserMap } from './directory.js'

const alice = { id: 'amartin', displayName: 'Alice Martin', numbers: [{ type: 'extension' as const, number: '101' }], department: 'Direction' }
const policy = { adminRole: 'twakephone-admin', adminUsers: new Set(['dev:root']) }
const as = (user: string, roles?: string, tenant = 'dev') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant, ...(roles ? { 'x-dev-roles': roles } : {}) })

const appWith = async (opts: { contacts?: MemoryContactDirectory; sync?: boolean; store?: MemoryStore } = {}) => {
  process.env.AUTH_MODE = 'dev'
  const store = opts.store ?? new MemoryStore()
  const contacts = opts.contacts
  const directorySync = contacts && opts.sync !== false ? new DirectorySync({ store, directory: contacts, tenantId: 'dev' }) : undefined
  return buildApp(new ProviderRegistry([]), { store, admin: policy, ...(contacts ? { contacts } : {}), ...(directorySync ? { directorySync } : {}) })
}

describe('admin policy', () => {
  it('admits a role of the identity provider or a user named in ADMIN_USERS, tenant included', () => {
    expect(isAdmin({ userId: 'u', tenantId: 'dev', roles: ['twakephone-admin'] }, policy)).toBe(true)
    expect(isAdmin({ userId: 'u', tenantId: 'dev', roles: ['user'] }, policy)).toBe(false)
    expect(isAdmin({ userId: 'root', tenantId: 'dev' }, policy)).toBe(true)
    expect(isAdmin({ userId: 'root', tenantId: 'acme' }, policy)).toBe(false)
  })
  it('reads ADMIN_ROLE and ADMIN_USERS, a bare user id being in the default tenant', () => {
    const p = adminPolicyFromEnv({ DEFAULT_TENANT: 'acme', ADMIN_USERS: ' alice, other:bob ,' })
    expect(p.adminRole).toBe('twakephone-admin')
    expect([...p.adminUsers]).toEqual(['acme:alice', 'other:bob'])
    expect(adminPolicyFromEnv({ ADMIN_ROLE: 'phone-admin' })).toEqual({ adminRole: 'phone-admin', adminUsers: new Set() })
    // The same default tenant as the dev authenticator, so ADMIN_USERS=alice works on a dev box.
    expect([...adminPolicyFromEnv({ AUTH_MODE: 'dev', ADMIN_USERS: 'alice' }).adminUsers]).toEqual(['dev:alice'])
  })
})

describe('admin routes', () => {
  it('says in /me who is an administrator, and keeps the others out', async () => {
    const app = await appWith({ contacts: new MemoryContactDirectory([alice]) })
    expect((await app.inject({ url: '/api/v1/me', headers: as('bob') })).json().features).toEqual({ directory: true, admin: false })
    expect((await app.inject({ url: '/api/v1/me', headers: as('root') })).json().features.admin).toBe(true)
    expect((await app.inject({ url: '/api/v1/me', headers: as('carol', 'staff twakephone-admin') })).json().features.admin).toBe(true)
    expect((await app.inject({ url: '/api/v1/admin/directory', headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/admin/directory' })).statusCode).toBe(401)
  })

  it('shows the source and the synchronisation state, without a credential', async () => {
    const dir = new MemoryContactDirectory([alice])
    dir.describe = () => ({ type: 'ldap', url: 'ldaps://ldap.example.test', baseDn: 'ou=people', userFilter: '(objectClass=person)', attributes: { id: 'uid', extension: 'ipPhone' } })
    const app = await appWith({ contacts: dir })
    const res = await app.inject({ url: '/api/v1/admin/directory', headers: as('root') })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ source: { type: 'ldap', url: 'ldaps://ldap.example.test', baseDn: 'ou=people', userFilter: '(objectClass=person)', attributes: { id: 'uid', extension: 'ipPhone' } }, sync: { available: true, running: false } })
  })

  it('starts a synchronisation on demand (202) and the status then carries the report', async () => {
    const store = new MemoryStore()
    const app = await appWith({ contacts: new MemoryContactDirectory([alice]), store })
    expect((await app.inject({ url: '/api/v1/me', headers: as('amartin') })).json().extension).toBeUndefined()
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('root') })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ running: true })
    const until = Date.now() + 2000
    let status = res.json()
    while (status.running && Date.now() < until) status = (await app.inject({ url: '/api/v1/admin/directory', headers: as('root') })).json().sync
    expect(status.last).toMatchObject({ seen: 1, withExtension: 1, created: 1, conflicts: [] })
    expect((await app.inject({ url: '/api/v1/me', headers: as('amartin') })).json()).toMatchObject({ extension: '101', displayName: 'Alice Martin' })
  })

  it('seeds DEV_USER_MAP only where no mapping exists: a restart never undoes the synchronisation', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101', displayName: 'Alice Martin', source: 'ldap' })
    process.env.DEV_USER_MAP = 'alice:199,bob:102'
    try {
      expect(parseUserMap(process.env.DEV_USER_MAP)).toHaveLength(2)
      await buildApp(new ProviderRegistry([]), { store })
    } finally {
      delete process.env.DEV_USER_MAP
    }
    expect(await store.getMappingByUser('dev', 'alice')).toMatchObject({ extension: '101', source: 'ldap' })
    expect(await store.getMappingByUser('dev', 'bob')).toMatchObject({ extension: '102', source: 'manual' })
  })

  it('answers 501 without a directory, 501 when it cannot be synchronised, and 409 while a run is in progress', async () => {
    const none = await appWith()
    expect((await none.inject({ url: '/api/v1/admin/directory', headers: as('root') })).statusCode).toBe(501)
    const noSync = await appWith({ contacts: new MemoryContactDirectory([alice]), sync: false })
    expect((await noSync.inject({ url: '/api/v1/admin/directory', headers: as('root') })).json().sync).toEqual({ available: false, running: false })
    expect((await noSync.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('root') })).statusCode).toBe(501)
    const slow = new MemoryContactDirectory([alice])
    let release!: () => void
    slow.listAll = () => new Promise(resolve => (release = () => resolve([alice])))
    const app = await appWith({ contacts: slow })
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('root') })).statusCode).toBe(202)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('root') })).statusCode).toBe(409)
    expect((await app.inject({ url: '/api/v1/admin/directory', headers: as('root') })).json().sync.running).toBe(true)
    release()
  })
})

describe('security headers', () => {
  it('are on every answer of the API, and let the OpenAPI UI run', async () => {
    const app = await appWith()
    const me = await app.inject({ url: '/api/v1/me', headers: as('bob') })
    expect(me.headers['content-security-policy']).toBe(API_CSP)
    expect(me.headers['x-content-type-options']).toBe('nosniff')
    expect(me.headers['x-frame-options']).toBe('DENY')
    expect(me.headers['referrer-policy']).toBe('no-referrer')
    expect(me.headers['cache-control']).toBe('no-store')
    expect(me.headers['strict-transport-security']).toBeUndefined()
    const notFound = await app.inject({ url: '/nowhere' })
    expect(notFound.headers['content-security-policy']).toBe(API_CSP)
    const docs = await app.inject({ url: '/docs/' })
    expect(docs.headers['content-security-policy']).toBe(DOCS_CSP)
    expect(docs.headers['cache-control']).toBeUndefined()
    // The UI's page runs under that policy: external scripts only, no inline one.
    expect(docs.statusCode).toBe(200)
    expect(docs.body).toMatch(/<script src=/)
    expect(docs.body.replace(/<script src="[^"]*"[^>]*>\s*<\/script>/g, '')).not.toMatch(/<script/)
  })

  it('adds HSTS only when asked, subdomains on request, and lets max-age=0 retract it', () => {
    expect(securityHeadersFor('/api/v1/me', { hstsMaxAge: 31536000 })['strict-transport-security']).toBe('max-age=31536000')
    expect(securityHeadersFor('/api/v1/me', { hstsMaxAge: 31536000, hstsIncludeSubDomains: true })['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    expect(securityHeadersFor('/api/v1/me', { hstsMaxAge: 0 })['strict-transport-security']).toBe('max-age=0')
    expect(securityHeadersFor('/api/v1/me')['strict-transport-security']).toBeUndefined()
    expect(securityHeadersFor('/docs')['content-security-policy']).toBe(DOCS_CSP)
    expect(securityHeadersFor('/docsx')['content-security-policy']).toBe(API_CSP)
  })
})
