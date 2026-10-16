import { describe, expect, it } from 'vitest'
import type { TrunkStatus, WebhookEvent } from '@twake/telephony-types'
import { MemoryStore } from './store/memory.js'
import { TrunkWatch, trunkHealthOf } from './trunk-health.js'

const trunk = (servers: TrunkStatus['servers'], registration?: TrunkStatus['registration']): TrunkStatus => ({ id: 'tr1', servers, ...(registration ? { registration } : {}) })

describe('the health of a trunk', () => {
  it('is up while its servers answer and its registration holds (or is under way)', () => {
    expect(trunkHealthOf(trunk([{ address: '192.0.2.10:5060', state: 'up' }]))).toBe('up')
    expect(trunkHealthOf(trunk([{ address: '192.0.2.10:5060', state: 'up' }, { address: '192.0.2.11:5060', state: 'disabled' }], { state: 'registering' }))).toBe('up')
  })
  it('is degraded when some of its servers answer no probe, down when none does or the registration is lost', () => {
    expect(trunkHealthOf(trunk([{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'up' }]))).toBe('degraded')
    expect(trunkHealthOf(trunk([{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'disabled' }]))).toBe('down')
    for (const state of ['refused', 'timeout', 'error', 'unregistered'] as const) expect(trunkHealthOf(trunk([{ address: '192.0.2.10:5060', state: 'up' }], { state })), state).toBe('down')
  })
  it('is not watched when an administrator disabled it whole', () => {
    expect(trunkHealthOf(trunk([{ address: '192.0.2.10:5060', state: 'disabled' }]))).toBeUndefined()
    expect(trunkHealthOf(trunk([], { state: 'disabled' }))).toBeUndefined()
  })
})

describe('the watch over the trunks', () => {
  const setup = (confirm = 2) => {
    const store = new MemoryStore()
    let status: TrunkStatus[] | undefined = [trunk([{ address: '192.0.2.10:5060', state: 'up' }, { address: '192.0.2.11:5060', state: 'up' }])]
    const told: Extract<WebhookEvent, { type: 'trunk.degraded' }>[] = []
    const watch = (s = store) =>
      new TrunkWatch({
        store: s,
        tenants: () => ['acme'],
        read: async () => status,
        names: async () => new Map([['tr1', 'Opérateur principal']]),
        publish: async (_t, e) => told.push(e),
        confirm
      })
    return { store, told, watch, set: (s: TrunkStatus[] | undefined) => (status = s) }
  }

  it('tells a trunk that gets worse once it is seen twice in a row, and each step down once', async () => {
    const { told, watch, set } = setup()
    const w = watch()
    await w.tick()
    expect(told).toEqual([])
    set([trunk([{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'up' }])])
    await w.tick()
    expect(told).toHaveLength(0)
    await w.tick()
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({
      type: 'trunk.degraded',
      tenant: 'acme',
      trunk: { id: 'tr1', name: 'Opérateur principal', state: 'degraded', previous: 'up', servers: [{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'up' }] }
    })
    await w.tick()
    expect(told).toHaveLength(1)
    set([trunk([{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'probing' }])])
    await w.tick()
    await w.tick()
    expect(told.map(e => [e.trunk.state, e.trunk.previous])).toEqual([
      ['degraded', 'up'],
      ['down', 'degraded']
    ])
    // Back up: kept, nothing told; down again: told again.
    set([trunk([{ address: '192.0.2.10:5060', state: 'up' }, { address: '192.0.2.11:5060', state: 'up' }])])
    await w.tick()
    expect(told).toHaveLength(2)
    set([trunk([{ address: '192.0.2.10:5060', state: 'up' }, { address: '192.0.2.11:5060', state: 'up' }], { state: 'refused' })])
    await w.tick()
    await w.tick()
    expect(told.map(e => [e.trunk.state, e.trunk.previous, e.trunk.registration])).toEqual([
      ['degraded', 'up', undefined],
      ['down', 'degraded', undefined],
      ['down', 'up', 'refused']
    ])
  })

  it('tells nothing of a blip of one read, nor when the SIP server cannot say', async () => {
    const { told, watch, set } = setup()
    const w = watch()
    await w.tick()
    set([trunk([{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'up' }])])
    await w.tick()
    set(undefined)
    await w.tick()
    set([trunk([{ address: '192.0.2.10:5060', state: 'up' }, { address: '192.0.2.11:5060', state: 'up' }])])
    await w.tick()
    expect(told).toEqual([])
  })

  it('tells it once whatever the Gateways that watch, and not again after a restart', async () => {
    const { store, told, watch, set } = setup()
    const a = watch(store)
    const b = watch(store)
    set([trunk([{ address: '192.0.2.10:5060', state: 'probing' }, { address: '192.0.2.11:5060', state: 'probing' }])])
    for (let i = 0; i < 2; i++) await Promise.all([a.tick(), b.tick()])
    expect(told).toHaveLength(1)
    expect(told[0]!.trunk).toMatchObject({ state: 'down' })
    expect(told[0]!.trunk).not.toHaveProperty('previous')
    // A Gateway that starts again while the trunk is still down: the store already knows it.
    const c = watch(store)
    await c.tick()
    await c.tick()
    expect(told).toHaveLength(1)
  })
})
