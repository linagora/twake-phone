// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoftCall } from '@twake/softphone'
import type { CallVisio } from '@twake/telephony-client'
import type { ConferenceParticipant } from '@twake/telephony-types'
import type { useGateway } from '../gateway.js'
import type { usePhone } from '../softphone.js'
import { CallPanel, PARTICIPANTS_EVERY_MS } from './CallPanel.js'

type Gateway = ReturnType<typeof useGateway>
type Phone = ReturnType<typeof usePhone>
// What useGateway() and usePhone() hand the panel, set by each test before it renders.
let gateway: Pick<Gateway, 'client' | 'me'>
let phone: Pick<Phone, 'calls' | 'lastEnded' | 'tones' | 'rooms' | 'parties' | 'inviting' | 'awaiting' | 'confirmConference' | 'cancelAwaiting'>
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
  const getCapabilities = vi.fn(async () => ({ conference: { dialIn: true, dialOut: true } }))
  const client: Partial<Gateway['client']> = { getCallConference, muteParticipant, getCapabilities: getCapabilities as unknown as Gateway['client']['getCapabilities'], getVisio: async () => null }
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
      phone = { calls: [call], lastEnded: null, tones: {}, rooms: call.conferenceOf ? { [call.conferenceOf]: ROOM } : {}, parties: parties && call.conferenceOf ? { [call.conferenceOf]: parties } : {}, inviting: {}, awaiting: {}, confirmConference: async () => undefined, cancelAwaiting: async () => undefined }
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
  it('asks the person to confirm a call with the operator made a conference (step 8c): the number called is shown in an alert, the two buttons are off while a request is out (no double send), « Passer en conférence » confirms, « Annuler » gives up, the add button waits, and the focus comes back when the question goes', async () => {
    reads([alice(true), jean()])
    let release: () => void = () => undefined
    const confirmConference = vi.fn(() => new Promise<void>(resolve => (release = resolve)))
    const cancelAwaiting = vi.fn(async () => undefined)
    const call = roomCall(true, 'room-a@192.0.2.30')
    const renderWaiting = (waiting: boolean) =>
      act(async () => {
        phone = { calls: [call], lastEnded: null, tones: {}, rooms: { [call.conferenceOf!]: ROOM }, parties: {}, inviting: {}, awaiting: waiting ? { [call.conferenceOf!]: '+33612345678' } : {}, confirmConference, cancelAwaiting }
        root.render(<CallPanel />)
        await vi.advanceTimersByTimeAsync(0)
      })
    await renderWaiting(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('conference.awaiting +33 6 12 34 56 78')
    const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent === name)!
    expect(button('call.addParticipant').disabled).toBe(true)
    await act(async () => {
      button('conference.confirm').click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(confirmConference).toHaveBeenCalledWith(call.conferenceOf)
    // A request is out: neither button answers, a second click sends nothing.
    expect(button('conference.confirm').disabled).toBe(true)
    expect(button('conference.giveUp').disabled).toBe(true)
    button('conference.confirm').click()
    button('conference.giveUp').click()
    expect(confirmConference).toHaveBeenCalledTimes(1)
    expect(cancelAwaiting).not.toHaveBeenCalled()
    await act(async () => {
      release()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(button('conference.giveUp').disabled).toBe(false)
    await act(async () => {
      button('conference.giveUp').click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cancelAwaiting).toHaveBeenCalledWith(call.conferenceOf)
    // Confirmed: the question goes, the focus is the conference's title again, the add button works.
    await renderWaiting(false)
    expect(host.querySelector('[data-testid="conference-confirm"]')).toBeNull()
    expect(document.activeElement === host.querySelector('.call-title') || document.activeElement === document.body).toBe(true)
    expect(button('call.addParticipant').disabled).toBe(false)
  })

  it('offers « Passer en visio » to the one who made the conference when Meet is there, off with its reason while a call with the operator waits or a passage goes on; the click opens a tab on the room of Meet, the state is read behind (and found again on opening), numbers called again ask for the person\'s word and who stays is named (step 8d)', async () => {
    reads([alice(true), jean()])
    const person = (number: string, status: CallVisio['people'][number]['status'], kind: CallVisio['people'][number]['kind'] = 'number') => ({ number, kind, status })
    const meetId = 'fe15dd04-262c-48d6-83de-d82ab167deb3'
    let passage: CallVisio | null = null
    const startVisio = vi.fn(async (_id: string) => (passage = { meetingId: meetId, slug: 'abc-defg-hij', url: 'https://meet.example/abc-defg-hij', state: 'running', people: [] }))
    const getVisio = vi.fn(async (_id: string) => passage)
    const leaveVisio = vi.fn(async (_id: string) => ({ left: false, remaining: ['104'] }))
    const call = roomCall(true, 'room-a@192.0.2.30')
    const renderIt = (caps: boolean, awaiting: boolean) =>
      act(async () => {
        Object.assign(gateway.client, { getCapabilities: async () => ({ conference: { dialIn: true, dialOut: true, ...(caps ? { visio: true } : {}) } }), startVisio, getVisio, leaveVisio })
        phone = { calls: [call], lastEnded: null, tones: {}, rooms: { [call.conferenceOf!]: ROOM }, parties: {}, inviting: {}, awaiting: awaiting ? { [call.conferenceOf!]: '+33612345678' } : {}, confirmConference: async () => undefined, cancelAwaiting: async () => undefined }
        root.render(<CallPanel />)
        await vi.advanceTimersByTimeAsync(0)
      })
    const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent === name)
    await renderIt(false, false)
    expect(button('conference.visio')).toBeUndefined()
    act(() => root.unmount())
    root = createRoot(host)
    // A call with the operator waits for the person: the button is there, off, and says why.
    await renderIt(true, true)
    expect(button('conference.visio')!.disabled).toBe(true)
    expect(button('conference.visio')!.getAttribute('aria-describedby')).toBeTruthy()
    expect(host.textContent).toContain('conference.errorVisioAwaiting')
    act(() => root.unmount())
    root = createRoot(host)
    await renderIt(true, false)
    const tab = { opener: 'us', location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => tab))
    expect(button('conference.visio')!.disabled).toBe(false)
    await act(async () => {
      button('conference.visio')!.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(startVisio).toHaveBeenCalledWith(ROOM)
    expect(tab.opener).toBeNull()
    expect(tab.location.href).toBe('https://meet.example/abc-defg-hij')
    // Running: said, nothing asked, the buttons off with the reason; read again every 2 s.
    expect(host.querySelector('[role="status"].badge')?.textContent).toBe('conference.visioRunning')
    expect(button('conference.visio')!.disabled).toBe(true)
    expect(button('call.addParticipant')!.disabled).toBe(true)
    expect(host.textContent).toContain('conference.visioGoing')
    passage = { ...passage!, state: 'done', people: [person('102', 'swapped', 'extension'), person('+33612345678', 'called'), person('104', 'failed', 'extension')] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    const alert = host.querySelector('[role="alert"]')?.textContent ?? ''
    // Only who was called by a new call is asked about (no empty list), and who stays is said.
    expect(alert).toContain('conference.visioAwaiting +33 6 12 34 56 78')
    expect(alert).toContain('conference.visioFailed 104')
    expect(alert).not.toContain('102')
    await act(async () => {
      button('conference.visioLeave')!.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(leaveVisio).toHaveBeenCalledWith(ROOM)
    // Not ended: someone stays in the old room, named; the question stays.
    expect(host.textContent).toContain('conference.visioRemaining 104')
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    leaveVisio.mockResolvedValueOnce({ left: true, remaining: [] })
    await act(async () => {
      button('conference.visioLeave')!.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    // A page loaded again finds the passage (the Gateway's record): the button is off at once, nothing asked when only phones moved.
    act(() => root.unmount())
    root = createRoot(host)
    passage = { meetingId: meetId, slug: 'abc-defg-hij', url: 'https://meet.example/abc-defg-hij', state: 'done', people: [person('102', 'swapped', 'extension')] }
    await renderIt(true, false)
    expect(button('conference.visio')!.disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    // Meet says no: the tab is closed and the person told.
    act(() => root.unmount())
    root = createRoot(host)
    passage = null
    startVisio.mockRejectedValueOnce(Object.assign(new Error('VISIO_UNAVAILABLE'), { code: 'VISIO_UNAVAILABLE' }))
    await renderIt(true, false)
    await act(async () => {
      button('conference.visio')!.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(tab.close).toHaveBeenCalled()
    expect(host.textContent).toContain('conference.errorVisioUnavailable')
  })

})
