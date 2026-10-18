import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { OvhOperator } from '@twake/provider-ovh'
import type { OperatorProvider, ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { DidRange, Trunk, TrunkInput } from '@twake/telephony-types'
import { pilotRules, startFakeOvh, type FakeOvh } from '../../../packages/provider-ovh/test/fake-ovh.mjs'
import { buildApp, restoreRefusalOf } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { OPERATOR_KEPT_MS, OperatorSync, erasedNumbersOf, matchesFallback } from './operator.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import type { TrunkRecord } from './store/types.js'

// Fictional numbers only (ARCEP: 01 99 00 xx xx, 06 39 98 xx xx), documentation addresses (RFC 5737) and names; the
// keys are the fake's own, nothing like OVH's.
const ACCOUNT = 'ab12345-ovh-1'
const LINE = '0033199000100'
const LINE2 = '0033199000200'
const MOBILE = '+33639980001'
const OPTIONS = (line: string) => `/telephony/${ACCOUNT}/line/${line}/options`
const fakes: FakeOvh[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop()
})
const fakeOvh = async (lines: Record<string, object> = { [LINE]: {}, [LINE2]: {} }) => {
  const f = await startFakeOvh({ accounts: { [ACCOUNT]: { lines } } })
  fakes.push(f)
  return { f, ovh: new OvhOperator({ ...f.credentials, baseUrl: f.url, billingAccount: ACCOUNT }) }
}
const config = (over: Partial<TrunkRecord['config']> = {}): TrunkRecord['config'] => ({ auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100', ...over })
const quiet = () => {
  const said: [string, object, string | undefined][] = []
  return { said, logger: { info: (o: object, m?: string) => void said.push(['info', o, m]), warn: (o: object, m?: string) => void said.push(['warn', o, m]) } }
}
const T = '2026-10-17T12:00:00.000Z'
const ASKED = { number: MOBILE, onUnavailable: true, noAnswerAfterSec: 150 }
const SET = { onUnavailable: { nature: 'number', number: MOBILE }, onNoAnswer: { nature: 'number', number: MOBILE, afterSec: 150 } }

describe('what the platform keeps in step with the operator', () => {
  const setup = async (lines?: Record<string, object>, over: Partial<ConstructorParameters<typeof OperatorSync>[0]> = {}) => {
    const { f, ovh } = await fakeOvh(lines)
    let t = Date.parse(T)
    const store = new MemoryStore(() => t)
    const { said, logger } = quiet()
    const sync = new OperatorSync({ store, operators: new Map([['A', ovh]]), logger, now: () => t, settleMs: 60_000, ...over })
    return { f, ovh, store, sync, said, logger, advance: (ms: number) => (t += ms), at: () => t }
  }
  const puts = (f: FakeOvh) => f.requests.filter(r => r.method === 'PUT' && r.status === 200).map(r => r.path)
  /** Resolves once `key` of tenant A is written to the store (fourth review 10b, n°9: a gate, not a fixed wait). */
  const writing = (store: MemoryStore, key: string) =>
    new Promise<void>(resolve => {
      const put = store.putOperatorState.bind(store)
      store.putOperatorState = async (tenantId, k, value) => {
        await put(tenantId, k, value)
        if (tenantId === 'A' && k === key) resolve()
      }
    })

  it('compares what is asked with each forward read, field by field: its nature, its number, its delay (review 10b, n°4 and n°15)', () => {
    expect(matchesFallback(ASKED, SET as never)).toBe(true)
    expect(matchesFallback(ASKED, { ...SET, onUnavailable: { nature: 'voicemail' } } as never)).toBe(false)
    expect(matchesFallback(ASKED, { ...SET, onUnavailable: { nature: 'number', number: '+33639980002' } } as never)).toBe(false)
    expect(matchesFallback(ASKED, { ...SET, onNoAnswer: { nature: 'number', number: MOBILE, afterSec: 120 } } as never)).toBe(false)
    expect(matchesFallback(ASKED, { onUnavailable: SET.onUnavailable } as never)).toBe(false)
    expect(matchesFallback({ number: MOBILE, onUnavailable: true }, SET as never)).toBe(false)
    expect(matchesFallback({ onUnavailable: false }, {})).toBe(true)
    expect(matchesFallback({ onUnavailable: false }, { onNoAnswer: { nature: 'voicemail', afterSec: 20 } })).toBe(false)
  })

  it('sets the fallback a trunk asks at the operator, leaves alone the lines of a trunk that asks none, and puts it back when the manager changed it, its number or its nature too', async () => {
    const { f, store, sync, said, logger, at } = await setup({ [LINE]: {}, [LINE2]: { options: { forwardBackup: true, forwardBackupNumber: '0033639980099' } } })
    await store.upsertTrunks([
      { tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) },
      { tenantId: 'A', id: 'backup', config: config({ operator: { lines: [LINE2] } }) }
    ])
    await sync.round('A')
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardBackupNumber: '0033639980001', forwardNoReply: true, forwardNoReplyDelay: 150, forwardNoReplyNumber: '0033639980001' })
    // Asked nothing: read only, what the manager set stays.
    expect(puts(f)).toEqual([OPTIONS(LINE)])
    expect(f.options(ACCOUNT, LINE2)).toMatchObject({ forwardBackup: true, forwardBackupNumber: '0033639980099' })
    expect((await sync.status('A'))?.trunks).toEqual([
      // What was there before (nothing): put back when its fallback is removed (third review 10b, n°8).
      { id: 'main', lines: [{ line: LINE, forwards: SET, managed: true, inSync: true, readAt: T, appliedAt: T, original: {} }] },
      { id: 'backup', lines: [{ line: LINE2, forwards: { onUnavailable: { nature: 'number', number: '+33639980099' } }, managed: false, readAt: T }] }
    ])
    // Read again, nothing changed there: nothing written.
    await sync.round('A')
    expect(puts(f)).toHaveLength(1)
    // Someone turns it off in the manager, changes its number, sends it to the voicemail: each put back, and said.
    const changes = [{ forwardBackup: false, forwardNoReply: false }, { forwardBackupNumber: '0033639980002' }, { forwardBackupNature: 'voicemail' }, { forwardNoReplyDelay: 30 }]
    for (const change of changes) {
      Object.assign(f.options(ACCOUNT, LINE)!, change)
      await sync.round('A')
      expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033639980001', forwardNoReplyDelay: 150 })
    }
    expect(puts(f)).toHaveLength(1 + changes.length)
    expect((await sync.status('A'))?.trunks[0]!.lines[0]).toMatchObject({ inSync: true, restoredAt: T })
    expect(said.filter(([level]) => level === 'warn').map(([, , m]) => m)).toEqual(changes.map(() => 'operator: the fallback was changed at the operator, put back as asked'))
    // What it knew is kept in the store: another Gateway (or this one restarted) knows it was in place, and says so.
    said.length = 0
    const again = new OperatorSync({ store, operators: new Map([['A', new OvhOperator({ ...f.credentials, baseUrl: f.url, billingAccount: ACCOUNT })]]), logger, now: at, settleMs: 60_000 })
    expect((await again.status('A'))?.trunks[0]!.lines[0]).toMatchObject({ inSync: true, restoredAt: T })
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackup: false })
    await again.round('A')
    expect(said.map(([, , m]) => m)).toEqual(['operator: the fallback was changed at the operator, put back as asked'])
  })

  it('says a line the operator does not have, or a key without the right, line by line, and reads the records of the others (review 10b, n°2)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: ['0033199000999', LINE], fallback: { number: MOBILE, onUnavailable: true } } }) }])
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T13:00:00+02:00', duration: 5, wayType: 'incoming' })
    // The rights of the pilot kit but writing.
    f.state.rules = pilotRules(ACCOUNT).filter(r => r.method === 'GET')
    await sync.round('A')
    const status = await sync.status('A')
    expect(status?.trunks[0]!.lines).toEqual([
      { line: '0033199000999', managed: true, inSync: false, error: 'not-found' },
      { line: LINE, forwards: {}, readAt: T, managed: true, inSync: false, error: 'forbidden' }
    ])
    expect(status?.cdrs).toMatchObject({ readAt: T, read: 1, lines: [{ line: '0033199000999', error: 'not-found' }], stats: { total: 1 } })
    f.state.rules = pilotRules(ACCOUNT)
    advance(1_000)
    await sync.round('A')
    expect((await sync.status('A'))?.trunks[0]!.lines[1]).toEqual({ line: LINE, forwards: { onUnavailable: { nature: 'number', number: MOBILE } }, managed: true, inSync: true, readAt: '2026-10-17T12:00:01.000Z', appliedAt: '2026-10-17T12:00:01.000Z', original: {} })
  })

  it('shares the reads of a round between the lines in turn: a line with many records leaves the others theirs (review 10b, n°2)', async () => {
    const { f, store, sync } = await setup(undefined, { readPerRound: 4 })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2] } }) }])
    for (let i = 0; i < 6; i++) f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: `2026-10-17T0${i}:00:00+02:00`, duration: 5, wayType: 'incoming' })
    for (let i = 0; i < 2; i++) f.addConsumption(ACCOUNT, LINE2, { calling: '0033639980001', called: '0033199000201', creationDatetime: `2026-10-17T0${i}:00:00+02:00`, duration: 5, wayType: 'incoming' })
    const reads = (line: string) => f.requests.filter(r => r.path.includes(`/service/${line}/voiceConsumption/`)).length
    await sync.round('A')
    expect([reads(LINE), reads(LINE2)]).toEqual([2, 2])
    await sync.round('A')
    expect([reads(LINE), reads(LINE2)]).toEqual([6, 2])
    expect((await sync.status('A'))?.cdrs.stats.total).toBe(8)
  })

  it('reads each record of calls once, reconciles them once read a while: with a call, alone in the history of the holder of the number, or counted', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertDid({ tenantId: 'A', id: 'group', trunkId: 'main', first: '+33199000102', last: '+33199000102', target: '200' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // Jean's call, as the SIP server told it, and the operator's record of it; another call the platform never had
    // (the trunk out: the operator forwarded it, two records: the call in, then the forward); one to the group; one
    // out the platform did not place; one OVH writes in a way not known.
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'sip-1', direction: 'inbound', remoteNumber: MOBILE, startedAt: '2026-10-17T10:00:00.000Z', endedAt: '2026-10-17T10:01:00.000Z', durationSec: 55, state: 'ended', answered: true })
    const ids = [
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T12:00:02+02:00', duration: 56, wayType: 'incoming' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980002', called: '0033199000101', creationDatetime: '2026-10-17T13:30:00+02:00', duration: 0, wayType: 'incoming' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000102', creationDatetime: '2026-10-17T13:31:00+02:00', duration: 12, wayType: 'incoming' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033199000100', called: '0033899000000', creationDatetime: '2026-10-17T13:32:00+02:00', duration: 300, wayType: 'outgoing' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033199000101', called: '0033639980001', creationDatetime: '2026-10-17T13:30:05+02:00', duration: 20, wayType: 'transfer' }),
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T13:33:00+02:00', duration: 20, wayType: 'conference' }),
      // Older than the 48 h asked: never read.
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980004', called: '0033199000101', creationDatetime: '2026-10-14T10:00:00+02:00', duration: 5, wayType: 'incoming' })
    ]
    await sync.round('A')
    const reads = () => f.requests.filter(r => /voiceConsumption\/\d+$/.test(r.path)).map(r => Number(r.path.split('/').at(-1)))
    expect(reads().sort()).toEqual(ids.slice(0, 6).sort())
    expect(f.requests.find(r => r.path.endsWith('/voiceConsumption'))!.query).toEqual({ 'creationDatetime.from': '2026-10-15T12:00:00.000Z', 'creationDatetime.to': '2026-10-17T12:00:00.000Z' })
    // Read a moment ago: not yet reconciled (the entry of a call may still be on its way).
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ total: 6, pending: 6 })
    advance(61_000)
    await sync.round('A')
    // Each record was read once only, the one OVH writes oddly too.
    expect(reads()).toHaveLength(6)
    expect((await sync.status('A'))?.cdrs).toMatchObject({ read: 0, stats: { total: 6, matched: 1, orphan: 1, unmatchedInbound: 1, unmatchedOutbound: 1, forwarded: 1, invalid: 1, pending: 0 } })
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

  it('never adds a second entry for a call the platform had: forwarded by the operator on no answer, a caller it did not see, the holder on a call then (review 10b, n°17)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    const history = (callId: string, remoteNumber: string, startedAt: string, durationSec: number, endedAt: string) =>
      store.addHistory({ tenantId: 'A', userId: 'jean', callId, direction: 'inbound', remoteNumber, startedAt, endedAt, durationSec, state: durationSec ? 'ended' : 'missed', answered: durationSec > 0 })
    // Missed here after 2 minutes of ringing; OVH forwarded it on no answer, and counts the forward answered.
    await history('sip-missed', '+33639980002', '2026-10-17T09:00:00.000Z', 0, '2026-10-17T09:02:30.000Z')
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980002', called: '0033199000101', creationDatetime: '2026-10-17T11:00:01+02:00', duration: 95, wayType: 'incoming' })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033199000101', called: '0033639980001', creationDatetime: '2026-10-17T11:02:31+02:00', duration: 64, wayType: 'transfer' })
    // A hidden caller: anonymous here, OVH gives the number.
    await history('sip-hidden', 'anonymous', '2026-10-17T10:00:00.000Z', 30, '2026-10-17T10:00:40.000Z')
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980005', called: '0033199000101', creationDatetime: '2026-10-17T12:00:02+02:00', duration: 31, wayType: 'incoming' })
    // Jean on an inside call while OVH has a call to his number the platform did not.
    await history('sip-inside', '102', '2026-10-17T10:30:00.000Z', 300, '2026-10-17T10:35:00.000Z')
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980006', called: '0033199000101', creationDatetime: '2026-10-17T12:31:00+02:00', duration: 0, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    const jean = (await store.listHistory('A', 'jean')).items
    expect(jean.map(e => [e.callId, e.remoteNumber, e.operatorOnly ?? false, e.operatorCdr !== undefined])).toEqual([
      ['sip-inside', '102', false, false],
      ['sip-hidden', 'anonymous', false, true],
      ['sip-missed', '+33639980002', false, true]
    ])
    // The hidden number is nowhere in the history.
    expect(JSON.stringify(jean)).not.toContain('39980005')
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ matched: 2, orphan: 0, unmatchedInbound: 1, forwarded: 1, pending: 0 })
  })

  it('finds the call of a record among many of the same number before it, every page read, and no second entry (review 10b, n°3)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // 1 200 calls of the same caller to a group, one every 3 s for the hour before, and 5 000 of others: then Jean's.
    const start = Date.parse('2026-10-17T09:00:00.000Z')
    for (let i = 0; i < 1_200; i++) {
      const at = new Date(start + i * 3_000).toISOString()
      await store.addHistory({ tenantId: 'A', userId: `agent-${i % 7}`, callId: `old-${i}`, direction: 'inbound', remoteNumber: MOBILE, startedAt: at, endedAt: at, durationSec: 0, state: 'missed', answered: false })
    }
    for (let i = 0; i < 5_000; i++) {
      const at = new Date(start + i * 700).toISOString()
      await store.addHistory({ tenantId: 'A', userId: 'agent-0', callId: `other-${i}`, direction: 'inbound', remoteNumber: '+33639980077', startedAt: at, endedAt: at, durationSec: 0, state: 'missed', answered: false })
    }
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'sip-real', direction: 'inbound', remoteNumber: MOBILE, startedAt: '2026-10-17T10:00:00.000Z', endedAt: '2026-10-17T10:01:00.000Z', durationSec: 58, state: 'ended', answered: true })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T12:00:01+02:00', duration: 59, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await store.listHistory('A', 'jean')).items.map(e => [e.callId, e.operatorCdr !== undefined])).toEqual([['sip-real', true]])
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ matched: 1, orphan: 0 })
  })

  it('never brings back a call of a person who erased their history: a record pending then, or read after, of a call from before (review 10b, n°1)', async () => {
    const { f, store, sync, advance, at } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // Received while the platform could not be reached, read, pending: then Jean erases his history.
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T13:30:00+02:00', duration: 12, wayType: 'incoming' })
    await sync.round('A')
    expect(await erasedNumbersOf(store, 'A', 'jean')).toEqual(['+33199000101'])
    expect(await store.deleteHistory('A', 'jean', await erasedNumbersOf(store, 'A', 'jean'))).toBe(0)
    // Listed late by OVH (its API was down), of a call before the erasure.
    advance(61_000)
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980002', called: '0033199000101', creationDatetime: '2026-10-17T13:40:00+02:00', duration: 0, wayType: 'incoming' })
    await sync.round('A')
    // After the erasure: his history again.
    advance(600_000)
    const after = new Date(at() - 60_000).toISOString().replace('Z', '+00:00')
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000101', creationDatetime: after, duration: 7, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await store.listHistory('A', 'jean')).items.map(e => e.remoteNumber)).toEqual(['+33639980003'])
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ total: 3, orphan: 1, erased: 2, unmatchedInbound: 0, pending: 0 })
    // Neither keeps a number of his.
    const kept = JSON.stringify([...(store as unknown as { operatorCdrs: Map<string, unknown> }).operatorCdrs.values()])
    expect([kept.includes('39980001'), kept.includes('39980002'), kept.includes('39980003')]).toEqual([false, false, true])
  })

  it('writes nothing on a line two trunks ask two fallbacks of, and says it (review 10b, n°5)', async () => {
    const { f, store, sync } = await setup()
    await store.upsertTrunks([
      { tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) },
      { tenantId: 'A', id: 'second', config: config({ operator: { lines: [LINE, LINE2], fallback: { number: '+33639980002', onUnavailable: true } } }) }
    ])
    for (let i = 0; i < 3; i++) await sync.round('A')
    expect(puts(f)).toEqual([OPTIONS(LINE2)])
    const lines = (await sync.status('A'))!.trunks.map(t => t.lines.map(l => [l.line, l.error ?? null, l.inSync ?? null]))
    expect(lines).toEqual([[[LINE, 'conflict', null]], [[LINE, 'conflict', null], [LINE2, null, true]]])
    // Its options read once a round, each line once whatever trunks name it.
    expect(f.requests.filter(r => r.method === 'GET' && r.path === OPTIONS(LINE))).toHaveLength(3)
  })

  it('reads the fallback back once written: what OVH did not keep, or refused, is said and not written again until the trunk is saved (review 10b, n°7 and n°16)', async () => {
    const { f, store, sync, said } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    // OVH rounds the delay to its own steps.
    f.state.normalize = c => (typeof c.forwardNoReplyDelay === 'number' ? { ...c, forwardNoReplyDelay: 120 } : c)
    await sync.round('A')
    await sync.round('A')
    expect(puts(f)).toEqual([OPTIONS(LINE)])
    expect((await sync.status('A'))?.trunks[0]!.lines[0]).toMatchObject({ managed: true, inSync: false, error: 'refused', rejected: true, appliedAt: T })
    expect(said.filter(([l]) => l === 'warn').map(([, , m]) => m)).toEqual(['operator: the operator did not keep the fallback asked, not written again until the trunk is saved'])
    // Saved again (the administrator tries again): written once more.
    f.state.normalize = undefined
    await sync.applyTrunk('A', 'main')
    expect(puts(f)).toHaveLength(2)
    expect((await sync.status('A'))?.trunks[0]!.lines[0]).toEqual({ line: LINE, forwards: SET, managed: true, inSync: true, readAt: T, appliedAt: T, original: {} })
    // OVH refuses the delay outright (400 INVALID_PARAMETER): the same.
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardNoReply: false })
    f.state.acceptDelay = sec => sec <= 120
    await sync.round('A')
    await sync.round('A')
    expect(f.requests.filter(r => r.method === 'PUT').map(r => r.status)).toEqual([200, 200, 400])
    expect((await sync.status('A'))?.trunks[0]!.lines[0]).toMatchObject({ inSync: false, error: 'refused', rejected: true })
  })

  it('keeps what it knows in the store for every Gateway: one that does not lead shows it, and has a round asked run by the one that leads (review 10b, n°8)', async () => {
    let t = Date.parse(T)
    const { f, ovh } = await fakeOvh()
    const store = new MemoryStore(() => t)
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    const leader = new OperatorSync({ store, operators: new Map([['A', ovh]]), leading: () => true, now: () => t, firstMs: 3_600_000, everyMs: 3_600_000, askedPollMs: 20 })
    const other = new OperatorSync({ store, operators: new Map([['A', ovh]]), leading: () => false, now: () => t })
    expect((await other.status('A'))?.trunks[0]!.lines).toEqual([{ line: LINE, managed: true }])
    await other.tick()
    expect(f.requests).toEqual([])
    leader.start()
    try {
      t += 1_000
      await other.roundNow('A', 5_000)
      expect(puts(f)).toEqual([OPTIONS(LINE)])
      expect((await other.status('A'))?.trunks[0]!.lines[0]).toMatchObject({ inSync: true, readAt: '2026-10-17T12:00:01.000Z' })
      // Answered once: the next look of the leader runs nothing more.
      const asked = f.requests.length
      await new Promise(r => setTimeout(r, 100))
      expect(f.requests).toHaveLength(asked)
    } finally {
      await leader.stop()
    }
  })

  it('raises an alert when the operator refuses its keys round after round, and when fewer than 99 % of the records are reconciled, each once as it happens (review 10b, n°12; second review n°5)', async () => {
    const { f, store, sync, advance } = await setup()
    const refusing = new OperatorSync({ store, operators: new Map([['A', new OvhOperator({ ...f.credentials, consumerKey: 'revoked', baseUrl: f.url, billingAccount: ACCOUNT })]]), now: () => Date.parse(T) })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    // Nothing read at the operator: the round says so (second review n°6).
    await expect(refusing.round('A')).rejects.toThrow('operator: not read (unauthorized)')
    expect(await store.listAlerts('A')).toEqual([])
    await expect(refusing.round('A')).rejects.toThrow()
    expect((await store.listAlerts('A')).map(a => [a.alert.kind, a.alert.param, a.alert.value, a.count])).toEqual([['operator', 'unauthorized', 2, 1]])
    // Refused still: not raised again (acknowledged, it would stay so).
    await expect(refusing.round('A')).rejects.toThrow()
    expect((await store.listAlerts('A')).map(a => a.count)).toEqual([1])
    // 19 calls to a group the platform never had: none reconciled, too few to tell.
    await store.upsertDid({ tenantId: 'A', id: 'group', trunkId: 'main', first: '+33199000102', last: '+33199000102', target: '200' })
    const call = (i: number) => f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000102', creationDatetime: `2026-10-17T1${i % 4}:${10 + i}:00+02:00`, duration: 12, wayType: 'incoming' })
    for (let i = 0; i < 19; i++) call(i)
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await store.listAlerts('A')).find(a => a.alert.param === 'reconciliation')).toBeUndefined()
    // The twentieth: under 99 % of 20, an alert.
    call(19)
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    const reconciled = (await store.listAlerts('A')).find(a => a.alert.param === 'reconciliation')
    expect(reconciled?.alert).toEqual({ kind: 'operator', param: 'reconciliation', scope: 'tenant', value: 0, threshold: 99 })
    // Under it still at the next rounds: not raised again.
    await sync.round('A')
    await sync.round('A')
    expect((await store.listAlerts('A')).find(a => a.alert.param === 'reconciliation')?.count).toBe(1)
  })

  it('leaves out of the rate the calls erased with a history and those received while the platform could not be reached (second review 10b, n°5)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // 25 calls the platform had, reconciled; one it never had (the trunk out); one of a history erased since.
    for (let i = 0; i < 25; i++) {
      const at = new Date(Date.parse('2026-10-17T08:00:00.000Z') + i * 120_000).toISOString()
      await store.addHistory({ tenantId: 'A', userId: 'jean', callId: `c${i}`, direction: 'inbound', remoteNumber: '+33639980003', startedAt: at, endedAt: at, durationSec: 0, state: 'missed', answered: false })
      f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000101', creationDatetime: at.replace('Z', '+00:00'), duration: 0, wayType: 'incoming' })
    }
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980004', called: '0033199000101', creationDatetime: '2026-10-17T11:00:00+00:00', duration: 0, wayType: 'incoming' })
    await store.addHistory({ tenantId: 'A', userId: 'bob', callId: 'gone', direction: 'outbound', remoteNumber: '+33639980005', startedAt: '2026-10-17T11:10:00.000Z', endedAt: '2026-10-17T11:11:00.000Z', durationSec: 60, state: 'ended', answered: true })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033199000100', called: '0033639980005', creationDatetime: '2026-10-17T11:10:02+00:00', duration: 58, wayType: 'outgoing' })
    await sync.round('A')
    await store.deleteHistory('A', 'bob')
    advance(61_000)
    await sync.round('A')
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ matched: 25, orphan: 1, erased: 1, unmatchedInbound: 0, unmatchedOutbound: 0 })
    expect(await store.listAlerts('A')).toEqual([])
  })

  it('tells a trunk event where each forward sends the calls on every line, read again when old, never a number (review 10b, n°4)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([
      { tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) },
      { tenantId: 'A', id: 'bare', config: config() }
    ])
    // Never read: nothing to tell; read (a trunk event only reads, never writes: second review n°1), what is there.
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: 'none', on_no_answer: 'none' })
    expect(f.requests.filter(r => r.method === 'PUT')).toEqual([])
    await sync.round('A')
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: 'number', on_no_answer: 'number', no_answer_after_sec: 150 })
    expect(await sync.fallbackOf('A', 'bare')).toBeUndefined()
    expect(await sync.fallbackOf('B', 'main')).toBeUndefined()
    // One line sent to the voicemail in the manager (not yet put back): read again once old.
    f.options(ACCOUNT, LINE2)!.forwardBackupNature = 'voicemail'
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: 'number', on_no_answer: 'number', no_answer_after_sec: 150 })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2] } }) }])
    advance(61_000)
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: 'mixed', on_no_answer: 'number', no_answer_after_sec: 150 })
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackup: false, forwardNoReply: false })
    Object.assign(f.options(ACCOUNT, LINE2)!, { forwardBackup: false, forwardNoReply: false })
    advance(61_000)
    expect(await sync.fallbackOf('A', 'main')).toEqual({ on_unavailable: 'none', on_no_answer: 'none' })
    expect(JSON.stringify(await sync.fallbackOf('A', 'main'))).not.toContain('39980001')
  })

  it('runs its rounds only on the Gateway that leads, and waits for the one under way when stopped (review 10b, n°25)', async () => {
    let leads = false
    const { f, store, sync } = await setup(undefined, { leading: () => leads })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await sync.tick()
    expect(f.requests).toEqual([])
    leads = true
    let done = false
    void sync.tick().then(() => (done = true))
    await sync.stop()
    expect(done).toBe(true)
    expect(f.requests.length).toBeGreaterThan(0)
    // Stopped: no round any more.
    const asked = f.requests.length
    await sync.tick()
    expect(f.requests).toHaveLength(asked)
  })

  it('removes the forwards of lines no trunk asks a fallback for any more, on demand (review 10b, n°13)', async () => {
    const { f, store, sync } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) }])
    await sync.round('A')
    expect(f.options(ACCOUNT, LINE2)).toMatchObject({ forwardBackup: true })
    // Still asked: left as it is.
    await sync.removeForwards('A', [LINE])
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await sync.removeForwards('A', [LINE, LINE2])
    expect([f.options(ACCOUNT, LINE), f.options(ACCOUNT, LINE2)].map(o => [o!.forwardBackup, o!.forwardNoReply])).toEqual([[false, false], [false, false]])
    // The line no trunk names is forgotten; the other one is read, no longer managed.
    expect((await sync.status('A'))?.trunks[0]!.lines).toEqual([{ line: LINE, forwards: {}, managed: false, readAt: T, appliedAt: T }])
  })

  /** `ovh`, whose first call of `method` is held once it has run (`after`) or before (`before`) until `release`. */
  const holding = (ovh: OperatorProvider, method: 'getForwards' | 'setFallback', when: 'before' | 'after') => {
    let release!: () => void
    let reached!: () => void
    const held = new Promise<void>(r => (release = r))
    const at = new Promise<void>(r => (reached = r))
    let once = false
    const operator = new Proxy(ovh, {
      get: (target, key) => {
        const v = Reflect.get(target, key) as unknown
        if (typeof v !== 'function') return v
        if (key !== method) return (v as (...a: unknown[]) => unknown).bind(target)
        return async (...args: unknown[]) => {
          const first = !once
          once = true
          if (first && when === 'before') {
            reached()
            await held
          }
          const got = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          if (first && when === 'after') {
            reached()
            await held
          }
          return got
        }
      }
    })
    return { operator, at, release: () => release() }
  }

  it('keeps a removal owed until the operator has it: replayed at each round, whatever became of its trunk (second review 10b, n°1)', async () => {
    const { f, store, sync } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    await sync.round('A')
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(true)
    // OVH does not answer: owed, said, and the fallback still there.
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    f.state.down = true
    expect(await sync.removeForwards('A', [LINE], 'main')).toEqual([{ line: LINE, since: T, trunkId: 'main', triedAt: T, error: 'unreachable', original: {} }])
    // The trunk deleted meanwhile: the removal stays owed, shown.
    await store.deleteTrunk('A', 'main')
    await sync.round('A')
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(true)
    expect(await sync.status('A')).toMatchObject({ trunks: [], removals: [{ line: LINE, trunkId: 'main', error: 'unreachable' }] })
    // Back: the next round removes it, reads it back, and owes nothing more.
    f.state.down = false
    await sync.round('A')
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    expect((await sync.status('A'))?.removals).toBeUndefined()
    const puts = f.requests.filter(r => r.method === 'PUT').length
    await sync.round('A')
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(puts)
    // A removal owed on a line asked again: the fallback asked is kept, never removed then written again (third
    // review 10b, n°6: no write at all).
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    await sync.round('A')
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    f.state.down = true
    await sync.removeForwards('A', [LINE], 'main')
    f.state.down = false
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    const written = f.requests.filter(r => r.method === 'PUT').length
    await sync.round('A')
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(true)
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(written)
    expect((await sync.status('A'))?.removals).toBeUndefined()
  })

  it('never puts back a fallback removed while a round of another Gateway was under way, before it wrote or as it wrote (second review 10b, n°1)', async () => {
    for (const [method, when] of [['getForwards', 'after'], ['setFallback', 'before']] as const) {
      const { f, ovh, store, sync, logger } = await setup()
      await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
      // Gateway A reads the line (nothing there yet), and is held before it writes, or as its write goes.
      const held = holding(ovh, method, when)
      const a = new OperatorSync({ store, operators: new Map([['A', held.operator]]), logger, now: () => Date.parse(T) })
      const round = a.round('A')
      await held.at
      // Gateway B meanwhile: the fallback removed on an administrator's word, done.
      await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
      expect(await sync.removeForwards('A', [LINE], 'main')).toEqual([])
      held.release()
      await round
      // What A wrote, if anything, is removed again: nothing left at OVH, nothing owed, the line read as it is.
      expect([method, f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([method, false, false])
      expect(await sync.status('A')).toMatchObject({ trunks: [{ id: 'main', lines: [{ line: LINE, managed: false, forwards: {} }] }] })
      expect((await sync.status('A'))?.removals).toBeUndefined()
      await a.round('A')
      expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(false)
    }
  })

  it('removes at the operator the fallback a trunk kept on a line it no longer names (second review 10b, n°8)', async () => {
    const { f, store, sync } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) }])
    await sync.applyTrunk('A', 'main')
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE2)!.forwardBackup]).toEqual([true, true])
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    expect(await sync.applyTrunk('A', 'main', [LINE2])).toEqual([])
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE2)!.forwardBackup]).toEqual([true, false])
  })

  it('answers a round asked even when it failed, with why, and runs it once (second review 10b, n°6 and n°11)', async () => {
    let t = Date.parse(T)
    const { f, ovh } = await fakeOvh()
    const store = new MemoryStore(() => t)
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    const leader = new OperatorSync({ store, operators: new Map([['A', ovh]]), leading: () => true, now: () => t, firstMs: 3_600_000, everyMs: 3_600_000, askedPollMs: 20 })
    const other = new OperatorSync({ store, operators: new Map([['A', ovh]]), leading: () => false, now: () => t })
    f.state.down = true
    leader.start()
    try {
      t += 1_000
      await expect(other.roundNow('A', 5_000)).rejects.toThrow('operator: not read (unreachable)')
      // Answered: not run again at each look of the leader.
      const asked = f.requests.length
      await new Promise(r => setTimeout(r, 150))
      expect(f.requests).toHaveLength(asked)
      // The leader itself, asked: the same.
      await expect(leader.roundNow('A', 5_000)).rejects.toThrow('operator: not read (unreachable)')
      // Not in time: said so.
      const late = new OperatorSync({ store, operators: new Map([['A', ovh]]), leading: () => false, now: () => t })
      await leader.stop()
      await expect(late.roundNow('A', 300)).rejects.toMatchObject({ timeout: true })
    } finally {
      await leader.stop()
    }
  })

  it('stops reading the entries of a number past its pages, and then writes no entry of its own: that call may be among those not read (second review 10b, n°10)', async () => {
    const { f, store, sync, advance } = await setup(undefined, { nearPage: 2, nearPages: 2 })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // Five calls of that caller to others in the hour before: more than 2 pages of 2.
    for (let i = 0; i < 5; i++) {
      const at = new Date(Date.parse('2026-10-17T09:00:00.000Z') + i * 600_000).toISOString()
      await store.addHistory({ tenantId: 'A', userId: `agent-${i}`, callId: `old-${i}`, direction: 'inbound', remoteNumber: MOBILE, startedAt: at, endedAt: at, durationSec: 0, state: 'missed', answered: false })
    }
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T12:00:00+02:00', duration: 30, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await store.listHistory('A', 'jean')).items).toEqual([])
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ orphan: 0, unmatchedInbound: 1 })
  })

  it('never enters a record in the history of whom its number rings now when the number changed hands since the call, nor keeps the numbers of a holder who erased them (second review 10b, n°3)', async () => {
    const { f, store, sync, advance, at } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000102', suffixDigits: 3 })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'paul', extension: '102' })
    // Jean erases his history, and is given another extension; Carol takes his. Paul leaves; Lea takes his. (Jean
    // leaving would take his erasure with him, his numbers too: third review 10b, n°3.)
    await store.deleteHistory('A', 'jean', await erasedNumbersOf(store, 'A', 'jean'))
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '104' })
    await store.upsertMapping({ tenantId: 'A', userId: 'carol', extension: '101' })
    await store.deleteMapping('A', 'paul', { left: true })
    await store.upsertMapping({ tenantId: 'A', userId: 'lea', extension: '102' })
    // Calls of before, listed late by OVH: to Jean's number, to Paul's.
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980002', called: '0033199000101', creationDatetime: '2026-10-17T13:30:00+02:00', duration: 0, wayType: 'incoming' })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000102', creationDatetime: '2026-10-17T13:31:00+02:00', duration: 0, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await store.listHistory('A', 'carol')).items).toEqual([])
    expect((await store.listHistory('A', 'lea')).items).toEqual([])
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ orphan: 0, erased: 1, unmatchedInbound: 1 })
    const kept = JSON.stringify([...(store as unknown as { operatorCdrs: Map<string, unknown> }).operatorCdrs.values()])
    expect([kept.includes('39980002'), kept.includes('39980003')]).toEqual([false, true])
    // A call to Lea once hers: in her history.
    advance(600_000)
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980004', called: '0033199000102', creationDatetime: new Date(at() - 60_000).toISOString().replace('Z', '+00:00'), duration: 0, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await store.listHistory('A', 'lea')).items.map(e => e.remoteNumber)).toEqual(['+33639980004'])
  })

  it('writes a call the operator alone had and forwarded to the fallback as missed, forwarded (second review 10b, n°4)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // The call in, then its forward from the number called to the fallback, answered there.
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980002', called: '0033199000101', creationDatetime: '2026-10-17T13:30:00+02:00', duration: 42, wayType: 'incoming' })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033199000101', called: '0033639980001', creationDatetime: '2026-10-17T13:30:01+02:00', duration: 41, wayType: 'transfer' })
    // Another, not forwarded: answered at the operator (its voicemail, say), as it says.
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000101', creationDatetime: '2026-10-17T13:40:00+02:00', duration: 20, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await store.listHistory('A', 'jean')).items.map(e => [e.remoteNumber, e.state, e.answered, e.durationSec, e.operatorForwarded ?? false])).toEqual([
      ['+33639980003', 'ended', true, 20, false],
      ['+33639980002', 'missed', false, 0, true]
    ])
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ orphan: 2, forwarded: 1 })
  })

  it('keeps a removal asked while a round of this Gateway is under way: never let go on the trunks the round read before (third review 10b, n°1, R3-1)', async () => {
    const { f, ovh, store, sync, logger } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) }])
    await sync.round('A')
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE2)!.forwardBackup]).toEqual([true, true])
    // The round is held on its first read (LINE); the fallback is removed meanwhile, on the same Gateway.
    const held = holding(ovh, 'getForwards', 'after')
    const a = new OperatorSync({ store, operators: new Map([['A', held.operator]]), logger, now: () => Date.parse(T) })
    const round = a.round('A')
    await held.at
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2] } }) }])
    const owed = writing(store, `remove:${LINE2}`)
    const removing = a.removeForwards('A', [LINE, LINE2], 'main')
    await owed
    held.release()
    await round
    // Both removed, said so: nothing left at OVH, nothing owed.
    expect(await removing).toEqual([])
    expect([LINE, LINE2].map(l => [f.options(ACCOUNT, l)!.forwardBackup, f.options(ACCOUNT, l)!.forwardNoReply])).toEqual([
      [false, false],
      [false, false]
    ])
    expect((await a.status('A'))?.removals).toBeUndefined()
    await a.round('A')
    await a.round('A')
    expect([f.options(ACCOUNT, LINE2)!.forwardBackup, f.options(ACCOUNT, LINE2)!.forwardNoReply]).toEqual([false, false])
  })

  it('keeps a removal asked on another Gateway while OVH was down, whatever the round of the one that leads read before (third review 10b, n°1, R3-2)', async () => {
    const { f, ovh, store, sync, logger } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) }])
    await sync.round('A')
    // The leader's round starts, held on its first read; on Gateway B, OVH answers 503: both removals owed (202).
    const held = holding(ovh, 'getForwards', 'after')
    const leader = new OperatorSync({ store, operators: new Map([['A', held.operator]]), logger, now: () => Date.parse(T) })
    const round = leader.round('A')
    await held.at
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2] } }) }])
    f.state.down = true
    expect((await sync.removeForwards('A', [LINE, LINE2], 'main')).map(r => [r.line, r.error])).toEqual([
      [LINE, 'unreachable'],
      [LINE2, 'unreachable']
    ])
    f.state.down = false
    held.release()
    await round
    await leader.round('A')
    expect([LINE, LINE2].map(l => [f.options(ACCOUNT, l)!.forwardBackup, f.options(ACCOUNT, l)!.forwardNoReply])).toEqual([
      [false, false],
      [false, false]
    ])
    expect((await leader.status('A'))?.removals).toBeUndefined()
  })

  it('removes only what the platform set: what an administrator set in the manager since is left as it is, and said (third review 10b, n°2, R3-3)', async () => {
    const { f, store, sync, said } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    await sync.round('A')
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    f.state.down = true
    expect(await sync.removeForwards('A', [LINE], 'main')).toHaveLength(1)
    f.state.down = false
    // Seeing it not removed yet, the administrator sets the voicemail on no answer in the manager.
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackup: false, forwardNoReply: true, forwardNoReplyNature: 'voicemail', forwardNoReplyDelay: 20 })
    const before = puts(f).length
    await sync.round('A')
    expect(puts(f)).toHaveLength(before)
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardNoReply: true, forwardNoReplyNature: 'voicemail' })
    const status = await sync.status('A')
    expect([status?.removals, status?.closedRemovals]).toEqual([undefined, [{ line: LINE, at: T, outcome: 'changed', trunkId: 'main' }]])
    expect(said.filter(([l]) => l === 'warn').map(([, , m]) => m)).toContain('operator: the forwards of a line were changed at the operator since their removal was asked, left as they are')
    expect((await store.listAlerts('A')).map(a => [a.alert.kind, a.alert.param, a.alert.number])).toEqual([['operator', 'removal-changed', '+33199000100']])
    // Rounds after: still left so.
    await sync.round('A')
    expect(puts(f)).toHaveLength(before)
  })

  it('lets a removal go on a line OVH no longer has after three rounds, and says it; says one owed past a day (third review 10b, n°4)', async () => {
    const { f, store, sync, said, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) }])
    await sync.round('A')
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2] } }) }])
    // LINE resigned at OVH; LINE2 out of reach for over a day.
    delete (f.state.accounts as Record<string, { lines: Record<string, unknown> }>)[ACCOUNT]!.lines[LINE]
    expect((await sync.removeForwards('A', [LINE], 'main')).map(r => [r.line, r.error])).toEqual([[LINE, 'not-found']])
    await sync.round('A')
    expect((await sync.status('A'))?.removals?.map(r => r.line)).toEqual([LINE])
    await sync.round('A')
    const status = await sync.status('A')
    expect(status?.removals).toBeUndefined()
    expect(status?.closedRemovals).toEqual([{ line: LINE, at: T, outcome: 'gone', trunkId: 'main' }])
    expect(said.map(([, , m]) => m)).toContain('operator: the operator has no such line, its removal let go')
    expect((await store.listAlerts('A')).map(a => a.alert.param)).toEqual(['removal-gone'])
    // Owed past a day (OVH down): one alert, not one per round.
    f.state.down = true
    await sync.removeForwards('A', [LINE2], 'main')
    advance(86_400_000 + 1_000)
    await expect(sync.round('A')).rejects.toThrow('operator: not read (unreachable)')
    await expect(sync.round('A')).rejects.toThrow('operator: not read (unreachable)')
    expect((await store.listAlerts('A')).map(a => [a.alert.param, a.count])).toEqual([
      ['removal-late', 1],
      ['removal-gone', 1]
    ])
    // Let go by an administrator: nothing more written, what is there stays.
    f.state.down = false
    expect(await sync.abandonRemoval('A', LINE2)).toBe(true)
    expect(await sync.abandonRemoval('A', LINE2)).toBe(false)
    const writes = puts(f).length
    await sync.round('A')
    expect([puts(f).length, f.options(ACCOUNT, LINE2)!.forwardBackup]).toEqual([writes, true])
    expect((await sync.status('A'))?.closedRemovals?.map(r => [r.line, r.outcome])).toEqual([
      [LINE2, 'abandoned'],
      [LINE, 'gone']
    ])
    // Shown a week, then forgotten.
    advance(8 * 86_400_000)
    await sync.round('A')
    expect((await sync.status('A'))?.closedRemovals).toBeUndefined()
  })

  it('never brings back a removal let go while it was tried (third review 10b, n°1 and n°4)', async () => {
    const { f, ovh, store, sync, logger } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    await sync.round('A')
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    // Gateway A tries it, held before it reads the line; an administrator lets it go on B; then OVH fails A.
    const held = holding(ovh, 'getForwards', 'before')
    const a = new OperatorSync({ store, operators: new Map([['A', held.operator]]), logger, now: () => Date.parse(T) })
    const removing = a.removeForwards('A', [LINE], 'main')
    await held.at
    expect(await sync.abandonRemoval('A', LINE)).toBe(true)
    f.state.down = true
    held.release()
    expect((await removing).map(r => r.error)).toEqual(['unreachable'])
    const status = await sync.status('A')
    expect([status?.removals, status?.closedRemovals?.map(r => r.outcome)]).toEqual([undefined, ['abandoned']])
  })

  it('puts back what was there before the platform took the line, and says when it cannot (third review 10b, n°8)', async () => {
    const { f, store, sync } = await setup({
      [LINE]: { options: { forwardNoReply: true, forwardNoReplyNature: 'voicemail', forwardNoReplyDelay: 20 } },
      [LINE2]: { options: { forwardNoReply: true, forwardNoReplyNature: 'telepathy', forwardNoReplyDelay: 20 } }
    })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) }])
    await sync.round('A')
    expect((await sync.status('A'))?.trunks[0]!.lines.map(l => l.original)).toEqual([{ onNoAnswer: { nature: 'voicemail', afterSec: 20 } }, { onNoAnswer: { nature: 'other', afterSec: 20 } }])
    // Changed in the manager and put back by the platform: what was there before stays what it was.
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackup: false })
    await sync.round('A')
    expect((await sync.status('A'))?.trunks[0]!.lines[0]!.original).toEqual({ onNoAnswer: { nature: 'voicemail', afterSec: 20 } })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2] } }) }])
    expect((await sync.removeForwards('A', [LINE, LINE2], 'main')).map(r => r.line)).toEqual([])
    // The voicemail of before put back; elsewhere (that the platform cannot write): nothing.
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: false, forwardNoReply: true, forwardNoReplyNature: 'voicemail', forwardNoReplyDelay: 20 })
    expect([f.options(ACCOUNT, LINE2)!.forwardBackup, f.options(ACCOUNT, LINE2)!.forwardNoReply]).toEqual([false, false])
    const status = await sync.status('A')
    expect(status?.closedRemovals).toEqual([
      { line: LINE, at: T, outcome: 'done', trunkId: 'main', restored: true },
      { line: LINE2, at: T, outcome: 'done', trunkId: 'main' }
    ])
    expect(status?.trunks[0]!.lines.map(l => l.original)).toEqual([undefined, undefined])
  })

  it('writes to the operator one at a time on a Gateway: a removal waits for the round under way (third review 10b, n°6, M9)', async () => {
    const { f, ovh, store, logger } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    // The round is held once its write is done, before it reads it back.
    const held = holding(ovh, 'setFallback', 'after')
    const a = new OperatorSync({ store, operators: new Map([['A', held.operator]]), logger, now: () => Date.parse(T) })
    const round = a.round('A')
    await held.at
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    const owed = writing(store, `remove:${LINE}`)
    const removing = a.removeForwards('A', [LINE], 'main')
    await owed
    // Nothing more written while the round holds the turn.
    expect(puts(f)).toEqual([OPTIONS(LINE)])
    held.release()
    await round
    expect(await removing).toEqual([])
    // The round's write, then its removal: in that order, once each.
    expect(f.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([
      { forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033639980001', forwardNoReply: true, forwardNoReplyDelay: 150, forwardNoReplyNature: 'number', forwardNoReplyNumber: '0033639980001' },
      { forwardBackup: false, forwardNoReply: false }
    ])
  })

  it('writes no fallback its trunk stopped asking before the write: no write, no removal (third review 10b, n°6, M4)', async () => {
    const { f, ovh, store, logger } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    const held = holding(ovh, 'getForwards', 'after')
    const a = new OperatorSync({ store, operators: new Map([['A', held.operator]]), logger, now: () => Date.parse(T) })
    const round = a.round('A')
    await held.at
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    held.release()
    await round
    expect(f.requests.filter(r => r.method === 'PUT')).toEqual([])
  })

  it('sets again a fallback asked again as its removal was written, never said changed at the operator (third review 10b, n°10)', async () => {
    const { f, ovh, store, sync, said, logger } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    await sync.round('A')
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    // Gateway A removes it, held as its write goes; on B, the fallback is ticked again and saved meanwhile.
    const held = holding(ovh, 'setFallback', 'before')
    const a = new OperatorSync({ store, operators: new Map([['A', held.operator]]), logger, now: () => Date.parse(T) })
    const removing = a.removeForwards('A', [LINE], 'main')
    await held.at
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    await sync.applyTrunk('A', 'main')
    said.length = 0
    held.release()
    expect(await removing).toEqual([])
    // Set again at once, as a fallback set, not one changed in the manager.
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardNoReply: true })
    expect(said.map(([, , m]) => m)).toEqual(['operator: the forwards of a line removed at the operator', 'operator: a fallback asked again as it was removed, set again', 'operator: fallback set at the operator'])
    expect((await sync.status('A'))?.trunks[0]!.lines[0]).toMatchObject({ managed: true, inSync: true })
    said.length = 0
    await sync.round('A')
    expect(said.filter(([l]) => l === 'warn')).toEqual([])
  })

  it('answers a round asked once it ended, even when the store failed under it, and runs it once (third review 10b, n°6 and n°9, M11)', async () => {
    let t = Date.parse(T)
    const { f, ovh } = await fakeOvh()
    const store = new MemoryStore(() => t)
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.addOperatorCdrs('A', 'ovh', [{ id: `${LINE}:1`, line: LINE, direction: 'inbound', calling: MOBILE, called: '+33199000101', startedAt: T, durationSec: 5 }])
    t += 600_000
    store.settleOperatorCdrs = async () => {
      throw new Error('store: connection lost')
    }
    const leader = new OperatorSync({ store, operators: new Map([['A', ovh]]), leading: () => true, now: () => t, firstMs: 3_600_000, everyMs: 3_600_000, askedPollMs: 20 })
    const other = new OperatorSync({ store, operators: new Map([['A', ovh]]), leading: () => false, now: () => t })
    leader.start()
    try {
      await expect(other.roundNow('A', 5_000)).rejects.toThrow('store: connection lost')
      const asked = f.requests.length
      await new Promise(r => setTimeout(r, 150))
      expect(f.requests).toHaveLength(asked)
    } finally {
      await leader.stop()
    }
  })

  it('erases a record of the operator only as the call of the person who erased it: of the same number, never another call then (third review 10b, n°5, M7)', async () => {
    const remoteKey = (tenantId: string, n: string) => `print:${tenantId}:${n}`
    const { f, store, sync, advance } = await setup(undefined, { remoteKey })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // Jean called +33639980055 through the trunk (its number shown), then erased his history.
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'c1', direction: 'outbound', remoteNumber: '+33639980055', startedAt: '2026-10-17T11:30:00.000Z', endedAt: '2026-10-17T11:31:00.000Z', durationSec: 60, state: 'ended', answered: true })
    await store.deleteHistory('A', 'jean', await erasedNumbersOf(store, 'A', 'jean'), sync.keptOfErasure('A'))
    // Read later: his call, and another one at the same minute the platform never had (an event lost).
    f.addConsumption(ACCOUNT, LINE, { calling: '0033199000100', called: '0033639980055', creationDatetime: '2026-10-17T13:30:01+02:00', duration: 59, wayType: 'outgoing' })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033199000100', called: '0033639980077', creationDatetime: '2026-10-17T13:30:02+02:00', duration: 40, wayType: 'outgoing' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ erased: 1, unmatchedOutbound: 1 })
    // Kept only for an organisation with an operator (third review 10b, n°3).
    expect(sync.keptOfErasure('B')).toBeUndefined()
    const kept = JSON.stringify([...(store as unknown as { operatorCdrs: Map<string, unknown> }).operatorCdrs.values()])
    expect([kept.includes('39980055'), kept.includes('39980077')]).toEqual([false, true])
  })

  it('lets a removal go only as it was read: one written again on another Gateway meanwhile stays, and is done (fourth review 10b, n°6, M1, M2 and M17)', async () => {
    const { f, ovh, store, sync, logger } = await setup()
    const main = (fallback?: typeof ASKED) => [{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], ...(fallback ? { fallback } : {}) } }) }]
    await store.upsertTrunks(main(ASKED))
    await sync.round('A')
    // Removed while OVH is down (owed), then asked again.
    await store.upsertTrunks(main())
    f.state.down = true
    expect(await sync.removeForwards('A', [LINE], 'main')).toHaveLength(1)
    await store.upsertTrunks(main(ASKED))
    // The round of the one that leads: held once its removal has read the trunks (asked again), before it lets it go.
    let reads = 0
    let release!: () => void
    let reached!: () => void
    const held = new Promise<void>(r => (release = r))
    const at = new Promise<void>(r => (reached = r))
    const leaderStore = new Proxy(store, {
      get: (target, key) => {
        const v = Reflect.get(target, key) as unknown
        if (typeof v !== 'function') return v
        if (key !== 'listTrunks') return (v as (...a: unknown[]) => unknown).bind(target)
        return async (...args: unknown[]) => {
          const got = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          if (++reads === 2) {
            reached()
            await held
          }
          return got
        }
      }
    })
    const leader = new OperatorSync({ store: leaderStore, operators: new Map([['A', ovh]]), logger, now: () => Date.parse(T) })
    const round = leader.round('A')
    await at
    // Meanwhile on Gateway B: unticked again and removed again, OVH still down: owed again, written as it was.
    await store.upsertTrunks(main())
    expect(await sync.removeForwards('A', [LINE], 'main')).toHaveLength(1)
    release()
    await expect(round).rejects.toThrow('operator: not read (unreachable)')
    // What B wrote stays, and is done once OVH answers.
    expect((await sync.status('A'))?.removals?.map(r => r.line)).toEqual([LINE])
    f.state.down = false
    await sync.round('A')
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    expect((await sync.status('A'))?.removals).toBeUndefined()
  })

  it('removes on a trunk that asks no fallback only what was read there: changed in the manager since, left as it is (fourth review 10b, n°6, M24)', async () => {
    const { f, store, sync } = await setup({ [LINE]: { options: { forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033639980002' } }, [LINE2]: {} })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await sync.round('A')
    // Changed in the manager after the screen read it, before the administrator removes it.
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackupNature: 'voicemail' })
    const before = puts(f).length
    expect(await sync.removeForwards('A', [LINE], 'main')).toEqual([])
    expect(puts(f)).toHaveLength(before)
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardBackupNature: 'voicemail' })
    expect((await sync.status('A'))?.closedRemovals?.map(r => [r.line, r.outcome])).toEqual([[LINE, 'changed']])
  })

  it('takes what the operator kept of a write of the platform for the platform\'s, never for a change in the manager (fourth review 10b, n°4, M19)', async () => {
    const { f, store, sync, said } = await setup({ [LINE]: { options: { forwardNoReply: true, forwardNoReplyNature: 'voicemail', forwardNoReplyDelay: 20 } }, [LINE2]: {} })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE], fallback: ASKED } }) }])
    await sync.round('A')
    // OVH rounds the delay of the voicemail it is given back: 30 s, not 20.
    f.state.normalize = c => (c.forwardNoReplyDelay === 20 ? { ...c, forwardNoReplyDelay: 30 } : c)
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    expect((await sync.removeForwards('A', [LINE], 'main')).map(r => [r.line, r.error])).toEqual([[LINE, 'refused']])
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: false, forwardNoReply: true, forwardNoReplyNature: 'voicemail', forwardNoReplyDelay: 30 })
    // The next round removes it, as said: what the platform wrote there, not a change in the manager.
    await sync.round('A')
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    const status = await sync.status('A')
    expect([status?.removals, status?.closedRemovals]).toEqual([undefined, [{ line: LINE, at: T, outcome: 'done', trunkId: 'main', unrestored: 'refused' }]])
    expect(await store.listAlerts('A')).toEqual([])
    expect(said.map(([, , m]) => m)).toContain('operator: the operator did not keep the forwards of before, the fallback removed without them at the next round')
  })

  it('never puts back a forward of before the rules of the platform refuse: said first, then done without it (fourth review 10b, n°3)', async () => {
    const restorable = async (_tenantId: string, number: string) => (number === '+33199000101' ? ('loop' as const) : undefined)
    const { f, store, sync, said } = await setup(
      {
        [LINE]: { options: { forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033199000101' } },
        [LINE2]: { options: { forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033639980002' } }
      },
      { restorable }
    )
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) }])
    await sync.round('A')
    expect((await sync.status('A'))?.trunks[0]!.lines.map(l => l.originalRefused)).toEqual(['loop', undefined])
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2] } }) }])
    expect(await sync.removeForwards('A', [LINE, LINE2], 'main')).toEqual([])
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    expect(f.options(ACCOUNT, LINE2)).toMatchObject({ forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033639980002', forwardNoReply: false })
    expect((await sync.status('A'))?.closedRemovals).toEqual([
      { line: LINE, at: T, outcome: 'done', trunkId: 'main', unrestored: 'loop' },
      { line: LINE2, at: T, outcome: 'done', trunkId: 'main', restored: true }
    ])
    expect(said.filter(([l]) => l === 'warn').map(([, o, m]) => [m, (o as { why?: string }).why])).toContainEqual([
      'operator: the forwards of before not put back on a line: they would loop to the platform, or go where its trunk may not call',
      'loop'
    ])
  })

  it('never brings back a call erased once what the erasure kept is purged: a record pending past it is nobody\'s, its numbers gone (fourth review 10b, n°1, R4-5)', async () => {
    const { f, store, sync, advance, at } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    // Received while the platform could not be reached; Jean erases his history; the record read a minute later.
    await store.deleteHistory('A', 'jean', await erasedNumbersOf(store, 'A', 'jean'), sync.keptOfErasure('A'))
    advance(60_000)
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T13:59:00+02:00', duration: 12, wayType: 'incoming' })
    await sync.round('A')
    // Then four days without a round (no keys, or stopped), the purge going on all the same.
    advance(OPERATOR_KEPT_MS + 3_600_000)
    expect(await store.purgeErasures(new Date(at() - OPERATOR_KEPT_MS).toISOString())).toBeGreaterThan(0)
    expect(await store.historyErasedAt('A', 'jean')).toBeUndefined()
    await sync.round('A')
    expect((await store.listHistory('A', 'jean')).items).toEqual([])
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ total: 1, orphan: 0, erased: 1, pending: 0 })
    const kept = JSON.stringify([...(store as unknown as { operatorCdrs: Map<string, unknown> }).operatorCdrs.values()])
    expect(kept.includes('39980001')).toBe(false)
  })

  it('keeps the erasure of whom the directory gives another extension: a record of before read later is still erased (fourth review 10b, n°2, R4-6)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await store.upsertDid({ tenantId: 'A', id: 'desk', trunkId: 'main', first: '+33199000101', last: '+33199000101', target: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '101' })
    await store.deleteHistory('A', 'jean', await erasedNumbersOf(store, 'A', 'jean'), sync.keptOfErasure('A'))
    // Given 105 by the directory: the old extension let go first, as the synchronisation does.
    await store.deleteMapping('A', 'jean')
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '105' })
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: '2026-10-17T13:59:00+02:00', duration: 12, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ erased: 1, unmatchedInbound: 0, orphan: 0 })
    const kept = JSON.stringify([...(store as unknown as { operatorCdrs: Map<string, unknown> }).operatorCdrs.values()])
    expect(kept.includes('39980001')).toBe(false)
  })
})

describe('the routes of the operator', () => {
  const trunk: TrunkInput = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }
  const setup = async (withOperator = true, store = new MemoryStore(), settleMs = 0) => {
    process.env.AUTH_MODE = 'dev'
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
      ...(withOperator ? { operators: new Map([['A', ovh]]), operatorSyncMs: 0, operatorSettleMs: settleMs } : {})
    })
    registry.startAll()
    const as = (user: string, roles?: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'A', ...(roles ? { 'x-dev-roles': roles } : {}) })
    return { app, f, store, admin: as('root', 'twakephone-admin'), as }
  }

  it('sets the fallback at the operator when a trunk is saved, and says how it went, to administrators only', async () => {
    const { app, f, admin, as } = await setup()
    const operator = { lines: [LINE], fallback: ASKED }
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator } })
    expect(put.statusCode).toBe(201)
    expect(put.json().operator).toEqual(operator)
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardBackupNumber: '0033639980001', forwardNoReplyDelay: 150 })
    const status = await app.inject({ url: '/api/v1/admin/operator', headers: admin })
    expect(status.json()).toMatchObject({ configured: true, operator: 'ovh', trunks: [{ id: 'main', lines: [{ line: LINE, managed: true, inSync: true, forwards: SET }] }], cdrs: { stats: { total: 0 } } })
    expect(JSON.stringify(status.json())).not.toMatch(/fake-(application|consumer)/)
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: as('jean') })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/admin/operator' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: as('jean') })).statusCode).toBe(403)
    // A round now, twice a minute at most (counted in the store: whatever Gateway is asked).
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })).statusCode).toBe(200)
    const third = await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    expect([third.statusCode, third.json().code]).toEqual([429, 'OPERATOR_RATE'])
    // The fallback no longer asked: left at the operator as it is.
    const puts = f.requests.filter(r => r.method === 'PUT').length
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(200)
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(puts)
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true })
    await app.close()
  })

  it('refuses a fallback before the inside one ends, without its number, to a number of the platform, on a line another trunk keeps another one on, or without an operator', async () => {
    const { app, admin } = await setup()
    const refused = async (operator: unknown, id = 'main', over: Partial<TrunkInput> = {}) => {
      const r = await app.inject({ method: 'PUT', url: `/api/v1/admin/trunks/${id}`, headers: admin, payload: { ...trunk, ...over, operator } })
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
    // Nor a line of a trunk, nor the number a trunk presents (review 10b, n°26).
    expect(await refused({ lines: [LINE, LINE2], fallback: { number: '+33199000200', onUnavailable: true } })).toEqual([409, 'OPERATOR_FALLBACK_LOOP', 'operator.fallback.number'])
    expect(await refused({ lines: [LINE2], fallback: { number: '+33199000100', onUnavailable: true } })).toEqual([409, 'OPERATOR_FALLBACK_LOOP', 'operator.fallback.number'])
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: { number: MOBILE, onUnavailable: true } } } })).statusCode).toBe(200)
    const did = await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/mobile', headers: admin, payload: { trunkId: 'main', first: MOBILE, target: '101' } })
    expect([did.statusCode, did.json().code]).toEqual([409, 'OPERATOR_FALLBACK_LOOP'])
    // One fallback a line (review 10b, n°5): another trunk on it keeps the same one, or none, or is refused.
    const other = { defaultNumber: '+33199000300' }
    expect(await refused({ lines: [LINE2, LINE], fallback: { number: '+33639980002', onUnavailable: true } }, 'second', other)).toEqual([409, 'OPERATOR_LINE_SHARED', 'operator.lines'])
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/second', headers: admin, payload: { ...trunk, ...other, operator: { lines: [LINE2, LINE] } } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/second', headers: admin, payload: { ...trunk, ...other, operator: { lines: [LINE2, LINE], fallback: { number: MOBILE, onUnavailable: true } } } })).statusCode).toBe(200)
    await app.close()
    // No operator: its lines may be named, no fallback set there.
    const none = await setup(false)
    expect((await none.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: none.admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(201)
    const without = await none.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: none.admin, payload: { ...trunk, operator: { lines: [LINE], fallback: { number: MOBILE, onUnavailable: true } } } })
    expect([without.statusCode, without.json().code]).toEqual([409, 'OPERATOR_NONE'])
    expect((await none.app.inject({ url: '/api/v1/admin/operator', headers: none.admin })).json()).toEqual({ configured: false })
    expect((await none.app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: none.admin })).statusCode).toBe(409)
    expect((await none.app.inject({ method: 'POST', url: '/api/v1/admin/operator/lines', headers: none.admin, payload: { lines: [LINE] } })).statusCode).toBe(409)
    await none.app.close()
  })

  it('shows what is set at the operator before a first fallback replaces it, removes it on demand, and with the trunk (review 10b, n°13)', async () => {
    const { app, f, admin, as } = await setup()
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackup: true, forwardBackupNature: 'voicemail' })
    const read = await app.inject({ method: 'POST', url: '/api/v1/admin/operator/lines', headers: admin, payload: { lines: [LINE, '0033199000999'] } })
    expect(read.json()).toEqual({ items: [{ line: LINE, forwards: { onUnavailable: { nature: 'voicemail' } } }, { line: '0033199000999', error: 'not-found' }] })
    expect(f.requests.filter(r => r.method === 'PUT')).toEqual([])
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/lines', headers: as('jean'), payload: { lines: [LINE] } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/lines', headers: admin, payload: { lines: ['../auth'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })).statusCode).toBe(201)
    expect(f.options(ACCOUNT, LINE)).toMatchObject({ forwardBackup: true, forwardBackupNature: 'number' })
    // What was there before is kept, and shown (third review 10b, n°8).
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().trunks[0].lines[0]).toMatchObject({ managed: true, inSync: true, original: { onUnavailable: { nature: 'voicemail' } } })
    // Removed on demand: the trunk no longer asks one, its fallback goes, and the voicemail of before is put back.
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: admin })
    expect([removed.statusCode, removed.json().trunk.operator, removed.json().pending]).toEqual([200, { lines: [LINE] }, []])
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardBackupNature, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([true, 'voicemail', false])
    const after = (await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json()
    expect(after.trunks[0].lines[0]).toEqual({ line: LINE, managed: false, forwards: { onUnavailable: { nature: 'voicemail' } }, readAt: expect.any(String), appliedAt: expect.any(String) })
    expect(after.closedRemovals).toEqual([{ line: LINE, at: expect.any(String), outcome: 'done', trunkId: 'main', restored: true }])
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/nope/operator/fallback', headers: admin })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: as('jean') })).statusCode).toBe(403)
    // Deleted with its fallback: its forwards go too.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })).statusCode).toBe(200)
    expect(f.options(ACCOUNT, LINE)!.forwardBackupNature).toBe('number')
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main', headers: admin })).statusCode).toBe(204)
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardBackupNature, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([true, 'voicemail', false])
    await app.close()
  })

  it('says a removal the operator does not have yet (202), shows it owed, trunk deleted or not, and has it done at the next round (second review 10b, n°1)', async () => {
    const { app, f, admin } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })).statusCode).toBe(201)
    // OVH in trouble: the trunk no longer asks one, the removal is owed, and said so.
    f.state.down = true
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: admin })
    expect([removed.statusCode, removed.json().trunk.operator, removed.json().pending]).toEqual([202, { lines: [LINE] }, [expect.objectContaining({ line: LINE, trunkId: 'main', error: 'unreachable' })]])
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(true)
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().removals).toEqual([expect.objectContaining({ line: LINE, trunkId: 'main' })])
    f.state.down = false
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })).statusCode).toBe(200)
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().removals).toBeUndefined()
    // Deleted with its fallback, OVH in trouble: 202, owed with no trunk left, done once OVH answers.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })).statusCode).toBe(200)
    f.state.down = true
    const gone = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main', headers: admin })
    expect([gone.statusCode, gone.json().pending]).toEqual([202, [expect.objectContaining({ line: LINE, trunkId: 'main', error: 'unreachable' })]])
    const owed = (await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json()
    expect([owed.trunks, owed.removals]).toEqual([[], [expect.objectContaining({ line: LINE, trunkId: 'main' })]])
    f.state.down = false
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })).statusCode).toBe(200)
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(false)
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().removals).toBeUndefined()
    await app.close()
  })

  it('removes on demand what is left on the lines of a trunk that asks no fallback, and the fallback of a line it no longer names (second review 10b, n°8)', async () => {
    const { app, f, admin } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE, LINE2], fallback: ASKED } } })).statusCode).toBe(201)
    // A line no longer named: its fallback goes with it.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })).statusCode).toBe(200)
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE2)!.forwardBackup]).toEqual([true, false])
    // Unticked: left there; removed on demand still.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(200)
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(true)
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: admin })
    expect([removed.statusCode, removed.json().pending]).toEqual([200, []])
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    await app.close()
  })

  it('says a round asked that could not read the operator: 502 OPERATOR_ROUND, not a status as if read (second review 10b, n°6)', async () => {
    const { app, f, admin } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(201)
    f.state.down = true
    const failed = await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    expect([failed.statusCode, failed.json().code]).toEqual([502, 'OPERATOR_ROUND'])
    f.state.down = false
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })).statusCode).toBe(200)
    await app.close()
  })

  it('refuses a trunk whose line or number is the fallback another trunk keeps at the operator (second review 10b, n°7)', async () => {
    const { app, admin } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: { number: '+33199000300', onUnavailable: true } } } })).statusCode).toBe(201)
    const refused = async (over: Partial<TrunkInput>) => {
      const r = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/second', headers: admin, payload: { ...trunk, ...over } })
      return [r.statusCode, r.json().code]
    }
    expect(await refused({ defaultNumber: '+33199000300' })).toEqual([409, 'OPERATOR_FALLBACK_LOOP'])
    expect(await refused({ defaultNumber: '+33199000400', operator: { lines: ['0033199000300'] } })).toEqual([409, 'OPERATOR_FALLBACK_LOOP'])
    expect(await refused({ defaultNumber: '+33199000400', operator: { lines: [LINE2] } })).toEqual([201, undefined])
    await app.close()
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
    await app.close()
  })

  it('erases with the history the numbers of the records of the operator of the direct number, and never brings a pending one back (review 10b, n°1)', async () => {
    // Read an hour before it is reconciled: pending still when the history is erased, whatever the clock.
    const { app, f, store, admin, as } = await setup(true, new MemoryStore(), 3_600_000)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'main', first: '+33199000101', target: '101' } })).statusCode).toBe(201)
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: new Date(Date.now() - 600_000).toISOString(), duration: 12, wayType: 'incoming' })
    await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).json()).toEqual({ deleted: 0 })
    await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    expect((await app.inject({ url: '/api/v1/calls/history', headers: as('jean') })).json().items).toEqual([])
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().cdrs.stats).toMatchObject({ total: 1, erased: 1, unmatchedInbound: 0, orphan: 0 })
    expect(JSON.stringify([...(store as unknown as { operatorCdrs: Map<string, unknown> }).operatorCdrs.values()])).not.toContain('39980001')
    await app.close()
  })

  it('never puts back a forward of before to a number of the platform, nor one its trunk may not call, and says it before (fourth review 10b, n°3)', async () => {
    const { app, f, store, admin } = await setup()
    Object.assign(f.options(ACCOUNT, LINE)!, { forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033199000101' })
    Object.assign(f.options(ACCOUNT, LINE2)!, { forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '00442079460123' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE, LINE2], fallback: ASKED } } })).statusCode).toBe(201)
    // The number LINE forwarded to became a direct number of the platform since; LINE2's is abroad, the trunk calls
    // France only.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'main', first: '+33199000101', target: '101' } })).statusCode).toBe(201)
    const lines = async () => ((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json<{ trunks: { lines: { originalRefused?: string }[] }[] }>()).trunks[0]!.lines.map(l => l.originalRefused)
    expect(await lines()).toEqual(['loop', 'outbound'])
    // The rules, number by number: the trunk's lines and number, what it may call (premium never, overseas, here Mayotte's
    // 0639, and abroad as it allows).
    const refusal = restoreRefusalOf(store)
    expect(await Promise.all(['+33199000100', '0033199000200', '+33899000000', '+33639980002', '+33199000555'].map(n => refusal('A', n, 'main')))).toEqual(['loop', 'loop', 'outbound', 'outbound', undefined])
    // Allowed to call abroad, elsewhere: still not; there: LINE2's put back, never LINE's.
    const elsewhere = { ...trunk, allowed: ['fixed', 'mobile', 'freephone', 'standard-rate', 'international'], countries: ['32'] }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...elsewhere, operator: { lines: [LINE, LINE2], fallback: ASKED } } })).statusCode).toBe(200)
    expect(await lines()).toEqual(['loop', 'outbound'])
    const abroad = { ...elsewhere, countries: ['44'] }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...abroad, operator: { lines: [LINE, LINE2], fallback: ASKED } } })).statusCode).toBe(200)
    expect(await lines()).toEqual(['loop', undefined])
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: admin })
    expect([removed.statusCode, removed.json().pending]).toEqual([200, []])
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    expect(f.options(ACCOUNT, LINE2)).toMatchObject({ forwardBackup: true, forwardBackupNumber: '00442079460123', forwardNoReply: false })
    const closed = (await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().closedRemovals as { line: string; unrestored?: string; restored?: true }[]
    expect(closed.map(c => [c.line, c.unrestored, c.restored]).sort()).toEqual([
      [LINE, 'loop', undefined],
      [LINE2, undefined, true]
    ])
    await app.close()
  })

  it('says what is owed still when a trunk saved drops a line it kept a fallback on: 202 with it (third review 10b, n°11)', async () => {
    const { app, f, admin } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE, LINE2], fallback: ASKED } } })).statusCode).toBe(201)
    f.state.down = true
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })
    expect([saved.statusCode, saved.json().id, saved.json().operator.lines, saved.json().pending]).toEqual([202, 'main', [LINE], [expect.objectContaining({ line: LINE2, trunkId: 'main', error: 'unreachable' })]])
    f.state.down = false
    const again = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, name: 'Principal', operator: { lines: [LINE], fallback: ASKED } } })
    expect([again.statusCode, 'pending' in again.json()]).toEqual([200, false])
    await app.close()
  })

  it('lets a removal go on an administrator\'s word, to administrators only: 204, then 404 (third review 10b, n°4)', async () => {
    const { app, f, admin, as } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })).statusCode).toBe(201)
    f.state.rules = pilotRules(ACCOUNT).filter(r => r.method === 'GET')
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: admin })
    expect([removed.statusCode, removed.json().pending.map((r: { error: string }) => r.error)]).toEqual([202, ['forbidden']])
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/operator/removals/${LINE}`, headers: as('jean') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/operator/removals/${LINE}`, headers: admin })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/operator/removals/${LINE}`, headers: admin })).statusCode).toBe(404)
    const status = (await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json()
    expect([status.removals, status.closedRemovals]).toEqual([undefined, [{ line: LINE, at: expect.any(String), outcome: 'abandoned', trunkId: 'main' }]])
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(true)
    await app.close()
    const none = await setup(false)
    expect((await none.app.inject({ method: 'DELETE', url: `/api/v1/admin/operator/removals/${LINE}`, headers: none.admin })).json().code).toBe('OPERATOR_NONE')
    await none.app.close()
  })

  it('purges what erasures and changes of hands keep after a few days, with no operator at all; keeps no time of an erased call then (third review 10b, n°3)', async () => {
    let t = Date.now() - 5 * 86_400_000
    const store = new MemoryStore(() => t)
    await store.upsertMapping({ tenantId: 'A', userId: 'paul', extension: '102' })
    await store.deleteHistory('A', 'paul', ['+33199000102'])
    await store.upsertMapping({ tenantId: 'A', userId: 'paul', extension: '103' })
    t = Date.now()
    const { app, as } = await setup(false, store)
    // An erasure now, without an operator: when its calls were is not kept.
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'c1', direction: 'outbound', remoteNumber: MOBILE, startedAt: new Date(t - 60_000).toISOString(), endedAt: new Date(t).toISOString(), durationSec: 60, state: 'ended', answered: true })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).json()).toEqual({ deleted: 1 })
    expect(await store.erasedCalls('A', new Date(t - 3_600_000).toISOString(), new Date(t + 3_600_000).toISOString())).toEqual([])
    // Purged once started (then every hour): what is older than four days.
    for (let i = 0; i < 100 && (await store.historyErasedAt('A', 'paul')); i++) await new Promise(r => setTimeout(r, 10))
    expect([await store.historyErasedAt('A', 'paul'), await store.numberChangedAt('A', '102', '+33199000102')]).toEqual([undefined, undefined])
    expect(await store.historyErasedAt('A', 'jean')).toBeDefined()
    await app.close()
  })

  it('keeps when the calls erased were, with an operator, those a record read later may be of, each with the print of its number (third review 10b, n°3 and n°5)', async () => {
    const { app, store, as } = await setup()
    const now = Date.now()
    for (const [id, ago] of [['recent', 3_600_000], ['old', 3 * 86_400_000]] as const)
      await store.addHistory({ tenantId: 'A', userId: 'jean', callId: id, direction: 'outbound', remoteNumber: '06 39 98 00 01', startedAt: new Date(now - ago).toISOString(), endedAt: new Date(now - ago + 60_000).toISOString(), durationSec: 60, state: 'ended', answered: true })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).json()).toEqual({ deleted: 2 })
    const kept = await store.erasedCalls('A', new Date(now - 4 * 86_400_000).toISOString(), new Date(now).toISOString())
    expect(kept.map(c => [c.startedAt, c.remoteKey?.length])).toEqual([[new Date(now - 3_600_000).toISOString(), 64]])
    expect(JSON.stringify(kept)).not.toContain('39980001')
    await app.close()
  })
})
