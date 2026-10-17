import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { OvhOperator } from '@twake/provider-ovh'
import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { DidRange, Trunk, TrunkInput } from '@twake/telephony-types'
import { pilotRules, startFakeOvh, type FakeOvh } from '../../../packages/provider-ovh/test/fake-ovh.mjs'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { OperatorSync, eraseOperatorNumbers, matchesFallback } from './operator.js'
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
      { id: 'main', lines: [{ line: LINE, forwards: SET, managed: true, inSync: true, readAt: T, appliedAt: T }] },
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
    expect((await sync.status('A'))?.trunks[0]!.lines[1]).toEqual({ line: LINE, forwards: { onUnavailable: { nature: 'number', number: MOBILE } }, managed: true, inSync: true, readAt: '2026-10-17T12:00:01.000Z', appliedAt: '2026-10-17T12:00:01.000Z' })
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
    expect(await store.deleteHistory('A', 'jean')).toBe(0)
    expect(await eraseOperatorNumbers(store, 'A', 'jean', (await store.historyErasedAt('A', 'jean'))!)).toBe(1)
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
    expect((await sync.status('A'))?.cdrs.stats).toMatchObject({ total: 3, orphan: 1, unmatchedInbound: 2, pending: 0 })
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
    expect((await sync.status('A'))?.trunks[0]!.lines[0]).toEqual({ line: LINE, forwards: SET, managed: true, inSync: true, readAt: T, appliedAt: T })
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

  it('raises an alert when the operator refuses its keys round after round, and when fewer than 99 % of the records are reconciled (review 10b, n°12)', async () => {
    const { f, store, sync, advance } = await setup()
    const refusing = new OperatorSync({ store, operators: new Map([['A', new OvhOperator({ ...f.credentials, consumerKey: 'revoked', baseUrl: f.url, billingAccount: ACCOUNT })]]), now: () => Date.parse(T) })
    await store.upsertTrunks([{ tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE] } }) }])
    await refusing.round('A')
    expect(await store.listAlerts('A')).toEqual([])
    await refusing.round('A')
    expect((await store.listAlerts('A')).map(a => [a.alert.kind, a.alert.param, a.alert.value])).toEqual([['operator', 'unauthorized', 2]])
    // 20 calls to a group the platform never had: none reconciled.
    await store.upsertDid({ tenantId: 'A', id: 'group', trunkId: 'main', first: '+33199000102', last: '+33199000102', target: '200' })
    for (let i = 0; i < 20; i++) f.addConsumption(ACCOUNT, LINE, { calling: '0033639980003', called: '0033199000102', creationDatetime: `2026-10-17T1${i % 4}:${10 + i}:00+02:00`, duration: 12, wayType: 'incoming' })
    await sync.round('A')
    advance(61_000)
    await sync.round('A')
    const reconciled = (await store.listAlerts('A')).find(a => a.alert.param === 'reconciliation')
    expect(reconciled?.alert).toEqual({ kind: 'operator', param: 'reconciliation', scope: 'tenant', value: 0, threshold: 99 })
  })

  it('tells a trunk event where each forward sends the calls on every line, read again when old, never a number (review 10b, n°4)', async () => {
    const { f, store, sync, advance } = await setup()
    await store.upsertTrunks([
      { tenantId: 'A', id: 'main', config: config({ operator: { lines: [LINE, LINE2], fallback: ASKED } }) },
      { tenantId: 'A', id: 'bare', config: config() }
    ])
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
    // Removed on demand: the trunk no longer asks one, and the forwards go.
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: admin })
    expect([removed.statusCode, removed.json().operator]).toEqual([200, { lines: [LINE] }])
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().trunks[0].lines[0]).toMatchObject({ managed: false, forwards: {} })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/nope/operator/fallback', headers: admin })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main/operator/fallback', headers: as('jean') })).statusCode).toBe(403)
    // Deleted with its fallback: its forwards go too.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE], fallback: ASKED } } })).statusCode).toBe(200)
    expect(f.options(ACCOUNT, LINE)!.forwardBackup).toBe(true)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main', headers: admin })).statusCode).toBe(204)
    expect([f.options(ACCOUNT, LINE)!.forwardBackup, f.options(ACCOUNT, LINE)!.forwardNoReply]).toEqual([false, false])
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
    const { app, f, store, admin, as } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...trunk, operator: { lines: [LINE] } } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'main', first: '+33199000101', target: '101' } })).statusCode).toBe(201)
    f.addConsumption(ACCOUNT, LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: new Date(Date.now() - 600_000).toISOString(), duration: 12, wayType: 'incoming' })
    await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).json()).toEqual({ deleted: 0 })
    await app.inject({ method: 'POST', url: '/api/v1/admin/operator/sync', headers: admin })
    expect((await app.inject({ url: '/api/v1/calls/history', headers: as('jean') })).json().items).toEqual([])
    expect((await app.inject({ url: '/api/v1/admin/operator', headers: admin })).json().cdrs.stats).toMatchObject({ total: 1, unmatchedInbound: 1, orphan: 0 })
    expect(JSON.stringify([...(store as unknown as { operatorCdrs: Map<string, unknown> }).operatorCdrs.values()])).not.toContain('39980001')
    await app.close()
  })
})
