import { describe, expect, it } from 'vitest'
import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { RingGroup } from '@twake/telephony-types'
import { buildApp, parseGroup } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'

describe('parseGroup', () => {
  const ours = async (n: string) => ['101', '102', '103'].includes(n)
  const anyButGroup = async (n: string) => n !== '200'

  it('keeps a number of its own, a one-line name and extensions of the organisation, each once, in order', async () => {
    expect(await parseGroup('200', { name: ' Accueil ', members: ['103', ' 1 01', '103', ''] }, ours)).toEqual({ number: '200', name: 'Accueil', members: ['103', '101'] })
  })

  it('refuses a number that is an extension, or not a number, a bad name, members that are not extensions', async () => {
    await expect(parseGroup('101', { name: 'G', members: ['102'] }, ours)).rejects.toMatchObject({ statusCode: 409, code: 'GROUP_NUMBER_TAKEN' })
    for (const number of ["200' OR 1=1", 'sip:200@x', '2 00', 'x'.repeat(65)]) await expect(parseGroup(number, { name: 'G', members: ['102'] }, ours)).rejects.toMatchObject({ statusCode: 400, code: 'GROUP_NUMBER' })
    for (const name of ['', '   ', 'two\nlines', 'x'.repeat(65), 42]) await expect(parseGroup('200', { name, members: ['102'] }, ours)).rejects.toMatchObject({ statusCode: 400, code: 'GROUP_NAME' })
    for (const members of [[], ['', ' '], 'not a list', Array.from({ length: 21 }, () => '101')]) {
      const res = parseGroup('200', { name: 'G', members }, anyButGroup)
      // 21 times 101 is one member: accepted. Every other one is refused.
      if (Array.isArray(members) && members.length === 21) await expect(res).resolves.toMatchObject({ members: ['101'] })
      else await expect(res).rejects.toMatchObject({ statusCode: 400, code: 'GROUP_MEMBERS' })
    }
    await expect(parseGroup('200', { name: 'G', members: Array.from({ length: 21 }, (_, i) => String(300 + i)) }, anyButGroup)).rejects.toMatchObject({ code: 'GROUP_MEMBERS' })
    for (const member of ['104', '+33612345678', "102' OR 1=1", 7]) await expect(parseGroup('200', { name: 'G', members: [member] }, ours)).rejects.toMatchObject({ statusCode: 400, code: 'GROUP_MEMBER_NOT_EXTENSION' })
    await expect(parseGroup('200', null, ours)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('ring group routes', () => {
  const setup = async (withGroups = true) => {
    process.env.AUTH_MODE = 'dev'
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101', displayName: 'Alice Martin' })
    await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '102' })
    await store.upsertMapping({ tenantId: 'B', userId: 'carol', extension: '103' })
    const groups = new Map<string, RingGroup>()
    const holders: unknown[] = []
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ groups: withGroups }),
      syncExtensions: async (h: unknown[]) => void holders.push(h),
      subscribe: async function* () {},
      close: async () => {},
      ...(withGroups
        ? {
            listGroups: async () => [...groups.values()],
            setGroup: async (g: RingGroup) => void groups.set(g.number, g),
            deleteGroup: async (n: string) => groups.delete(n)
          }
        : {})
    }
    const factory: ProviderFactory<unknown> = { type: 'recording', create: () => provider as unknown as TelephonyProvider }
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'recording', config: {} }], [factory])
    const app = await buildApp(registry, { store, bus: new EventBus(), directory: new StoreDirectory(store), tickets: new TicketStore(), admin: { adminRole: 'twakephone-admin', adminUsers: new Set() } })
    registry.startAll()
    const as = (user: string, roles?: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'A', ...(roles ? { 'x-dev-roles': roles } : {}) })
    return { app, as, groups, holders }
  }

  it('lets an administrator create, list, change and delete the groups of the organisation', async () => {
    const { app, as, groups } = await setup()
    const admin = as('root', 'twakephone-admin')
    let res = await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/200', headers: admin, payload: { name: 'Accueil', members: ['101', '102'] } })
    expect([res.statusCode, res.json()]).toEqual([200, { number: '200', name: 'Accueil', members: ['101', '102'] }])
    res = await app.inject({ url: '/api/v1/admin/groups', headers: admin })
    expect(res.json()).toEqual({ items: [{ number: '200', name: 'Accueil', members: ['101', '102'] }] })
    await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/200', headers: admin, payload: { name: 'Accueil', members: ['102'] } })
    expect(groups.get('200')?.members).toEqual(['102'])
    // An extension is no group's number; 103 is another organisation's extension, not a member.
    res = await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/101', headers: admin, payload: { name: 'X', members: ['102'] } })
    expect([res.statusCode, res.json().code]).toEqual([409, 'GROUP_NUMBER_TAKEN'])
    res = await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/201', headers: admin, payload: { name: 'X', members: ['103'] } })
    expect([res.statusCode, res.json().code]).toEqual([400, 'GROUP_MEMBER_NOT_EXTENSION'])
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/groups/200', headers: admin })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/groups/200', headers: admin })).statusCode).toBe(404)
    expect(groups.size).toBe(0)
    await app.close()
  })

  it('keeps everyone else out', async () => {
    const { app, as, groups } = await setup()
    for (const headers of [as('alice'), as('bob', 'staff')]) {
      expect((await app.inject({ url: '/api/v1/admin/groups', headers })).statusCode).toBe(403)
      expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/200', headers, payload: { name: 'G', members: ['101'] } })).statusCode).toBe(403)
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/groups/200', headers })).statusCode).toBe(403)
    }
    expect((await app.inject({ url: '/api/v1/admin/groups' })).statusCode).toBe(401)
    expect(groups.size).toBe(0)
    await app.close()
  })

  it('says ring groups are not available on a platform without them', async () => {
    const { app, as } = await setup(false)
    const admin = as('root', 'twakephone-admin')
    expect((await app.inject({ url: '/api/v1/admin/groups', headers: admin })).statusCode).toBe(501)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/200', headers: admin, payload: { name: 'G', members: ['101'] } })).statusCode).toBe(501)
    await app.close()
  })

  it('hands the provider the directory name of each extension with its holder', async () => {
    const { app, holders } = await setup()
    const until = Date.now() + 2_000
    while (holders.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 10))
    expect(holders[0]).toEqual([
      { extension: '101', userId: 'alice', displayName: 'Alice Martin' },
      { extension: '102', userId: 'bob' }
    ])
    await app.close()
  })

  it('lets an allowed origin preflight the PUT and DELETE of a group', async () => {
    process.env.CORS_ORIGINS = 'https://phone.example.org'
    try {
      const { app } = await setup()
      for (const method of ['PUT', 'DELETE']) {
        const res = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/groups/200', headers: { origin: 'https://phone.example.org', 'access-control-request-method': method } })
        expect(res.statusCode).toBe(204)
        expect(String(res.headers['access-control-allow-methods']).split(/,\s*/)).toContain(method)
      }
      await app.close()
    } finally {
      delete process.env.CORS_ORIGINS
    }
  })
})
