import { describe, expect, it } from 'vitest'
import { historyEntryFor } from './history.js'

const ended = (call: object, type = 'call.ended') => ({ type, timestamp: '2026-10-05T10:05:00.000Z', payload: { call } }) as never

describe('historyEntryFor', () => {
  it('computes talk time from the moment the call was answered', () => {
    const e = historyEntryFor('A', 'alice', ended({ id: 'c', direction: 'inbound', state: 'ended', remoteNumber: '102', startedAt: '2026-10-05T10:00:00.000Z', connectedAt: '2026-10-05T10:01:00.000Z', endedAt: '2026-10-05T10:05:00.000Z' }))
    expect(e).toMatchObject({ tenantId: 'A', userId: 'alice', answered: true, durationSec: 240 })
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
