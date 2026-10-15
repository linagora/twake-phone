import { describe, expect, it } from 'vitest'
import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Contact, RingGroup } from '@twake/telephony-types'
import { buildApp, parseGroup } from './app.js'
import { TicketStore } from './auth.js'
import { MemoryContactDirectory } from './contacts.js'
import { StoreDirectory } from './directory.js'
import { DirectorySync } from './directory-sync.js'
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
    for (const members of [[], ['', ' '], 'not a list', Array.from({ length: 13 }, () => '101')]) {
      const res = parseGroup('200', { name: 'G', members }, anyButGroup)
      // 13 times 101 is one member: accepted. Every other one is refused.
      if (Array.isArray(members) && members.length === 13) await expect(res).resolves.toMatchObject({ members: ['101'] })
      else await expect(res).rejects.toMatchObject({ statusCode: 400, code: 'GROUP_MEMBERS' })
    }
    for (const member of ['104', '+33612345678', "102' OR 1=1", 7]) await expect(parseGroup('200', { name: 'G', members: [member] }, ours)).rejects.toMatchObject({ statusCode: 400, code: 'GROUP_MEMBER_NOT_EXTENSION' })
    await expect(parseGroup('200', null, ours)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('takes 12 members, what one call of the SIP server rings, and refuses 13 before looking any up', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => String(300 + i))
    expect((await parseGroup('200', { name: 'G', members: twelve }, anyButGroup)).members).toEqual(twelve)
    let lookups = 0
    const counting = async (n: string) => (lookups++, n !== '200')
    await expect(parseGroup('200', { name: 'G', members: Array.from({ length: 100_000 }, (_, i) => String(300 + i)) }, counting)).rejects.toMatchObject({ statusCode: 400, code: 'GROUP_MEMBERS' })
    // The group number only.
    expect(lookups).toBe(1)
  })

  it('keeps a member the group already has whose extension nobody holds now, and no other vacant one', async () => {
    expect((await parseGroup('200', { name: 'G', members: ['104', '101'] }, ours, ['104'])).members).toEqual(['104', '101'])
    await expect(parseGroup('200', { name: 'G', members: ['105'] }, ours, ['104'])).rejects.toMatchObject({ code: 'GROUP_MEMBER_NOT_EXTENSION' })
  })
})

describe('ring group routes', () => {
  const setup = async (withGroups = true, people?: Contact[]) => {
    process.env.AUTH_MODE = 'dev'
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101', displayName: 'Alice Martin' })
    await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '102' })
    await store.upsertMapping({ tenantId: 'B', userId: 'carol', extension: '103' })
    const groups = new Map<string, RingGroup>()
    const holders: unknown[] = []
    const writes: string[] = []
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ groups: withGroups }),
      syncExtensions: async (h: unknown[]) => void holders.push(h),
      subscribe: async function* () {},
      close: async () => {},
      ...(withGroups
        ? {
            listGroups: async () => [...groups.values()],
            // As the OpenSIPS provider does: create refuses a number it has, replace one it has not.
            setGroup: async (g: RingGroup, mode: 'create' | 'replace') => {
              writes.push(`${mode} ${g.number}`)
              if (mode === 'create' && groups.has(g.number)) throw Object.assign(new Error('exists'), { statusCode: 409, code: 'GROUP_EXISTS' })
              if (mode === 'replace' && !groups.has(g.number)) throw Object.assign(new Error('No such group'), { statusCode: 404 })
              groups.set(g.number, g)
            },
            deleteGroup: async (n: string) => groups.delete(n)
          }
        : {})
    }
    const factory: ProviderFactory<unknown> = { type: 'recording', create: () => provider as unknown as TelephonyProvider }
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'recording', config: {} }], [factory])
    const directory = people ? new MemoryContactDirectory(people) : undefined
    const directorySync = directory ? new DirectorySync({ store, directory, tenantId: 'A', reserved: async () => [...groups.keys()] }) : undefined
    const app = await buildApp(registry, {
      store,
      bus: new EventBus(),
      directory: new StoreDirectory(store),
      tickets: new TicketStore(),
      admin: { adminRole: 'twakephone-admin', adminUsers: new Set() },
      ...(directorySync ? { directorySync } : {})
    })
    registry.startAll()
    const as = (user: string, roles?: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'A', ...(roles ? { 'x-dev-roles': roles } : {}) })
    return { app, as, groups, holders, store, directory, directorySync, writes }
  }

  it('lets an administrator create, list, change and delete the groups of the organisation', async () => {
    const { app, as, groups } = await setup()
    const admin = as('root', 'twakephone-admin')
    let res = await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '200', name: 'Accueil', members: ['101', '102'] } })
    expect([res.statusCode, res.json()]).toEqual([201, { number: '200', name: 'Accueil', members: ['101', '102'] }])
    res = await app.inject({ url: '/api/v1/admin/groups', headers: admin })
    expect(res.json()).toEqual({ items: [{ number: '200', name: 'Accueil', members: ['101', '102'], vacant: [] }] })
    res = await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/200', headers: admin, payload: { name: 'Accueil', members: ['102'] } })
    expect([res.statusCode, groups.get('200')?.members]).toEqual([200, ['102']])
    // An extension is no group's number; 103 is another organisation's extension, not a member.
    res = await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '101', name: 'X', members: ['102'] } })
    expect([res.statusCode, res.json().code]).toEqual([409, 'GROUP_NUMBER_TAKEN'])
    res = await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '201', name: 'X', members: ['103'] } })
    expect([res.statusCode, res.json().code]).toEqual([400, 'GROUP_MEMBER_NOT_EXTENSION'])
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/groups/200', headers: admin })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/groups/200', headers: admin })).statusCode).toBe(404)
    expect(groups.size).toBe(0)
    await app.close()
  })

  it('never replaces a group from the creation form: 409 for a number the organisation has, 404 to change one it has not', async () => {
    const { app, as, groups } = await setup()
    const admin = as('root', 'twakephone-admin')
    await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '200', name: 'Accueil', members: ['101', '102'] } })
    let res = await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '200', name: 'Support', members: ['101'] } })
    expect([res.statusCode, res.json().code]).toEqual([409, 'GROUP_EXISTS'])
    expect(groups.get('200')).toEqual({ number: '200', name: 'Accueil', members: ['101', '102'] })
    res = await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/201', headers: admin, payload: { name: 'Support', members: ['101'] } })
    expect(res.statusCode).toBe(404)
    expect(groups.has('201')).toBe(false)
    res = await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { name: 'Sans numéro', members: ['101'] } })
    expect([res.statusCode, res.json().code]).toEqual([400, 'GROUP_NUMBER'])
    await app.close()
  })

  it('lists the members nobody holds now, and lets them stay when the group changes', async () => {
    const { app, as, groups, store } = await setup()
    const admin = as('root', 'twakephone-admin')
    await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '200', name: 'Accueil', members: ['101', '102'] } })
    // Bob leaves: 102 is vacant, still a member.
    await store.deleteMapping('A', 'bob')
    let res = await app.inject({ url: '/api/v1/admin/groups', headers: admin })
    expect(res.json().items).toEqual([{ number: '200', name: 'Accueil', members: ['101', '102'], vacant: ['102'] }])
    res = await app.inject({ method: 'PUT', url: '/api/v1/admin/groups/200', headers: admin, payload: { name: 'Accueil du siège', members: ['102', '101'] } })
    expect([res.statusCode, groups.get('200')?.members]).toEqual([200, ['102', '101']])
    // A vacant extension that is no member yet is refused.
    await store.deleteMapping('A', 'alice')
    res = await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '201', name: 'X', members: ['101'] } })
    expect([res.statusCode, res.json().code]).toEqual([400, 'GROUP_MEMBER_NOT_EXTENSION'])
    await app.close()
  })

  it('checks and writes a group while no directory synchronisation runs, so neither gives the other its number', async () => {
    const people: Contact[] = [{ id: 'alice', displayName: 'Alice Martin', numbers: [{ type: 'extension', number: '101' }] }]
    const { app, as, groups, store, directory, directorySync, writes } = await setup(true, people)
    const admin = as('root', 'twakephone-admin')
    // A synchronisation that will give 200 to Dave is running when the administrator creates group 200.
    let release!: () => void
    directory!.listAll = () => new Promise(resolve => (release = () => resolve([...people, { id: 'dave', displayName: 'Dave', numbers: [{ type: 'extension', number: '200' }] }])))
    const run = directorySync!.run()
    const created = app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '200', name: 'Accueil', members: ['101'] } })
    await new Promise(r => setTimeout(r, 30))
    expect(writes).toEqual([])
    release()
    await run
    const res = await created
    // The run gave 200 to Dave first: the group is refused, nothing written.
    expect([res.statusCode, res.json().code]).toEqual([409, 'GROUP_NUMBER_TAKEN'])
    expect(await store.getMappingByExtension('A', '200')).toMatchObject({ userId: 'dave' })
    expect(groups.size).toBe(0)
    // The other way round: the group is written first, the run that follows refuses to give its number away.
    await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '201', name: 'Support', members: ['101'] } })
    directory!.listAll = async () => [...people, { id: 'erin', displayName: 'Erin', numbers: [{ type: 'extension', number: '201' }] }]
    expect((await directorySync!.run()).conflicts).toEqual([{ userId: 'erin', extension: '201', heldBy: '', group: true }])
    await app.close()
  })

  it('keeps everyone else out', async () => {
    const { app, as, groups } = await setup()
    for (const headers of [as('alice'), as('bob', 'staff')]) {
      expect((await app.inject({ url: '/api/v1/admin/groups', headers })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers, payload: { number: '200', name: 'G', members: ['101'] } })).statusCode).toBe(403)
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
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: admin, payload: { number: '200', name: 'G', members: ['101'] } })).statusCode).toBe(501)
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

  it('lets an allowed origin preflight the POST, PUT and DELETE of a group', async () => {
    process.env.CORS_ORIGINS = 'https://phone.example.org'
    try {
      const { app } = await setup()
      for (const method of ['POST', 'PUT', 'DELETE']) {
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
