import { describe, expect, it } from 'vitest'
import type { ConferenceParticipant } from '@twake/telephony-types'
import { conferenceMade, conferenceOver } from './conferences.js'

const ROOM = 'twake-call-0123456789abcdef'
const party = (name: string): ConferenceParticipant => ({ id: `${ROOM}:${name}`, meetingId: ROOM, kind: 'phone', displayName: name, muted: false })

describe('the conferences a window made (step 8b)', () => {
  it('keeps the room and the two parties POST /calls/:id/conference answered, by the call that became it, until its room call ends', () => {
    const made = conferenceMade({}, 'first-call', { meetingId: ROOM, participants: [party('Alice'), party('Jean')] })
    expect(made).toEqual({ 'first-call': { meetingId: ROOM, parties: [party('Alice'), party('Jean')] } })
    const two = conferenceMade(made, 'other-call', { meetingId: 'twake-call-00000000000000aa', participants: [] })
    expect(Object.keys(two)).toEqual(['first-call', 'other-call'])
    expect(conferenceOver(two, 'first-call')).toEqual({ 'other-call': { meetingId: 'twake-call-00000000000000aa', parties: [] } })
    // Another call's end leaves it as it is.
    expect(conferenceOver(made, 'not-one')).toBe(made)
  })
})
