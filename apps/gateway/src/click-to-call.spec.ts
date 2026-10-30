import { afterEach, describe, expect, it } from 'vitest'
import { SupervisionError } from '@twake/provider-wazo'
import type { ProviderFactory, SupervisionProvider, TelephonyProvider } from '@twake/telephony-provider-sdk'
import { buildApp } from './app.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'

// Click-to-call (ADR 0033): the SIP server cannot place a call; the voicemail and telephony server rings the person's line.

const as = (user: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'dev' })
const apps: { close(): Promise<undefined | void> }[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
})

const setup = async (opts: { clickToCall?: boolean; refuse?: 'refused' | 'unavailable'; outbound?: boolean; grants?: boolean } = {}) => {
  process.env.AUTH_MODE = 'dev'
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'dev', userId: 'bdurand', extension: '103', displayName: 'Bob Durand' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'amartin', extension: '101', displayName: 'Alice Martin' })
  const placed: { extension: string; target: string; grant: string }[] = []
  const order: string[] = []
  const calling = { outbound: opts.outbound ?? false, inbound: true, answer: false, hangup: false, hold: false, transfer: false, dtmf: false }
  const telephony: ProviderFactory<unknown> = {
    type: 'fake',
    create: () =>
      ({
        getStatus: () => 'CONNECTED',
        getCapabilities: async () => ({ calling, media: { browserAudio: true } }),
        // Only Bob's extension has a line at Wazo.
        listWazoLines: async () => ['103'],
        ...(opts.grants === false
          ? {}
          : {
              grantClickToCall: async (extension: string, number: string) => {
                order.push(`grant ${extension} ${number}`)
                return 'f'.repeat(32)
              }
            }),
        originate: async () => {
          throw Object.assign(new Error('Click-to-call is not available yet'), { statusCode: 501 })
        },
        subscribe: async function* () {},
        close: async () => {}
      }) as unknown as TelephonyProvider
  }
  const server = {
    id: 'fake',
    ...(opts.clickToCall === false
      ? {}
      : {
          async clickToCall(line: { extension: string }, target: string, grant: string) {
            if (opts.refuse) throw new SupervisionError('no', opts.refuse)
            placed.push({ extension: line.extension, target, grant })
            order.push(`ring ${line.extension}`)
          }
        })
  } as unknown as SupervisionProvider
  const app = await buildApp(new ProviderRegistry([{ tenantId: 'dev', type: 'fake', config: {} }], [telephony]), { store, supervision: () => server })
  apps.push(app)
  const capabilities = async (user: string) => (await app.inject({ url: '/api/v1/capabilities', headers: as(user) })).json()
  const call = (user: string, target: unknown) => app.inject({ method: 'POST', url: '/api/v1/calls', payload: { target } as object, headers: as(user) })
  return { placed, order, capabilities, call }
}

describe('click-to-call', () => {
  it('is offered to whoever has a line at the telephony server, and calling then rings their phone with the number', async () => {
    const { placed, order, capabilities, call } = await setup()
    const bob = await capabilities('bdurand')
    expect(bob.clickToCall).toBe(true)
    expect(bob.calling.outbound).toBe(true)
    const res = await call('bdurand', '+33612345678')
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ direction: 'outbound', state: 'new', remoteNumber: '+33612345678' })
    expect(placed).toEqual([{ extension: '103', target: '+33612345678', grant: 'f'.repeat(32) }])
    // The SIP server lets Wazo's call through only with the Gateway's grant, written before the line rings and handed to Wazo.
    expect(order).toEqual(['grant 103 +33612345678', 'ring 103'])
  })

  it('is not offered to someone without a line, nor without a server that can, nor when the SIP server places calls itself', async () => {
    const { placed, capabilities, call } = await setup()
    const alice = await capabilities('amartin')
    expect(alice.clickToCall).toBeUndefined()
    expect(alice.calling.outbound).toBe(false)
    expect((await call('amartin', '102')).statusCode).toBe(501)
    expect(placed).toEqual([])
    expect((await (await setup({ clickToCall: false })).capabilities('bdurand')).clickToCall).toBeUndefined()
    expect((await (await setup({ outbound: true })).capabilities('bdurand')).clickToCall).toBeUndefined()
    expect((await (await setup({ grants: false })).capabilities('bdurand')).clickToCall).toBeUndefined()
  })

  it('refuses what is not an extension or a number in E.164, and says when the server refused or cannot be reached', async () => {
    const { placed, call } = await setup()
    for (const target of ['', 'sip:102@evil', '102,Hangup', '+3361234567890123456789', 102, null]) expect((await call('bdurand', target)).statusCode, String(target)).toBe(400)
    expect(placed).toEqual([])
    expect((await (await setup({ refuse: 'refused' })).call('bdurand', '102')).statusCode).toBe(409)
    expect((await (await setup({ refuse: 'unavailable' })).call('bdurand', '102')).statusCode).toBe(503)
  })
})
