import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { MemoryStore } from './store/memory.js'
import { ProviderRegistry } from './registry.js'
import type { ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Presence, TelephonyEvent, User } from '@twake/telephony-types'

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

  it('rejects unauthenticated calls', async () => {
    process.env.AUTH_MODE = 'dev'
    const app = await buildApp(new ProviderRegistry([]))
    const res = await app.inject('/api/v1/me')
    expect(res.statusCode).toBe(401)
  })
})

describe('event stream', () => {
  it('delivers a simulated incoming call to the websocket of that user only', async () => {
    process.env.AUTH_MODE = 'dev'
    const { buildApp: build } = await import('./app.js')
    const app = await build(new ProviderRegistry([]))
    await app.listen({ port: 0 })
    const port = (app.server.address() as { port: number }).port

    const open = (user: string) =>
      new Promise<{ ws: WebSocket; got: string[] }>(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?user=${user}`)
        const got: string[] = []
        ws.onmessage = e => got.push(String(e.data))
        ws.onopen = () => resolve({ ws, got })
      })
    const alice = await open('alice')
    const bob = await open('bob')

    await app.inject({
      method: 'POST',
      url: '/api/v1/dev/incoming-call',
      headers: { 'x-dev-user': 'alice' },
      payload: { from: '+33612345678' }
    })
    await new Promise(r => setTimeout(r, 100))

    expect(JSON.parse(alice.got[0]!).type).toBe('call.ringing')
    expect(bob.got).toHaveLength(0)
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
  const setup = async () => {
    process.env.AUTH_MODE = 'dev'
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '102' })
    await store.upsertMapping({ tenantId: 'B', userId: 'carol', extension: '101' })
    const { factory, push } = pushing()
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'pushing', config: {} }, { tenantId: 'B', type: 'pushing', config: {} }], [factory])
    const app = await buildApp(registry, { store, directory: new StoreDirectory(store), tickets: new TicketStore() })
    registry.startAll()
    const as = (user: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
    return { app, push, as }
  }

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
        ws.onmessage = e => got.push(JSON.parse(String(e.data)))
        ws.onopen = () => resolve({ ws, got })
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

  it('answers a presence set by the user with what the others see', async () => {
    const { app, as } = await setup()
    const res = await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'dnd' } })
    expect(res.json()).toMatchObject({ status: 'dnd', source: 'user' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('alice'), payload: { status: 'sleeping' } })).statusCode).toBe(400)
    await app.close()
  })
})
