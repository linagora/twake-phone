import dgram from 'node:dgram'
import { parseUdpUrl } from '../src/events.js'

/** A stand-in for OpenSIPS's mi_datagram and event_datagram: answers MI over UDP, pushes events to whoever subscribed. */
export const fakeOpensips = async () => {
  const socket = dgram.createSocket('udp4')
  const subscriptions: { event: string; socket: string; expire: number }[] = []
  const requests: { id: string; method: string; params: unknown[] }[] = []
  /** `down`: received but never answered (requests still counts them). `upSince`: what MI `uptime` says. */
  const state = { down: false, received: 0, upSince: 'Wed Oct 14 18:00:00 2026', dump: { Domains: [{ name: 'location', hash_size: 512, AORs: [] as unknown[] }] }, dialogs: { Dialogs: [] as unknown[] } }
  socket.on('message', (raw, rinfo) => {
    state.received++
    if (state.down) return
    const req = JSON.parse(raw.toString()) as { id: string; method: string; params: unknown[] }
    requests.push({ id: req.id, method: req.method, params: req.params })
    const reply = (body: Record<string, unknown>) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }), rinfo.port, rinfo.address)
    if (req.method === 'event_subscribe') {
      const [event, to, expire] = req.params as [string, string, number]
      if (event === 'E_NOPE') return reply({ error: { code: -32602, message: 'Event not found' } })
      // expire 0: unsubscribes, as OpenSIPS does.
      if (expire === 0) {
        for (let i = subscriptions.length - 1; i >= 0; i--) if (subscriptions[i]!.event === event && subscriptions[i]!.socket === to) subscriptions.splice(i, 1)
      } else subscriptions.push({ event, socket: to, expire })
      return reply({ result: 'OK' })
    }
    if (req.method === 'uptime') return reply({ result: { Now: 'Wed Oct 14 18:10:00 2026', 'Up since': state.upSince, 'Up time': '600 [sec]' } })
    if (req.method === 'ul_dump') return reply({ result: state.dump })
    if (req.method === 'dlg_list') return reply({ result: state.dialogs })
    return reply({ error: { code: -32601, message: 'Method not found' } })
  })
  await new Promise<void>(r => socket.bind(0, '127.0.0.1', r))
  const url = `udp:127.0.0.1:${socket.address().port}`
  const send = (raw: string) => {
    const last = subscriptions[subscriptions.length - 1]
    if (!last) throw new Error('nobody subscribed')
    const { host, port } = parseUdpUrl(last.socket, 'subscriber')
    socket.send(raw, port, host)
  }
  const push = (method: string, params: Record<string, unknown>) => send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  /** OpenSIPS restarted: its subscribers forgotten, a new start time. */
  const restart = (upSince: string) => {
    subscriptions.splice(0)
    state.upSince = upSince
  }
  return { url, subscriptions, requests, state, push, send, restart, close: () => new Promise<void>(r => socket.close(r)) }
}
