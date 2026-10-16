import dgram from 'node:dgram'
import { parseUdpUrl } from '../src/events.js'

/** A stand-in for OpenSIPS's mi_datagram and event_datagram: answers MI over UDP, pushes events to whoever subscribed. */
export const fakeOpensips = async () => {
  const socket = dgram.createSocket('udp4')
  const subscriptions: { event: string; socket: string; expire: number }[] = []
  const requests: { id: string; method: string; params: unknown[] }[] = []
  /**
   * `down`: received but never answered (requests still counts them). `upSince`, `upTime`: what MI `uptime` says.
   * `unknownEvents`: events its script does not declare (MI `raise_event` refuses them). `eventsVia`: the socket the
   * events raised through the MI are sent from (another address than the MI's), this one's when absent.
   */
  const state = {
    down: false,
    received: 0,
    upSince: 'Wed Oct 14 18:00:00 2026',
    upTime: '600 [sec]',
    dump: { Domains: [{ name: 'location', hash_size: 512, AORs: [] as unknown[] }] },
    dialogs: { Dialogs: [] as unknown[] },
    /** What MI dlg_list_ctx answers for a Call-ID (step 8b): the dialog, with its context; 404 for any other. */
    dialogContexts: new Map<string, unknown>(),
    /** What MI ds_list and reg_list answer (step 7): the servers of the trunks, their registrations. */
    dispatcher: { PARTITIONS: [{ name: 'default', SETS: [] as unknown[] }] },
    registrations: { Records: [] as unknown[] },
    unknownEvents: new Set<string>(),
    /** What MI shv_get answers (step 8: meet_on, meet_number); undefined: the method is unknown. */
    shv: undefined as { name: string; type: number; value: unknown }[] | undefined,
    eventsVia: undefined as dgram.Socket | undefined
  }
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
    if (req.method === 'raise_event') {
      // As OpenSIPS: 404 for an event its script does not know, 480 when nobody subscribed, else to each subscriber.
      const [event, params] = req.params as [string, string | undefined]
      if (state.unknownEvents.has(event)) return reply({ error: { code: 404, message: 'Event not registered' } })
      const to = subscriptions.filter(s => s.event === event)
      if (!to.length) return reply({ error: { code: 480, message: 'Temporarily Unavailable' } })
      const body = JSON.stringify({ jsonrpc: '2.0', method: event, params: params ? JSON.parse(params) : {} })
      for (const s of to) {
        const { host, port } = parseUdpUrl(s.socket, 'subscriber')
        ;(state.eventsVia ?? socket).send(body, port, host)
      }
      return reply({ result: 'OK' })
    }
    if (req.method === 'uptime') return reply({ result: { Now: 'Wed Oct 14 18:10:00 2026', 'Up since': state.upSince, 'Up time': state.upTime } })
    if (req.method === 'ul_dump') return reply({ result: state.dump })
    if (req.method === 'dlg_list') return reply({ result: state.dialogs })
    if (req.method === 'dlg_list_ctx') {
      const dialog = state.dialogContexts.get(String((req.params as unknown as { callid?: unknown }).callid))
      return reply(dialog ? { result: { Dialog: dialog } } : { error: { code: 404, message: 'No such dialog' } })
    }
    if (req.method === 'ds_list') return reply({ result: state.dispatcher })
    if (req.method === 'reg_list') return reply({ result: state.registrations })
    if (req.method === 'shv_get' && state.shv) return reply({ result: { VARs: state.shv } })
    // The trunks (step 6): OpenSIPS reads its tables again.
    if (['ds_reload', 'reg_reload', 'dp_reload', 'fraud_reload'].includes(req.method)) return reply({ result: 'OK' })
    if (req.method === 'ul_rm') {
      // Removes the AOR from the location table, as OpenSIPS does (OK even when it is not there).
      const [, aor] = req.params as [string, string]
      const domain = state.dump.Domains[0]!
      domain.AORs = domain.AORs.filter(a => (a as { AOR: string }).AOR !== aor)
      return reply({ result: 'OK' })
    }
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
