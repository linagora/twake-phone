import { describe, expect, it } from 'vitest'
import { adminPolicyFromEnv, isAdmin } from './admin.js'
import { buildApp } from './app.js'
import { MemoryContactDirectory } from './contacts.js'
import { DirectorySync } from './directory-sync.js'
import { ProviderRegistry } from './registry.js'
import { API_CSP, DOCS_CSP, securityHeadersFor } from './security.js'
import { MemoryStore } from './store/memory.js'

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
    const p = adminPolicyFromEnv({ DEFAULT_TENANT: 'acme', ADMIN_USERS: ' alice, other:bob ,' } as never)
    expect(p.adminRole).toBe('twakephone-admin')
    expect([...p.adminUsers]).toEqual(['acme:alice', 'other:bob'])
    expect(adminPolicyFromEnv({ ADMIN_ROLE: 'phone-admin' } as never)).toEqual({ adminRole: 'phone-admin', adminUsers: new Set() })
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

  it('synchronises on demand and reports what it did; the next status carries the report', async () => {
    const store = new MemoryStore()
    const app = await appWith({ contacts: new MemoryContactDirectory([alice]), store })
    expect((await app.inject({ url: '/api/v1/me', headers: as('amartin') })).json().extension).toBeUndefined()
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('root') })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ seen: 1, withExtension: 1, created: 1, conflicts: [] })
    expect((await app.inject({ url: '/api/v1/me', headers: as('amartin') })).json()).toMatchObject({ extension: '101', displayName: 'Alice Martin' })
    expect((await app.inject({ url: '/api/v1/admin/directory', headers: as('root') })).json().sync.last).toMatchObject({ created: 1 })
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
    const first = app.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('root') })
    await new Promise(r => setTimeout(r, 20))
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/directory/sync', headers: as('root') })).statusCode).toBe(409)
    release()
    expect((await first).statusCode).toBe(200)
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
  })

  it('adds HSTS only when asked, with subdomains', () => {
    expect(securityHeadersFor('/api/v1/me', { hstsMaxAge: 31536000 })['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    expect(securityHeadersFor('/api/v1/me')['strict-transport-security']).toBeUndefined()
    expect(securityHeadersFor('/docs')['content-security-policy']).toBe(DOCS_CSP)
    expect(securityHeadersFor('/docsx')['content-security-policy']).toBe(API_CSP)
  })
})
