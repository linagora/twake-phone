import { createServer, type Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { AriClient } from './ari.js'

describe('AriClient.events', () => {
  it('keeps retrying when the PBX refuses the WebSocket handshake', async () => {
    // The retry delay is random (jitter): pin it so the test does not depend on luck.
    vi.spyOn(Math, 'random').mockReturnValue(0.05)
    let connections = 0
    const server = createServer((socket: Socket) => {
      connections++
      socket.destroy() // handshake never completes: only an error, possibly no close
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port

    let downs = 0
    const client = new AriClient({ url: `http://127.0.0.1:${port}`, user: 'u', password: 'p', app: 'a' })
    const stop = client.events({ onEvent() {}, onUp() {}, onDown: () => downs++ })
    const end = Date.now() + 6000
    while (connections < 3 && Date.now() < end) await new Promise(r => setTimeout(r, 100))
    stop()
    server.close()
    vi.restoreAllMocks()

    expect(connections).toBeGreaterThanOrEqual(3)
    expect(downs).toBeGreaterThanOrEqual(2)
  }, 10_000)
})
