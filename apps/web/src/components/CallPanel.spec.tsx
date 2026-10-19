// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoftCall } from '@twake/softphone'
import type { ConferenceParticipant } from '@twake/telephony-types'
import type { useGateway } from '../gateway.js'
import type { usePhone } from '../softphone.js'
import { CallPanel, PARTICIPANTS_EVERY_MS } from './CallPanel.js'

type Gateway = ReturnType<typeof useGateway>
type Phone = ReturnType<typeof usePhone>
// What useGateway() and usePhone() hand the panel, set by each test before it renders.
let gateway: Pick<Gateway, 'client' | 'me'>
let phone: Pick<Phone, 'calls' | 'lastEnded' | 'tones' | 'rooms' | 'parties' | 'inviting' | 'awaiting' | 'confirmConference'>
vi.mock('../gateway.js', () => ({ useGateway: () => gateway }))
vi.mock('../softphone.js', () => ({ usePhone: () => phone }))
// One translator for every render, as the app's (a new one would start the reads again).
const i18n = { t: (key: string, vars?: { who?: string }) => (vars?.who ? `${key} ${vars.who}` : key) }
vi.mock('../i18n/useT.js', () => ({ useT: () => i18n }))

const ROOM = 'twake-call-0123456789abcdef'
/** A phone in the room, its number hidden (MEET_NUMBER_PRIVACY=hide): only its name and when it came, by the room's clock. */
const person = (name: string, joinedAt: number, you = false): ConferenceParticipant => ({ id: `${ROOM}:${name}`, meetingId: ROOM, kind: 'phone', displayName: name, muted: false, joinedAt, ...(you ? { you } : {}) })
const alice = (you = false) => person('Alice', 1_000, you)
const jean = (you = false) => person('Jean', 1_400, you)
const bob = (you = false) => person('Bob', 9_000, you)
const dan = person('Dan', 9_500)

/** The call of the room in this window: the one that made the conference (`made`), or one the room's call reached. */
const roomCall = (made: boolean, sipCallId: string): SoftCall => {
  const call: Partial<SoftCall> = { id: 'room-call', direction: 'inbound', state: 'connected', room: 'conference', remoteNumber: '101', remoteName: 'Alice', muted: false, sipCallId, ...(made ? { conferenceOf: 'first-call' } : { conferenceRoom: ROOM }) }
  return call as SoftCall
}

/** Reads of the room answering, in turn, what the test queues (an Error: that read refused; a promise: a slow one). */
const reads = (...answers: (ConferenceParticipant[] | Error | Promise<ConferenceParticipant[]>)[]) => {
  const getCallConference = vi.fn(async (_meetingId: string, _options?: { call?: string }) => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!
    if (next instanceof Error) throw next
    return { meetingId: ROOM, participants: await next }
  })
  const muteParticipant = vi.fn(async () => undefined)
  const client: Partial<Gateway['client']> = { getCallConference, muteParticipant }
  gateway = { client: client as Gateway['client'], me: { extension: '101' } as Gateway['me'] }
  return { getCallConference, muteParticipant }
}

describe('CallPanel, a conference (step 8b): who comes in or leaves is told in the status region', () => {
  let root: Root
  let host: HTMLDivElement
  let actEnvironment: unknown
  let chimes: number
  const status = () => host.querySelector('[data-testid="call-status"]')!.textContent
  const render = (call: SoftCall, parties?: ConferenceParticipant[]) =>
    act(async () => {
      phone = { calls: [call], lastEnded: null, tones: {}, rooms: call.conferenceOf ? { [call.conferenceOf]: ROOM } : {}, parties: parties && call.conferenceOf ? { [call.conferenceOf]: parties } : {}, inviting: {}, awaiting: {}, confirmConference: async () => undefined }
      root.render(<CallPanel />)
      await vi.advanceTimersByTimeAsync(0)
    })
  const later = (ms = PARTICIPANTS_EVERY_MS) => act(() => vi.advanceTimersByTimeAsync(ms))

  beforeEach(() => {
    actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    chimes = 0
    // The chime of an arrival: jsdom has no sound, a stand-in counts the tones started.
    class Audio {
      currentTime = 0
      destination = {}
      createGain = () => ({ gain: { value: 0 }, connect: (to: unknown) => to })
      createOscillator = () => ({ frequency: { value: 0 }, connect: (to: unknown) => to, start: () => void chimes++, stop: () => undefined })
      close = async () => undefined
    }
    vi.stubGlobal('AudioContext', Audio)
    host = document.createElement('div')
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
    vi.useRealTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = actEnvironment
  })

  it('tells the one who made it of a participant already there at its first read (the e2e race), numbers hidden, with a chime, once', async () => {
    const { getCallConference } = reads([alice(true), bob(), jean()])
    await render(roomCall(true, 'room-a@192.0.2.30'), [alice(), jean()])
    // Its own call named in each read; the two parties the conference began with are no news.
    expect(getCallConference).toHaveBeenCalledWith(ROOM, { call: 'room-a@192.0.2.30' })
    expect(status()).toBe('conference.joined Bob')
    expect(chimes).toBe(1)
    const shown = host.querySelector('[data-testid="call-status"] p')
    await later()
    expect(getCallConference).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-testid="call-status"] p')).toBe(shown)
    expect(chimes).toBe(1)
  })

  it('tells it all the same when the first reads are refused and a later one finds that participant', async () => {
    reads(new Error('429'), new Error('429'), [alice(true), jean(), bob()])
    await render(roomCall(true, 'room-a@192.0.2.30'), [alice(), jean()])
    expect(status()).toBe('')
    await later()
    await later()
    expect(status()).toBe('conference.joined Bob')
  })

  it('never tells someone of their own arrival: the panel waits for its own call to be in the room (the room took the place of our call)', async () => {
    reads([alice()], [alice(), jean(true)], [alice(), jean(true), bob()])
    await render(roomCall(false, 'room-j@192.0.2.30'))
    await later()
    expect(status()).toBe('')
    await later()
    expect(status()).toBe('conference.joined Bob')
  })

  it("tells a third participant's panel of whoever came after it, even before its first read; not of those there before", async () => {
    reads([alice(), jean(), bob(true), dan])
    await render(roomCall(false, 'room-b@192.0.2.30'))
    expect(status()).toBe('conference.joined Dan')
  })

  it.each([
    ['Alice, who made it', true],
    ['Jean', false]
  ])("tells %s of Bob, called within the same second as Jean's call, 800 ms after it (third review of the notice, n°2)", async (_who, made) => {
    // The Gateway's clock, in milliseconds: Alice's and Jean's calls dialled at …400.050 and …400.100, Bob's at …400.900.
    const at = (p: ConferenceParticipant, joinedAt: number) => ({ ...p, joinedAt })
    reads([at(alice(made), 1_792_171_400_050), at(jean(!made), 1_792_171_400_100), at(bob(), 1_792_171_400_900)])
    await render(roomCall(made, made ? 'room-a@192.0.2.30' : 'room-j@192.0.2.30'), made ? [alice(), jean()] : undefined)
    expect(status()).toBe('conference.joined Bob')
  })

  it('takes nobody as an arrival from a read made before its own call was in the room', async () => {
    // Read once before Bob's call is in it: Jean, there before him, is no news when it is.
    reads([alice()], [alice(), jean(), bob(true)])
    await render(roomCall(false, 'room-b@192.0.2.30'))
    await later()
    expect(status()).toBe('')
  })

  it('says all the arrivals and departures of a read in one message, and the same words again in a new one', async () => {
    const phoneOf = (name: string, joinedAt: number) => ({ ...person(name, joinedAt), displayName: 'Phone' })
    reads([alice(true), jean()], [alice(true), bob(), dan], [alice(true), bob(), dan, phoneOf('x', 9_700)], [alice(true), bob(), dan, phoneOf('x', 9_700), phoneOf('y', 9_800)])
    await render(roomCall(true, 'room-a@192.0.2.30'), [alice(), jean()])
    await later()
    expect(status()).toBe('conference.joined Bob conference.joined Dan conference.left Jean')
    await later()
    const first = host.querySelector('[data-testid="call-status"] p')
    expect(status()).toBe('conference.joined Phone')
    await later()
    expect(status()).toBe('conference.joined Phone')
    // A paragraph of its own: read out again.
    expect(host.querySelector('[data-testid="call-status"] p')).not.toBe(first)
  })

  it('reads one at a time, and drops the answer of a read made before an action', async () => {
    let slow!: (participants: ConferenceParticipant[]) => void
    const late = new Promise<ConferenceParticipant[]>(resolve => (slow = resolve))
    const { getCallConference, muteParticipant } = reads([alice(true), jean()], late, [alice(true), jean(), bob()])
    await render(roomCall(true, 'room-a@192.0.2.30'), [alice(), jean()])
    await later()
    // The second read is slow: no other one meanwhile.
    await later(3 * PARTICIPANTS_EVERY_MS)
    expect(getCallConference).toHaveBeenCalledTimes(2)
    // An action reads again at once, and finds Bob.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="conference.muteWho Jean"]')!.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(muteParticipant).toHaveBeenCalled()
    expect(status()).toBe('conference.joined Bob')
    // The slow one answers now, without Bob: dropped, nobody said to leave.
    await act(async () => {
      slow([alice(true), jean()])
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(status()).toBe('conference.joined Bob')
    expect(host.querySelectorAll('[data-testid="conference-participant"]')).toHaveLength(3)
  })

  it('takes its first read as who was there when its own call is not found in three, and tells what changed since', async () => {
    // Dan comes in at the second read, Jean leaves at the third: both told once the panel gives up on its own call.
    reads([alice(), jean(), bob()], [alice(), jean(), bob(), dan], [alice(), bob(), dan], [alice(), bob(), dan])
    await render(roomCall(false, 'room-j@192.0.2.30'))
    await later()
    expect(status()).toBe('')
    await later()
    expect(status()).toBe('conference.joined Dan conference.left Jean')
    await later()
    expect(status()).toBe('conference.joined Dan conference.left Jean')
  })

  it('takes its first read as who was there without the clock of the room', async () => {
    const unclocked = (p: ConferenceParticipant) => {
      const { joinedAt: _, ...rest } = p
      return rest
    }
    // Read once before its own call is marked: that first read is who was there, Bob came after it.
    reads([unclocked(alice()), unclocked(jean())], [unclocked(alice(true)), unclocked(jean()), unclocked(bob())])
    await render(roomCall(true, 'room-a@192.0.2.30'), [alice(), jean()])
    expect(status()).toBe('')
    await later()
    expect(status()).toBe('conference.joined Bob')
  })

  it('tells the one who made it that a party it began with left before its first read', async () => {
    reads(new Error('429'), [alice(true), bob()])
    await render(roomCall(true, 'room-a@192.0.2.30'), [alice(), jean()])
    await later()
    expect(status()).toBe('conference.joined Bob conference.left Jean')
  })

  it('says « (vous) » of its own call only, not of another leg of the same extension', async () => {
    const leg = (name: string, you: boolean): ConferenceParticipant => ({ ...person(name, 1_000, you), number: '101' })
    reads([leg('a', true), leg('b', false), jean()])
    await render(roomCall(false, 'room-a@192.0.2.30'))
    const items = [...host.querySelectorAll('[data-testid="conference-participant"]')].map(li => li.textContent)
    expect(items.filter(text => text?.includes('conference.you'))).toHaveLength(1)
    // Unmarked (the Gateway marks none), the number tells.
    reads([leg('a', false), jean()])
    act(() => root.unmount())
    root = createRoot(host)
    await render(roomCall(false, 'room-a@192.0.2.30'))
    expect([...host.querySelectorAll('[data-testid="conference-participant"]')].filter(li => li.textContent?.includes('conference.you'))).toHaveLength(1)
  })
  it('asks the person to confirm a call with the operator made a conference (step 8c): the number called is shown, « Passer en conférence » confirms, « Annuler » ends the room', async () => {
    const { getCallConference } = reads([alice(true), jean()])
    expect(getCallConference).toBeDefined()
    const confirmConference = vi.fn(async () => undefined)
    const endCallConference = vi.fn(async () => undefined)
    Object.assign(gateway.client, { endCallConference })
    const call = roomCall(true, 'room-a@192.0.2.30')
    await act(async () => {
      phone = { calls: [call], lastEnded: null, tones: {}, rooms: { [call.conferenceOf!]: ROOM }, parties: {}, inviting: {}, awaiting: { [call.conferenceOf!]: '+33612345678' }, confirmConference }
      root.render(<CallPanel />)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(host.textContent).toContain('conference.awaiting +33 6 12 34 56 78')
    const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent === name)!
    await act(async () => {
      button('conference.confirm').click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(confirmConference).toHaveBeenCalledWith(call.conferenceOf)
    await act(async () => {
      button('conference.giveUp').click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(endCallConference).toHaveBeenCalledWith(ROOM)
  })

})
