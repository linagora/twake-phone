import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Call, TelephonyEvent } from '@twake/telephony-types'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { MemoryStore } from './store/memory.js'
import { ProviderRegistry } from './registry.js'

process.env.AUTH_MODE = 'dev'

const call = (id: string, state: Call['state'] = 'ringing'): Call => ({ id, direction: 'inbound', state, remoteNumber: '+33612345678' })

/** A provider that reports calls for alice's extension and records which actions reached it. */
const setup = async () => {
  const acted: string[] = []
  const events: { extension: string; event: TelephonyEvent }[] = [{ extension: '101', event: { type: 'call.ringing', timestamp: new Date().toISOString(), payload: { call: call('alice-call') } } }]
  const factory: ProviderFactory<unknown> = {
    type: 'fake',
    create: () =>
      ({
        getStatus: () => 'CONNECTED',
        getCapabilities: async () => ({}) as never,
        subscribe: async function* () {
          for (const e of events) yield e
        },
        originate: async () => call('bob-call', 'new'),
        hold: async (id: string) => void acted.push(`hold ${id}`),
        hangup: async (id: string) => void acted.push(`hangup ${id}`),
        close: async () => {}
      }) as unknown as TelephonyProvider
  }
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'dev', userId: 'alice', extension: '101' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'bob', extension: '102' })
  const registry = new ProviderRegistry([{ tenantId: 'dev', type: 'fake', config: {} }], [factory])
  const app = await buildApp(registry, { store })
  registry.startAll()
  await new Promise(r => setTimeout(r, 50)) // let the event pump record the call
  return { app, acted }
}
const as = (user: string) => ({ 'x-dev-user': user })

describe('call ownership', () => {
  it('lets a user act on a call that was reported to them', async () => {
    const { app, acted } = await setup()
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/alice-call/hold', headers: as('alice') })).statusCode).toBe(204)
    expect(acted).toEqual(['hold alice-call'])
  })

  it('answers 404 to another user, as if the call did not exist, and never reaches the provider', async () => {
    const { app, acted } = await setup()
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/alice-call/hangup', headers: as('bob') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/no-such-call/hangup', headers: as('bob') })).statusCode).toBe(404)
    expect(acted).toEqual([])
  })

  it('owns the call a user just originated, even before any event for it', async () => {
    const { app, acted } = await setup()
    const placed = await app.inject({ method: 'POST', url: '/api/v1/calls', headers: as('bob'), payload: { target: '+33612345678' } })
    expect(placed.statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/bob-call/hangup', headers: as('bob') })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: '/api/v1/calls/bob-call/hangup', headers: as('alice') })).statusCode).toBe(404)
    expect(acted).toEqual(['hangup bob-call'])
  })
})
