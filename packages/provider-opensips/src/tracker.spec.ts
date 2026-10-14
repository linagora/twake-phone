import { describe, expect, it } from 'vitest'
import type { TelephonyEvent } from '@twake/telephony-types'
import { CallTracker, userOf } from './tracker.js'

// The events as OpenSIPS 3.6 sends them (captured on the Docker stack), trimmed to what the tracker reads.
const contact = (aor: string, uri: string) => ({ domain: 'location', aor, uri, received: 'sip:127.0.0.1:44860;transport=wss', user_agent: 'TwakePhone', expires: 1792003007, callid: 'reg-1', cseq: 2 })
const call = (callid: string, caller: string, callee: string) => ({ callid, caller, callee })
const cdr = (callid: string, caller: string, callee: string, duration: number, time: number) => ({ method: 'INVITE', from_tag: 'a', to_tag: 'b', callid, sip_code: '200', sip_reason: 'OK', time, caller, callee, duration, ms_duration: duration * 1000, setuptime: 1, created: time })
const missed = (callid: string, caller: string, callee: string, sip_code: string, time: number) => ({ method: 'INVITE', from_tag: 'a', to_tag: null, callid, sip_code, sip_reason: 'x', time, caller, callee, setuptime: 0, created: time })

const make = () => {
  const events: { extension: string; event: TelephonyEvent }[] = []
  let t = Date.parse('2026-10-14T18:00:00.000Z')
  const tracker = new CallTracker((extension, event) => events.push({ extension, event }), () => new Date((t += 1000)).toISOString())
  const presences = () => events.filter(e => e.event.type === 'presence.changed').map(e => `${e.extension}:${(e.event.payload as { presence: { status: string } }).presence.status}`)
  const calls = () => events.filter(e => e.event.type.startsWith('call.')).map(e => `${e.extension}:${e.event.type}:${(e.event.payload as { call: { state: string; direction: string; remoteNumber: string } }).call.direction}:${(e.event.payload as { call: { state: string; direction: string; remoteNumber: string } }).call.remoteNumber}:${(e.event.payload as { call: { state: string } }).call.state}`)
  return { tracker, events, presences, calls, clear: () => events.splice(0) }
}

describe('CallTracker', () => {
  it('reads the user of an address of record with or without domain', () => {
    expect(userOf('101')).toBe('101')
    expect(userOf('101@sip.example.test')).toBe('101')
    expect(userOf('sip:101@sip.example.test')).toBe('101')
  })

  it('tells an extension available at its first registration and offline at its last unregistration', () => {
    const { tracker, presences, clear } = make()
    tracker.handle('E_UL_AOR_INSERT', { domain: 'location', aor: '101' })
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:a@x.invalid;transport=ws'))
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:b@y.invalid;transport=ws'))
    expect(presences()).toEqual(['101:available'])
    expect(tracker.presenceOf('101')).toEqual({ status: 'available', source: 'telephony' })
    clear()
    tracker.handle('E_UL_CONTACT_DELETE', contact('101', 'sip:a@x.invalid;transport=ws'))
    expect(presences()).toEqual([])
    tracker.handle('E_UL_CONTACT_DELETE', contact('101', 'sip:b@y.invalid;transport=ws'))
    expect(presences()).toEqual(['101:offline'])
    expect(tracker.presenceOf('102')).toEqual({ status: 'offline', source: 'telephony' })
  })

  it('tells both sides of a call as it starts, rings, is answered and ends, and keeps them busy meanwhile', () => {
    const { tracker, presences, calls, events, clear } = make()
    for (const ext of ['101', '102']) tracker.handle('E_UL_CONTACT_INSERT', contact(ext, `sip:${ext}@x.invalid`))
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    expect(calls()).toEqual(['101:call.created:outbound:102:new', '102:call.created:inbound:101:new'])
    expect(presences()).toEqual(['101:busy', '102:busy'])
    clear()
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_ANSWERED', call('c1', '101', '102'))
    expect(calls()).toEqual(['101:call.ringing:outbound:102:ringing', '102:call.ringing:inbound:101:ringing', '101:call.connected:outbound:102:connected', '102:call.connected:inbound:101:connected'])
    expect(presences()).toEqual([])
    clear()
    tracker.handle('E_ACC_CDR', cdr('c1', '101', '102', 4, 1792002800))
    expect(calls()).toEqual(['101:call.ended:outbound:102:ended', '102:call.ended:inbound:101:ended'])
    const ended = events[0]!.event.payload as { call: { startedAt: string; connectedAt: string; endedAt: string } }
    expect(ended.call.endedAt).toBe('2026-10-14T18:33:20.000Z')
    expect(Date.parse(ended.call.connectedAt)).toBeLessThan(Date.parse(ended.call.endedAt))
    expect(Date.parse(ended.call.startedAt)).toBeLessThanOrEqual(Date.parse(ended.call.connectedAt))
    expect(presences()).toEqual(['101:available', '102:available'])
  })

  it('tells a refused call as rejected to both, a cancelled one as missed to the callee, an unreachable one to the caller only', () => {
    const { tracker, calls, clear } = make()
    for (const ext of ['101', '102']) tracker.handle('E_UL_CONTACT_INSERT', contact(ext, `sip:${ext}@x.invalid`))
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c1', '101', '102', '603', 1792002800))
    expect(calls().slice(-2)).toEqual(['101:call.ended:outbound:102:rejected', '102:call.ended:inbound:101:rejected'])
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', call('c2', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c2', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c2', '101', '102', '487', 1792002810))
    expect(calls().slice(-2)).toEqual(['101:call.ended:outbound:102:ended', '102:call.ended:inbound:101:missed'])
    clear()
    // Nobody registered as 105: it never rang, so 105 has no missed call.
    tracker.handle('E_TWAKEPHONE_CALLING', call('c3', '101', '105'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c3', '101', '105', '404', 1792002820))
    expect(calls().filter(c => c.includes('call.failed') || c.includes('call.ended'))).toEqual(['101:call.failed:outbound:105:failed'])
    // A dead registration (477 from tm): same for the caller, nothing for the callee.
    tracker.handle('E_TWAKEPHONE_CALLING', call('c4', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c4', '101', '102', '477', 1792002830))
    expect(calls().slice(-1)).toEqual(['101:call.failed:outbound:102:failed'])
    expect(tracker.activeCalls()).toEqual([])
  })

  it('records the end of a call whose start it never saw (a Gateway started mid-call)', () => {
    const { tracker, calls, events } = make()
    tracker.handle('E_ACC_CDR', cdr('old', '103', '101', 30, 1792002800))
    expect(calls()).toEqual(['103:call.ended:outbound:101:ended', '101:call.ended:inbound:103:ended'])
    const c = (events[0]!.event.payload as { call: { connectedAt: string; endedAt: string } }).call
    expect(Date.parse(c.endedAt) - Date.parse(c.connectedAt)).toBe(30_000)
  })

  it('keeps what the user set unless the SIP server has something stronger to say', () => {
    const { tracker, presences, clear } = make()
    tracker.setUserPresence('101', { status: 'dnd', source: 'user', since: '2026-10-14T17:00:00.000Z' })
    // Not registered: offline, whatever was set.
    expect(tracker.presenceOf('101')).toEqual({ status: 'offline', source: 'telephony' })
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:a@x.invalid'))
    expect(tracker.presenceOf('101')).toEqual({ status: 'dnd', source: 'user', since: '2026-10-14T17:00:00.000Z' })
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '102', '101'))
    expect(tracker.presenceOf('101').status).toBe('busy')
    tracker.handle('E_ACC_MISSED_EVENT', missed('c1', '102', '101', '486', 1792002800))
    expect(tracker.presenceOf('101').status).toBe('dnd')
    expect(presences()).toEqual(['101:busy', '102:busy', '101:dnd', '102:offline'])
    tracker.setUserPresence('101', { status: 'available', source: 'user' })
    expect(tracker.presenceOf('101')).toMatchObject({ status: 'available', source: 'user' })
  })

  it('resyncs from what OpenSIPS holds: registrations replace the known ones, lost dialogs end, unknown confirmed ones are in progress', () => {
    const { tracker, presences, calls, clear } = make()
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:a@x.invalid'))
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '101', '102'))
    clear()
    tracker.seedRegistrations([{ aor: '102', contacts: ['sip:b@y.invalid'] }, { aor: '103', contacts: [] }])
    tracker.seedDialogs([{ callid: 'c9', state: 4, caller: '103', callee: '102', startedAt: '2026-10-14T17:59:00.000Z' }])
    expect(calls()).toEqual(['101:call.ended:outbound:102:ended', '102:call.ended:inbound:101:missed', '103:call.connected:outbound:102:connected', '102:call.connected:inbound:103:connected'])
    expect(presences()).toEqual(['101:offline', '103:busy'])
    expect(tracker.presenceOf('102').status).toBe('busy')
    clear()
    tracker.reset()
    expect(presences()).toEqual(['102:offline', '103:offline'])
  })

  it('tells the presence once per change, with the moment it changed', () => {
    const { tracker, events, clear } = make()
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:a@x.invalid'))
    const first = events[0]!.event.payload as { presence: { since: string } }
    clear()
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:b@x.invalid'))
    expect(events).toEqual([])
    expect(tracker.presences().get('101')).toEqual({ status: 'available', source: 'telephony', since: first.presence.since })
  })

  it('forgets a call whose end was never told, after longer than OpenSIPS keeps a dialog', () => {
    const { tracker, calls, clear } = make()
    let t = Date.parse('2026-10-14T18:00:00.000Z')
    const tracker2 = new CallTracker((extension, event) => tracker['emit'](extension, event), () => new Date(t).toISOString())
    tracker2.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    clear()
    t += 6 * 3_600_000
    tracker2.handle('E_UL_CONTACT_INSERT', contact('103', 'sip:c@x.invalid'))
    expect(calls()).toEqual(['101:call.ended:outbound:102:ended'])
    expect(tracker2.activeCalls()).toEqual([])
  })
})
