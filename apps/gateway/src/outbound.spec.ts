import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { OutboundAssignment, OutboundPolicy, OutboundProfile, TelephonyEvent } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { parseOutbound } from './outbound.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { parseDid, parseTrunk, trunkFromEnv } from './trunks.js'

// Fictional numbers only (ARCEP: 01 99 00 xx xx, 06 39 98 xx xx), documentation names.
const profiles = [
  { id: 'national', name: 'France', allowed: ['mobile', 'fixed'], caps: { concurrent: 2, dailyMinutes: 120 } },
  { id: 'internal', allowed: [] }
]

describe('parseOutbound', () => {
  it('keeps the profiles, the default one, the caps, the thresholds and who has which, classes in their order', () => {
    expect(
      parseOutbound({
        profiles,
        policy: { defaultProfile: 'internal', caps: { concurrent: 10, monthlyMinutes: 6000 }, fraud: { international: { callsPerMinute: { warning: 2, critical: 4 } } } },
        assignments: [{ userId: 'alice', profileId: 'national' }]
      })
    ).toEqual({
      profiles: [
        { id: 'national', name: 'France', allowed: ['fixed', 'mobile'], caps: { concurrent: 2, dailyMinutes: 120 } },
        { id: 'internal', allowed: [] }
      ],
      policy: { defaultProfile: 'internal', caps: { concurrent: 10, monthlyMinutes: 6000 }, fraud: { international: { callsPerMinute: { warning: 2, critical: 4 } } } },
      assignments: [{ userId: 'alice', profileId: 'national' }]
    })
    expect(parseOutbound({})).toEqual({ profiles: [], policy: {}, assignments: [] })
  })

  it('refuses what is not a profile, a cap, a threshold or a profile that exists, naming the field', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ profiles: [{ id: 'National', allowed: [] }] }, /^id/],
      [{ profiles: [{ id: 'a', allowed: ['premium'] }] }, /allowed/],
      [{ profiles: [{ id: 'a', allowed: ['fixed', 'fixed'] }] }, /allowed/],
      [{ profiles: [{ id: 'a' }] }, /allowed/],
      [{ profiles: [{ id: 'a', allowed: [] }, { id: 'a', allowed: [] }] }, /each id once/],
      [{ profiles: [{ id: 'a', allowed: [], caps: { concurrent: 0 } }] }, /caps\.concurrent/],
      [{ profiles: [{ id: 'a', allowed: [], caps: { hourlyCalls: 3 } }] }, /caps\.hourlyCalls/],
      [{ profiles: [{ id: 'a', allowed: [], name: 'two\nlines' }] }, /name/],
      [{ policy: { defaultProfile: 'none' } }, /defaultProfile/],
      [{ policy: { caps: { dailyCalls: 2.5 } } }, /dailyCalls/],
      [{ policy: { fraud: { national: { callsPerMinute: { warning: 5, critical: 3 } } } } }, /warning comes before/],
      [{ policy: { fraud: { national: { perHour: {} } } } }, /perHour/],
      [{ policy: { fraud: { national: { callsPerMinute: { warning: -1 } } } } }, /warning/],
      [{ assignments: [{ userId: 'alice', profileId: 'none' }] }, /profileId/],
      [{ profiles, assignments: [{ userId: 'alice', profileId: 'internal' }, { userId: 'alice', profileId: 'national' }] }, /alice once/],
      [{ assignments: [{ userId: 'a b', profileId: 'x' }] }, /userId/]
    ]
    for (const [body, error] of bad) {
      expect(() => parseOutbound(body), JSON.stringify(body)).toThrow(error)
      expect(() => parseOutbound(body)).toThrow(expect.objectContaining({ statusCode: 400, code: 'OUTBOUND_INVALID' }))
    }
  })
})

describe('the fallback number (FR-C8)', () => {
  const trunk = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], defaultNumber: '+33199000100' }
  const trunks = [{ id: 'operator' }]
  it('is a number in E.164 of a trunk or of a range, never one of our own direct numbers (the call would come back)', () => {
    expect(parseTrunk({ ...trunk, fallbackNumber: '+33199000199' }).config.fallbackNumber).toBe('+33199000199')
    expect(() => parseTrunk({ ...trunk, fallbackNumber: '0199000199' })).toThrow(/^fallbackNumber/)
    const others = [{ id: 'sales', trunkId: 'operator', first: '+33199000130', last: '+33199000139', suffixDigits: 3, fallbackNumber: '+33199000120' }]
    expect(parseDid('desk', { trunkId: 'operator', first: '+33199000101', target: '101', fallbackNumber: '+33199000199' }, trunks, others).fallbackNumber).toBe('+33199000199')
    expect(() => parseDid('desk', { trunkId: 'operator', first: '+33199000101', target: '101', fallbackNumber: '+33199000135' }, trunks, others)).toThrow(expect.objectContaining({ statusCode: 409, code: 'FALLBACK_LOOP' }))
    expect(() => parseDid('desk', { trunkId: 'operator', first: '+33199000101', target: '101', fallbackNumber: '+33199000101' }, trunks, others)).toThrow(/come back/)
    // A new range that takes in another one's fallback number.
    expect(() => parseDid('desk', { trunkId: 'operator', first: '+33199000120', target: '101' }, trunks, others)).toThrow(expect.objectContaining({ code: 'FALLBACK_LOOP' }))
    expect(trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_FALLBACK_NUMBER: '+33199000199' })?.parsed.config.fallbackNumber).toBe('+33199000199')
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_FALLBACK_NUMBER: '+33199000101', TRUNK_DIDS: '+33199000101=101' })).toThrow(/^TRUNK_FALLBACK_NUMBER/)
  })
})

describe('outbound routes', () => {
  type Handed = [OutboundPolicy, OutboundProfile[], OutboundAssignment[]]
  const setup = async (opts: { store?: MemoryStore; without?: boolean; events?: RoutedEvent[] } = {}) => {
    process.env.AUTH_MODE = 'dev'
    const store = opts.store ?? new MemoryStore()
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101' })
    const handed: Handed[] = []
    const control: { fail?: Error } = {}
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ trunks: true, outboundPolicy: !opts.without }),
      subscribe: async function* () {
        for (const e of opts.events ?? []) yield e
      },
      close: async () => {},
      ...(opts.without
        ? {}
        : {
            setOutboundPolicy: async (...args: Handed) => {
              handed.push(args)
              const fail = control.fail
              control.fail = undefined
              if (fail) throw fail
            }
          })
    }
    const factory: ProviderFactory<unknown> = { type: 'recording', create: () => provider as unknown as TelephonyProvider }
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'recording', config: {} }, { tenantId: 'B', type: 'recording', config: {} }], [factory])
    const bus = new EventBus()
    const published: TelephonyEvent[] = []
    const publish = bus.publish.bind(bus)
    bus.publish = (tenantId, userId, event) => {
      published.push(event)
      publish(tenantId, userId, event)
    }
    const app = await buildApp(registry, { store, bus, directory: new StoreDirectory(store), tickets: new TicketStore(), admin: { adminRole: 'twakephone-admin', adminUsers: new Set() }, secretsKey: randomBytes(32) })
    registry.startAll()
    const as = (user: string, roles?: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant, ...(roles ? { 'x-dev-roles': roles } : {}) })
    return { app, as, admin: as('root', 'twakephone-admin'), handed, store, control, published }
  }
  const settle = async (test: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 2000
    while (!(await test()) && Date.now() < until) await new Promise(r => setTimeout(r, 10))
  }

  it('lets an administrator set the rights profiles, caps and thresholds, hands them whole to the provider, then keeps them', async () => {
    const { app, admin, handed, store } = await setup()
    // Nothing set: no profile, no cap, the default thresholds (shown).
    const empty = await app.inject({ url: '/api/v1/admin/outbound', headers: admin })
    expect(empty.json()).toMatchObject({ policy: {}, profiles: [], assignments: [], defaults: { fraud: { national: { callsPerMinute: { warning: 6, critical: 20 } } } } })
    const body = { profiles, policy: { defaultProfile: 'internal', caps: { concurrent: 4 } }, assignments: [{ userId: 'alice', profileId: 'national' }] }
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: body })
    expect(put.statusCode).toBe(200)
    expect(handed.at(-1)).toEqual([{ defaultProfile: 'internal', caps: { concurrent: 4 } }, [expect.objectContaining({ id: 'national', allowed: ['fixed', 'mobile'] }), { id: 'internal', allowed: [] }], [{ userId: 'alice', profileId: 'national' }]])
    expect((await store.getOutbound('A'))?.assignments).toEqual([{ userId: 'alice', profileId: 'national' }])
    // One person's profile, or back to the default one.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound/users/bob', headers: admin, payload: { profileId: 'national' } })).json()).toEqual({ userId: 'bob', profileId: 'national' })
    expect(handed.at(-1)![2]).toEqual([{ userId: 'alice', profileId: 'national' }, { userId: 'bob', profileId: 'national' }])
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound/users/alice', headers: admin, payload: { profileId: null } })).statusCode).toBe(200)
    expect((await store.getOutbound('A'))?.assignments).toEqual([{ userId: 'bob', profileId: 'national' }])
    const unknown = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound/users/bob', headers: admin, payload: { profileId: 'premium' } })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json()).toMatchObject({ code: 'OUTBOUND_INVALID' })
    // A profile still given to someone cannot go.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles: [profiles[1]], assignments: [{ userId: 'bob', profileId: 'national' }] } })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/v1/admin/outbound', headers: admin })).json()).toMatchObject({ policy: { defaultProfile: 'internal' }, assignments: [{ userId: 'bob', profileId: 'national' }] })
  })

  it('keeps out whoever is not an administrator, each tenant to its own rules, and says 501 where they are not available', async () => {
    const { app, as, admin } = await setup()
    expect((await app.inject({ url: '/api/v1/admin/outbound', headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: as('bob'), payload: { profiles } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/admin/alerts', headers: as('bob') })).statusCode).toBe(403)
    await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles } })
    expect((await app.inject({ url: '/api/v1/admin/outbound', headers: as('root', 'twakephone-admin', 'B') })).json().profiles).toEqual([])
    const bare = await setup({ without: true })
    expect((await bare.app.inject({ url: '/api/v1/admin/outbound', headers: bare.admin })).statusCode).toBe(501)
  })

  it('fails a change the SIP server did not apply (502) and hands it back what it had; the same when the store fails', async () => {
    const { app, admin, handed, store, control } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles } })
    control.fail = Object.assign(new Error('OpenSIPS did not reload the thresholds'), { statusCode: 502, code: 'OUTBOUND_RELOAD_FAILED' })
    const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles: [] } })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ code: 'OUTBOUND_RELOAD_FAILED' })
    expect(handed.slice(-2).map(h => h[1].length)).toEqual([0, 2])
    expect((await store.getOutbound('A'))?.profiles).toHaveLength(2)
    store.setOutbound = async () => {
      throw new Error('database down')
    }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles: [] } })).statusCode).toBe(500)
    expect(handed.slice(-2).map(h => h[1].length)).toEqual([0, 2])
  })

  it('hands the provider the rules the store kept as soon as it starts, the empty ones when none', async () => {
    const store = new MemoryStore()
    await store.setOutbound({ tenantId: 'A', policy: { defaultProfile: 'internal' }, profiles: [{ id: 'internal', allowed: [] }], assignments: [] })
    const { handed } = await setup({ store })
    await settle(() => handed.length >= 2)
    expect(handed).toContainEqual([{ defaultProfile: 'internal' }, [{ id: 'internal', allowed: [] }], []])
    expect(handed).toContainEqual([{}, [], []])
  })

  it("keeps the SIP server's alerts for the administrators, with who holds the extension, and never tells the person", async () => {
    const alert = { kind: 'fraud-critical' as const, param: 'callsPerMinute', scope: 'user' as const, value: 6, threshold: 6, extension: '101', number: '+442079460123' }
    const limit = { kind: 'limit' as const, param: 'concurrent', scope: 'tenant' as const, extension: '101', number: '+33199000004' }
    const events: RoutedEvent[] = [
      { extension: '101', event: { type: 'alert.raised', timestamp: '2026-10-15T10:00:00.000Z', payload: { alert } } },
      { extension: '101', event: { type: 'alert.raised', timestamp: '2026-10-15T10:01:00.000Z', payload: { alert: limit } } }
    ]
    const { app, admin, published, store } = await setup({ events })
    await settle(async () => (await store.listAlerts('A')).length === 2)
    const list = await app.inject({ url: '/api/v1/admin/alerts?limit=10', headers: admin })
    expect(list.json().items).toEqual([
      { at: '2026-10-15T10:01:00.000Z', ...limit, userId: 'alice' },
      { at: '2026-10-15T10:00:00.000Z', ...alert, userId: 'alice' }
    ])
    expect(published).toEqual([])
  })

})
