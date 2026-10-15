import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelephonyClient } from './index.js'

/** A WebSocket the test opens and closes by hand. */
class FakeSocket {
  static all: FakeSocket[] = []
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  constructor(readonly url: URL) {
    FakeSocket.all.push(this)
  }
  close() {
    this.onclose?.()
  }
}

describe('TelephonyClient.connect', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    FakeSocket.all = []
  })

  it('tells each time the event stream opens, the first time and after a reconnection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ticket: 't' }), { status: 200 }))
    const client = new TelephonyClient({ baseUrl: 'https://gw.example.test', getToken: async () => 'token' })
    const opened: number[] = []
    const events: string[] = []
    const stop = client.connect(e => events.push(e.type), { onOpen: () => opened.push(FakeSocket.all.length) })
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1))
    expect(FakeSocket.all[0]!.url.searchParams.get('ticket')).toBe('t')
    expect(opened).toEqual([])
    FakeSocket.all[0]!.onopen?.()
    FakeSocket.all[0]!.onmessage?.({ data: JSON.stringify({ type: 'presence.changed' }) })
    expect(opened).toEqual([1])
    // The Gateway restarts: the stream closes, comes back after a backoff, and says so again.
    FakeSocket.all[0]!.onclose?.()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2))
    FakeSocket.all[1]!.onopen?.()
    expect(opened).toEqual([1, 2])
    expect(events).toEqual(['presence.changed'])
    stop()
  })
})
