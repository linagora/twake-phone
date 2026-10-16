import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// How the Gateway hears OpenSIPS (ADR 0011): the Event Interface of OpenSIPS pushes JSON-RPC notifications over UDP
// (`event_datagram`) to whoever subscribed through the Management Interface (`mi_datagram`, JSON-RPC over UDP too).
// One socket does both: MI requests go out of it (the replies come back to it) and the events are delivered to it.
// Nothing on this socket is authenticated: only datagrams from the MI host (or the addresses given in `from`) are
// read, and the port stays on a network OpenSIPS and the Gateway trust (the loopback by default).

/** The log the event source writes to; `console` by default. */
export interface EventsLogger {
  info(message: string): void
  warn(message: string): void
  /** What needs someone's attention; `warn` when absent. */
  error?(message: string): void
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
  /**
   * The addresses the events may come from besides the MI host (IPv4 or names): `event_datagram` sends from an
   * unbound socket, so the kernel picks the source address of the route to the Gateway, which is not always the
   * MI one (a bridged container, a host with several addresses).
   */
  from?: string[]
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
  /**
   * An event of OpenSIPS's script this process raises itself through the MI (`raise_event`) after each subscription
   * made or renewed, and subscribes to: when it comes back from an accepted address, the events are heard (onHeard).
   */
  probeEvent?: string
  /**
   * The events of OpenSIPS reach this process `expireSec` seconds more at least: its subscription lives that long, and
   * the probe event it raised after making or renewing it came back from an accepted address. Without `probeEvent`,
   * or from an OpenSIPS whose script does not know it: the subscription went through and the last period was not
   * deaf (only datagrams from addresses not accepted).
   */
  onHeard?(expireSec: number): void
  /**
   * No renewal went through for the whole life of the last subscription: OpenSIPS has dropped it, and what it told
   * may no longer hold. A single failed renewal is not that: the subscription lives on and events keep coming.
   */
  onExpired?(): void
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
const isLoopback = (host: string) => /^127\./.test(host) || host === 'localhost'

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** After a start on a fixed address, the first renewal comes this soon: a previous instance may have unsubscribed it. */
const FIRST_RENEWAL_MS = 5_000
/** Resyncs failing in a row before it is logged as an error. */
const RESYNC_ALERT = 3

type Rpc = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }

/**
 * Keeps the Gateway subscribed to the events of one OpenSIPS and hands them over as they come. OpenSIPS forgets
 * its subscribers when it restarts and after their expiry: the subscription is renewed on a timer, and a renewal
 * that follows a failure (or the first one), or that finds OpenSIPS restarted since the last one (MI `uptime`),
 * triggers `onResync` so the state is read again rather than guessed. A configuration that cannot work (an
 * address it cannot listen on or announce) is logged and leaves it degraded: calls do not depend on it.
 */
export class OpensipsEvents {
  private socket?: dgram.Socket
  private readonly mi: { host: string; port: number } = { host: '', port: 0 }
  private readonly listen: { host: string; port: number } = { host: '127.0.0.1', port: 0 }
  private readonly advertise?: { host: string; port: number }
  /** Why this configuration cannot work, logged once; nothing is started. */
  private readonly broken?: string
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  /** The addresses datagrams are accepted from: the MI host's and those of `from`. */
  private sources = new Set<string>()
  /** Since the last renewal: events read, datagrams ignored (and the last address they came from). */
  private heard = 0
  private foreign = 0
  private foreignFrom = ''
  /** Only ignored datagrams arrived during the last renewal period: OpenSIPS sends from an address not accepted. */
  private deaf = false
  /** The probe event raised after the last subscription, until it comes back: its nonce, when, and the life it tells. */
  private probing?: { nonce: string; sentAt: number; expire: number }
  /** The probe event was refused by OpenSIPS (logged once until it is known again). */
  private probeRefused = false
  /** When OpenSIPS started, as its MI `uptime` says: a change means it restarted. */
  private upSince?: string
  private timer?: ReturnType<typeof setTimeout>
  private expiry?: ReturnType<typeof setTimeout>
  private stopped = false
  private failures = 0
  private resyncFailures = 0
  private renewals = 0
  private subscribed = false
  /** The last subscription still lives in OpenSIPS (renewed within its expiry). */
  private alive = false
  private notStarted = false
  private status = false
  private readonly log: EventsLogger

  constructor(private readonly options: OpensipsEventsOptions) {
    this.log = options.logger ?? console
    if (options.events.length === 0) throw new Error('OpenSIPS events: nothing to subscribe to')
    try {
      this.mi = parseUdpUrl(options.miUrl, 'OpenSIPS MI URL')
      if (isIP(this.mi.host) === 6) throw new Error(`OpenSIPS MI URL must be IPv4 or a host name, got ${options.miUrl}`)
      this.listen = parseHostPort(options.listen ?? '127.0.0.1', 'listen')
      if (options.advertise) {
        this.advertise = parseHostPort(options.advertise, 'advertise')
        if (WILDCARD.has(this.advertise.host)) throw new Error(`events advertise address must be one OpenSIPS can send to, got ${options.advertise}`)
      } else if (WILDCARD.has(this.listen.host)) {
        if (!isLoopback(this.mi.host)) throw new Error(`events listen address ${options.listen} is a wildcard: set the address OpenSIPS sends the events to (advertise)`)
        // OpenSIPS on this host: it reaches the wildcard socket on the loopback (what a bare 0.0.0.0 used to mean).
        this.advertise = { host: '127.0.0.1', port: 0 }
        this.log.warn(`OpenSIPS events: listening on ${options.listen} without an advertised address; OpenSIPS (${this.mi.host}) is told 127.0.0.1`)
      }
    } catch (err) {
      this.broken = err instanceof Error ? err.message : String(err)
      this.log.warn(`OpenSIPS events disabled, calls still work: ${this.broken}`)
    }
  }

  /** Subscribed, and the events arrive from an accepted address. */
  get connected() {
    return this.subscribed && !this.deaf
  }

  /** The last subscription still lives in OpenSIPS: its events come, even while a renewal is failing. */
  get live() {
    return this.alive && !this.deaf
  }

  /** Why the events are not heard, in a few words (no address: it may be shown unauthenticated). */
  get reason(): string | undefined {
    if (this.broken) return 'events: invalid configuration (see the log)'
    if (this.notStarted) return 'events: cannot listen (see the log)'
    if (!this.subscribed) return this.resyncFailures > 0 ? 'events: the state of OpenSIPS cannot be read (see the log)' : 'events: OpenSIPS MI does not answer'
    if (this.deaf) return 'events: datagrams come only from addresses that are not accepted (OPENSIPS_EVENTS_FROM)'
    return undefined
  }

  /** The listening address is fixed (a port, or an advertised address): another instance may use the same one. */
  private get fixed() {
    return this.listen.port !== 0 || !!this.options.advertise
  }

  /** Binds the socket and subscribes; failures to subscribe are retried in the background until `stop()`. */
  async start() {
    if (this.socket || this.stopped || this.broken) return
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
      this.notStarted = true
      socket.close()
      throw err
    }
    this.notStarted = false
    if (this.stopped) {
      socket.close()
      return
    }
    this.socket = socket
    await this.renew()
  }

  /**
   * Stops renewing and closes the socket. Unsubscribes (best effort: expire 0) only from an address no other
   * instance can hold: on a fixed one, the instance that replaces this one may already be subscribed with it.
   */
  async stop() {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.expiry)
    const address = this.address
    if (this.subscribed && address && !this.fixed) {
      await Promise.allSettled(this.options.events.map(event => this.request('event_subscribe', [event, address, 0], 500)))
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('OpenSIPS events stopped'))
    }
    this.pending.clear()
    this.socket?.close()
    this.socket = undefined
    this.subscribed = false
    this.alive = false
    this.updateStatus()
  }

  /** The address OpenSIPS sends the events to, once started. */
  get address() {
    const a = this.socket?.address()
    if (!a) return undefined
    return `udp:${this.advertise?.host ?? a.address}:${this.advertise?.port || a.port}`
  }

  /** One MI request (JSON-RPC 2.0 over UDP); rejects on an error reply, on a timeout, and after `stop()`. */
  call<T = unknown>(method: string, params: unknown[] | Record<string, unknown> = []): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('OpenSIPS events not started'))
    return this.request<T>(method, params)
  }

  private request<T>(method: string, params: unknown[] | Record<string, unknown>, timeoutMs = this.options.timeoutMs ?? 2_000): Promise<T> {
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
      if (this.foreign++ === 0) this.log.warn(`OpenSIPS events: ignoring a datagram from ${from}, which is neither the MI host ${this.mi.host} nor in OPENSIPS_EVENTS_FROM`)
      this.foreignFrom = from
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
      // Our requests carry a string id: a reply with any other id answers none of them.
      const id = typeof msg.id === 'string' ? msg.id : ''
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      const error = msg.error && typeof msg.error === 'object' ? msg.error : undefined
      if (error) p.reject(Object.assign(new Error(`OpenSIPS MI: ${error.message ?? 'error'}`), { code: error.code }))
      else p.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string') {
      this.heard++
      const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? (msg.params as Record<string, unknown>) : {}
      if (msg.method === this.options.probeEvent) {
        // Ours (another process subscribed to the same OpenSIPS raises its own): heard, for what is left of its life.
        const probe = this.probing
        if (probe && params.probe === probe.nonce) {
          this.probing = undefined
          this.options.onHeard?.(Math.max(0, probe.expire - Math.floor((Date.now() - probe.sentAt) / 1000)))
        }
        return
      }
      try {
        this.options.onEvent(msg.method, params)
      } catch (err) {
        this.log.warn(`OpenSIPS event ${msg.method} not handled: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** The accepted addresses, looked up again at each renewal for names (a container may move). */
  private async resolveSources() {
    const resolve = async (host: string) => (isIP(host) ? [host] : (await lookup(host, { all: true, family: 4 })).map(a => a.address))
    const sources = new Set(await resolve(this.mi.host))
    for (const host of this.options.from ?? []) {
      try {
        for (const a of await resolve(host)) sources.add(a)
      } catch (err) {
        this.log.warn(`OpenSIPS events: accepted source ${host} not found: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.sources = sources
  }

  /** Whether OpenSIPS restarted since the last renewal: MI `uptime` gives another "Up since" (set once at startup). */
  private async restarted(): Promise<boolean> {
    let result: unknown
    try {
      result = await this.call('uptime')
    } catch (err) {
      // An OpenSIPS without the command: no restart detection, the subscription still goes on.
      if ((err as MiError).code !== undefined) return false
      throw err
    }
    const since = result && typeof result === 'object' ? (result as Record<string, unknown>)['Up since'] : undefined
    if (typeof since !== 'string') return false
    const restarted = this.upSince !== undefined && since !== this.upSince
    this.upSince = since
    return restarted
  }

  /** Only ignored datagrams during the period that just ended: the events come from an address not accepted. */
  private checkSources() {
    const deaf = this.heard === 0 && this.foreign > 0
    if (deaf && !this.deaf) {
      ;(this.log.error ?? this.log.warn).call(
        this.log,
        `OpenSIPS events: since the last renewal only datagrams from ${this.foreignFrom} arrived, none from an accepted address (${[...this.sources].join(', ')}). event_datagram sends from the address its kernel picks for the route: add it to OPENSIPS_EVENTS_FROM`
      )
    } else if (this.foreign > 1) this.log.warn(`OpenSIPS events: ${this.foreign} datagrams ignored from addresses that are not accepted`)
    this.deaf = deaf
    this.heard = 0
    this.foreign = 0
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
      const lapsed = !this.alive
      this.keepAlive(expire)
      this.checkSources()
      await this.probe(expire)
      if (!wasSubscribed || restarted || lapsed) {
        if (restarted) this.log.info('OpenSIPS restarted since the last renewal: reading its state again')
        try {
          await this.options.onResync?.()
          this.resyncFailures = 0
        } catch (err) {
          if (++this.resyncFailures === RESYNC_ALERT) {
            ;(this.log.error ?? this.log.warn).call(
              this.log,
              `OpenSIPS events: the state of OpenSIPS could not be read ${RESYNC_ALERT} times in a row (ul_dump, dlg_list): ${err instanceof Error ? err.message : String(err)}. With many registered browsers the reply may not fit in one MI datagram (about 64 KB).`
            )
          }
          throw err
        }
        if (!wasSubscribed) this.log.info(`OpenSIPS events: subscribed at ${this.mi.host}:${this.mi.port}, delivered to ${address}`)
      } else this.options.onRenewed?.()
      this.failures = 0
      this.subscribed = true
      this.updateStatus()
      this.schedule(this.renewals++ === 0 && this.fixed ? Math.min(FIRST_RENEWAL_MS, (expire * 1000) / 2) : (expire * 1000) / 2)
    } catch (err) {
      if (this.stopped) return
      const delay = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]!
      if (wasSubscribed || this.failures === 1) this.log.warn(`OpenSIPS events: ${err instanceof Error ? err.message : String(err)}; retrying in ${delay / 1000} s`)
      this.subscribed = false
      this.updateStatus()
      this.schedule(delay)
    }
  }

  /**
   * Asks OpenSIPS to send the probe event to its subscribers, this process among them: onHeard once it comes back.
   * Not back (an address not accepted, a datagram lost): not heard, the next renewal asks again.
   */
  private async probe(expire: number) {
    if (!this.options.onHeard) return
    this.probing = undefined
    const event = this.options.probeEvent
    if (event) {
      const probe = { nonce: randomBytes(12).toString('hex'), sentAt: Date.now(), expire }
      this.probing = probe
      try {
        await this.call('raise_event', [event, JSON.stringify({ probe: probe.nonce })])
        this.probeRefused = false
        return
      } catch (err) {
        if (this.probing === probe) this.probing = undefined
        // No reply: as a probe that does not come back. An error reply: this OpenSIPS's script does not know the event.
        if ((err as MiError).code === undefined) return
        if (!this.probeRefused) this.log.warn(`OpenSIPS events: ${event} refused (${err instanceof Error ? err.message : String(err)}); whether the events are heard is told by the addresses they come from only`)
        this.probeRefused = true
      }
    }
    if (!this.deaf) this.options.onHeard(expire)
  }

  /** The subscription now lives `expire` seconds in OpenSIPS: past that without a renewal, it is gone. */
  private keepAlive(expire: number) {
    this.alive = true
    clearTimeout(this.expiry)
    this.expiry = setTimeout(() => {
      if (this.stopped) return
      this.alive = false
      this.log.warn('OpenSIPS events: the subscription expired without a renewal; what OpenSIPS told is forgotten until it answers again')
      this.options.onExpired?.()
    }, expire * 1000)
    this.expiry.unref?.()
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(() => void this.renew(), ms)
    this.timer.unref?.()
  }

  private updateStatus() {
    const value = this.connected
    if (this.status === value) return
    this.status = value
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
 * One dialog as `dlg_list_ctx` with its Call-ID reports it (step 8b): its state, the user of its From, the caller's tag
 * and the values the script keeps in it (`$dlg_val`, strings; numbers as their digits). Undefined for anything else.
 */
export const parseDlgContext = (result: unknown): { callid: string; state: number; caller: string; callerTag: string; values: Record<string, string> } | undefined => {
  const d = (result as { Dialog?: { callid?: unknown; state?: unknown; from_uri?: unknown; caller_tag?: unknown; context?: { values?: unknown } } } | null)?.Dialog
  if (!d || typeof d.callid !== 'string' || typeof d.state !== 'number') return undefined
  const values: Record<string, string> = {}
  for (const item of Array.isArray(d.context?.values) ? d.context.values : []) {
    if (!item || typeof item !== 'object') continue
    for (const [name, value] of Object.entries(item as Record<string, unknown>)) if (typeof value === 'string' || typeof value === 'number') values[name] = String(value)
  }
  const uri = typeof d.from_uri === 'string' ? d.from_uri.replace(/^<|>$/g, '') : ''
  const caller = /^(?:sips?:)?([^@;>]+)@/.exec(uri)?.[1] ?? ''
  return { callid: d.callid, state: d.state, caller, callerTag: typeof d.caller_tag === 'string' ? d.caller_tag : '', values }
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
