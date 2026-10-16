import { createHash, randomBytes } from 'node:crypto'
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

  it('keeps a cap lifted (null) apart from one left to its default (absent), and the caps of those without a profile (review 6b, n°6)', () => {
    expect(parseOutbound({ policy: { userCaps: { concurrent: 3, dailyMinutes: null }, caps: { concurrent: null } }, profiles: [{ id: 'a', allowed: [], caps: { dailyMinutes: null } }] })).toEqual({
      profiles: [{ id: 'a', allowed: [], caps: { dailyMinutes: null } }],
      policy: { userCaps: { concurrent: 3, dailyMinutes: null }, caps: { concurrent: null } },
      assignments: []
    })
    expect(() => parseOutbound({ policy: { userCaps: { concurrent: 0 } } })).toThrow(/userCaps\.concurrent/)
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

describe('the fallback (FR-C8, review 6b, n°1)', () => {
  const trunk = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], defaultNumber: '+33199000100' }
  const trunks = [{ id: 'operator' }]
  it('is an extension or a ring group of a trunk or of a range, never a number outside, nor where the number rings already', () => {
    expect(parseTrunk({ ...trunk, fallbackTarget: '199' }).config.fallbackTarget).toBe('199')
    for (const bad of ['+33199000199', '0199000199', '112', '1', 'abc']) expect(() => parseTrunk({ ...trunk, fallbackTarget: bad }), bad).toThrow(/^fallbackTarget/)
    expect(parseDid('desk', { trunkId: 'operator', first: '+33199000101', target: '101', fallbackTarget: '199' }, trunks, []).fallbackTarget).toBe('199')
    expect(() => parseDid('desk', { trunkId: 'operator', first: '+33199000101', target: '101', fallbackTarget: '101' }, trunks, [])).toThrow(expect.objectContaining({ statusCode: 409, code: 'FALLBACK_LOOP' }))
    expect(() => parseDid('desk', { trunkId: 'operator', first: '+33199000101', target: '101', fallbackTarget: '+33199000199' }, trunks, [])).toThrow(/^fallbackTarget/)
    // A range by suffix: the fallback is any extension or group.
    expect(parseDid('staff', { trunkId: 'operator', first: '+33199000130', last: '+33199000139', suffixDigits: 3, fallbackTarget: '130' }, trunks, []).fallbackTarget).toBe('130')
    expect(trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_FALLBACK_TARGET: '199' })?.parsed.config.fallbackTarget).toBe('199')
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_FALLBACK_TARGET: '+33199000199' })).toThrow(/fallbackTarget/)
  })
})

describe('outbound routes', () => {
  type Handed = [OutboundPolicy, OutboundProfile[], OutboundAssignment[]]
  const setup = async (opts: { store?: MemoryStore; without?: boolean; noSecretsKey?: boolean; events?: RoutedEvent[]; beforeStart?: (app: Awaited<ReturnType<typeof buildApp>>) => void; turnMaxMs?: number; slow?: () => Promise<void> } = {}) => {
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
              await opts.slow?.()
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
    const app = await buildApp(registry, { store, bus, directory: new StoreDirectory(store), tickets: new TicketStore(), admin: { adminRole: 'twakephone-admin', adminUsers: new Set() }, ...(opts.noSecretsKey ? {} : { secretsKey: randomBytes(32) }), ...(opts.turnMaxMs ? { turnMaxMs: opts.turnMaxMs } : {}) })
    opts.beforeStart?.(app)
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
    // Nothing set: no profile, the default caps and thresholds (shown, review 6b, n°6).
    const empty = await app.inject({ url: '/api/v1/admin/outbound', headers: admin })
    expect(empty.json()).toMatchObject({ policy: {}, profiles: [], assignments: [], defaults: { fraud: { national: { callsPerMinute: { warning: 6, critical: 20 } } }, caps: { user: { concurrent: 2, dailyMinutes: 300 }, tenant: { concurrent: 20, dailyMinutes: 3000 } } } })
    const body = { profiles, policy: { defaultProfile: 'internal', caps: { concurrent: 4 } }, assignments: [{ userId: 'alice', profileId: 'national' }] }
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: body })
    expect(put.statusCode).toBe(200)
    expect(handed.at(-1)).toEqual([{ defaultProfile: 'internal', caps: { concurrent: 4 } }, [expect.objectContaining({ id: 'national', allowed: ['fixed', 'mobile'] }), { id: 'internal', allowed: [] }], [{ userId: 'alice', profileId: 'national' }]])
    expect((await store.getOutbound('A'))?.assignments).toEqual([{ userId: 'alice', profileId: 'national' }])
    // One person's profile, or back to the default one.
    // The whole setting as it is now comes back, with its version (review 7 bis, n°1).
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound/users/bob', headers: admin, payload: { profileId: 'national' } })).json()).toEqual({
      userId: 'bob',
      profileId: 'national',
      policy: { defaultProfile: 'internal', caps: { concurrent: 4 } },
      profiles: [expect.objectContaining({ id: 'national' }), { id: 'internal', allowed: [] }],
      assignments: [{ userId: 'alice', profileId: 'national' }, { userId: 'bob', profileId: 'national' }],
      version: expect.any(String),
      defaults: expect.objectContaining({ caps: expect.any(Object) })
    })
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

  it('refuses a change sent with a version older than the setting (two administrators, review 7, n°1): 409, nothing changed', async () => {
    const { app, admin, handed, store } = await setup()
    const read = async () => (await app.inject({ url: '/api/v1/admin/outbound', headers: admin })).json()
    const first = await read()
    expect(first.version).toEqual(expect.any(String))
    // Two screens read the same setting; the first one withdraws a right from Bob.
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles, assignments: [{ userId: 'bob', profileId: 'internal' }], version: first.version } })
    expect(put.statusCode).toBe(200)
    expect(put.json().version).not.toBe(first.version)
    expect(put.json().version).toBe((await read()).version)
    const handedBefore = handed.length
    // The second screen, opened before, sends a cap with what it read: refused, Bob keeps "internal".
    const stale = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles: [], policy: { caps: { concurrent: 3 } }, assignments: [], version: first.version } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'OUTBOUND_STALE' })
    expect(handed.length).toBe(handedBefore)
    expect((await store.getOutbound('A'))?.assignments).toEqual([{ userId: 'bob', profileId: 'internal' }])
    // One person's profile changes the version too: the answer gives the new one, which a change can then carry.
    const assigned = (await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound/users/alice', headers: admin, payload: { profileId: 'national' } })).json()
    const now = await read()
    expect(assigned.version).toBe(now.version)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { ...now, policy: { caps: { concurrent: 3 } }, version: put.json().version } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { ...now, policy: { caps: { concurrent: 3 } } } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles, version: 7 } })).statusCode).toBe(400)
  })

  it("never undoes another administrator's change after an assignment: the screen gets the whole setting it made (review 7 bis, n°1)", async () => {
    const { app, admin, store } = await setup()
    const read = async () => (await app.inject({ url: '/api/v1/admin/outbound', headers: admin })).json()
    await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles, assignments: [{ userId: 'bob', profileId: 'national' }] } })
    // A reads; B withdraws "national" from Bob; A gives Alice a profile, then saves the default profile.
    const a = await read()
    const b = await read()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { ...b, assignments: [{ userId: 'bob', profileId: 'internal' }] } })).statusCode).toBe(200)
    const assigned = (await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound/users/alice', headers: admin, payload: { profileId: 'national' } })).json()
    // What A's screen shows now is the whole setting, Bob's change included, with the version of exactly that.
    expect(assigned.assignments).toEqual([{ userId: 'bob', profileId: 'internal' }, { userId: 'alice', profileId: 'national' }])
    const { userId: _u, profileId: _p, ...view } = assigned
    expect(view).toEqual(await read())
    // What A read before, sent with its own version: refused. What the assignment gave, sent: kept, Bob untouched.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { ...a, policy: { defaultProfile: 'national' } } })).statusCode).toBe(409)
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { ...assigned, policy: { defaultProfile: 'national' } } })
    expect(saved.statusCode).toBe(200)
    expect((await store.getOutbound('A'))?.assignments).toEqual([{ userId: 'bob', profileId: 'internal' }, { userId: 'alice', profileId: 'national' }])
  })

  it('refuses the second of two changes made from the same version, even once the turn of the first one has ended (review 7 bis, n°2)', async () => {
    const store = new MemoryStore()
    // A provider slow to take the first change: longer than the turn of a tenant lasts.
    let release: (() => void) | undefined
    let hold = false
    const { app, admin, handed } = await setup({
      store,
      turnMaxMs: 50,
      slow: () => {
        if (!hold) return Promise.resolve()
        hold = false
        return new Promise<void>(resolve => (release = resolve))
      }
    })
    const { version } = (await app.inject({ url: '/api/v1/admin/outbound', headers: admin })).json()
    hold = true
    const first = app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles, policy: { caps: { concurrent: 1 } }, version } })
    await settle(() => release !== undefined)
    // The second one, made from the same version, goes once the turn of the first has run out: kept.
    const second = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles, policy: { caps: { concurrent: 2 } }, version } })
    expect(second.statusCode).toBe(200)
    release!()
    // The first one, then: refused as the store writes, and the provider handed back what the store keeps.
    const res = await first
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'OUTBOUND_STALE' })
    expect((await store.getOutbound('A'))?.policy).toEqual({ caps: { concurrent: 2 } })
    expect(handed.at(-1)![0]).toEqual({ caps: { concurrent: 2 } })
  })

  it('says how many profiles at most, with its own code (review 7, n°14)', async () => {
    const { app, admin } = await setup()
    const many = Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, allowed: [] }))
    const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/outbound', headers: admin, payload: { profiles: many } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'PROFILE_LIMIT' })
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
      { id: expect.any(String), at: '2026-10-15T10:01:00.000Z', lastAt: '2026-10-15T10:01:00.000Z', count: 1, ...limit, userId: 'alice', first: expect.any(Object) },
      { id: expect.any(String), at: '2026-10-15T10:00:00.000Z', lastAt: '2026-10-15T10:00:00.000Z', count: 1, ...alert, userId: 'alice', first: expect.any(Object) }
    ])
    expect(list.json()).not.toHaveProperty('next')
    expect(published).toEqual([])
  })

  it('counts an alert that repeats in one, lists the latest repeated first, pages them (next), filters them, and logs neither the number nor the extension nor who (review 6b, n°7; second review, n°7, n°8)', async () => {
    const limit = { kind: 'limit' as const, param: 'concurrent', scope: 'user' as const, extension: '101', number: '+33199000004' }
    const at = (min: number) => new Date(Date.parse('2026-10-15T10:00:00.000Z') + min * 60_000).toISOString()
    const events: RoutedEvent[] = [
      ...Array.from({ length: 50 }, (_, i): RoutedEvent => ({ extension: '101', event: { type: 'alert.raised', timestamp: at(i), payload: { alert: limit } } })),
      { extension: '101', event: { type: 'alert.raised', timestamp: at(51), payload: { alert: { kind: 'rights', param: 'international', scope: 'user', extension: '101', number: '+442079460123' } } } },
      { extension: '101', event: { type: 'alert.raised', timestamp: at(52), payload: { alert: { kind: 'emergency', param: 'burst', scope: 'user', value: 3, threshold: 3, extension: '101', number: '112' } } } }
    ]
    const logged: unknown[] = []
    const { app, admin, store } = await setup({
      events,
      beforeStart: built => {
        const warn = built.log.warn.bind(built.log)
        built.log.warn = ((...args: Parameters<typeof warn>) => {
          logged.push(args)
          return warn(...args)
        })
      }
    })
    await settle(async () => (await store.listAlerts('A')).length === 3)
    // Tenant A's lines (the provider of tenant B tells the same).
    const ofA = () => logged.filter(l => (l as [{ tenantId: string }])[0].tenantId === 'A')
    await settle(() => ofA().length === 52)
    const all = (await app.inject({ url: '/api/v1/admin/alerts', headers: admin })).json()
    expect(all.items.map((a: { kind: string; count: number }) => [a.kind, a.count])).toEqual([['emergency', 1], ['rights', 1], ['limit', 50]])
    expect(all.items[2]).toMatchObject({ at: at(0), lastAt: at(49), number: '+33199000004', first: { number: '+33199000004' } })
    const first = (await app.inject({ url: '/api/v1/admin/alerts?limit=2', headers: admin })).json()
    expect(first.items.map((a: { kind: string }) => a.kind)).toEqual(['emergency', 'rights'])
    const second = (await app.inject({ url: `/api/v1/admin/alerts?limit=2&before=${first.next}`, headers: admin })).json()
    expect(second.items.map((a: { kind: string }) => a.kind)).toEqual(['limit'])
    expect(second).not.toHaveProperty('next')
    expect((await app.inject({ url: '/api/v1/admin/alerts?kind=rights', headers: admin })).json().items).toHaveLength(1)
    expect((await app.inject({ url: '/api/v1/admin/alerts?param=burst', headers: admin })).json().items).toMatchObject([{ kind: 'emergency', value: 3 }])
    for (const bad of ['kind=other', 'before=abc', 'before=12', 'param=a%20b', 'limit=x']) {
      const res = await app.inject({ url: `/api/v1/admin/alerts?${bad}`, headers: admin })
      expect(res.statusCode, bad).toBe(400)
      expect(res.json()).toMatchObject({ code: 'ALERTS_QUERY' })
    }
    // The log: what and how much, the extension as a hash (the same each time), never the number, the extension nor who.
    const text = JSON.stringify(logged)
    for (const secret of ['+33199000004', '+442079460123', '"101"', 'alice']) expect(text, secret).not.toContain(secret)
    expect(ofA()).toHaveLength(52)
    const hashes = new Set(ofA().map(l => (l as [{ alert: { ext: string } }])[0].alert.ext))
    expect([...hashes]).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/)])
    // Keyed (SECRETS_KEY): trying every extension of 2 to 6 digits with the tenant, as a plain hash, finds nothing.
    const [hash] = [...hashes] as [string]
    const plain = (ext: string) => createHash('sha256').update(`A\u0000${ext}`).digest('hex')
    for (let n = 10; n < 1_000_000; n++) if (plain(String(n)).startsWith(hash.slice(0, 12))) throw new Error(`the extension ${n} is found from the log`)
    expect((ofA()[0] as unknown[])[0]).toMatchObject({ alert: { kind: 'limit', param: 'concurrent', scope: 'user' } })
  })

  it('lets an administrator acknowledge an alert of the tenant (step 7): who and when, listed open or acknowledged, a repeat opening a new one', async () => {
    const rights = { kind: 'rights' as const, param: 'international', scope: 'user' as const, extension: '101', number: '+442079460123' }
    const events: RoutedEvent[] = [{ extension: '101', event: { type: 'alert.raised', timestamp: '2026-10-16T10:00:00.000Z', payload: { alert: rights } } }]
    const { app, admin, as, store } = await setup({ events })
    await settle(async () => (await store.listAlerts('A')).length === 1)
    const [seen] = (await app.inject({ url: '/api/v1/admin/alerts', headers: admin })).json().items
    expect(seen).not.toHaveProperty('acknowledgedAt')
    // As listed: its last time and how many times (review 7 bis, n°3).
    const ack = (id: string, lastAt: unknown, count: unknown, headers = admin) =>
      app.inject({ method: 'POST', url: `/api/v1/admin/alerts/${id}/acknowledge`, headers, payload: { ...(lastAt === undefined ? {} : { lastAt }), ...(count === undefined ? {} : { count }) } })
    expect((await ack(seen.id, seen.lastAt, seen.count, as('bob'))).statusCode).toBe(403)
    // Repeated between the list and the click (review 7, n°2): 409, still open, the repeat in view.
    await store.addAlert({ tenantId: 'A', at: '2026-10-16T10:01:00.000Z', alert: rights })
    const changed = await ack(seen.id, seen.lastAt, seen.count)
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ code: 'ALERT_CHANGED' })
    const [open] = (await app.inject({ url: '/api/v1/admin/alerts?state=open', headers: admin })).json().items
    expect(open).toMatchObject({ id: seen.id, count: 2, lastAt: '2026-10-16T10:01:00.000Z' })
    // What was seen is said, as listed.
    for (const bad of [undefined, 12, 'yesterday', '2026-10-16'])
      expect((await ack(open.id, bad, open.count)).json(), String(bad)).toMatchObject({ statusCode: 400, code: 'ALERT_INVALID' })
    for (const bad of [undefined, 0, 1.5, '2'])
      expect((await ack(open.id, open.lastAt, bad)).json(), String(bad)).toMatchObject({ statusCode: 400, code: 'ALERT_INVALID' })
    // Seen once, repeated since at the very same instant: its last time unchanged, still refused.
    await store.addAlert({ tenantId: 'A', at: '2026-10-16T10:01:00.000Z', alert: rights })
    expect((await ack(open.id, open.lastAt, open.count)).statusCode).toBe(409)
    const [same] = (await app.inject({ url: '/api/v1/admin/alerts?state=open', headers: admin })).json().items
    expect(same).toMatchObject({ id: open.id, count: 3, lastAt: open.lastAt })
    open.count = same.count
    // Another tenant's administrator, an id of none, an id that is no number: not found.
    expect((await ack(open.id, open.lastAt, open.count, as('root', 'twakephone-admin', 'B'))).statusCode).toBe(404)
    for (const id of ['999999', 'abc', '1%3B']) expect((await ack(id, open.lastAt, open.count)).statusCode, id).toBe(404)
    const acked = await ack(open.id, open.lastAt, open.count)
    expect(acked.statusCode).toBe(200)
    expect(acked.json()).toMatchObject({ id: open.id, kind: 'rights', acknowledgedBy: 'root', acknowledgedAt: expect.stringMatching(/^\d{4}-/) })
    // Twice: the same, the first acknowledgement kept.
    expect((await ack(open.id, open.lastAt, open.count, as('carol', 'twakephone-admin'))).json().acknowledgedBy).toBe('root')
    await store.addAlert({ tenantId: 'A', at: '2026-10-16T10:05:00.000Z', alert: rights })
    const states = async (q: string) => (await app.inject({ url: `/api/v1/admin/alerts${q}`, headers: admin })).json().items.map((a: { id: string; acknowledgedBy?: string }) => a.acknowledgedBy ?? 'open')
    expect(await states('')).toEqual(['open', 'root'])
    expect(await states('?state=open')).toEqual(['open'])
    expect(await states('?state=acknowledged')).toEqual(['root'])
    const bad = await app.inject({ url: '/api/v1/admin/alerts?state=closed', headers: admin })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ code: 'ALERTS_QUERY' })
  })

  it('repeated for days, an alert stays on top of those that came once since (second review 6b, n°8)', async () => {
    // One every 59 minutes for two days: always within an hour of the one before.
    const at = (h: number) => new Date(Date.parse('2026-10-15T10:00:00.000Z') + h * 3_540_000).toISOString()
    const attack = { kind: 'fraud-warning' as const, param: 'callsPerMinute', scope: 'user' as const, extension: '101', value: 4, threshold: 3 }
    const events: RoutedEvent[] = [
      ...Array.from({ length: 48 }, (_, h): RoutedEvent => ({ extension: '101', event: { type: 'alert.raised', timestamp: at(h), payload: { alert: { ...attack, value: 4 + h } } } })),
      ...Array.from({ length: 30 }, (_, i): RoutedEvent => ({ extension: '102', event: { type: 'alert.raised', timestamp: at(i + 1), payload: { alert: { kind: 'limit', param: `p${i}`, scope: 'user', extension: '102' } } } }))
    ]
    const { app, admin, store } = await setup({ events })
    await settle(async () => (await store.listAlerts('A', { limit: 100 })).length === 31)
    const page = (await app.inject({ url: '/api/v1/admin/alerts?limit=10', headers: admin })).json()
    expect(page.items[0]).toMatchObject({ kind: 'fraud-warning', count: 48, at: at(0), lastAt: at(47), value: 51, first: { value: 4 } })
    const rest = (await app.inject({ url: `/api/v1/admin/alerts?limit=50&before=${page.next}`, headers: admin })).json()
    expect(rest.items).toHaveLength(21)
    expect(new Set([...page.items, ...rest.items].map((a: { id: string }) => a.id)).size).toBe(31)
  })

  it('logs no extension at all without SECRETS_KEY (second review 6b, n°7)', async () => {
    const logged: unknown[] = []
    const { store } = await setup({
      noSecretsKey: true,
      events: [{ extension: '101', event: { type: 'alert.raised', timestamp: '2026-10-15T10:00:00.000Z', payload: { alert: { kind: 'limit', param: 'concurrent', scope: 'user', extension: '101' } } } }],
      beforeStart: built => {
        const warn = built.log.warn.bind(built.log)
        built.log.warn = ((...args: Parameters<typeof warn>) => {
          logged.push(args)
          return warn(...args)
        })
      }
    })
    await settle(async () => (await store.listAlerts('A')).length === 1)
    await settle(() => logged.some(l => (l as [{ tenantId?: string }])[0].tenantId === 'A'))
    const line = logged.find(l => (l as [{ tenantId?: string }])[0].tenantId === 'A') as [{ alert: Record<string, unknown> }]
    expect(line[0].alert).not.toHaveProperty('ext')
    expect(line[0].alert).toMatchObject({ kind: 'limit', param: 'concurrent' })
  })

  it('purges the alerts past their retention every hour, from their last repeat (review 6b, n°7)', async () => {
    const store = new MemoryStore()
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString()
    await store.addAlert({ tenantId: 'A', at: old, alert: { kind: 'limit', param: 'concurrent', scope: 'user', extension: '101' } })
    await store.addAlert({ tenantId: 'A', at: new Date().toISOString(), alert: { kind: 'limit', param: 'dailyMinutes', scope: 'user', extension: '101' } })
    const purged: string[] = []
    const purge = store.purgeAlerts.bind(store)
    store.purgeAlerts = async before => {
      purged.push(before)
      return purge(before)
    }
    const { app } = await setup({ store })
    await app.ready()
    await settle(async () => (await store.listAlerts('A')).length === 1)
    expect((await store.listAlerts('A')).map(a => a.alert.param)).toEqual(['dailyMinutes'])
    expect(purged.length).toBeGreaterThanOrEqual(1)
  })
})
