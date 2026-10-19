import type { CallConference } from '@twake/telephony-client'
import type { ConferenceParticipant } from '@twake/telephony-types'

/** A conference this window made (step 8b): its room, and the participants it began with (the two parties). */
export interface MadeConference {
  meetingId: string
  parties: ConferenceParticipant[]
  /** A call with the operator (step 8c): the number the room called again, and the third participant to call once the person confirms. */
  awaiting?: { number: string; third: string; call: string }
}

/** The conferences this window made, by the call that became each one. */
export type MadeConferences = Readonly<Record<string, MadeConference>>

/** Our call `callId` became the conference POST /calls/:id/conference answered: its room and who it began with. */
export const conferenceMade = (made: MadeConferences, callId: string, answer: CallConference, third = '', call = ''): MadeConferences => ({
  ...made,
  [callId]: { meetingId: answer.meetingId, parties: answer.participants, ...(answer.awaiting ? { awaiting: { number: answer.awaiting, third, call } } : {}) }
})

/** The person confirmed (or the wait is over): the conference no longer waits for them. */
export const conferenceConfirmed = (made: MadeConferences, callId: string): MadeConferences => {
  const c = made[callId]
  if (!c?.awaiting) return made
  const { awaiting: _, ...rest } = c
  return { ...made, [callId]: rest }
}

/** The conference made out of our call `callId` is over for this window (its room's call ended): forgotten. */
export const conferenceOver = (made: MadeConferences, callId: string): MadeConferences => {
  if (!(callId in made)) return made
  const { [callId]: _, ...rest } = made
  return rest
}
