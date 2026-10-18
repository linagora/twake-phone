// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelephonyEvent, Voicemail } from '@twake/telephony-types'
import { useVoicemailTab } from './voicemailTab.js'

const v = (id: string, unread = true): Voicemail => ({ id, from: '101', receivedAt: '2026-10-18T02:12:07.000Z', durationSec: 7, unread })

describe('the tab « Messagerie vocale »', () => {
  let root: Root
  let host: HTMLDivElement
  let actEnvironment: unknown
  let seen: { on: boolean; unread: number }
  let connected: () => void
  let send: (event: TelephonyEvent) => void
  let caps: (() => Promise<{ voicemail?: boolean }>)[]
  let items: Voicemail[]
  const getCapabilities = vi.fn(async () => (caps.length > 1 ? caps.shift()! : caps[0]!)())
  const listVoicemails = vi.fn(async () => ({ items: [...items] }))
  const flush = async () => {
    for (let i = 0; i < 3; i++) await act(() => vi.advanceTimersByTimeAsync(0))
  }

  // Stable, as the app's (useGateway's callbacks).
  const client = { getCapabilities, listVoicemails } as never
  const onConnected = (listener: () => void) => {
    connected = () => act(() => listener())
    return () => undefined
  }
  const onEvent = (listener: (event: TelephonyEvent) => void) => {
    send = event => act(() => listener(event))
    return () => undefined
  }
  const Tab = () => {
    seen = useVoicemailTab(client, '102', onConnected, onEvent)
    return null
  }

  beforeEach(() => {
    actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    getCapabilities.mockClear()
    listVoicemails.mockClear()
    items = []
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = actEnvironment
  })

  it('shows once the Gateway answers, after an outage at the start, without a reload', async () => {
    const outage = Object.assign(new Error('unavailable'), { status: 503 })
    caps = [() => Promise.reject(outage), async () => ({ voicemail: true })]
    items = [v('a'), v('b', false)]
    await act(async () => root.render(<Tab />))
    await flush()
    expect(seen).toEqual({ on: false, unread: 0 })
    // Tried again after a while.
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    await flush()
    expect(seen).toEqual({ on: true, unread: 1 })
  })

  it('reads the capability again each time the event stream is back, and the count at each message', async () => {
    caps = [async () => ({}), async () => ({ voicemail: true })]
    await act(async () => root.render(<Tab />))
    await flush()
    expect(seen.on).toBe(false)
    // A message event while it is off: nothing read.
    send({ type: 'voicemail.created', timestamp: '2026-10-18T02:12:07.000Z', payload: { voicemail: v('a') } })
    await flush()
    expect(listVoicemails).not.toHaveBeenCalled()
    items = [v('a')]
    connected()
    await flush()
    expect(seen).toEqual({ on: true, unread: 1 })
    items = [v('a'), v('b')]
    send({ type: 'voicemail.created', timestamp: '2026-10-18T02:12:07.000Z', payload: { voicemail: v('b') } })
    await flush()
    expect(seen.unread).toBe(2)
    items = [v('a', false), v('b')]
    send({ type: 'voicemail.updated', timestamp: '2026-10-18T02:12:07.000Z', payload: { voicemail: v('a', false) } })
    await flush()
    expect(seen.unread).toBe(1)
    expect(getCapabilities).toHaveBeenCalledTimes(2)
  })
})
