import { mergeHistory, toHistoryEntry } from './history'

describe('history', () => {
  it('marks an inbound call that was never answered as missed', () => {
    const entry = toHistoryEntry({
      id: 'a',
      direction: 'inbound',
      remoteNumber: '102',
      startedAt: 1000,
      endedAt: 5000
    })
    expect(entry).toMatchObject({
      missed: true,
      durationSec: 0,
      answered: false
    })
  })

  it('computes the talk time of an answered call', () => {
    const entry = toHistoryEntry({
      id: 'a',
      direction: 'outbound',
      remoteNumber: '102',
      startedAt: 0,
      connectedAt: 2000,
      endedAt: 66000
    })
    expect(entry).toMatchObject({
      missed: false,
      durationSec: 64,
      answered: true
    })
  })

  it('merges server and local entries by call id, the server winning, newest first', () => {
    const merged = mergeHistory(
      [
        { id: 'a', startedAt: '2026-10-05T10:00:00.000Z', durationSec: 1 },
        { id: 'c', startedAt: '2026-10-05T12:00:00.000Z' }
      ],
      [
        { id: 'a', startedAt: '2026-10-05T10:00:00.000Z', durationSec: 60 },
        { id: 'b', startedAt: '2026-10-05T11:00:00.000Z' }
      ]
    )
    expect(merged.map(e => e.id)).toEqual(['c', 'b', 'a'])
    expect(merged.find(e => e.id === 'a').durationSec).toBe(60)
  })
})
