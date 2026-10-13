import { describe, expect, it } from 'vitest'
import type { TelephonyEvent } from '@twake/telephony-types'
import type { AriChannel, AriEvent } from './ari.js'
import { CallTracker, extensionOf } from './tracker.js'

const ch = (id: string, name: string, state: string, caller = '', exten = ''): AriChannel => ({
  id,
  name,
  state,
  caller: { name: '', number: caller },
  connected: { name: '', number: '' },
  dialplan: { context: 'minipbx-internal', exten }
})

const setup = () => {
  const events: { ext: string; event: TelephonyEvent }[] = []
  const tracker = new CallTracker((ext, event) => events.push({ ext, event }), () => 'T')
  const run = (...es: AriEvent[]) => es.forEach(e => tracker.handle(e))
  const types = (ext: string) => events.filter(e => e.ext === ext).map(e => e.event.type)
  return { events, tracker, run, types }
}

describe('extensionOf', () => {
  it('extracts the extension of a user leg and ignores trunk legs', () => {
    expect(extensionOf('PJSIP/101-0000000a')).toBe('101')
    expect(extensionOf('PJSIP/trunk-main-0000000a')).toBeNull()
    expect(extensionOf('Local/foo@bar-0001;1')).toBeNull()
  })
})

describe('CallTracker', () => {
  it('reports an internal call from both sides with the right direction and numbers', () => {
    const { run, types, events } = setup()
    const a = ch('a', 'PJSIP/101-00000001', 'Ring', '101', '102')
    const b = ch('b', 'PJSIP/102-00000002', 'Down', '101')
    run(
      { type: 'ChannelCreated', channel: a },
      { type: 'ChannelCreated', channel: b },
      { type: 'Dial', caller: a, peer: b, dialstatus: '' },
      { type: 'ChannelStateChange', channel: { ...b, state: 'Ringing' } },
      { type: 'ChannelStateChange', channel: { ...b, state: 'Up' } },
      { type: 'ChannelStateChange', channel: { ...a, state: 'Up' } },
      { type: 'ChannelDestroyed', channel: b, cause: 16 },
      { type: 'ChannelDestroyed', channel: a, cause: 16 }
    )
    expect(types('101')).toContain('call.created')
    expect(types('102')).toEqual(
      expect.arrayContaining(['call.created', 'call.ringing', 'call.connected', 'call.ended'])
    )
    const created = events.find(e => e.ext === '102' && e.event.type === 'call.created')!.event
    expect(created.type === 'call.created' && created.payload.call).toMatchObject({
      direction: 'inbound',
      remoteNumber: '101'
    })
    const out = events.find(e => e.ext === '101' && e.event.type === 'call.created')!.event
    expect(out.type === 'call.created' && out.payload.call).toMatchObject({ direction: 'outbound', remoteNumber: '102' })
  })

  it('marks an unanswered inbound call as missed, and a busy one as rejected', () => {
    const { run, events } = setup()
    const b = ch('b', 'PJSIP/102-00000002', 'Down', '101')
    const a = ch('a', 'PJSIP/101-00000001', 'Ring', '101', '102')
    run({ type: 'ChannelCreated', channel: a }, { type: 'ChannelCreated', channel: b }, { type: 'Dial', caller: a, peer: b, dialstatus: '' })
    run({ type: 'ChannelDestroyed', channel: b, cause: 19 })
    const ended = events.filter(e => e.ext === '102' && e.event.type === 'call.ended').at(-1)!.event
    expect(ended.type === 'call.ended' && ended.payload.call.state).toBe('missed')
  })

  it('derives presence: busy during a call, back to available afterwards, dnd from device state', () => {
    const { run, tracker, events } = setup()
    const b = ch('b', 'PJSIP/102-00000002', 'Down', '101')
    const a = ch('a', 'PJSIP/101-00000001', 'Ring', '101', '102')
    run({ type: 'ChannelCreated', channel: a }, { type: 'ChannelCreated', channel: b }, { type: 'Dial', caller: a, peer: b, dialstatus: '' })
    run({ type: 'ChannelStateChange', channel: { ...b, state: 'Up' } })
    expect(tracker.getPresence('102')).toMatchObject({ status: 'busy', source: 'telephony' })
    run({ type: 'ChannelDestroyed', channel: b, cause: 16 })
    expect(tracker.getPresence('102').status).toBe('available')
    run({ type: 'DeviceStateChanged', device_state: { name: 'Stasis:dnd102', state: 'BUSY' } })
    expect(tracker.getPresence('102')).toMatchObject({ status: 'dnd', source: 'user' })
    run({ type: 'DeviceStateChanged', device_state: { name: 'PJSIP/103', state: 'UNAVAILABLE' } })
    expect(tracker.getPresence('103').status).toBe('offline')
    expect(events.filter(e => e.event.type === 'presence.changed').length).toBeGreaterThan(2)
  })

  it('uses hints for legs created through originate', () => {
    const { run, events, tracker } = setup()
    tracker.hint('call-1', { direction: 'outbound', remoteNumber: '102' })
    run({ type: 'ChannelCreated', channel: ch('call-1', 'PJSIP/101-00000009', 'Down', '101') })
    const created = events.find(e => e.event.type === 'call.created')!.event
    expect(created.type === 'call.created' && created.payload.call).toMatchObject({ id: 'call-1', direction: 'outbound', remoteNumber: '102' })
  })
})

describe('CallTracker connectedAt', () => {
  it('stamps when the call was answered, and only then', () => {
    const { run, events } = setup()
    const a = ch('a', 'PJSIP/101-00000001', 'Ring', '101', '102')
    run({ type: 'ChannelCreated', channel: a }, { type: 'ChannelStateChange', channel: { ...a, state: 'Up' } }, { type: 'ChannelDestroyed', channel: a, cause: 16 })
    const ended = events.find(e => e.event.type === 'call.ended')!.event
    expect(ended.type === 'call.ended' && ended.payload.call.connectedAt).toBe('T')
    const m = ch('m', 'PJSIP/103-00000003', 'Down', '101')
    run({ type: 'ChannelCreated', channel: m }, { type: 'ChannelDestroyed', channel: m, cause: 19 })
    const missed = events.filter(e => e.ext === '103' && e.event.type === 'call.ended').at(-1)?.event
    expect(missed && missed.type === 'call.ended' && missed.payload.call.connectedAt).toBeUndefined()
  })
})

describe('CallTracker hold', () => {
  it('reports hold and resume on the call of the user who asked', () => {
    const { run, tracker, events } = setup()
    tracker.hint('c1', { direction: 'outbound', remoteNumber: '102' })
    const a = ch('c1', 'PJSIP/101-00000001', 'Down', '101', '102')
    run({ type: 'ChannelCreated', channel: a }, { type: 'ChannelStateChange', channel: { ...a, state: 'Up' } })
    tracker.markHeld('c1', true)
    tracker.markHeld('c1', false)
    expect(events.filter(e => e.ext === '101').map(e => e.event.type)).toEqual(
      expect.arrayContaining(['call.connected', 'call.held', 'call.resumed'])
    )
  })
})

describe('CallTracker through Local channels', () => {
  it('labels the phone dialled by a Local channel with the direction and number given for that call', () => {
    const { run, events, tracker } = setup()
    tracker.hintLocal('Local/104@twake-ring-0000001c', { direction: 'outbound', remoteNumber: '105', callId: 'call-1' })
    const local2 = ch('l2', 'Local/104@twake-ring-0000001c;2', 'Ring', '104', '104')
    const phone = ch('p', 'PJSIP/104-00000030', 'Down', '104')
    run({ type: 'ChannelCreated', channel: phone }, { type: 'Dial', caller: local2, peer: phone, dialstatus: '' })
    const created = events.find(e => e.ext === '104' && e.event.type === 'call.created')!.event
    expect(created.type === 'call.created' && created.payload.call).toMatchObject({ id: 'call-1', direction: 'outbound', remoteNumber: '105' })
    // The API id works for actions that address the call, e.g. hold.
    run({ type: 'ChannelStateChange', channel: { ...phone, state: 'Up' } })
    tracker.markHeld('call-1', true)
    expect(events.some(e => e.ext === '104' && e.event.type === 'call.held')).toBe(true)
  })

  it('does not treat the Local channel itself as a user call', () => {
    const { run, events, tracker } = setup()
    tracker.hintLocal('Local/105@twake-ring-0000001d', { direction: 'inbound', remoteNumber: '104' })
    const local2 = ch('l2', 'Local/105@twake-ring-0000001d;2', 'Ring', '104', '105')
    run({ type: 'ChannelCreated', channel: local2 })
    expect(events).toHaveLength(0)
  })
})

describe('CallTracker direction from the Dial event', () => {
  it('does not mistake a phone dialled through Local for an outgoing call, even when its channel carries its own number', () => {
    const { run, events, tracker } = setup()
    tracker.hintLocal('Local/105@twake-ring-0000001e', { direction: 'inbound', remoteNumber: '104' })
    const local2 = ch('l2', 'Local/105@twake-ring-0000001e;2', 'Ring', '104', '105')
    // What ARI really sends: the phone's channel says caller=105 (itself); the Dial event tells who is calling.
    const phone = ch('p', 'PJSIP/105-00000031', 'Down', '105')
    run({ type: 'ChannelCreated', channel: phone }, { type: 'Dial', caller: local2, peer: phone, dialstatus: '' }, { type: 'ChannelStateChange', channel: { ...phone, state: 'Ringing' } })
    const created = events.find(e => e.ext === '105' && e.event.type === 'call.created')!.event
    expect(created.type === 'call.created' && created.payload.call).toMatchObject({ direction: 'inbound', remoteNumber: '104' })
  })
})
