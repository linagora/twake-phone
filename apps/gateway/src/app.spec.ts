import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { MemoryStore } from './store/memory.js'
import { ProviderRegistry } from './registry.js'
import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'

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
