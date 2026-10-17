// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoftCall } from '@twake/softphone'
import type { ConferenceParticipant } from '@twake/telephony-types'
import type { useGateway } from './gateway.js'
import { SoftphoneProvider, usePhone, type Phone } from './softphone.js'

type Gateway = ReturnType<typeof useGateway>
// What the provider's softphone was given (its callbacks), and the call of the room it has for our call, if any.
let softphoneOptions: { onCallChange: (call: SoftCall) => void } | undefined
let roomCall: SoftCall | undefined
vi.mock('@twake/softphone', () => ({
  Softphone: class {
    constructor(options: { onCallChange: (call: SoftCall) => void }) {
      softphoneOptions = options
    }
    start = async () => undefined
    stop = async () => undefined
    activeCalls = () => []
    expectConference = () => 'token'
    cancelConference = () => undefined
    conferenceCall = (callId: string) => (roomCall?.conferenceOf === callId ? roomCall : undefined)
  }
}))
let gateway: Pick<Gateway, 'client' | 'me'>
vi.mock('./gateway.js', () => ({ useGateway: () => gateway }))
vi.mock('./auth/AuthProvider.js', () => ({ useAuth: () => ({ state: { status: 'signed-out' } }) }))
vi.mock('./auth/oidc.js', () => ({ displayNameFor: () => 'Alice' }))

const ROOM = 'twake-call-0123456789abcdef'
const parties: ConferenceParticipant[] = [
  { id: `${ROOM}:phone-a`, meetingId: ROOM, kind: 'phone', number: '101', muted: false },
  { id: `${ROOM}:phone-b`, meetingId: ROOM, kind: 'phone', number: '102', muted: false }
]
const first = { id: 'first-call', sipCallId: 'a1b2@192.0.2.30', state: 'connected' } as SoftCall
const theRoomsCall = { id: 'room-call', state: 'connected', room: 'conference', conferenceOf: 'first-call' } as SoftCall

describe('SoftphoneProvider, the conferences this window made (third review of the conference notice, n°3 and n°4)', () => {
  let root: Root
  let host: HTMLDivElement
  let actEnvironment: unknown
  let phone: Phone
  let inviteByPhone: ReturnType<typeof vi.fn>
  const Probe = () => {
    phone = usePhone()
    return null
  }

  beforeEach(async () => {
    actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    softphoneOptions = undefined
    roomCall = undefined
    inviteByPhone = vi.fn(async () => undefined)
    const client: Partial<Gateway['client']> = {
      getCapabilities: vi.fn(async () => ({}) as Awaited<ReturnType<Gateway['client']['getCapabilities']>>),
      makeConference: vi.fn(async () => ({ meetingId: ROOM, participants: parties })),
      inviteByPhone
    }
    gateway = { client: client as Gateway['client'], me: { id: 'u1', displayName: 'Alice', extension: '101' } }
    host = document.createElement('div')
    root = createRoot(host)
    await act(async () => {
      root.render(
        <SoftphoneProvider>
          <Probe />
        </SoftphoneProvider>
      )
    })
    expect(softphoneOptions).toBeDefined()
  })
  afterEach(() => {
    act(() => root.unmount())
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = actEnvironment
  })

  it("keeps the room of the conference it made and who it began with, until the room's call ends", async () => {
    roomCall = theRoomsCall
    await act(() => phone.addParticipant(first, '103'))
    expect(phone.rooms).toEqual({ 'first-call': ROOM })
    expect(phone.parties).toEqual({ 'first-call': parties })
    expect(inviteByPhone).toHaveBeenCalledWith(ROOM, '103')
    // Another call ending changes nothing.
    act(() => softphoneOptions!.onCallChange({ id: 'other-call', state: 'ended' } as SoftCall))
    expect(phone.rooms).toEqual({ 'first-call': ROOM })
    // The room's call ends: the conference is no longer this window's.
    roomCall = undefined
    act(() => softphoneOptions!.onCallChange({ ...theRoomsCall, state: 'ended' }))
    expect(phone.rooms).toEqual({})
    expect(phone.parties).toEqual({})
  })

  it("keeps nothing of a conference whose room's call ended while it began (its end already told)", async () => {
    // The person hung up during POST /calls/:id/conference: the room's call to this window is over already.
    await act(() => phone.addParticipant(first, '103'))
    expect(phone.rooms).toEqual({})
    expect(phone.parties).toEqual({})
    expect(inviteByPhone).not.toHaveBeenCalled()
  })
})
