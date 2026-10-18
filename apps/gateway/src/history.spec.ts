import { describe, expect, it } from 'vitest'
import { historyEntryFor } from './history.js'

const ended = (call: object, type = 'call.ended') => ({ type, timestamp: '2026-10-05T10:05:00.000Z', payload: { call } }) as never

describe('historyEntryFor', () => {
  it('computes talk time from the moment the call was answered', () => {
    const e = historyEntryFor('A', 'alice', ended({ id: 'c', direction: 'inbound', state: 'ended', remoteNumber: '102', startedAt: '2026-10-05T10:00:00.000Z', connectedAt: '2026-10-05T10:01:00.000Z', endedAt: '2026-10-05T10:05:00.000Z' }))
    expect(e).toMatchObject({ tenantId: 'A', userId: 'alice', answered: true, durationSec: 240 })
  })

  it('says a conference\'s call is one (step 8b), and nothing of it for the others', () => {
    const call = { id: 'c', direction: 'inbound', state: 'ended', remoteNumber: '101', startedAt: '2026-10-05T10:00:00.000Z', connectedAt: '2026-10-05T10:00:01.000Z' }
    expect(historyEntryFor('A', 'bob', ended({ ...call, conference: true }))).toMatchObject({ conference: true, remoteNumber: '101' })
    expect(historyEntryFor('A', 'bob', ended(call))).not.toHaveProperty('conference')
  })

  it('says a call a mailbox took is one (step 11a): answered for the caller, missed for the person called', () => {
    const call = { id: 'c', remoteNumber: '102', startedAt: '2026-10-05T10:00:00.000Z', voicemail: true }
    expect(historyEntryFor('A', 'alice', ended({ ...call, direction: 'outbound', state: 'ended', connectedAt: '2026-10-05T10:04:50.000Z' }))).toMatchObject({ voicemail: true, answered: true, durationSec: 10 })
    expect(historyEntryFor('A', 'bob', ended({ ...call, direction: 'inbound', state: 'missed' }))).toMatchObject({ voicemail: true, answered: false, state: 'missed' })
    expect(historyEntryFor('A', 'bob', ended({ id: 'd', direction: 'inbound', state: 'missed', remoteNumber: '101' }))).not.toHaveProperty('voicemail')
  })

  it('records an unanswered call with no duration', () => {
    const e = historyEntryFor('A', 'alice', ended({ id: 'c', direction: 'inbound', state: 'missed', remoteNumber: '102' }))
    expect(e).toMatchObject({ answered: false, durationSec: 0, state: 'missed' })
  })

  it('ignores events that are not the end of a call, or calls without a number', () => {
    expect(historyEntryFor('A', 'a', { type: 'call.ringing', timestamp: 'T', payload: { call: {} } } as never)).toBeNull()
    expect(historyEntryFor('A', 'a', ended({ id: 'c', direction: 'inbound', state: 'ended', remoteNumber: '' }))).toBeNull()
  })
})
