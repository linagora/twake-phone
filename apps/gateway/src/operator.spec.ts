import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { OvhOperator } from '@twake/provider-ovh'
import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { DidRange, Trunk, TrunkInput } from '@twake/telephony-types'
import { startFakeOvh, type FakeOvh } from '../../../packages/provider-ovh/test/fake-ovh.mjs'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { OperatorSync } from './operator.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import type { TrunkRecord } from './store/types.js'

// Fictional numbers only (ARCEP: 01 99 00 xx xx, 06 39 98 xx xx), documentation addresses (RFC 5737) and names; the
// keys are the fake's own, nothing like OVH's.
const ACCOUNT = 'ab12345-ovh-1'
const LINE = '0033199000100'
const MOBILE = '+33639980001'
const fakes: FakeOvh[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})
const fakeOvh = async (lines: Record<string, object> = { [LINE]: {}, '0033199000200': {} }) => {
  const f = await startFakeOvh({ accounts: { [ACCOUNT]: { lines } } })
  fakes.push(f)
  return { f, ovh: new OvhOperator({ ...f.credentials, endpoint: f.url, billingAccount: ACCOUNT }) }
}
const config = (over: Partial<TrunkRecord['config']> = {}): TrunkRecord['config'] => ({ auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100', ...over })
const quiet = () => {
  const said: [string, object, string | undefined][] = []
  return { said, logger: { info: (o: object, m?: string) => void said.push(['info', o, m]), warn: (o: object, m?: string) => void said.push(['warn', o, m]) } }
}

describe('what the platform keeps in step with the operator', () => {
  const setup = async (lines?: Record<string, object>, over: { leading?: () => boolean } = {}) => {
    const { f, ovh } = await fakeOvh(lines)
    let t = Date.parse('2026-10-17T12:00:00.000Z')
    const store = new MemoryStore(() => t)
    const { said, logger } = quiet()
    const sync = new OperatorSync({ store, operators: new Map([['A', ovh]]), logger, now: () => t, settleMs: 60_000, ...over })
    return { f, ovh, store, sync, said, advance: (ms: number) => (t += ms), at: () => t }
  }

  it('sets the fallback a trunk asks at the operator, leaves alone the lines of a trunk that asks none, and puts it back when the manager changed it', async () => {
    const { f, store, sync, said } = await setup({ [LINE]: {}, '0033199000200': { options: { forwardBackup: true, forwardBackupNumber: '0033639980099' } } })
    await store.upsertTrunks([
      { tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: { number: MOBILE, onUnavailable: true, noAnswerAfterSec: 150 } } }) },
      { tenantId: 'A', id: 'backup', config: config({ operator: { lines: ['0033199000200'] } }) }
    ])
    await sync.round('A')
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardBackupNumber: '0033639980001', forwardNoReply: true, forwardNoReplyDelay: 150, forwardNoReplyNumber: '0033639980001' })
    // Asked nothing: read only, what the manager set stays.
    expect(f.requests.filter(r => r.method === 'PUT').map(r => r.path)).toEqual([`/telephony/${ACCOUNT}/line/${LINE}/options`])
    expect(f.options(ACCOUNT, '0033199000200')).toMatchObject({ forwardBackup: true, forwardBackupNumber: '0033639980099' })
    const status = await sync.status('A')
    expect(status?.trunks).toEqual([
      { id: 'main', lines: [{ line: LINE, fallback: { number: MOBILE, onUnavailable: true, noAnswerAfterSec: 150 }, managed: true, inSync: true, readAt: '2026-10-17T12:00:00.000Z', appliedAt: '2026-10-17T12:00:00.000Z' }] },
      { id: 'backup', lines: [{ line: '0033199000200', fallback: { number: '+33639980099', onUnavailable: true }, managed: false, readAt: '2026-10-17T12:00:00.000Z' }] }
    ])
    // Read again, nothing changed there: nothing written.
    await sync.round('A')
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1)
    // Someone turns it off in the manager: the next round puts it back, and says so.
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackup: false, forwardNoReply: false })
    await sync.round('A')
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardNoReply: true })
    expect((await sync.status('A'))?.trunks[0]!.lines[0]).toMatchObject({ inSync: true, restoredAt: '2026-10-17T12:00:00.000Z' })
    expect(said.filter(([level]) => level === 'warn').map(([, , m]) => m)).toEqual(['operator: the fallback was changed at the operator, put back as asked'])
  })

  it('says a line the operator does not have, or a key without the right, and tries again at the next round', async () => {
    const { f, store, sync } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: ['0033199000999', LINE], fallback: { number: MOBILE, onUnavailable: true } } }) }])
    f.state.rules = [{ method: 'GET', path: '/telephony/*' }]
    await sync.round('A')
    expect((await sync.status('A'))?.trunks[0]!.lines).toEqual([
      { line: '0033199000999', managed: true, inSync: false, error: 'not-found' },
      { line: LINE, managed: true, inSync: false, error: 'forbidden' }
    ])
    f.state.rules = [{ method: 'GET', path: '/telephony/*' }, { method: 'PUT', path: '/telephony/*/line/*/options' }]
    await sync.round('A')
    expect((await sync.status('A'))?.trunks[0]!.lines[1]).toMatchObject({ line: LINE, inSync: true, fallback: { number: MOBILE, onUnavailable: true } })
    expect((await sync.status('A'))?.trunks[0]!.lines[1]).not.toHaveProperty('error')
  })

  it('reads each record of calls once, reconciles them once read a while: with a call, alone in the history of the holder of the number, or counted', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertDid({ tenantId: 'A', id: 'group', trunkId: 'main', first: '+33199000102', last: '+33199000102', target: '200' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // Jean's call, as the SIP server told it, and the operator's record of it; another call the platform never had
    // (the trunk out: the operator forwarded it); one to the group; one out the platform did not place; a forward.
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'sip-1', direction: 'inbound', remoteNumber: MOBILE, startedAt: '2026-10-17T10:00:00.000Z', endedAt: '2026-10-17T10:01:00.000Z', durationSec: 55, state: 'ended', answered: true })
    const ids = [
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T12:00:02+02:00', duration: 56, wayType: 'incoming' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980002', called: '0033199000101', creationDatetime: '2026-10-17T13:30:00+02:00', duration: 0, wayType: 'incoming' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000102', creationDatetime: '2026-10-17T13:31:00+02:00', duration: 12, wayType: 'incoming' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033199000100', called: '0033899000000', creationDatetime: '2026-10-17T13:32:00+02:00', duration: 300, wayType: 'outgoing' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033199000101', called: '0033639980001', creationDatetime: '2026-10-17T13:30:05+02:00', duration: 20, wayType: 'transfer' }),
      // Older than the 48 h asked: never read.
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980004', called: '0033199000101', creationDatetime: '2026-10-14T10:00:00+02:00', duration: 5, wayType: 'incoming' })
    ]
    await sync.round('A')
    const reads = () => f.requests.filter(r => /voiceConsumption\/\d+$/.test(r.path)).map(r => Number(r.path.split('/').at(-1)))
    expect(reads().sort()).toEqual(ids.slice(0, 5).sort())
    expect(f.requests.find(r => r.path.endsWith('/voiceConsumption'))!.query).toEqual({ 'creationDatetime.from': '2026-10-15T12:00:00.000Z', 'creationDatetime.to': '2026-10-17T12:00:00.000Z' })
    // Read a moment ago: not yet reconciled (the entry of a call may still be on its way).
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ total: 5, pending: 5 })
    advance(61_000)
    await sync.round('A')
    // Each record was read once only.
    expect(reads()).toHaveLength(5)
    expect((await sync.status('A'))?.cdrs).toMatchObject({ read: 0, stats: { total: 5, matched: 1, orphan: 1, unmatchedInbound: 1, unmatchedOutbound: 1, forwarded: 1, pending: 0 } })
    const jean = (await store.listHistory('A', 'jean')).items
    expect(jean.map(e => [e.callId, e.operator, e.operatorOnly ?? false, e.state, e.remoteNumber])).toEqual([
      [`ovh:${LINE}:${ids[1]}`, 'ovh', true, 'missed', '+33639980002'],
      ['sip-1', 'ovh', false, 'ended', MOBILE]
    ])
    // Another round: nothing settled twice, nothing added.
    advance(600_000)
    await sync.round('A')
    expect((await store.listHistory('A', 'jean')).items).toHaveLength(2)
  })

  it('tells a trunk event whether its fallback is set at the operator, read again when old, never its number', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([
      { tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, '0033199000200'], fallback: { number: MOBILE, onUnavailable: true, noAnswerAfterSec: 150 } } }) },
      { tenantId: 'A', id: 'bare', config: config() }
    ])
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: true, no_answer_after_sec: 150 })
    expect(await sync.fallbackOf('A', 'bare')).toBeUndefined()
    expect(await sync.fallbackOf('B', 'main')).toBeUndefined()
    // One line loses its forward on no answer at the operator (not yet put back): read again once old.
    f.options(ACCOUNT, '0033199000200')!.forwardNoReply = false
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: true, no_answer_after_sec: 150 })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, '0033199000200'] } }) }])
    advance(61_000)
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: true })
  })

  it('runs its rounds only on the Gateway that leads', async () => {
    let leads = false
    const { f, store, sync } = await setup(undefined, { leading: () => leads })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await sync.tick()
    expect(f.requests).toEqual([])
    leads = true
    await sync.tick()
    expect(f.requests.length).toBeGreaterThan(0)
  })
})

describe('the routes of the operator', () => {
  const trunk: TrunkInput = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }
  const setup = async (withOperator = true) => {
    process.env.AUTH_MODE = 'dev'
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    const { f, ovh } = await fakeOvh()
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ trunks: true }),
      subscribe: async function* () {},
      close: async () => {},
      setTrunks: async (_t: Trunk[], _d: DidRange[]) => {}
    }
    const factory: ProviderFactory<unknown> = { type: 'recording', create: () => provider as unknown as TelephonyProvider }
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'recording', config: {} }], [factory])
    const app = await buildApp(registry, {
      store,
      bus: new EventBus(),
      directory: new StoreDirectory(store),
      tickets: new TicketStore(),
      admin: { adminRole: 'twakephone-admin', adminUsers: new Set() },
      secretsKey: randomBytes(32),
      ...(withOperator ? { operators: new Map([['A', ovh]]), operatorSyncMs: 0, operatorSettleMs: 0 } : {})
    })
    registry.startAll()
    const as = (user: string, roles?: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'A', ...(roles ? { 'x-dev-roles': roles } : {}) })
    return { app, f, store, admin: as('root', 'twakephone-admin'), as }
  }

  it('sets the fallback at the operator when a trunk is saved, and says how it went, to administrators only', async () => {
    const { app, f, admin, as } = await setup()
    const operator = { lines: [LINE], fallback: { number: MOBILE, onUnavailable: true, noAnswerAfterSec: 150 } }
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator } })
    expect(put.statusCode).toBe(201)
    expect(put.json().operator).toEqual(operator)
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardBackupNumber: '0033639980001', forwardNoReplyDelay: 150 })
    const status = await app.inject({ url: '/api/v1/admin/operator', headers: admin })
    expect(status.json()).toMatchObject({ configured: true, operator: 'ovh', trunks: [{ id: 'main', lines: [{ line: LINE, managed: true, inSync: true, fallback: { number: MOBILE } }] }], cdrs: { stats: { total: 0 } } })
    expect(JSON.stringify(status.json())).not.toMatch(/fake-(application|consumer)/)
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: as('jean') })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/admin/operator' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: as('jean') })).statusCode).toBe(403)
    // A round now, twice a minute at most.
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })).statusCode).toBe(200)
    const third = await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    expect([third.statusCode, third.json().code]).toEqual([429, 'OPERATOR_RATE'])
    // The fallback no longer asked: left at the operator as it is.
    const puts = f.requests.filter(r => r.method === 'PUT').length
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(200)
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(puts)
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true })
  })

  it('refuses a fallback before the inside one ends, without its number, to a direct number of the platform, or without an operator', async () => {
    const { app, admin } = await setup()
    const refused = async (operator: unknown) => {
      const r = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator } })
      return [r.statusCode, r.json().code, r.json().message.split(':')[0]]
    }
    expect(await refused({ lines: [LINE], fallback: { number: MOBILE, onUnavailable: false, noAnswerAfterSec: 120 } })).toEqual([400, 'OPERATOR_FALLBACK_DELAY', 'operator.fallback.noAnswerAfterSec'])
    expect(await refused({ lines: [LINE], fallback: { number: MOBILE, onUnavailable: false, noAnswerAfterSec: 601 } })).toEqual([400, 'TRUNK_INVALID', 'operator.fallback.noAnswerAfterSec'])
    expect(await refused({ lines: [LINE], fallback: { onUnavailable: true } })).toEqual([400, 'TRUNK_INVALID', 'operator.fallback.number'])
    expect(await refused({ lines: [LINE], fallback: { number: '0639980001', onUnavailable: true } })).toEqual([400, 'TRUNK_INVALID', 'operator.fallback.number'])
    expect(await refused({ lines: [] })).toEqual([400, 'TRUNK_INVALID', 'operator.lines'])
    expect(await refused({ lines: ['../../auth'] })).toEqual([400, 'TRUNK_INVALID', 'operator.lines'])
    expect(await refused({ lines: [LINE, LINE] })).toEqual([400, 'TRUNK_INVALID', 'operator.lines'])
    expect(await refused({ lines: [LINE], fallback: { number: MOBILE, onUnavailable: 'yes' } })).toEqual([400, 'TRUNK_INVALID', 'operator.fallback.onUnavailable'])
    // A fallback that is one of the platform's direct numbers, either way round.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: trunk })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'main', first: '+33199000101', target: '101' } })).statusCode).toBe(201)
    expect(await refused({ lines: [LINE], fallback: { number: '+33199000101', onUnavailable: true } })).toEqual([409, 'OPERATOR_FALLBACK_LOOP', 'operator.fallback.number'])
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: { number: MOBILE, onUnavailable: true } } } })).statusCode).toBe(200)
    const did = await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/mobile', headers: admin, payload: { trunkId: 'main', first: MOBILE, target: '101' } })
    expect([did.statusCode, did.json().code]).toEqual([409, 'OPERATOR_FALLBACK_LOOP'])
    // No operator: its lines may be named, no fallback set there.
    const none = await setup(false)
    expect((await none.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: none.admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(201)
    const without = await none.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: none.admin, payload: { ...trunk, operator: { lines: [LINE], fallback: { number: MOBILE, onUnavailable: true } } } })
    expect([without.statusCode, without.json().code]).toEqual([409, 'OPERATOR_NONE'])
    expect((await none.app.inject({ url: '/api/v1/admin/operator', headers: none.admin })).json()).toEqual({ configured: false })
    expect((await none.app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: none.admin })).statusCode).toBe(409)
  })

  it('says in the history where each call is known from: the SIP server, its operator record reconciled with it, or that record alone', async () => {
    const { app, f, store, admin, as } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'main', first: '+33199000101', target: '101' } })).statusCode).toBe(201)
    const at = new Date(Date.now() - 3_600_000)
    const iso = (ms: number) => new Date(at.getTime() + ms).toISOString()
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'sip-1', direction: 'inbound', remoteNumber: MOBILE, startedAt: iso(0), endedAt: iso(60_000), durationSec: 50, state: 'ended', answered: true })
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'sip-2', direction: 'outbound', remoteNumber: '+33199000999', startedAt: iso(120_000), endedAt: iso(130_000), durationSec: 10, state: 'ended', answered: true })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: iso(1_000), duration: 51, wayType: 'incoming' })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980007', called: '0033199000101', creationDatetime: iso(600_000), duration: 0, wayType: 'incoming' })
    // Read, then reconciled at the next round (read before it).
    await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    const items = (await app.inject({ url: '/api/v1/calls/history', headers: as('jean') })).json().items as { id: string; sources: string[]; missed: boolean }[]
    expect(items.map(i => [i.id, i.sources, i.missed])).toEqual([
      [expect.stringMatching(/^ovh:/), ['ovh'], true],
      ['sip-2', ['opensips'], false],
      ['sip-1', ['opensips', 'ovh'], false]
    ])
    expect(JSON.stringify(items)).not.toContain('operatorCdr')
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().cdrs.stats).toMatchObject({ total: 2, matched: 1, orphan: 1 })
  })
})
