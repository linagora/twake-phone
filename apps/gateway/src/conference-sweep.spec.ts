import { describe, expect, it } from 'vitest'
import { sweepDialIns } from './conference-sweep.js'
import { MemoryStore } from './store/memory.js'

describe('sweepDialIns', () => {
  it('deletes at start the rules that let in no room the Gateway serves, and only those (third review n°4)', async () => {
    const store = new MemoryStore()
    const room = (meetingId: string, pin?: string) =>
      store.claimConference({ tenantId: 'dev', meetingId, ownerUserId: 'alice', createdAt: '2026-10-01T00:00:00.000Z' }).then(() => (pin ? store.setConferencePin(meetingId, pin) : undefined))
    await room('twake-0123456789abcdef', '1234567890')
    await room('twake-00000000000000aa', '123456')
    await room('abc-defg-hij', '2345678901')
    await room('twake-00000000000000bb', '3456789012')
    const rules = [
      { meetingId: 'twake-0123456789abcdef', pin: '1234567890' },
      // Left by two Gateways drawing at once.
      { meetingId: 'twake-0123456789abcdef', pin: '9999999999' },
      // 6 digits, before the PINs were drawn from crypto.
      { meetingId: 'twake-00000000000000aa', pin: '123456' },
      // Claimed by its name before the Gateway named the rooms.
      { meetingId: 'abc-defg-hij', pin: '2345678901' },
      // Closed while LiveKit was away.
      { meetingId: 'twake-00000000000000cc', pin: '4567890123' },
      { meetingId: 'twake-00000000000000cc', pin: '4567890123' },
      { meetingId: 'twake-00000000000000bb', pin: '3456789012' }
    ]
    const drops: string[] = []
    const bridge = {
      listDialIns: async () => rules,
      dropDialIn: async (meetingId: string, pin: string) => void drops.push(`${meetingId} ${pin}`)
    }
    const dropped = await sweepDialIns(bridge, store)
    expect(drops).toEqual(['twake-0123456789abcdef 9999999999', 'twake-00000000000000aa 123456', 'abc-defg-hij 2345678901', 'twake-00000000000000cc 4567890123'])
    // Logged without the PINs.
    expect(dropped).toEqual(['twake-0123456789abcdef 10', 'twake-00000000000000aa 6', 'abc-defg-hij 10', 'twake-00000000000000cc 10'])
    // The records stay: a short PIN is drawn again at the next read.
    expect((await store.getConference('twake-00000000000000aa'))?.pin).toBe('123456')
  })
})
