import { describe, expect, it } from 'vitest'
import type { Voicemail } from '@twake/telephony-types'
import { applyVoicemailEvent, clock } from './Voicemail.js'

const v = (id: string, receivedAt: string, unread = true): Voicemail => ({ id, from: '101', receivedAt, durationSec: 7, unread })
const at = '2026-10-18T02:12:07.000Z'

describe('the Messagerie', () => {
  it('puts a new message first, once, and changes or removes one in place', () => {
    const items = [v('b', '2026-10-18T02:00:00.000Z'), v('a', '2026-10-18T01:00:00.000Z')]
    const created = applyVoicemailEvent(items, { type: 'voicemail.created', timestamp: at, payload: { voicemail: v('c', '2026-10-18T02:12:04.000Z') } })
    expect(created.map(i => i.id)).toEqual(['c', 'b', 'a'])
    // Told twice (the list read while the event was on its way): still once.
    expect(applyVoicemailEvent(created, { type: 'voicemail.created', timestamp: at, payload: { voicemail: v('c', '2026-10-18T02:12:04.000Z') } }).map(i => i.id)).toEqual(['c', 'b', 'a'])
    const read = applyVoicemailEvent(created, { type: 'voicemail.updated', timestamp: at, payload: { voicemail: v('b', '2026-10-18T02:00:00.000Z', false) } })
    expect(read.map(i => [i.id, i.unread])).toEqual([['c', true], ['b', false], ['a', true]])
    expect(applyVoicemailEvent(read, { type: 'voicemail.deleted', timestamp: at, payload: { id: 'b' } }).map(i => i.id)).toEqual(['c', 'a'])
    // Any other event changes nothing.
    expect(applyVoicemailEvent(items, { type: 'stream.ready' } as never)).toBe(items)
  })

  it('says how long a message lasts as a clock does', () => {
    expect([clock(0), clock(7), clock(75), clock(600)]).toEqual(['0:00', '0:07', '1:15', '10:00'])
  })
})
