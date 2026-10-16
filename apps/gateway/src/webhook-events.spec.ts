import { describe, expect, it } from 'vitest'
import type { Call, TelephonyEvent } from '@twake/telephony-types'
import { eventId, presenceEvent, webhookEventsFor } from './webhook-events.js'

const at = '2026-10-16T10:00:05.000Z'
const call = (over: Partial<Call> = {}): Call => ({ id: 'a84b4c76e66710@192.0.2.10', direction: 'inbound', state: 'ringing', remoteNumber: '101', startedAt: '2026-10-16T10:00:00.000Z', ...over })
const ev = (type: 'call.created' | 'call.ringing' | 'call.connected' | 'call.held' | 'call.ended' | 'call.failed', c: Call): TelephonyEvent => ({ type, timestamp: at, payload: { call: c } })

describe('the public events of a call', () => {
  it('tells it ringing then answered then ended for the person, with the two numbers as they called', () => {
    expect(webhookEventsFor('acme', 'jdupont', '102', ev('call.ringing', call()))).toEqual([
      {
        id: eventId('acme', 'call.ringing', 'a84b4c76e66710@192.0.2.10', 'jdupont'),
        type: 'call.ringing',
        occurred_at: at,
        tenant: 'acme',
        call: { id: 'a84b4c76e66710@192.0.2.10', direction: 'inbound', from: '101', to: '102', user: 'jdupont', extension: '102', started_at: '2026-10-16T10:00:00.000Z', source: ['opensips'] }
      }
    ])
    const answered = call({ state: 'connected', connectedAt: '2026-10-16T10:00:03.000Z' })
    expect(webhookEventsFor('acme', 'jdupont', '102', ev('call.connected', answered)).map(e => [e.type, 'call' in e && e.call.answered_at])).toEqual([['call.answered', '2026-10-16T10:00:03.000Z']])
    const ended = webhookEventsFor('acme', 'jdupont', '102', ev('call.ended', { ...answered, state: 'ended', endedAt: '2026-10-16T10:01:05.400Z' }))
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ type: 'call.ended', call: { outcome: 'answered', duration_sec: 62, ended_at: '2026-10-16T10:01:05.400Z' } })
  })

  it('writes an outbound call from the extension to the number called', () => {
    const [e] = webhookEventsFor('acme', 'amartin', '101', ev('call.ringing', call({ direction: 'outbound', remoteNumber: '+33199001234' })))
    expect(e).toMatchObject({ call: { direction: 'outbound', from: '101', to: '+33199001234' } })
  })

  it('adds a missed call to an inbound call that ended unanswered, never to a declined, a failed or an outbound one', () => {
    const missed = webhookEventsFor('acme', 'jdupont', '102', ev('call.ended', call({ state: 'missed', endedAt: at })))
    expect(missed.map(e => e.type)).toEqual(['call.ended', 'call.missed'])
    expect(missed[1]).toMatchObject({ id: eventId('acme', 'call.missed', 'a84b4c76e66710@192.0.2.10', 'jdupont'), call: { from: '101', to: '102', user: 'jdupont', outcome: 'missed', duration_sec: 0 } })
    expect(webhookEventsFor('acme', 'jdupont', '102', ev('call.ended', call({ state: 'rejected', endedAt: at }))).map(e => [e.type, 'call' in e && e.call.outcome])).toEqual([['call.ended', 'declined']])
    expect(webhookEventsFor('acme', 'jdupont', '102', ev('call.failed', call({ state: 'failed', endedAt: at }))).map(e => [e.type, 'call' in e && e.call.outcome])).toEqual([['call.ended', 'failed']])
    expect(webhookEventsFor('acme', 'amartin', '101', ev('call.ended', call({ direction: 'outbound', state: 'missed', endedAt: at }))).map(e => e.type)).toEqual(['call.ended'])
  })

  it('gives an event the same id whichever Gateway hears it, another to each person and type', () => {
    const a = webhookEventsFor('acme', 'jdupont', '102', ev('call.ended', call({ state: 'missed', endedAt: at })))
    const b = webhookEventsFor('acme', 'jdupont', '102', ev('call.ended', call({ state: 'missed', endedAt: '2026-10-16T10:00:05.020Z' })))
    expect(a.map(e => e.id)).toEqual(b.map(e => e.id))
    expect(a[0]!.id).not.toBe(a[1]!.id)
    expect(webhookEventsFor('acme', 'amartin', '101', ev('call.ringing', call()))[0]!.id).not.toBe(webhookEventsFor('acme', 'jdupont', '102', ev('call.ringing', call()))[0]!.id)
    expect(webhookEventsFor('other', 'jdupont', '102', ev('call.ringing', call()))[0]!.id).not.toBe(webhookEventsFor('acme', 'jdupont', '102', ev('call.ringing', call()))[0]!.id)
    expect(a[0]!.id).toMatch(/^evt_[0-9a-f]{32}$/)
  })

  it('tells nothing of what is internal: a call created, held, a wake, a call taken by a colleague', () => {
    expect(webhookEventsFor('acme', 'jdupont', '102', ev('call.created', call()))).toEqual([])
    expect(webhookEventsFor('acme', 'jdupont', '102', ev('call.held', call()))).toEqual([])
    expect(webhookEventsFor('acme', 'jdupont', '102', { type: 'call.wake', timestamp: at, payload: { call: call(), waitSec: 10 } })).toEqual([])
    expect(webhookEventsFor('acme', 'jdupont', '102', { type: 'call.taken', timestamp: at, payload: { call: call(), by: '103' } })).toEqual([])
  })

  it('says a call of a conference as such', () => {
    expect(webhookEventsFor('acme', 'jdupont', '102', ev('call.ringing', call({ conference: true })))[0]).toMatchObject({ call: { conference: true } })
  })
})

describe('the public event of a presence', () => {
  it('carries the status only, never the message', () => {
    const e = presenceEvent('acme', 'jdupont', '102', 'dnd', at)
    expect(e).toEqual({ id: expect.stringMatching(/^evt_[0-9a-f]{32}$/), type: 'presence.changed', occurred_at: at, tenant: 'acme', presence: { user: 'jdupont', extension: '102', status: 'dnd' } })
    expect(presenceEvent('acme', 'jdupont', undefined, 'available', at)).not.toHaveProperty('presence.extension')
  })
})
