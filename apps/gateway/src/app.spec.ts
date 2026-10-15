import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { MemoryStore } from './store/memory.js'
import { ProviderRegistry } from './registry.js'
import type { ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Presence, TelephonyEvent, User } from '@twake/telephony-types'
import type { HistoryEntry } from './store/types.js'

const caps = { calling: { outbound: true, inbound: true, answer: false, hangup: true, hold: true, transfer: false, dtmf: true }, media: { browserAudio: true }, presence: { read: true, write: true, realtime: true, statuses: [] }, history: false, conference: { dialIn: false, dialOut: false } }
const fakeFactory: ProviderFactory<unknown> = {
  type: 'fake',
  create: () =>
    ({
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => caps,
      subscribe: async function* () {},
      close: async () => {}
    }) as unknown as TelephonyProvider
}

describe('gateway', () => {
  it('answers /health', async () => {
    const app = await buildApp(new ProviderRegistry([]))
    const res = await app.inject('/health')
    expect(res.statusCode).toBe(200)
  })

  it('serves capabilities of the tenant provider', async () => {
    process.env.AUTH_MODE = 'dev'
    const app = await buildApp(
      new ProviderRegistry([{ tenantId: 'dev', type: 'fake', config: {} }], [fakeFactory])
    )
    const res = await app.inject({
      url: '/api/v1/capabilities',
      headers: { 'x-dev-user': 'user1' }
    })
    expect(res.json().calling.outbound).toBe(true)
  })

  it('is ready while every provider can place calls, and says which are degraded and why', async () => {
    const statuses = new Map<string, string>([['A', 'CONNECTED'], ['B', 'DEGRADED'], ['C', 'DEGRADED']])
    const factory: ProviderFactory<unknown> = {
      type: 'fake',
      create: (_c: unknown, ctx?: { tenantId: string }) =>
        ({ ...fakeFactory.create({}), getStatus: () => statuses.get(ctx?.tenantId ?? ''), getStatusReason: () => (ctx?.tenantId === 'A' ? 'shown only while not connected' : 'events: OpenSIPS MI does not answer') }) as unknown as TelephonyProvider
    }
    const registry = new ProviderRegistry(['A', 'B', 'C'].map(tenantId => ({ tenantId, type: 'fake', config: {} })), [factory])
    const app = await buildApp(registry)
    registry.startAll()
    let res = await app.inject('/ready')
    expect([res.statusCode, res.json()]).toEqual([200, { ready: true, degraded: 2, reasons: ['events: OpenSIPS MI does not answer'] }])
    statuses.set('C', 'CONNECTED')
    statuses.set('B', 'CONNECTED')
    res = await app.inject('/ready')
    expect([res.statusCode, res.json()]).toEqual([200, { ready: true }])
    statuses.set('A', 'DISCONNECTED')
    res = await app.inject('/ready')
    expect([res.statusCode, res.json()]).toEqual([503, { ready: false, reasons: ['shown only while not connected'] }])
  })

  it('rejects unauthenticated calls', async () => {
    process.env.AUTH_MODE = 'dev'
    const app = await buildApp(new ProviderRegistry([]))
    const res = await app.inject('/api/v1/me')
    expect(res.statusCode).toBe(401)
  })

  it('lets an allowed origin send PUT and DELETE, which a browser preflights (Firefox enforces the methods)', async () => {
    process.env.CORS_ORIGINS = 'https://phone.example.org'
    try {
      const app = await buildApp(new ProviderRegistry([]))
      for (const method of ['PUT', 'DELETE']) {
        const res = await app.inject({
          method: 'OPTIONS',
          url: '/api/v1/me/forwarding',
          headers: { origin: 'https://phone.example.org', 'access-control-request-method': method }
        })
        expect(res.statusCode).toBe(204)
        expect(String(res.headers['access-control-allow-methods']).split(/,\s*/)).toContain(method)
      }
    } finally {
      delete process.env.CORS_ORIGINS
    }
  })
})

describe('event stream', () => {
  it('delivers a simulated incoming call to the websocket of that user only', async () => {
    process.env.AUTH_MODE = 'dev'
    const { buildApp: build } = await import('./app.js')
    const app = await build(new ProviderRegistry([]))
    await app.listen({ port: 0 })
    const port = (app.server.address() as { port: number }).port

    // Open once the Gateway says the session is accepted: from then on, every event reaches it.
    const open = (user: string) =>
      new Promise<{ ws: WebSocket; got: string[] }>(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?user=${user}`)
        const got: string[] = []
        ws.onmessage = e => {
          got.push(String(e.data))
          if (got.length === 1) resolve({ ws, got })
        }
      })
    const alice = await open('alice')
    const bob = await open('bob')
    expect(alice.got).toEqual(['{"type":"stream.ready"}'])

    await app.inject({
      method: 'POST',
      url: '/api/v1/dev/incoming-call',
      headers: { 'x-dev-user': 'alice' },
      payload: { from: '+33612345678' }
    })
    await new Promise(r => setTimeout(r, 100))

    expect(JSON.parse(alice.got[1]!).type).toBe('call.ringing')
    expect(bob.got).toEqual(['{"type":"stream.ready"}'])
    alice.ws.close()
    bob.ws.close()
    await app.close()
  })
})

describe('history, tenants and tickets', () => {
  const setup = async () => {
    process.env.AUTH_MODE = 'dev'
    const store = new MemoryStore()
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'fake', config: {} }, { tenantId: 'B', type: 'fake', config: {} }], [fakeFactory])
    const app = await buildApp(registry, { store, directory: new StoreDirectory(store), tickets: new TicketStore() })
    const as = (user: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
    const entry = (over: object) => ({ tenantId: 'A', userId: 'alice', callId: 'c1', direction: 'outbound' as const, remoteNumber: '102', startedAt: '2026-10-05T10:00:00.000Z', durationSec: 10, state: 'ended' as const, answered: true, ...over })
    return { app, store, as, entry }
  }

  it('returns only the history of the authenticated user in the authenticated tenant', async () => {
    const { app, store, as, entry } = await setup()
    await store.addHistory(entry({ callId: 'mine' }))
    await store.addHistory(entry({ callId: 'other-user', userId: 'bob' }))
    await store.addHistory(entry({ callId: 'other-tenant', tenantId: 'B' }))
    const res = await app.inject({ url: '/api/v1/calls/history', headers: as('alice') })
    expect(res.json().items.map((e: { id: string }) => e.id)).toEqual(['mine'])
    const other = await app.inject({ url: '/api/v1/calls/history', headers: as('alice', 'B') })
    expect(other.json().items.map((e: { id: string }) => e.id)).toEqual(['other-tenant'])
  })

  it('cannot be pointed at someone else through the query string', async () => {
    const { app, store, as, entry } = await setup()
    await store.addHistory(entry({ callId: 'bobs', userId: 'bob' }))
    const res = await app.inject({ url: '/api/v1/calls/history?userId=bob&tenantId=B&user=bob', headers: as('alice') })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([])
  })

  it('filters, flags missed calls and paginates', async () => {
    const { app, store, as, entry } = await setup()
    await store.addHistory(entry({ callId: '1', startedAt: '2026-10-05T08:00:00.000Z' }))
    await store.addHistory(entry({ callId: '2', direction: 'inbound', answered: false, durationSec: 0, state: 'missed', startedAt: '2026-10-05T09:00:00.000Z' }))
    const missed = (await app.inject({ url: '/api/v1/calls/history?status=missed', headers: as('alice') })).json()
    expect(missed.items).toHaveLength(1)
    expect(missed.items[0]).toMatchObject({ id: '2', missed: true })
    const page = (await app.inject({ url: '/api/v1/calls/history?limit=1', headers: as('alice') })).json()
    expect(page.items.map((e: { id: string }) => e.id)).toEqual(['2'])
    expect(page.next).toBeTruthy()
  })

  it('flags a call the user declined as declined, not missed', async () => {
    const { app, store, as, entry } = await setup()
    await store.addHistory(entry({ callId: 'd', direction: 'inbound', answered: false, durationSec: 0, state: 'rejected' }))
    const items = (await app.inject({ url: '/api/v1/calls/history', headers: as('alice') })).json().items
    expect(items).toEqual([expect.objectContaining({ id: 'd', state: 'rejected', missed: false })])
    expect((await app.inject({ url: '/api/v1/calls/history?status=missed', headers: as('alice') })).json().items).toEqual([])
    expect((await app.inject({ url: '/api/v1/calls/history?status=declined', headers: as('alice') })).json().items.map((e: { id: string }) => e.id)).toEqual(['d'])
  })

  it('rejects malformed filters instead of passing them on', async () => {
    const { app, as } = await setup()
    for (const q of ['direction=sideways', 'status=x', 'limit=abc', 'limit=0', 'from=yesterday', `number=${'9'.repeat(40)}`]) {
      expect((await app.inject({ url: `/api/v1/calls/history?${q}`, headers: as('alice') })).statusCode).toBe(400)
    }
  })

  it('erases the caller history only', async () => {
    const { app, store, as, entry } = await setup()
    await store.addHistory(entry({ callId: 'a' }))
    await store.addHistory(entry({ callId: 'b', userId: 'bob' }))
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('alice') })).json()).toEqual({ deleted: 1 })
    expect((await store.listHistory('A', 'bob')).items).toHaveLength(1)
  })

  it('refuses an anonymous history request', async () => {
    const { app } = await setup()
    expect((await app.inject('/api/v1/calls/history')).statusCode).toBe(401)
  })

  it('issues a single-use ticket that opens the event stream, and refuses a reused or invented one', async () => {
    const { app, as } = await setup()
    await app.listen({ port: 0 })
    const port = (app.server.address() as { port: number }).port
    const { ticket } = (await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: as('alice') })).json()
    const connect = (t: string) => new Promise<'open' | 'closed'>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?ticket=${t}`)
      ws.onopen = () => { setTimeout(() => { ws.close(); resolve('open') }, 100) }
      ws.onclose = () => resolve('closed')
    })
    expect(await connect(ticket)).toBe('open')
    expect(await connect(ticket)).toBe('closed')
    expect(await connect('invented')).toBe('closed')
    await app.close()
  })
})

describe('presence of the tenant', () => {
  /** A provider whose events the test pushes, as provider-opensips does from what OpenSIPS tells it. */
  const pushing = () => {
    const queues = new Map<string, { waiters: ((e: RoutedEvent) => void)[]; pending: RoutedEvent[] }>()
    const queueOf = (tenantId: string) => {
      const q = queues.get(tenantId) ?? { waiters: [], pending: [] }
      queues.set(tenantId, q)
      return q
    }
    const create = (_config: unknown, context?: { tenantId: string }) => {
      const q = queueOf(context?.tenantId ?? '')
      const presences = new Map<string, Presence>()
      return {
        getStatus: () => 'CONNECTED',
        getCapabilities: async () => caps,
        getPresence: async (u: User) => presences.get(u.extension ?? '') ?? { status: 'offline', source: 'telephony' },
        setPresence: async (u: User, p: Presence) => void presences.set(u.extension ?? '', p),
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => (q.pending.length ? Promise.resolve({ value: q.pending.shift()!, done: false }) : new Promise<IteratorResult<RoutedEvent>>(r => q.waiters.push(e => r({ value: e, done: false }))))
          })
        }),
        close: async () => {}
      } as unknown as TelephonyProvider
    }
    const push = (extension: string, event: TelephonyEvent, tenantId = 'A') => {
      const q = queueOf(tenantId)
      const w = q.waiters.shift()
      if (w) w({ extension, event })
      else q.pending.push({ extension, event })
    }
    return { factory: { type: 'pushing', create } as ProviderFactory<unknown>, push }
  }
  const presence = (status: Presence['status']): TelephonyEvent => ({ type: 'presence.changed', timestamp: '2026-10-14T18:00:00.000Z', payload: { userId: '', presence: { status, source: 'telephony' } } })
  const setup = async (store = new MemoryStore(), bus = new EventBus(), historyWriteTimeoutMs?: number) => {
    process.env.AUTH_MODE = 'dev'
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '102' })
    await store.upsertMapping({ tenantId: 'B', userId: 'carol', extension: '101' })
    const { factory, push } = pushing()
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'pushing', config: {} }, { tenantId: 'B', type: 'pushing', config: {} }], [factory])
    const app = await buildApp(registry, { store, bus, directory: new StoreDirectory(store), tickets: new TicketStore(), ...(historyWriteTimeoutMs ? { historyWriteTimeoutMs } : {}) })
    registry.startAll()
    const as = (user: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
    return { app, push, as }
  }
  const ended = (id: string): TelephonyEvent => ({ type: 'call.ended', timestamp: '2026-10-14T18:01:00.000Z', payload: { call: { id, direction: 'outbound', state: 'ended', remoteNumber: '102', startedAt: '2026-10-14T18:00:00.000Z', connectedAt: '2026-10-14T18:00:05.000Z', endedAt: '2026-10-14T18:01:00.000Z' } } })

  it('keeps pumping when one event fails (the directory down a moment)', async () => {
    let failures = 1
    const store = new (class extends MemoryStore {
      override async getMappingByExtension(tenantId: string, extension: string) {
        if (extension === '101' && failures-- > 0) throw new Error('database gone for a moment')
        return super.getMappingByExtension(tenantId, extension)
      }
    })()
    const { app, push, as } = await setup(store)
    push('101', presence('busy'))
    push('101', presence('available'))
    push('102', presence('busy'))
    await new Promise(r => setTimeout(r, 50))
    const items = (await app.inject({ url: '/api/v1/presence', headers: as('bob') })).json().items
    expect(items.map((i: { extension: string; presence: Presence }) => `${i.extension}:${i.presence.status}`)).toEqual(['101:available', '102:busy'])
    await app.close()
  })

  it('records the history of a call before telling it ended (the app reloads its history then)', async () => {
    const recorded: HistoryEntry[] = []
    const store = new (class extends MemoryStore {
      override async addHistory(entry: HistoryEntry) {
        await new Promise(r => setTimeout(r, 20))
        recorded.push(entry)
        return super.addHistory(entry)
      }
    })()
    const bus = new EventBus()
    const { app, push } = await setup(store, bus)
    const seen: number[] = []
    bus.subscribe('A', 'alice', () => seen.push(recorded.length))
    push('101', ended('c1'))
    await new Promise(r => setTimeout(r, 100))
    expect(seen).toEqual([1])
    await app.close()
  })

  it('does not wait for a history write that hangs longer than its timeout: the events go on', async () => {
    const store = new (class extends MemoryStore {
      override async addHistory(entry: HistoryEntry) {
        if (entry.callId === 'c1') return new Promise<void>(() => undefined)
        return super.addHistory(entry)
      }
    })()
    const bus = new EventBus()
    const { app, push } = await setup(store, bus, 30)
    const seen: string[] = []
    bus.subscribe('A', 'alice', e => seen.push(e.type === 'call.ended' ? e.payload.call.id : e.type))
    push('101', ended('c1'))
    push('101', ended('c2'))
    await new Promise(r => setTimeout(r, 200))
    expect(seen).toEqual(['c1', 'c2'])
    expect((await store.listHistory('A', 'alice')).items.map(e => e.callId)).toEqual(['c2'])
    await app.close()
  })

  it('lists the presence of every extension the provider told about, to anyone of the tenant and to nobody else', async () => {
    const { app, push, as } = await setup()
    push('101', presence('available'))
    push('102', presence('busy'))
    push('109', presence('available'))
    await new Promise(r => setTimeout(r, 50))
    const seen = (await app.inject({ url: '/api/v1/presence', headers: as('bob') })).json()
    expect(seen.realtime).toBe(true)
    // 109 is nobody's extension: not told.
    expect(seen.items).toEqual([
      { extension: '101', userId: 'alice', presence: { status: 'available', source: 'telephony' } },
      { extension: '102', userId: 'bob', presence: { status: 'busy', source: 'telephony' } }
    ])
    expect((await app.inject({ url: '/api/v1/presence', headers: as('carol', 'B') })).json().items).toEqual([])
    await app.close()
  })

  it('broadcasts a presence change to every WebSocket of the tenant, with the extension, and calls to their parties only', async () => {
    const { app, push, as } = await setup()
    await app.listen({ port: 0 })
    const port = (app.server.address() as { port: number }).port
    const open = async (user: string, tenant = 'A') => {
      const { ticket } = (await app.inject({ method: 'POST', url: '/api/v1/ws-ticket', headers: as(user, tenant) })).json()
      return new Promise<{ ws: WebSocket; got: TelephonyEvent[] }>(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?ticket=${ticket}`)
        const got: TelephonyEvent[] = []
        ws.onmessage = e => {
          const message = JSON.parse(String(e.data))
          if (message.type === 'stream.ready') resolve({ ws, got })
          else got.push(message)
        }
      })
    }
    const alice = await open('alice')
    const bob = await open('bob')
    const carol = await open('carol', 'B')
    push('101', presence('busy'))
    push('101', { type: 'call.ringing', timestamp: 'T', payload: { call: { id: 'c1', direction: 'outbound', state: 'ringing', remoteNumber: '102' } } })
    await new Promise(r => setTimeout(r, 100))
    expect(alice.got.map(e => e.type)).toEqual(['presence.changed', 'call.ringing'])
    expect(bob.got).toEqual([{ type: 'presence.changed', timestamp: '2026-10-14T18:00:00.000Z', payload: { userId: 'alice', extension: '101', presence: { status: 'busy', source: 'telephony' } } }])
    expect(carol.got).toEqual([])
    for (const w of [alice, bob, carol]) w.ws.close()
    await app.close()
  })

  it('keeps the tenant channel apart from the users: a user named "*" hears only their own calls', () => {
    const bus = new EventBus()
    const star: TelephonyEvent[] = []
    const tenant: TelephonyEvent[] = []
    bus.subscribe('A', '*', e => star.push(e))
    const stop = bus.subscribeTenant('A', e => tenant.push(e))
    bus.publish('A', '*', ended('mine'))
    bus.broadcast('A', presence('busy'))
    bus.broadcast('B', presence('dnd'))
    expect(star.map(e => e.type)).toEqual(['call.ended'])
    expect(tenant.map(e => e.type)).toEqual(['presence.changed'])
    stop()
    bus.broadcast('A', presence('away'))
    expect(tenant).toHaveLength(1)
  })

  it('answers a presence set by the user with what the others see', async () => {
    const { app, as } = await setup()
    const res = await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'dnd' } })
    expect(res.json()).toMatchObject({ status: 'dnd', source: 'user' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'sleeping' } })).statusCode).toBe(400)
    await app.close()
  })
})
