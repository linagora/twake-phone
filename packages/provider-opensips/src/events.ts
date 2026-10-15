import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// How the Gateway hears OpenSIPS (ADR 0011): the Event Interface of OpenSIPS pushes JSON-RPC notifications over UDP
// (`event_datagram`) to whoever subscribed through the Management Interface (`mi_datagram`, JSON-RPC over UDP too).
// One socket does both: MI requests go out of it (the replies come back to it) and the events are delivered to it.
// Nothing on this socket is authenticated: only datagrams from the MI host are read, and the port stays on a
// network OpenSIPS and the Gateway trust (the loopback by default).

/** The log the event source writes to; `console` by default. */
export interface EventsLogger {
  info(message: string): void
  warn(message: string): void
}

export interface OpensipsEventsOptions {
  /** The MI socket of OpenSIPS, as `mi_datagram` names it: `udp:host:port` (IPv4 or a host name). */
  miUrl: string
  /** Address this process listens on for the events, `host[:port]` (IPv4). Default 127.0.0.1, any free port. */
  listen?: string
  /**
   * The address OpenSIPS is told to send the events to, `host[:port]`, when it is not the listening one (a wildcard
   * `listen`, a container or a NAT in between). The port defaults to the bound one.
   */
  advertise?: string
  /** The events to subscribe to (E_UL_CONTACT_INSERT, E_ACC_CDR…). */
  events: string[]
  /** Seconds a subscription lives in OpenSIPS; renewed at half of it. Default 120. */
  expireSec?: number
  /** How long an MI reply is waited for. Default 2000 ms. */
  timeoutMs?: number
  /** Each notification OpenSIPS sends. */
  onEvent(method: string, params: Record<string, unknown>): void
  /** The subscription was (re)established, or OpenSIPS restarted: time to read the state again (registrations, dialogs). */
  onResync?(): Promise<void> | void
  /** A renewal went through without needing a resync: time for periodic housekeeping. */
  onRenewed?(): void
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

const parseHostPort = (value: string, what: string) => {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(value)
  if (!m) throw new Error(`events ${what} address must be host[:port], got ${value}`)
  const host = m[1]!.replace(/^\[|\]$/g, '')
  // The socket is udp4: an IPv6 address could neither be bound nor reached from it.
  if (isIP(host) === 6) throw new Error(`events ${what} address must be IPv4, got ${value}`)
  return { host, port: m[2] ? Number(m[2]) : 0 }
}

const WILDCARD = new Set(['0.0.0.0', '::', ''])

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

type Rpc = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }

/**
 * Keeps the Gateway subscribed to the events of one OpenSIPS and hands them over as they come. OpenSIPS forgets
 * its subscribers when it restarts and after their expiry: the subscription is renewed on a timer, and a renewal
 * that follows a failure (or the first one), or that finds OpenSIPS restarted since the last one (MI `uptime`),
 * triggers `onResync` so the state is read again rather than guessed.
 */
export class OpensipsEvents {
  private socket?: dgram.Socket
  private readonly mi: { host: string; port: number }
  private readonly listen: { host: string; port: number }
  private readonly advertise?: { host: string; port: number }
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  /** The addresses datagrams are accepted from: those of the MI host. */
  private sources = new Set<string>()
  private foreign = 0
  /** When OpenSIPS started, as its MI `uptime` says: a change means it restarted. */
  private upSince?: string
  private upTime?: number
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private failures = 0
  private subscribed = false
  private readonly log: EventsLogger

  constructor(private readonly options: OpensipsEventsOptions) {
    this.mi = parseUdpUrl(options.miUrl, 'OpenSIPS MI URL')
    if (isIP(this.mi.host) === 6) throw new Error(`OpenSIPS MI URL must be IPv4 or a host name, got ${options.miUrl}`)
    if (isIP(this.mi.host)) this.sources.add(this.mi.host)
    this.listen = parseHostPort(options.listen ?? '127.0.0.1', 'listen')
    if (options.advertise) {
      this.advertise = parseHostPort(options.advertise, 'advertise')
      if (WILDCARD.has(this.advertise.host)) throw new Error(`events advertise address must be one OpenSIPS can send to, got ${options.advertise}`)
    } else if (WILDCARD.has(this.listen.host)) {
      throw new Error(`events listen address ${options.listen} is a wildcard: set the address OpenSIPS sends the events to (advertise)`)
    }
    this.log = options.logger ?? console
    if (options.events.length === 0) throw new Error('OpenSIPS events: nothing to subscribe to')
  }

  get connected() {
    return this.subscribed
  }

  /** Binds the socket and subscribes; failures to subscribe are retried in the background until `stop()`. */
  async start() {
    if (this.socket || this.stopped) return
    const socket = dgram.createSocket('udp4')
    socket.on('message', (msg, rinfo) => {
      // Whatever arrives, the process keeps running.
      try {
        this.receive(msg, rinfo.address)
      } catch (err) {
        this.log.warn(`OpenSIPS events: datagram not handled: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    socket.on('error', err => this.log.warn(`OpenSIPS events socket: ${err.message}`))
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(this.listen.port, this.listen.host, () => {
          socket.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      socket.close()
      throw err
    }
    if (this.stopped) {
      socket.close()
      return
    }
    this.socket = socket
    await this.renew()
  }

  /** Stops renewing, unsubscribes (best effort: expire 0) and closes the socket. */
  async stop() {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    const address = this.address
    if (this.subscribed && address) {
      await Promise.allSettled(this.options.events.map(event => this.request('event_subscribe', [event, address, 0], 500)))
    }
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
    if (!a) return undefined
    return `udp:${this.advertise?.host ?? a.address}:${this.advertise?.port || a.port}`
  }

  /** One MI request (JSON-RPC 2.0 over UDP); rejects on an error reply, on a timeout, and after `stop()`. */
  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('OpenSIPS events not started'))
    return this.request<T>(method, params)
  }

  private request<T>(method: string, params: unknown[], timeoutMs = this.options.timeoutMs ?? 2_000): Promise<T> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('OpenSIPS events not started'))
    // Unpredictable ids: a reply cannot be forged without seeing the request.
    const id = randomBytes(12).toString('hex')
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`OpenSIPS MI ${method}: no reply within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), this.mi.port, this.mi.host, err => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  private receive(raw: Buffer, from: string) {
    if (!this.sources.has(from)) {
      if (this.foreign++ === 0) this.log.warn(`OpenSIPS events: ignoring a datagram from ${from}, which is not the MI host ${this.mi.host}`)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      this.log.warn(`OpenSIPS events: not JSON (${raw.length} bytes)`)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.log.warn('OpenSIPS events: not a JSON-RPC object')
      return
    }
    const msg = parsed as Rpc
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(String(msg.id))
      if (!p) return
      this.pending.delete(String(msg.id))
      clearTimeout(p.timer)
      const error = msg.error && typeof msg.error === 'object' ? msg.error : undefined
      if (error) p.reject(Object.assign(new Error(`OpenSIPS MI: ${error.message ?? 'error'}`), { code: error.code }) as MiError)
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

  /** The addresses of the MI host, looked up again at each renewal when it is a name (a container may move). */
  private async resolveSources() {
    if (isIP(this.mi.host)) return
    const found = await lookup(this.mi.host, { all: true, family: 4 })
    this.sources = new Set(found.map(a => a.address))
  }

  /** Whether OpenSIPS restarted since the last renewal, from MI `uptime`: another "Up since", or a smaller "Up time". */
  private async restarted(): Promise<boolean> {
    let result: unknown
    try {
      result = await this.call('uptime')
    } catch (err) {
      // An OpenSIPS without the command: no restart detection, the subscription still goes on.
      if ((err as MiError).code !== undefined) return false
      throw err
    }
    const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
    const since = typeof r['Up since'] === 'string' ? r['Up since'] : undefined
    const time = Number.parseInt(String(r['Up time'] ?? ''), 10)
    // "Up since" is set once at startup (to the second); "Up time" going back catches a restart within that second.
    const restarted = (since !== undefined && this.upSince !== undefined && since !== this.upSince) || (Number.isFinite(time) && this.upTime !== undefined && time < this.upTime)
    this.upSince = since
    this.upTime = Number.isFinite(time) ? time : undefined
    return restarted
  }

  private async renew() {
    if (this.stopped) return
    const expire = this.options.expireSec ?? 120
    const wasSubscribed = this.subscribed
    try {
      const address = this.address
      if (!address) throw new Error('socket not bound')
      await this.resolveSources()
      const restarted = await this.restarted()
      for (const event of this.options.events) await this.call('event_subscribe', [event, address, expire])
      if (!wasSubscribed || restarted) {
        if (restarted) this.log.info('OpenSIPS restarted since the last renewal: reading its state again')
        await this.options.onResync?.()
        if (!wasSubscribed) this.log.info(`OpenSIPS events: subscribed at ${this.mi.host}:${this.mi.port}, delivered to ${address}`)
      } else this.options.onRenewed?.()
      if (this.foreign > 1) this.log.warn(`OpenSIPS events: ${this.foreign} datagrams ignored from hosts other than ${this.mi.host}`)
      this.foreign = 0
      this.failures = 0
      this.setSubscribed(true)
      this.schedule((expire * 1000) / 2)
    } catch (err) {
      if (this.stopped) return
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

/** A registered contact and, when OpenSIPS says, when it expires (ms since the epoch). */
export interface RegisteredContact {
  uri: string
  expiresAt?: number
}

/** The registered contacts per address of record, as `ul_dump` reports them (`Expires`: seconds left). */
export const parseUlDump = (result: unknown, nowMs = Date.now()): { aor: string; contacts: RegisteredContact[] }[] => {
  const domains = (result as { Domains?: { AORs?: { AOR?: string; Contacts?: { Contact?: string; Expires?: unknown }[] }[] }[] } | null)?.Domains ?? []
  return domains.flatMap(d =>
    (d.AORs ?? []).flatMap(a =>
      a.AOR
        ? [
            {
              aor: a.AOR,
              contacts: (a.Contacts ?? [])
                .filter(c => c.Contact && c.Expires !== 'expired' && c.Expires !== 'deleted')
                .map(c => (typeof c.Expires === 'number' && c.Expires > 0 ? { uri: c.Contact!, expiresAt: nowMs + c.Expires * 1000 } : { uri: c.Contact! }))
            }
          ]
        : []
    )
  )
}

/**
 * The dialogs OpenSIPS follows, as `dlg_list` reports them. States: 1 unconfirmed, 2 early (ringing), 3 answered
 * but not acknowledged, 4 confirmed, 5 deleted. `timestart` is when the dialog was answered (0 before).
 */
export const parseDlgList = (result: unknown): { callid: string; state: number; caller: string; callee: string; startedAt?: string }[] => {
  const dialogs = (result as { Dialogs?: { callid?: string; state?: number; from_uri?: string; to_uri?: string; timestart?: number }[] } | null)?.Dialogs ?? []
  const user = (uri = '') => /^(?:sips?:)?([^@;>]+)/.exec(uri.replace(/^<|>$/g, ''))?.[1] ?? uri
  return dialogs.flatMap(d =>
    d.callid
      ? [{ callid: d.callid, state: d.state ?? 0, caller: user(d.from_uri), callee: user(d.to_uri), ...(d.timestart ? { startedAt: new Date(d.timestart * 1000).toISOString() } : {}) }]
      : []
  )
}
