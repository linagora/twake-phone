import { describe, expect, it } from 'vitest'
import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { ForwardingRules, Presence, User } from '@twake/telephony-types'
import { buildApp, parseForwarding, parsePresence } from './app.js'
import { TicketStore } from './auth.js'
import type { ContactDirectory } from './contacts.js'
import { StoreDirectory } from './directory.js'
import { DirectorySync } from './directory-sync.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'

const NOW = Date.parse('2026-10-15T10:00:00.000Z')
const alice: User = { id: 'alice', tenantId: 'A', displayName: 'Alice', extension: '101' }

describe('parsePresence', () => {
  it('takes an end in the future and a one-line message for an absence or a "do not disturb"', () => {
    expect(parsePresence({ status: 'dnd', until: '2026-10-15T16:00:00+02:00', message: '  En réunion  ' }, NOW)).toEqual({ status: 'dnd', until: '2026-10-15T14:00:00.000Z', message: 'En réunion' })
    expect(parsePresence({ status: 'away', until: '', message: '' }, NOW)).toEqual({ status: 'away' })
    expect(parsePresence({ status: 'available', until: null }, NOW)).toEqual({ status: 'available' })
  })

  it('refuses an end or a message for any other status, an end past or too far, a message that is not one short line', () => {
    expect(() => parsePresence({ status: 'sleeping' }, NOW)).toThrow(/invalid status/)
    expect(() => parsePresence({ status: 'available', until: '2026-10-15T16:00:00Z' }, NOW)).toThrow(/end/)
    expect(() => parsePresence({ status: 'busy', message: 'x' }, NOW)).toThrow(/message/)
    for (const until of ['2026-10-15T09:59:59Z', 'tomorrow', '2027-10-17T10:00:00Z', 12]) expect(() => parsePresence({ status: 'dnd', until }, NOW)).toThrow(expect.objectContaining({ statusCode: 400, code: 'PRESENCE_UNTIL' }))
    for (const message of ['two\nlines', 'x'.repeat(141)]) expect(() => parsePresence({ status: 'dnd', message }, NOW)).toThrow(expect.objectContaining({ statusCode: 400, code: 'PRESENCE_MESSAGE' }))
    expect(() => parsePresence({ status: 'dnd', message: 42 }, NOW)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('parseForwarding', () => {
  const ours = async (t: string) => ['102', '103'].includes(t)

  it('keeps the forwards to extensions of the organisation, the spaces typed removed', async () => {
    expect(await parseForwarding({ always: ' 102 ', busy: '', noAnswer: { target: '1 03', delaySec: '15' } }, alice, ours)).toEqual({ always: '102', noAnswer: { target: '103', delaySec: 15 } })
    expect(await parseForwarding({ noAnswer: { target: '103' } }, alice, ours)).toEqual({ noAnswer: { target: '103', delaySec: 20 } })
    // A delay without target is checked, then nothing is forwarded on no answer.
    expect(await parseForwarding({ noAnswer: { target: '', delaySec: 30 } }, alice, ours)).toEqual({})
    expect(await parseForwarding({}, alice, ours)).toEqual({})
  })

  it('refuses a forward to oneself, to anything but one of our extensions, and a delay out of bounds, each with its code', async () => {
    await expect(parseForwarding({ always: '101' }, alice, ours)).rejects.toMatchObject({ statusCode: 400, code: 'FORWARD_SELF' })
    await expect(parseForwarding({ noAnswer: { target: '101' } }, alice, ours)).rejects.toMatchObject({ code: 'FORWARD_SELF' })
    for (const busy of ['+33612345678', '0612345678', 'sip:bob@elsewhere.example', "102' OR '1'='1"]) await expect(parseForwarding({ busy }, alice, ours)).rejects.toMatchObject({ statusCode: 400, code: 'FORWARD_NOT_EXTENSION' })
    for (const delaySec of [1, 121, 2.5, 'soon']) await expect(parseForwarding({ noAnswer: { target: '102', delaySec } }, alice, ours)).rejects.toMatchObject({ statusCode: 400, code: 'FORWARD_DELAY' })
    for (const body of [null, [], 'x', { always: 102 }, { noAnswer: '102' }]) await expect(parseForwarding(body, alice, ours)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('/me/presence and /me/forwarding', () => {
  /** A provider keeping what it is given, like provider-opensips with its `call_rules` table. */
  const recording = (withForwarding = true) => {
    const restored: { user: User; presence: Presence }[][] = []
    const presences = new Map<string, Presence>()
    const forwards = new Map<string, ForwardingRules>()
    /** What reached the provider, in order. */
    const log: string[] = []
    let failRestore = 0
    /** While set, a restore waits for it (a database that is slow to answer). */
    let gate: Promise<void> | undefined
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ forwarding: withForwarding }),
      getPresence: async (u: User) => presences.get(u.extension ?? u.id) ?? { status: 'available', source: 'telephony' },
      setPresence: async (u: User, p: Presence) => {
        if (p.message === 'refused') throw Object.assign(new Error('refused by the platform'), { statusCode: 400 })
        log.push(`set ${u.extension ?? u.id} ${p.status}`)
        presences.set(u.extension ?? u.id, p)
      },
      syncExtensions: async (holders: { extension: string; userId: string }[]) => void log.push(`holders ${holders.map(h => `${h.extension}=${h.userId}`).sort().join(',')}`),
      restorePresences: async (entries: { user: User; presence: Presence }[]) => {
        await gate
        if (failRestore-- > 0) throw new Error('database not ready')
        log.push(`restore ${entries.map(e => `${e.user.extension}=${e.presence.status}`).join(',')}`)
        restored.push(entries)
      },
      ...(withForwarding
        ? {
            getForwarding: async (u: User) => forwards.get(u.extension!) ?? {},
            setForwarding: async (u: User, r: ForwardingRules) => void forwards.set(u.extension!, r)
          }
        : {}),
      subscribe: async function* () {},
      close: async () => {}
    }
    const factory: ProviderFactory<unknown> = { type: 'recording', create: () => provider as unknown as TelephonyProvider }
    return { factory, restored, presences, forwards, log, failNextRestores: (n: number) => void (failRestore = n), hold: (p: Promise<void> | undefined) => void (gate = p) }
  }
  const setup = async (store = new MemoryStore(), rec = recording(), directorySync?: DirectorySync, turnMaxMs?: number) => {
    process.env.AUTH_MODE = 'dev'
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '102' })
    await store.upsertMapping({ tenantId: 'B', userId: 'carol', extension: '103' })
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'recording', config: {} }], [rec.factory])
    const app = await buildApp(registry, { store, bus: new EventBus(), directory: new StoreDirectory(store), tickets: new TicketStore(), ...(directorySync ? { directorySync } : {}), ...(turnMaxMs ? { turnMaxMs } : {}) })
    registry.startAll()
    const as = (user: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
    return { app, as, store, rec }
  }
  const until = async (what: string, fn: () => boolean, timeout = 3_000) => {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
      await new Promise(r => setTimeout(r, 10))
    }
  }

  it('keeps the chosen presence per person in the store, with its end and message, and forgets it once available', async () => {
    const { app, as, store, rec } = await setup()
    const end = new Date(Date.now() + 3_600_000).toISOString()
    const res = await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'dnd', until: end, message: 'En réunion' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'dnd', source: 'user', until: end, message: 'En réunion', choice: { status: 'dnd', until: end, message: 'En réunion' } })
    expect(rec.presences.get('101')).toMatchObject({ status: 'dnd', until: end, message: 'En réunion' })
    expect(await store.getUserPresence('A', 'alice')).toMatchObject({ status: 'dnd', until: end, message: 'En réunion' })
    expect((await app.inject({ url: '/api/v1/me/presence', headers: as('alice') })).json().choice).toMatchObject({ status: 'dnd', until: end })
    // Bob has chosen nothing.
    expect((await app.inject({ url: '/api/v1/me/presence', headers: as('bob') })).json().choice).toBeUndefined()
    await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'available' } })
    expect(await store.getUserPresence('A', 'alice')).toBeNull()
    await app.close()
  })

  it('stores nothing the provider refused, and says why with a code the app translates', async () => {
    const { app, as, store } = await setup()
    const refused = await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'dnd', message: 'refused' } })
    expect(refused.statusCode).toBe(400)
    const past = await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'dnd', until: '2020-01-01T00:00:00Z' } })
    expect([past.statusCode, past.json().code]).toEqual([400, 'PRESENCE_UNTIL'])
    expect(await store.getUserPresence('A', 'alice')).toBeNull()
    await app.close()
  })

  it('hands the provider the presences kept in the store when it starts, the person with their extension of today', async () => {
    const store = new MemoryStore()
    await store.setUserPresence({ tenantId: 'A', userId: 'alice', status: 'dnd', since: '2026-10-15T08:00:00.000Z', message: 'En congé' })
    await store.setUserPresence({ tenantId: 'B', userId: 'carol', status: 'away', since: '2026-10-15T08:00:00.000Z' })
    const rec = recording()
    rec.failNextRestores(1)
    const { app } = await setup(store, rec)
    // The first attempt fails (its database not ready): tried again a second later.
    await until('the restore', () => rec.restored.length === 1, 4_000)
    expect(rec.restored[0]).toEqual([{ user: { id: 'alice', tenantId: 'A', displayName: 'alice', extension: '101' }, presence: { status: 'dnd', source: 'user', since: '2026-10-15T08:00:00.000Z', message: 'En congé' } }])
    await app.close()
  })

  it('tells the provider who holds each extension before the presences, at its start and after a synchronisation that changed it', async () => {
    const store = new MemoryStore()
    await store.setUserPresence({ tenantId: 'A', userId: 'bob', status: 'dnd', since: '2026-10-15T08:00:00.000Z' })
    const people = [{ id: 'alice', displayName: 'alice', numbers: [{ type: 'extension' as const, number: '101' }] }]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const sync = new DirectorySync({ store, directory, tenantId: 'A' })
    const rec = recording()
    const { app } = await setup(store, rec, sync)
    await until('the restore', () => rec.restored.length === 1)
    expect(rec.log).toEqual(['holders 101=alice,102=bob', 'restore 102=dnd'])
    // The directory now lists Bob with 105: his extension changes, his rules on 102 must go, his choice follows him.
    people.push({ id: 'bob', displayName: 'bob', numbers: [{ type: 'extension' as const, number: '105' }] })
    await sync.run()
    await until('the second restore', () => rec.restored.length === 2)
    expect(rec.log.slice(2)).toEqual(['holders 101=alice,105=bob', 'restore 105=dnd'])
    // A run that changes nothing tells nothing.
    await sync.run()
    await new Promise(r => setTimeout(r, 50))
    expect(rec.restored).toHaveLength(2)
    await app.close()
  })

  it('makes a presence written while the restore runs wait for it, so that the restore cannot undo it', async () => {
    const rec = recording()
    let release!: () => void
    rec.hold(new Promise<void>(resolve => (release = resolve)))
    const { app, as } = await setup(new MemoryStore(), rec)
    await until('the restore to start', () => rec.log.length === 1)
    const put = app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'dnd' } })
    await new Promise(r => setTimeout(r, 50))
    expect(rec.presences.get('101')).toBeUndefined()
    release()
    expect((await put).statusCode).toBe(200)
    expect(rec.log).toEqual(['holders 101=alice,102=bob', 'restore ', 'set 101 dnd'])
    await app.close()
  })

  it('lets a change go once the one before it took too long (a provider whose database hangs)', async () => {
    const rec = recording()
    // The restore never ends.
    rec.hold(new Promise<void>(() => undefined))
    const { app, as } = await setup(new MemoryStore(), rec, undefined, 100)
    await until('the restore to start', () => rec.log.length === 1)
    const started = Date.now()
    const res = await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'away' } })
    expect(res.statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(rec.presences.get('101')).toMatchObject({ status: 'away' })
    await app.close()
  })

  it('refuses a change for an extension that changed holder while it waited, rather than give the new holder those rules', async () => {
    const rec = recording()
    let release!: () => void
    rec.hold(new Promise<void>(resolve => (release = resolve)))
    const { app, as, store } = await setup(new MemoryStore(), rec)
    await until('the restore to start', () => rec.log.length === 1)
    // Resolved as 101's holder, then the synchronisation gives Alice 105 before her turn comes.
    const forward = app.inject({ method: 'PUT', url: '/api/v1/me/forwarding', headers: as('alice'), payload: { busy: '102' } })
    const presence = app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'dnd' } })
    await new Promise(r => setTimeout(r, 50))
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '105' })
    release()
    expect((await forward).statusCode).toBe(409)
    expect((await presence).statusCode).toBe(409)
    expect(rec.forwards.has('101')).toBe(false)
    expect(rec.presences.has('101')).toBe(false)
    // Asked again, it applies to her extension of now.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/forwarding', headers: as('alice'), payload: { busy: '102' } })).statusCode).toBe(200)
    expect(rec.forwards.get('105')).toEqual({ busy: '102' })
    await app.close()
  })

  it('keeps one restore per tenant: a change heard while one waits to be tried again joins it, with the mappings of then', async () => {
    const store = new MemoryStore()
    await store.setUserPresence({ tenantId: 'A', userId: 'bob', status: 'dnd', since: '2026-10-15T08:00:00.000Z' })
    const people = [{ id: 'alice', displayName: 'alice', numbers: [{ type: 'extension' as const, number: '101' }] }]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const sync = new DirectorySync({ store, directory, tenantId: 'A' })
    const rec = recording()
    rec.failNextRestores(1)
    const { app } = await setup(store, rec, sync)
    await until('the first attempt', () => rec.log.length === 1)
    // While it waits a second to try again, Bob moves to 105, twice told.
    people.push({ id: 'bob', displayName: 'bob', numbers: [{ type: 'extension' as const, number: '105' }] })
    await sync.run()
    await sync.run()
    await until('the restore', () => rec.restored.length === 1, 4_000)
    await new Promise(r => setTimeout(r, 300))
    expect(rec.log).toEqual(['holders 101=alice,102=bob', 'holders 101=alice,105=bob', 'restore 105=dnd'])
    await app.close()
  })

  it('sets the forwards of the person to extensions of their organisation only, replaced as a whole', async () => {
    const { app, as, rec } = await setup()
    const put = (payload: unknown, user = 'alice') => app.inject({ method: 'PUT', url: '/api/v1/me/forwarding', headers: as(user), payload: payload as object })
    let res = await put({ always: '102', noAnswer: { target: '102', delaySec: 5 } })
    expect([res.statusCode, res.json()]).toEqual([200, { always: '102', noAnswer: { target: '102', delaySec: 5 } }])
    expect((await app.inject({ url: '/api/v1/me/forwarding', headers: as('alice') })).json()).toEqual({ always: '102', noAnswer: { target: '102', delaySec: 5 } })
    res = await put({ busy: '102' })
    expect(res.json()).toEqual({ busy: '102' })
    // 103 is an extension of another tenant: not one of Alice's colleagues.
    for (const [payload, code] of [[{ always: '101' }, 'FORWARD_SELF'], [{ always: '103' }, 'FORWARD_NOT_EXTENSION'], [{ busy: '+33612345678' }, 'FORWARD_NOT_EXTENSION'], [{ noAnswer: { target: '102', delaySec: 500 } }, 'FORWARD_DELAY']] as const) {
      res = await put(payload)
      expect([res.statusCode, res.json().code]).toEqual([400, code])
    }
    expect(rec.forwards.get('101')).toEqual({ busy: '102' })
    // Without an extension, nothing to forward.
    expect((await put({ always: '102' }, 'dave')).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/v1/me/forwarding', headers: as('dave') })).statusCode).toBe(404)
    await app.close()
  })

  it('says forwarding is not available on a platform without it', async () => {
    const { app, as } = await setup(new MemoryStore(), recording(false))
    expect((await app.inject({ url: '/api/v1/me/forwarding', headers: as('alice') })).statusCode).toBe(501)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/forwarding', headers: as('alice'), payload: { always: '102' } })).statusCode).toBe(501)
    await app.close()
  })
})
