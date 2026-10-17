import { describe, expect, it } from 'vitest'
import { directNumbersOf, e164Of, extensionOfDid, matchCdrs } from './reconcile.js'
import type { HistoryEntry, OperatorCdrRecord } from './store/types.js'

// Fictional numbers only (ARCEP: 01 99 00 xx xx, 06 39 98 xx xx).
const call = (callId: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  tenantId: 'A', userId: 'jean', callId, direction: 'inbound', remoteNumber: '+33639980001',
  startedAt: '2026-10-17T10:00:00.000Z', endedAt: '2026-10-17T10:01:10.000Z', durationSec: 60, state: 'ended', answered: true, ...over
})
const cdr = (id: string, over: Partial<OperatorCdrRecord> = {}): OperatorCdrRecord => ({
  tenantId: 'A', operator: 'ovh', id, line: '0033199000100', direction: 'inbound', calling: '+33639980001', called: '+33199000101',
  startedAt: '2026-10-17T10:00:02.000Z', durationSec: 61, ...over
})

describe('the reconciliation of the operator records with the history', () => {
  it('writes the numbers of both sides in E.164', () => {
    expect(['+33639980001', '0033639980001', '06 39 98 00 01', '0639980001', 'anonymous', '101'].map(e164Of)).toEqual(['+33639980001', '+33639980001', '+33639980001', '+33639980001', 'anonymous', '101'])
  })

  it('pairs a record with the call of the same way and number, started within the window, of a close duration', () => {
    expect(matchCdrs([cdr('r1')], [call('c1')])).toEqual(new Map([['r1', 'c1']]))
    // The operator's numbers as it writes them, the history's as OpenSIPS: the same once in E.164.
    expect(matchCdrs([cdr('r1', { calling: '0033639980001' })], [call('c1', { remoteNumber: '0639980001' })])).toEqual(new Map([['r1', 'c1']]))
    // Outbound: the number called is the other side.
    expect(matchCdrs([cdr('r1', { direction: 'outbound', calling: '+33199000100', called: '+33639980001' })], [call('c1', { direction: 'outbound' })])).toEqual(new Map([['r1', 'c1']]))
    const none: [string, Partial<OperatorCdrRecord>, Partial<HistoryEntry>][] = [
      ['another way', { direction: 'outbound', called: '+33639980001' }, {}],
      ['another number', { calling: '+33639980002' }, {}],
      ['started over a minute before ours', { startedAt: '2026-10-17T09:58:59.000Z' }, {}],
      ['started over a minute after our end', { startedAt: '2026-10-17T10:02:11.000Z' }, {}],
      ['answered there, not here', { durationSec: 42 }, { durationSec: 0, answered: false, state: 'missed' }],
      ['a much longer call', { durationSec: 90 }, {}],
      ['a forward of the operator', { forwarded: true }, {}],
      ['its numbers erased', { calling: undefined }, {}]
    ]
    for (const [what, r, c] of none) expect(matchCdrs([cdr('r1', r)], [call('c1', c)]).size, what).toBe(0)
    // A ring that lasted: the operator dates it from its start, ours too, within the window either way.
    expect(matchCdrs([cdr('r1', { startedAt: '2026-10-17T09:59:30.000Z', durationSec: 0 })], [call('c1', { durationSec: 0, answered: false, state: 'missed' })]).size).toBe(1)
    // Short ones count as close (a few seconds apart).
    expect(matchCdrs([cdr('r1', { durationSec: 3 })], [call('c1', { durationSec: 0 })]).size).toBe(1)
  })

  it('gives each record one call and each call one record, the closest in time first, whoever entries a call has', () => {
    // Two calls of the same number a few minutes apart, two records: each its own.
    const calls = [call('early'), call('late', { startedAt: '2026-10-17T10:00:50.000Z', endedAt: '2026-10-17T10:02:00.000Z' })]
    expect(matchCdrs([cdr('r-late', { startedAt: '2026-10-17T10:00:51.000Z' }), cdr('r-early')], calls)).toEqual(new Map([['r-late', 'late'], ['r-early', 'early']]))
    // Two records for one call: one of them only.
    expect(matchCdrs([cdr('r1'), cdr('r2', { startedAt: '2026-10-17T10:00:20.000Z' })], [call('c1')])).toEqual(new Map([['r1', 'c1']]))
    // A call of a ring group: an entry per member who rang, one call.
    expect(matchCdrs([cdr('r1')], [call('g1'), call('g1', { userId: 'alice', durationSec: 0, answered: false, state: 'missed', endedAt: '2026-10-17T10:00:20.000Z' })])).toEqual(new Map([['r1', 'g1']]))
  })

  it('finds the extension a direct number rings: the target of its range, or its last digits', () => {
    const dids = [
      { id: 'desk', trunkId: 't', first: '+33199000101', last: '+33199000101', target: '101' },
      { id: 'sales', trunkId: 't', first: '+33199000130', last: '+33199000139', suffixDigits: 3 }
    ]
    expect(extensionOfDid(dids, '+33199000101')).toBe('101')
    expect(extensionOfDid(dids, '0199000135')).toBe('135')
    expect(extensionOfDid(dids, '+33199000140')).toBeUndefined()
    expect(extensionOfDid(dids, '+3319900013')).toBeUndefined()
  })

  it('pairs what the first pass left when loose: durations apart (forwarded on no answer), a caller the platform did not see (review 10b, n°17)', () => {
    const missed = call('c1', { durationSec: 0, answered: false, state: 'missed', endedAt: '2026-10-17T10:00:30.000Z' })
    // Missed here, answered at the operator (it forwarded it on no answer): two calls for the first pass, one loose.
    expect(matchCdrs([cdr('r1', { durationSec: 95 })], [missed]).size).toBe(0)
    expect(matchCdrs([cdr('r1', { durationSec: 95 })], [missed], { loose: true })).toEqual(new Map([['r1', 'c1']]))
    // A hidden caller: `anonymous` here, a number there; inbound only, and never a call already paired.
    const hidden = call('c2', { remoteNumber: 'anonymous' })
    expect(matchCdrs([cdr('r2')], [hidden]).size).toBe(0)
    expect(matchCdrs([cdr('r2')], [hidden], { loose: true })).toEqual(new Map([['r2', 'c2']]))
    expect(matchCdrs([cdr('r2', { direction: 'outbound', called: '+33639980001' })], [call('c3', { direction: 'outbound', remoteNumber: 'anonymous' })], { loose: true }).size).toBe(0)
    expect(matchCdrs([cdr('r2')], [hidden], { loose: true, taken: new Set(['c2']) }).size).toBe(0)
    // Never a record that is no call, even loose.
    expect(matchCdrs([cdr('r3', { invalid: 'wayType conference' })], [call('c1')], { loose: true }).size).toBe(0)
  })

  it('finds the direct numbers that ring an extension: the ranges aimed at it, the numbers of a range whose last digits make it (review 10b, n°1)', () => {
    const dids = [
      { id: 'desk', trunkId: 't', first: '+33199000101', last: '+33199000101', target: '101' },
      { id: 'pair', trunkId: 't', first: '+33199000150', last: '+33199000151', target: '101' },
      { id: 'sales', trunkId: 't', first: '+33199000130', last: '+33199000139', suffixDigits: 3 },
      { id: 'wide', trunkId: 't', first: '+33199001100', last: '+33199003299', suffixDigits: 2 },
      { id: 'group', trunkId: 't', first: '+33199000102', last: '+33199000102', target: '200' }
    ]
    expect(directNumbersOf(dids, '101').sort()).toEqual(['+33199000101', '+33199000150', '+33199000151'])
    expect(directNumbersOf(dids, '135')).toEqual(['+33199000135'])
    expect(directNumbersOf(dids, '140')).toEqual([])
    expect(directNumbersOf(dids, '42')).toEqual(['+33199001142', '+33199001242', '+33199001342', '+33199001442', '+33199001542', '+33199001642', '+33199001742', '+33199001842', '+33199001942', '+33199002042', '+33199002142', '+33199002242', '+33199002342', '+33199002442', '+33199002542', '+33199002642', '+33199002742', '+33199002842', '+33199002942', '+33199003042', '+33199003142', '+33199003242'])
    for (const n of directNumbersOf(dids, '135')) expect(extensionOfDid(dids, n)).toBe('135')
  })
})
