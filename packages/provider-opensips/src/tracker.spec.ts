import { describe, expect, it } from 'vitest'
import type { TelephonyEvent } from '@twake/telephony-types'
import { CallTracker, userOf } from './tracker.js'

// The events as OpenSIPS 3.6 sends them (captured on the Docker stack), trimmed to what the tracker reads.
// usrloc's `expires` is an absolute time (seconds since the epoch).
const contact = (aor: string, uri: string, expires = 1792003007) => ({ domain: 'location', aor, uri, received: 'sip:127.0.0.1:44860;transport=wss', user_agent: 'TwakePhone', expires, callid: 'reg-1', cseq: 2 })
const call = (callid: string, caller: string, callee: string) => ({ callid, caller, callee })
// acc in CDR mode: `created` is when the INVITE came, `time` when the call was answered (`setuptime` seconds later),
// `ms_duration` how long it lasted after that (`duration`: the same, rounded up to the second).
const cdr = (callid: string, caller: string, callee: string, duration: number, time: number, ms_duration = duration * 1000) => ({ method: 'INVITE', from_tag: 'a', to_tag: 'b', callid, sip_code: '200', sip_reason: 'OK', time, caller, callee, duration, ms_duration, setuptime: 1, created: time - 1 })
// A CDR captured on the Docker stack, received at 18:31:53.019Z: answered at 18:31:49, 3.012 s of talk.
const capturedCdr = { method: 'INVITE', from_tag: '0q982rupr8', to_tag: '1s0h4iajm5', callid: 'kk942qijdsdnpm482itb', sip_code: '200', sip_reason: 'OK', time: 1792002709, caller: '101', callee: '102', duration: 4, ms_duration: 3012, setuptime: 0, created: 1792002709 }
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
    // The callee hears of the call, and is busy with it, once its phone rings.
    expect(calls()).toEqual(['101:call.created:outbound:102:new'])
    expect(presences()).toEqual(['101:busy'])
    clear()
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '101', '102'))
    expect(presences()).toEqual(['102:busy'])
    tracker.handle('E_TWAKEPHONE_ANSWERED', call('c1', '101', '102'))
    expect(calls()).toEqual(['101:call.ringing:outbound:102:ringing', '102:call.ringing:inbound:101:ringing', '101:call.connected:outbound:102:connected', '102:call.connected:inbound:101:connected'])
    clear()
    tracker.handle('E_ACC_CDR', cdr('c1', '101', '102', 4, 1792000805))
    expect(calls()).toEqual(['101:call.ended:outbound:102:ended', '102:call.ended:inbound:101:ended'])
    const ended = events[0]!.event.payload as { call: { startedAt: string; connectedAt: string; endedAt: string } }
    expect(ended.call.connectedAt).toBe('2026-10-14T18:00:05.000Z')
    expect(ended.call.endedAt).toBe('2026-10-14T18:00:09.000Z')
    expect(Date.parse(ended.call.startedAt)).toBeLessThanOrEqual(Date.parse(ended.call.connectedAt))
    expect(presences()).toEqual(['101:available', '102:available'])
  })

  it('tells a declined call (603, 600) as rejected to both, a busy one (486) as missed to the callee, a cancelled one as missed, an unreachable one to the caller only', () => {
    const { tracker, calls, clear } = make()
    for (const ext of ['101', '102']) tracker.handle('E_UL_CONTACT_INSERT', contact(ext, `sip:${ext}@x.invalid`))
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c1', '101', '102', '603', 1792002800))
    expect(calls().slice(-2)).toEqual(['101:call.ended:outbound:102:rejected', '102:call.ended:inbound:101:rejected'])
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', call('c600', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c600', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c600', '101', '102', '600', 1792002801))
    expect(calls().slice(-2)).toEqual(['101:call.ended:outbound:102:rejected', '102:call.ended:inbound:101:rejected'])
    clear()
    // A second window already in a call answers 486, and tm prefers it to the others' silence: nobody declined.
    tracker.handle('E_TWAKEPHONE_CALLING', call('c486', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c486', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c486', '101', '102', '486', 1792002802))
    expect(calls().slice(-2)).toEqual(['101:call.ended:outbound:102:rejected', '102:call.ended:inbound:101:missed'])
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

  it('creates a call whose CALLING was lost from a later event naming both sides (ringing, answer, CDR), never one that ended', () => {
    const { tracker, calls, events, clear } = make()
    tracker.handle('E_ACC_CDR', cdr('lost1', '103', '101', 30, 1792002800))
    expect(calls()).toEqual(['103:call.ended:outbound:101:ended', '101:call.ended:inbound:103:ended'])
    // Started when the INVITE came (`created`), answered at `time`.
    expect((events[0]!.event.payload as { call: { startedAt: string; connectedAt: string } }).call).toMatchObject({ startedAt: '2026-10-14T18:33:19.000Z', connectedAt: '2026-10-14T18:33:20.000Z' })
    clear()
    tracker.handle('E_TWAKEPHONE_RINGING', call('lost2', '103', '101'))
    tracker.handle('E_TWAKEPHONE_ANSWERED', call('lost2', '103', '101'))
    tracker.handle('E_ACC_CDR', cdr('lost2', '103', '101', 5, 1792002810))
    expect(calls()).toEqual([
      '103:call.ringing:outbound:101:ringing',
      '101:call.ringing:inbound:103:ringing',
      '103:call.connected:outbound:101:connected',
      '101:call.connected:inbound:103:connected',
      '103:call.ended:outbound:101:ended',
      '101:call.ended:inbound:103:ended'
    ])
    clear()
    tracker.handle('E_TWAKEPHONE_ANSWERED', call('lost3', '103', '101'))
    expect(tracker.activeCalls().map(c => `${c.id}:${c.state}`)).toEqual(['lost3:connected'])
    expect(tracker.telephonyPresence('101')).toBe('busy')
    clear()
    // Not without both sides, not after its end, not from a missed call (did the callee's phone ring?).
    tracker.handle('E_ACC_CDR', cdr('lost1', '103', '101', 30, 1792002800))
    tracker.handle('E_TWAKEPHONE_RINGING', { callid: 'lost4', caller: '', callee: '101' })
    tracker.handle('E_ACC_CDR', { ...cdr('lost5', '103', '101', 30, 1792002800), caller: undefined })
    tracker.handle('E_ACC_MISSED_EVENT', missed('lost6', '103', '101', '487', 1792002800))
    expect(events).toEqual([])
  })

  it('records the end of a call whose start it never saw once the dialogs read say it is in progress (a Gateway started mid-call)', () => {
    const { tracker, calls, events, clear } = make()
    tracker.seedDialogs([{ callid: 'old', state: 4, caller: '103', callee: '101', startedAt: '2026-10-14T18:33:20.000Z' }])
    clear()
    tracker.handle('E_ACC_CDR', cdr('old', '103', '101', 31, 1792002800, 30_500))
    expect(calls()).toEqual(['103:call.ended:outbound:101:ended', '101:call.ended:inbound:103:ended'])
    const c = (events[0]!.event.payload as { call: { connectedAt: string; endedAt: string } }).call
    expect(c.connectedAt).toBe('2026-10-14T18:33:20.000Z')
    expect(Date.parse(c.endedAt) - Date.parse(c.connectedAt)).toBe(30_500)
  })

  it('takes the answer and the length of a call from its CDR (time: answered; ms_duration after it), on OpenSIPS clock', () => {
    const { tracker, events, clear } = make()
    tracker.handle('E_TWAKEPHONE_CALLING', call(capturedCdr.callid, '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call(capturedCdr.callid, '101', '102'))
    tracker.handle('E_TWAKEPHONE_ANSWERED', call(capturedCdr.callid, '101', '102'))
    clear()
    tracker.handle('E_ACC_CDR', capturedCdr)
    const ended = events.filter(e => e.event.type === 'call.ended').map(e => (e.event.payload as { call: { connectedAt: string; endedAt: string } }).call)
    expect(ended).toHaveLength(2)
    // Answered at 18:31:49, over 3.012 s later: before the CDR arrived (18:31:53.019), as it should.
    for (const c of ended) expect(c).toMatchObject({ connectedAt: '2026-10-14T18:31:49.000Z', endedAt: '2026-10-14T18:31:52.012Z' })
    // Numbers given as strings, no milliseconds: the duration in seconds.
    tracker.handle('E_TWAKEPHONE_CALLING', call('c2', '101', '102'))
    clear()
    tracker.handle('E_ACC_CDR', { ...cdr('c2', '101', '102', 62, 1792002600), time: '1792002600', duration: '62', ms_duration: undefined })
    expect((events[0]!.event.payload as { call: { connectedAt: string; endedAt: string } }).call).toMatchObject({ connectedAt: '2026-10-14T18:30:00.000Z', endedAt: '2026-10-14T18:31:02.000Z' })
  })

  it('never brings an ended call back: a late RINGING, ANSWERED, CDR, dialog or second CALLING of the same Call-ID tells nothing', () => {
    const { tracker, events, clear } = make()
    for (const ext of ['101', '102']) tracker.handle('E_UL_CONTACT_INSERT', contact(ext, `sip:${ext}@x.invalid`))
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('c1', '101', '102', '487', 1792002800))
    clear()
    // UDP reorders: the RINGING of a forked branch, then an ANSWERED and a CDR, arrive after the MISSED.
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_ANSWERED', call('c1', '101', '102'))
    tracker.handle('E_ACC_CDR', cdr('c1', '101', '102', 3, 1792002801))
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    tracker.seedDialogs([{ callid: 'c1', state: 4, caller: '101', callee: '102' }])
    expect(events).toEqual([])
    expect(tracker.activeCalls()).toEqual([])
    expect(tracker.presenceOf('101').status).toBe('available')
    expect(tracker.presenceOf('102').status).toBe('available')
  })

  it('remembers a bounded number of ended calls', () => {
    const { tracker } = make()
    for (let i = 0; i < 10_050; i++) {
      tracker.handle('E_TWAKEPHONE_CALLING', call(`c${i}`, '101', '102'))
      tracker.handle('E_ACC_MISSED_EVENT', missed(`c${i}`, '101', '102', '480', 1792002800))
    }
    const ended = tracker['ended'] as Set<string>
    expect(ended.size).toBe(10_000)
    expect(ended.has('c49')).toBe(false)
    expect(ended.has('c50')).toBe(true)
  })

  it('keeps an extension busy while any of its calls lasts, and forgets the extensions back to plain offline', () => {
    const { tracker, presences, clear } = make()
    tracker.handle('E_TWAKEPHONE_CALLING', call('c1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_CALLING', call('c2', '101', '103'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('c2', '101', '103'))
    expect(presences()).toEqual(['101:busy', '103:busy'])
    clear()
    tracker.handle('E_ACC_MISSED_EVENT', missed('c1', '101', '102', '404', 1792002800))
    expect(presences()).toEqual([])
    expect(tracker.presenceOf('101').status).toBe('busy')
    tracker.handle('E_ACC_MISSED_EVENT', missed('c2', '101', '103', '486', 1792002801))
    // Neither is registered: offline, told once, then not kept.
    expect(presences()).toEqual(['101:offline', '103:offline'])
    expect([...tracker.presences().keys()]).toEqual([])
    expect((tracker['busy'] as Map<string, number>).size).toBe(0)
    // One who set a presence is kept.
    tracker.setUserPresence('104', { status: 'dnd', source: 'user' })
    expect([...tracker.presences().keys()]).toEqual(['104'])
  })

  it('drops a registration past its expiry when neither a refresh nor a deletion came, and keeps a refreshed one', () => {
    let t = Date.parse('2026-10-14T18:00:00.000Z')
    const told: string[] = []
    const tracker = new CallTracker((ext, e) => void (e.type === 'presence.changed' && told.push(`${ext}:${e.payload.presence.status}`)), () => new Date(t).toISOString())
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:a@x.invalid', t / 1000 + 60))
    tracker.handle('E_UL_CONTACT_INSERT', contact('102', 'sip:b@x.invalid', t / 1000 + 60))
    tracker.seedRegistrations([
      { aor: '101', contacts: [{ uri: 'sip:a@x.invalid', expiresAt: t + 60_000 }] },
      { aor: '102', contacts: [{ uri: 'sip:b@x.invalid', expiresAt: t + 60_000 }] },
      // No expiry known: kept until told otherwise.
      { aor: '103', contacts: ['sip:c@x.invalid'] }
    ])
    t += 30_000
    tracker.handle('E_UL_CONTACT_UPDATE', contact('102', 'sip:b@x.invalid', t / 1000 + 60))
    tracker.sweep()
    expect(told).toEqual(['101:available', '102:available', '103:available'])
    // A minute and a grace later: 101's tab was closed without unregistering, and the deletion never came.
    t += 45_000
    tracker.sweep()
    expect(told.slice(3)).toEqual(['101:offline'])
    expect(tracker.presenceOf('102').status).toBe('available')
    expect(tracker.presenceOf('103').status).toBe('available')
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
    expect(tracker.presenceOf('101').status).toBe('dnd')
    tracker.handle('E_TWAKEPHONE_RINGING', call('c1', '102', '101'))
    expect(tracker.presenceOf('101').status).toBe('busy')
    tracker.handle('E_ACC_MISSED_EVENT', missed('c1', '102', '101', '486', 1792002800))
    expect(tracker.presenceOf('101').status).toBe('dnd')
    expect(presences()).toEqual(['102:busy', '101:busy', '101:dnd', '102:offline'])
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
    // The subscription lapsed: the registrations are forgotten, the calls kept (busy is still true) until a
    // resync ends those OpenSIPS no longer has, with their history.
    tracker.reset()
    expect(presences()).toEqual([])
    expect(tracker.presenceOf('102').status).toBe('busy')
    tracker.seedRegistrations([])
    tracker.seedDialogs([])
    expect(calls()).toEqual(['103:call.ended:outbound:102:ended', '102:call.ended:inbound:103:ended'])
    expect(presences()).toEqual(['102:offline', '103:offline'])
  })

  it('only ends or removes in a resync what it knew before asking: what came while the answer was on its way is newer', () => {
    const { tracker, presences, calls, clear } = make()
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:a@x.invalid'))
    tracker.handle('E_TWAKEPHONE_CALLING', call('old', '101', '104'))
    const contacts = tracker.knownContacts()
    // 103 registers, 101 adds a window, while ul_dump's answer (taken before) is on its way.
    tracker.handle('E_UL_CONTACT_INSERT', contact('103', 'sip:c@x.invalid'))
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:b@x.invalid'))
    clear()
    tracker.seedRegistrations([{ aor: '102', contacts: ['sip:d@x.invalid'] }], contacts)
    expect(presences()).toEqual(['102:available'])
    expect(['101', '102', '103'].map(e => tracker.telephonyPresence(e))).toEqual(['busy', 'available', 'available'])
    const calls0 = tracker.knownCalls()
    tracker.handle('E_TWAKEPHONE_CALLING', call('new', '102', '103'))
    clear()
    tracker.seedDialogs([], calls0)
    // Only the call known before the question ends; the one that started meanwhile goes on.
    expect(calls()).toEqual(['101:call.ended:outbound:104:ended'])
    expect(tracker.activeCalls().map(c => c.id)).toEqual(['new'])
    // A resync deduced that end: no tombstone, the CDR that comes late still records the call (its history
    // keeps the first end).
    clear()
    tracker.handle('E_ACC_CDR', cdr('old', '101', '104', 3, 1792002800))
    expect(calls()).toEqual(['101:call.ended:outbound:104:ended', '104:call.ended:inbound:101:ended'])
  })

  it('reads every live dialog state: 1 calling, 2 ringing, 3 and 4 answered; 5 (deleted) is over', () => {
    const { tracker, calls, clear } = make()
    tracker.handle('E_TWAKEPHONE_CALLING', call('gone', '101', '102'))
    tracker.handle('E_TWAKEPHONE_CALLING', call('known', '101', '104'))
    clear()
    tracker.seedDialogs([
      { callid: 'gone', state: 5, caller: '101', callee: '102' },
      { callid: 'known', state: 3, caller: '101', callee: '104' },
      { callid: 'd1', state: 1, caller: '105', callee: '106' },
      { callid: 'd2', state: 2, caller: '107', callee: '108' },
      { callid: 'd3', state: 3, caller: '109', callee: '110', startedAt: '2026-10-14T17:59:00.000Z' }
    ])
    expect(calls()).toEqual([
      '101:call.ended:outbound:102:ended',
      '101:call.connected:outbound:104:connected',
      '104:call.connected:inbound:101:connected',
      '105:call.created:outbound:106:new',
      '107:call.ringing:outbound:108:ringing',
      '108:call.ringing:inbound:107:ringing',
      '109:call.connected:outbound:110:connected',
      '110:call.connected:inbound:109:connected'
    ])
    expect(tracker.activeCalls().map(c => `${c.id}:${c.state}`)).toEqual(['known:connected', 'd1:new', 'd2:ringing', 'd3:connected'])
    expect(['101', '104', '105', '106', '107', '108'].map(e => tracker.telephonyPresence(e))).toEqual(['busy', 'busy', 'busy', 'offline', 'busy', 'busy'])
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
    tracker2.sweep()
    expect(calls()).toEqual(['101:call.ended:outbound:102:ended'])
    expect(tracker2.activeCalls()).toEqual([])
  })

  it('follows a forwarded call: the caller sees the number dialled, each callee left behind a missed (or declined) call', () => {
    const { tracker, calls, presences, clear } = make()
    for (const ext of ['101', '102', '103', '104']) tracker.handle('E_UL_CONTACT_INSERT', contact(ext, `sip:${ext}@x.invalid`))
    clear()
    // 102 forwards everything to 103: the call goes there at once, the caller dialled 102.
    tracker.handle('E_TWAKEPHONE_CALLING', { ...call('f1', '101', '103'), dialled: '102' })
    tracker.handle('E_TWAKEPHONE_RINGING', call('f1', '101', '103'))
    expect(calls()).toEqual(['101:call.created:outbound:102:new', '101:call.ringing:outbound:102:ringing', '103:call.ringing:inbound:101:ringing'])
    clear()
    // 103 does not answer (408) and forwards to 104 on no answer: a missed call for 103, free again.
    tracker.handle('E_TWAKEPHONE_FORWARDED', { callid: 'f1', caller: '101', callee: '104', from: '103', code: '408' })
    expect(calls()).toEqual(['103:call.ended:inbound:101:missed'])
    expect(presences()).toEqual(['103:available'])
    clear()
    tracker.handle('E_TWAKEPHONE_RINGING', call('f1', '101', '104'))
    tracker.handle('E_TWAKEPHONE_ANSWERED', call('f1', '101', '104'))
    tracker.handle('E_ACC_CDR', cdr('f1', '101', '104', 4, 1792000805))
    expect(calls().filter(c => c.includes('ended'))).toEqual(['101:call.ended:outbound:102:ended', '104:call.ended:inbound:101:ended'])
    expect(tracker.activeCalls()).toEqual([])
    expect(['101', '103', '104'].map(e => tracker.telephonyPresence(e))).toEqual(['available', 'available', 'available'])
    clear()
    // Declined (603) then forwarded on busy: declined for the one who refused it.
    tracker.handle('E_TWAKEPHONE_CALLING', call('f2', '101', '102'))
    tracker.handle('E_TWAKEPHONE_RINGING', call('f2', '101', '102'))
    tracker.handle('E_TWAKEPHONE_FORWARDED', { callid: 'f2', caller: '101', callee: '103', from: '102', code: '603' })
    expect(calls().slice(-1)).toEqual(['102:call.ended:inbound:101:rejected'])
    clear()
    // Unreachable (it never rang): nothing for the one left; the same callee again changes nothing.
    tracker.handle('E_TWAKEPHONE_CALLING', call('f3', '101', '105'))
    tracker.handle('E_TWAKEPHONE_FORWARDED', { callid: 'f3', caller: '101', callee: '103', from: '105', code: '480' })
    tracker.handle('E_TWAKEPHONE_FORWARDED', { callid: 'f3', caller: '101', callee: '103', from: '103', code: '480' })
    expect(calls()).toEqual(['101:call.created:outbound:105:new'])
    expect(tracker.activeCalls().find(c => c.id === 'f3')).toMatchObject({ remoteNumber: '105' })
  })

  it('makes a call refused by a "do not disturb" a missed one for the callee, whose phone never rang, and a refused one for the caller', () => {
    const { tracker, calls, presences, clear } = make()
    for (const ext of ['101', '102']) tracker.handle('E_UL_CONTACT_INSERT', contact(ext, `sip:${ext}@x.invalid`))
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', call('d1', '101', '102'))
    tracker.handle('E_TWAKEPHONE_DND', call('d1', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('d1', '101', '102', '480', 1792002800))
    expect(calls()).toEqual(['101:call.created:outbound:102:new', '101:call.ended:outbound:102:rejected', '102:call.ended:inbound:101:missed'])
    // 102 was never busy with it.
    expect(presences()).toEqual(['101:busy', '101:available'])
    clear()
    // A plain 480 (nobody registered answers) stays a failed call for the caller only.
    tracker.handle('E_TWAKEPHONE_CALLING', call('d2', '101', '102'))
    tracker.handle('E_ACC_MISSED_EVENT', missed('d2', '101', '102', '480', 1792002801))
    expect(calls().slice(-1)).toEqual(['101:call.failed:outbound:102:failed'])
    // Forwarded to a colleague who does not want to be disturbed: a missed call for them, a failed one for the caller,
    // who was not told about their "do not disturb".
    clear()
    tracker.handle('E_UL_CONTACT_INSERT', contact('103', 'sip:103@x.invalid'))
    clear()
    tracker.handle('E_TWAKEPHONE_CALLING', { callid: 'd3', caller: '101', callee: '103', dialled: '102' })
    tracker.handle('E_TWAKEPHONE_DND', { callid: 'd3', caller: '101', callee: '103', dialled: '102', told: '0' })
    tracker.handle('E_ACC_MISSED_EVENT', missed('d3', '101', '103', '480', 1792002802))
    expect(calls()).toEqual(['101:call.created:outbound:102:new', '101:call.failed:outbound:102:failed', '103:call.ended:inbound:101:missed'])
    // Unknown calls are left alone.
    clear()
    tracker.handle('E_TWAKEPHONE_DND', { callid: 'nope' })
    tracker.handle('E_TWAKEPHONE_FORWARDED', { callid: 'nope' })
    expect(calls()).toEqual([])
  })

  it('ends what the user chose at its date: told when it comes, never in force after it', () => {
    let t = Date.parse('2026-10-14T18:00:00.000Z')
    const told: string[] = []
    const tracker = new CallTracker((ext, e) => void (e.type === 'presence.changed' && told.push(`${ext}:${e.payload.presence.status}`)), () => new Date(t).toISOString())
    tracker.handle('E_UL_CONTACT_INSERT', contact('101', 'sip:a@x.invalid'))
    tracker.handle('E_UL_CONTACT_INSERT', contact('102', 'sip:b@x.invalid'))
    tracker.setUserPresence('101', { status: 'dnd', source: 'user', until: new Date(t + 60_000).toISOString(), message: 'En réunion' })
    tracker.setUserPresence('102', { status: 'away', source: 'user', until: new Date(t + 30_000).toISOString() })
    tracker.setUserPresence('103', { status: 'dnd', source: 'user' })
    // 103 is not registered: offline, whatever it chose, until it is.
    expect(told).toEqual(['101:available', '102:available', '101:dnd', '102:away', '103:offline'])
    expect(tracker.presenceOf('101')).toMatchObject({ status: 'dnd', message: 'En réunion' })
    expect(tracker.nextUserPresenceEnd()).toBe(t + 30_000)
    expect([...tracker.userPresences().keys()]).toEqual(['101', '102', '103'])
    t += 30_000
    // Past its end it no longer holds, even before anything tells it.
    expect(tracker.presenceOf('102').status).toBe('available')
    expect([...tracker.userPresences().keys()]).toEqual(['101', '103'])
    tracker.expire()
    expect(told.slice(5)).toEqual(['102:available'])
    expect(tracker.nextUserPresenceEnd()).toBe(t + 30_000)
    t += 30_000
    tracker.sweep()
    expect(told.slice(6)).toEqual(['101:available'])
    expect(tracker.nextUserPresenceEnd()).toBeUndefined()
    // A choice whose end already passed is not taken; one cleared is forgotten.
    tracker.setUserPresence('102', { status: 'dnd', source: 'user', until: new Date(t - 1).toISOString() })
    expect(tracker.presenceOf('102').status).toBe('available')
    tracker.clearUserPresence('103')
    tracker.clearUserPresence('103')
    expect([...tracker.userPresences().keys()]).toEqual([])
    expect(told.slice(7)).toEqual([])
    // A new message for the same choice is told.
    tracker.setUserPresence('101', { status: 'dnd', source: 'user', message: 'En réunion' })
    tracker.setUserPresence('101', { status: 'dnd', source: 'user', message: 'En rendez-vous' })
    expect(told.slice(7)).toEqual(['101:dnd', '101:dnd'])
  })
})
