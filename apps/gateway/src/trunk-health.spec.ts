import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { TrunkStatus, WebhookEvent } from '@twake/telephony-types'
import { MemoryStore } from './store/memory.js'
import { TrunkWatch, trunkHealthOf } from './trunk-health.js'
import { WebhookHub } from './webhooks.js'

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

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
  const UP = [{ address: '192.0.2.10:5060', state: 'up' as const }, { address: '192.0.2.11:5060', state: 'up' as const }]
  const ONE_OUT = [{ address: '192.0.2.10:5060', state: 'probing' as const }, { address: '192.0.2.11:5060', state: 'up' as const }]
  const ALL_OUT = [{ address: '192.0.2.10:5060', state: 'probing' as const }, { address: '192.0.2.11:5060', state: 'probing' as const }]
  const setup = async (confirm = 2) => {
    const store = new MemoryStore()
    let writes = 0
    const write = store.setWebhookState.bind(store)
    store.setWebhookState = (...args) => {
      writes++
      return write(...args)
    }
    await store.setWebhookDomains('acme', ['crm.example.org'])
    const subscribe = () => store.addWebhookSubscription({ tenantId: 'acme', id: 'wh_00000000000000c1', url: 'https://crm.example.org/in', events: ['trunk.degraded', 'trunk.recovered'], enabled: true, secretEnc: 'enc', failures: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 20)
    await subscribe()
    let status: TrunkStatus[] | undefined = [trunk(UP)]
    const gateway = async (tenants = ['acme']) => {
      const hub = new WebhookHub({ store, key: randomBytes(32), logger: quiet, stateLeaseMs: 60_000 })
      await hub.renewLease()
      const watch = new TrunkWatch({
        leading: () => hub.leading,
        publishChange: (...args) => hub.publishChange(...args),
        tenants: () => tenants,
        read: async () => status,
        names: async () => new Map([['tr1', 'Opérateur principal']]),
        told: tenantId => store.listWebhookStates(tenantId, 'trunk:'),
        confirm
      })
      return { hub, watch }
    }
    const told = async () => (await store.listWebhookDeliveries('acme', 'wh_00000000000000c1')).reverse().map(d => JSON.parse(d.body) as TrunkEvent)
    return { store, told, gateway, subscribe, writes: () => writes, set: (s: TrunkStatus[] | undefined) => (status = s) }
  }
  type TrunkEvent = Extract<WebhookEvent, { type: 'trunk.degraded' | 'trunk.recovered' }>
  const steps = (events: TrunkEvent[]) => events.map(e => [e.type, e.trunk.state, e.trunk.previous])

  it('tells a trunk that gets worse once it is seen twice in a row, each step down once, and its recovery seen twice too', async () => {
    const { told, gateway, set } = await setup()
    const { watch: w } = await gateway()
    await w.tick()
    await w.tick()
    expect(await told()).toEqual([])
    set([trunk(ONE_OUT)])
    await w.tick()
    expect(await told()).toHaveLength(0)
    await w.tick()
    const [first] = await told()
    expect(first).toMatchObject({
      type: 'trunk.degraded',
      tenant: 'acme',
      trunk: { id: 'tr1', name: 'Opérateur principal', state: 'degraded', previous: 'up', servers: ONE_OUT }
    })
    await w.tick()
    expect(await told()).toHaveLength(1)
    set([trunk(ALL_OUT)])
    await w.tick()
    await w.tick()
    // Back up: told once seen twice too.
    set([trunk(UP)])
    await w.tick()
    expect(await told()).toHaveLength(2)
    await w.tick()
    await w.tick()
    set([trunk(UP, { state: 'refused' })])
    await w.tick()
    await w.tick()
    const events = await told()
    expect(steps(events)).toEqual([
      ['trunk.degraded', 'degraded', 'up'],
      ['trunk.degraded', 'down', 'degraded'],
      ['trunk.recovered', 'up', 'down'],
      ['trunk.degraded', 'down', 'up']
    ])
    expect(events[3]!.trunk.registration).toBe('refused')
    expect(events[2]!.trunk.servers).toEqual(UP)
  })

  it('tells a partial recovery (down to degraded), and a trunk no longer watched as recovered, removed (review 10a, second, n°16)', async () => {
    const { told, gateway, set } = await setup()
    const { watch: w } = await gateway()
    const twice = async () => {
      await w.tick()
      await w.tick()
    }
    const backup = (servers: TrunkStatus['servers']): TrunkStatus => ({ id: 'tr2', servers })
    set([trunk(UP), backup(UP)])
    await twice()
    set([trunk(ALL_OUT), backup(ALL_OUT)])
    await twice()
    set([trunk(ONE_OUT), backup(ALL_OUT)])
    await twice()
    // tr1 disabled whole by an administrator, tr2 deleted: nothing to wait for any more, told at once.
    set([trunk([{ address: '192.0.2.10:5060', state: 'disabled' }, { address: '192.0.2.11:5060', state: 'disabled' }])])
    await w.tick()
    const events = await told()
    const of = (id: string) => events.filter(e => e.trunk.id === id).map(e => [e.type, e.trunk.state, e.trunk.previous, 'removed' in e.trunk ? e.trunk.removed : undefined])
    expect(of('tr1')).toEqual([
      ['trunk.degraded', 'down', 'up', undefined],
      ['trunk.degraded', 'degraded', 'down', undefined],
      ['trunk.recovered', 'up', 'degraded', true]
    ])
    expect(of('tr2')).toEqual([
      ['trunk.degraded', 'down', 'up', undefined],
      ['trunk.recovered', 'up', 'down', true]
    ])
    // Enabled again and up: nothing (it was told recovered); down again: told from up.
    set([trunk(UP)])
    await twice()
    expect(await told()).toHaveLength(5)
    set([trunk(ALL_OUT)])
    await twice()
    expect(steps((await told()).filter(e => e.trunk.id === 'tr1').slice(3))).toEqual([['trunk.degraded', 'down', 'up']])
  })

  it('tells the trunk deleted while another Gateway told it down, from what the store kept (review 10a, second, n°16)', async () => {
    const { told, gateway, set } = await setup()
    const a = await gateway()
    set([trunk(ALL_OUT)])
    await a.watch.tick()
    await a.watch.tick()
    await a.hub.stop()
    // The trunk deleted meanwhile; the next Gateway never saw it, the store did.
    set([])
    const b = await gateway()
    expect(b.hub.leading).toBe(true)
    await b.watch.tick()
    expect(steps(await told())).toEqual([
      ['trunk.degraded', 'down', undefined],
      ['trunk.recovered', 'up', 'down']
    ])
  })

  it('reads several tenants at a time, and says when a round runs over the next one', async () => {
    const { store } = await setup()
    const warned: string[] = []
    const hub = new WebhookHub({ store, key: randomBytes(32), logger: quiet, stateLeaseMs: 60_000 })
    await hub.renewLease()
    let reading = 0
    let most = 0
    let release: () => void = () => undefined
    const held = new Promise<void>(r => (release = r))
    const watch = new TrunkWatch({
      leading: () => hub.leading,
      publishChange: (...args) => hub.publishChange(...args),
      tenants: () => Array.from({ length: 20 }, (_, i) => `t${i}`),
      read: async () => {
        most = Math.max(most, ++reading)
        await held
        reading--
        return []
      },
      names: async () => new Map(),
      parallel: 4,
      logger: { warn: (_o, msg) => void warned.push(msg ?? '') }
    })
    const round = watch.tick()
    await new Promise(r => setTimeout(r, 20))
    await watch.tick()
    await watch.tick()
    release()
    await round
    expect(most).toBe(4)
    expect(warned).toEqual(['trunk health: a round is still going, the next one is skipped'])
    await hub.stop()
  })

  it('tells nothing of a blip of one read, nor when the SIP server cannot say, nor of a trunk that wavers back for one read', async () => {
    const { told, gateway, set } = await setup()
    const { watch: w } = await gateway()
    await w.tick()
    await w.tick()
    set([trunk(ONE_OUT)])
    await w.tick()
    set(undefined)
    await w.tick()
    set([trunk(UP)])
    await w.tick()
    expect(await told()).toEqual([])
    // Degraded twice, up once, degraded twice…: one trunk.degraded, no recovery (never up twice in a row).
    for (let i = 0; i < 3; i++) {
      set([trunk(ONE_OUT)])
      await w.tick()
      await w.tick()
      set([trunk(UP)])
      await w.tick()
    }
    expect(steps(await told())).toEqual([['trunk.degraded', 'degraded', 'up']])
  })

  it('knows the trunk was up when its first subscriber comes after it was read: what was not written is written then', async () => {
    const { store, told, gateway, subscribe, set } = await setup()
    await store.deleteWebhookSubscription('acme', 'wh_00000000000000c1')
    const { hub, watch: w } = await gateway()
    await w.tick()
    await w.tick()
    await subscribe()
    hub.forget('acme')
    await w.tick()
    set([trunk(ONE_OUT)])
    await w.tick()
    await w.tick()
    expect(steps(await told())).toEqual([['trunk.degraded', 'degraded', 'up']])
  })

  it('is told by the Gateway that holds the lease only, once, and not again after a restart; nothing written without a subscriber', async () => {
    const { told, gateway, writes, set } = await setup()
    const a = await gateway()
    const b = await gateway()
    expect([a.hub.leading, b.hub.leading]).toEqual([true, false])
    set([trunk(ALL_OUT)])
    for (let i = 0; i < 2; i++) await Promise.all([a.watch.tick(), b.watch.tick()])
    const events = await told()
    expect(steps(events)).toEqual([['trunk.degraded', 'down', undefined]])
    // A Gateway that starts again while the trunk is still down: the store already knows it.
    const c = await gateway()
    expect(c.hub.leading).toBe(false)
    for (let i = 0; i < 2; i++) await Promise.all([a.watch.tick(), c.watch.tick()])
    expect(await told()).toHaveLength(1)
    // The leader restarting (a new watch, same lease holder gone and back): the store remembers the trunk is down.
    const again = new TrunkWatch({ leading: () => a.hub.leading, publishChange: (...args) => a.hub.publishChange(...args), tenants: () => ['acme'], read: async () => [trunk(ALL_OUT)], names: async () => new Map(), confirm: 2 })
    for (let i = 0; i < 3; i++) await again.tick()
    expect(await told()).toHaveLength(1)
    // Another tenant, nobody subscribed to its trunks: read, nothing written.
    const before = writes()
    const other = await gateway(['other'])
    await other.watch.tick()
    await other.watch.tick()
    expect(writes()).toBe(before)
  })
})
