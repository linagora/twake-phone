import dgram from 'node:dgram'

// How the Gateway hears OpenSIPS (ADR 0011): the Event Interface of OpenSIPS pushes JSON-RPC notifications over UDP
// (`event_datagram`) to whoever subscribed through the Management Interface (`mi_datagram`, JSON-RPC over UDP too).
// One socket does both: MI requests go out of it (the replies come back to it) and the events are delivered to it.

/** The log the event source writes to; `console` by default. */
export interface EventsLogger {
  info(message: string): void
  warn(message: string): void
}

export interface OpensipsEventsOptions {
  /** The MI socket of OpenSIPS, as `mi_datagram` names it: `udp:host:port`. */
  miUrl: string
  /** Address this process listens on for the events, `host[:port]`; the host must be the one OpenSIPS can reach. Default 127.0.0.1, any free port. */
  listen?: string
  /** The events to subscribe to (E_UL_CONTACT_INSERT, E_ACC_CDR…). */
  events: string[]
  /** Seconds a subscription lives in OpenSIPS; renewed at half of it. Default 120. */
  expireSec?: number
  /** How long an MI reply is waited for. Default 2000 ms. */
  timeoutMs?: number
  /** Each notification OpenSIPS sends. */
  onEvent(method: string, params: Record<string, unknown>): void
  /** The subscription was (re)established: time to read the state again (registrations, dialogs). */
  onResync?(): Promise<void> | void
  onStatus?(connected: boolean): void
  logger?: EventsLogger
}

export interface MiError extends Error {
  code?: number
}

/** `udp:host:port` → host and port. */
export const parseUdpUrl = (url: string, what: string): { host: string; port: number } => {
  const m = /^udp:(?:\/\/)?(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(url)
  const port = m ? Number(m[2]) : NaN
  if (!m || !(port > 0 && port < 65536)) throw new Error(`${what} must be udp:host:port, got ${url}`)
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port }
}

const parseListen = (listen = '127.0.0.1') => {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(listen)
  if (!m) throw new Error(`events listen address must be host[:port], got ${listen}`)
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : 0 }
}

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * Keeps the Gateway subscribed to the events of one OpenSIPS and hands them over as they come. OpenSIPS forgets
 * its subscribers when it restarts and after their expiry: the subscription is renewed on a timer, and a renewal
 * that follows a failure (or the first one) triggers `onResync` so the state is read again rather than guessed.
 */
export class OpensipsEvents {
  private socket?: dgram.Socket
  private readonly mi: { host: string; port: number }
  private readonly listen: { host: string; port: number }
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 0
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private failures = 0
  private subscribed = false
  private readonly log: EventsLogger

  constructor(private readonly options: OpensipsEventsOptions) {
    this.mi = parseUdpUrl(options.miUrl, 'OpenSIPS MI URL')
    this.listen = parseListen(options.listen)
    this.log = options.logger ?? console
    if (options.events.length === 0) throw new Error('OpenSIPS events: nothing to subscribe to')
  }

  get connected() {
    return this.subscribed
  }

  /** Binds the socket and subscribes; failures are retried in the background until `stop()`. */
  async start() {
    if (this.socket) return
    const socket = dgram.createSocket('udp4')
    this.socket = socket
    socket.on('message', msg => this.receive(msg))
    socket.on('error', err => this.log.warn(`OpenSIPS events socket: ${err.message}`))
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(this.listen.port, this.listen.host, () => {
        socket.off('error', reject)
        resolve()
      })
    })
    await this.renew()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('OpenSIPS events stopped'))
    }
    this.pending.clear()
    this.socket?.close()
    this.socket = undefined
    this.setSubscribed(false)
  }

  /** The address OpenSIPS sends the events to, once started. */
  get address() {
    const a = this.socket?.address()
    return a ? `udp:${a.address}:${a.port}` : undefined
  }

  /** One MI request (JSON-RPC 2.0 over UDP); rejects on an error reply, on a timeout, and after `stop()`. */
  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const socket = this.socket
    if (!socket || this.stopped) return Promise.reject(new Error('OpenSIPS events not started'))
    const id = String(++this.nextId)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`OpenSIPS MI ${method}: no reply within ${this.options.timeoutMs ?? 2_000} ms`))
      }, this.options.timeoutMs ?? 2_000)
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), this.mi.port, this.mi.host, err => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  private receive(raw: Buffer) {
    let msg: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      this.log.warn(`OpenSIPS events: not JSON (${raw.length} bytes)`)
      return
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(String(msg.id))
      if (!p) return
      this.pending.delete(String(msg.id))
      clearTimeout(p.timer)
      if (msg.error) p.reject(Object.assign(new Error(`OpenSIPS MI: ${msg.error.message ?? 'error'}`), { code: msg.error.code }) as MiError)
      else p.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string') {
      const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? (msg.params as Record<string, unknown>) : {}
      try {
        this.options.onEvent(msg.method, params)
      } catch (err) {
        this.log.warn(`OpenSIPS event ${msg.method} not handled: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async renew() {
    if (this.stopped) return
    const expire = this.options.expireSec ?? 120
    const wasSubscribed = this.subscribed
    try {
      const address = this.address
      if (!address) throw new Error('socket not bound')
      for (const event of this.options.events) await this.call('event_subscribe', [event, address, expire])
      if (!wasSubscribed) {
        await this.options.onResync?.()
        this.log.info(`OpenSIPS events: subscribed at ${this.mi.host}:${this.mi.port}, delivered to ${address}`)
      }
      this.failures = 0
      this.setSubscribed(true)
      this.schedule((expire * 1000) / 2)
    } catch (err) {
      const delay = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]!
      if (wasSubscribed || this.failures === 1) this.log.warn(`OpenSIPS events: ${err instanceof Error ? err.message : String(err)}; retrying in ${delay / 1000} s`)
      this.setSubscribed(false)
      this.schedule(delay)
    }
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(() => void this.renew(), ms)
    this.timer.unref?.()
  }

  private setSubscribed(value: boolean) {
    if (this.subscribed === value) return
    this.subscribed = value
    this.options.onStatus?.(value)
  }
}

/** The registered contacts per address of record, as `ul_dump` reports them. */
export const parseUlDump = (result: unknown): { aor: string; contacts: string[] }[] => {
  const domains = (result as { Domains?: { AORs?: { AOR?: string; Contacts?: { Contact?: string; Expires?: unknown }[] }[] }[] } | null)?.Domains ?? []
  return domains.flatMap(d =>
    (d.AORs ?? []).flatMap(a =>
      a.AOR
        ? [{ aor: a.AOR, contacts: (a.Contacts ?? []).filter(c => c.Contact && c.Expires !== 'expired' && c.Expires !== 'deleted').map(c => c.Contact!) }]
        : []
    )
  )
}

/** The dialogs OpenSIPS follows, as `dlg_list` reports them (state 4 = confirmed, i.e. answered). */
export const parseDlgList = (result: unknown): { callid: string; state: number; caller: string; callee: string; startedAt: string }[] => {
  const dialogs = (result as { Dialogs?: { callid?: string; state?: number; from_uri?: string; to_uri?: string; timestart?: number }[] } | null)?.Dialogs ?? []
  const user = (uri = '') => /^(?:sips?:)?([^@;>]+)/.exec(uri.replace(/^<|>$/g, ''))?.[1] ?? uri
  return dialogs.flatMap(d =>
    d.callid ? [{ callid: d.callid, state: d.state ?? 0, caller: user(d.from_uri), callee: user(d.to_uri), startedAt: new Date((d.timestart ?? 0) * 1000).toISOString() }] : []
  )
}
