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

  it('tells each time the event stream is established, the first time and after a reconnection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ticket: 't' }), { status: 200 }))
    const client = new TelephonyClient({ baseUrl: 'https://gw.example.test', getToken: async () => 'token' })
    const opened: number[] = []
    const events: string[] = []
    let closed = 0
    const stop = client.connect(e => events.push(e.type), { onOpen: () => opened.push(FakeSocket.all.length), onClose: () => void closed++ })
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1))
    expect(FakeSocket.all[0]!.url.searchParams.get('ticket')).toBe('t')
    expect(opened).toEqual([])
    FakeSocket.all[0]!.onopen?.()
    // Open is not enough: the Gateway accepted the session once it says so (and that is not an event).
    expect(opened).toEqual([])
    FakeSocket.all[0]!.onmessage?.({ data: JSON.stringify({ type: 'stream.ready' }) })
    FakeSocket.all[0]!.onmessage?.({ data: JSON.stringify({ type: 'presence.changed' }) })
    expect(opened).toEqual([1])
    // The Gateway restarts: the stream closes, comes back after a backoff, and says so again; an older Gateway
    // that says nothing counts once the stream stayed open 2 s.
    FakeSocket.all[0]!.onclose?.()
    expect(closed).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2))
    FakeSocket.all[1]!.onopen?.()
    await vi.advanceTimersByTimeAsync(1_900)
    expect(opened).toEqual([1])
    await vi.advanceTimersByTimeAsync(100)
    expect(opened).toEqual([1, 2])
    expect(events).toEqual(['presence.changed'])
    stop()
  })

  it('backs off when the Gateway closes the stream right after opening it, and tells nothing', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ticket: 't' }), { status: 200 }))
    const client = new TelephonyClient({ baseUrl: 'https://gw.example.test', getToken: async () => 'token' })
    let opened = 0
    let closed = 0
    const stop = client.connect(() => undefined, { onOpen: () => void opened++, onClose: () => void closed++ })
    // Upgraded, then closed at once (its directory or database down): each attempt waits twice as long.
    await vi.advanceTimersByTimeAsync(0)
    for (const [i, delay] of [500, 1_000, 2_000, 4_000, 8_000].entries()) {
      expect(FakeSocket.all).toHaveLength(i + 1)
      FakeSocket.all[i]!.onopen?.()
      await vi.advanceTimersByTimeAsync(10)
      FakeSocket.all[i]!.onclose?.()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(FakeSocket.all).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(FakeSocket.all).toHaveLength(6)
    expect(opened).toBe(0)
    expect(closed).toBe(0)
    stop()
    vi.restoreAllMocks()
  })
})
