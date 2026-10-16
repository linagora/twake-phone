// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConferenceParticipant } from '@twake/telephony-types'
import type { useGateway } from '../gateway.js'
import { Participants } from './CallPanel.js'

type Gateway = ReturnType<typeof useGateway>
// What useGateway() hands the panel, set by each test before it renders.
let gateway: Pick<Gateway, 'client' | 'me'>
vi.mock('../gateway.js', () => ({ useGateway: () => gateway }))
vi.mock('../softphone.js', () => ({ usePhone: () => ({}) }))
// One translator for every render, as the app's (a new one would start the reads again).
const i18n = { t: (key: string, vars?: { who?: string }) => (vars?.who ? `${key} ${vars.who}` : key) }
vi.mock('../i18n/useT.js', () => ({ useT: () => i18n }))

const phone = (number: string): ConferenceParticipant => ({ id: `phone-${number}`, meetingId: 'twake-call-0123456789abcdef', kind: 'phone', number, muted: false })
/** A Gateway whose reads of the room answer, in turn, what the test lists (an Error: that read is refused). */
const reads = (extension: string, ...answers: (ConferenceParticipant[] | Error)[]) => {
  const getCallConference = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!
    if (next instanceof Error) throw next
    return { meetingId: 'twake-call-0123456789abcdef', participants: next }
  })
  gateway = { client: { getCallConference } as unknown as Gateway['client'], me: { extension } as unknown as Gateway['me'] }
  return getCallConference
}

describe('Participants (step 8b): who joined a conference is told', () => {
  let root: Root
  let notices: string[]
  const render = (party?: string) =>
    act(async () => {
      root.render(<Participants meetingId="twake-call-0123456789abcdef" manage={false} {...(party ? { party } : {})} onError={() => undefined} onNotice={m => notices.push(m)} />)
      await vi.advanceTimersByTimeAsync(0)
    })
  const later = () => act(() => vi.advanceTimersByTimeAsync(5_000))

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    notices = []
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it('tells who is already there at the first read of a conference made out of our call: the third participant answered before it (the e2e race)', async () => {
    // Alice's panel: her call with 102 became the conference, and 103 answered before the panel first read the room.
    const read = reads('101', [phone('101'), phone('103'), phone('102')])
    await render('102')
    expect(read).toHaveBeenCalledTimes(1)
    expect(notices).toEqual(['conference.joined 103'])
    // Told once: the next reads find the same people.
    await later()
    expect(read).toHaveBeenCalledTimes(2)
    expect(notices).toEqual(['conference.joined 103'])
  })

  it('tells it all the same when the first read is refused and a later one finds the third participant', async () => {
    reads('102', new Error('429'), [phone('101'), phone('102'), phone('103')])
    // Jean's panel: the room took the place of his call with 101.
    await render('101')
    expect(notices).toEqual([])
    await later()
    expect(notices).toEqual(['conference.joined 103'])
  })

  it("takes everyone there at the first read as there before for a third participant's panel, then tells who comes and goes", async () => {
    reads('103', [phone('101'), phone('102'), phone('103')], [phone('101'), phone('103'), phone('104')])
    await render()
    expect(notices).toEqual([])
    await later()
    expect(notices).toEqual(['conference.joined 104', 'conference.left 102'])
  })

  it('takes everyone at the first read as there before when the far end of our call is not found by its number (a group answered)', async () => {
    reads('101', [phone('101'), phone('102'), phone('103')])
    await render('600')
    expect(notices).toEqual([])
  })
})
