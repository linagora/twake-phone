// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SoftCall } from '@twake/softphone'
import { CALLS_MESSAGE, COMMAND_MESSAGE, ParentCalls } from './embedded.js'

let calls: SoftCall[] = []
vi.mock('./softphone.js', () => ({ usePhone: () => ({ calls }) }))

const ORIGIN = 'https://wp.test'
// jsdom: the parent of the page is the page itself; framed once `self` is not `top`.
const from = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, origin: ORIGIN, source: window }))

describe('ParentCalls, the orders of the Workplace widget (ADR 0034)', () => {
  afterEach(() => {
    Object.assign(window, { self: window })
    vi.restoreAllMocks()
    calls = []
  })

  it('answers a ringing call once, ignores an answer to a call no longer ringing, and says no call once gone', async () => {
    Object.assign(window, { self: {} })
    const post = vi.spyOn(window, 'postMessage').mockImplementation(message => message === 'requestParentOrigin' && setTimeout(() => from('answerParentOrigin')))
    // An answer that waits (the microphone asked in the background).
    const ringing = { id: 'r1', direction: 'inbound', state: 'ringing', remoteNumber: '102', answer: vi.fn(() => new Promise(() => undefined)), reject: vi.fn(async () => undefined) }
    const connected = { id: 'c1', direction: 'inbound', state: 'connected', remoteNumber: '103', answer: vi.fn(async () => undefined), reject: vi.fn(async () => undefined) }
    calls = [ringing, connected] as unknown as SoftCall[]
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<ParentCalls />))
    await act(() => new Promise(r => setTimeout(r, 20)))
    expect(post).toHaveBeenCalledWith({ type: CALLS_MESSAGE, calls: expect.arrayContaining([expect.objectContaining({ id: 'r1', state: 'ringing' })]) }, ORIGIN)
    from({ type: COMMAND_MESSAGE, callId: 'r1', action: 'answer' })
    from({ type: COMMAND_MESSAGE, callId: 'r1', action: 'answer' })
    from({ type: COMMAND_MESSAGE, callId: 'c1', action: 'answer' })
    from({ type: COMMAND_MESSAGE, callId: 'c1', action: 'reject' })
    expect(ringing.answer).toHaveBeenCalledTimes(1)
    // Declining while the answer waits still goes.
    from({ type: COMMAND_MESSAGE, callId: 'r1', action: 'reject' })
    expect(ringing.reject).toHaveBeenCalledTimes(1)
    expect(connected.answer).not.toHaveBeenCalled()
    expect(connected.reject).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(post).toHaveBeenLastCalledWith({ type: CALLS_MESSAGE, calls: [] }, ORIGIN)
  })
})
