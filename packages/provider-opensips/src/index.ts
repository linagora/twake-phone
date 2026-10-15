import type { MediaProvider, ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Call, Capabilities, Endpoint, MediaSession, OriginateRequest, Presence, ProviderStatus, User } from '@twake/telephony-types'
import { OpensipsEvents, parseDlgList, parseUlDump, type EventsLogger } from './events.js'
import { AsyncQueue } from './queue.js'
import { CallTracker } from './tracker.js'

export { SubscriberProvisioner, digestHashes, SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, EXTRA_COLUMNS, SUBSCRIBER_TABLE_VERSION, ACC_TABLE_VERSION, MISSED_CALLS_TABLE_VERSION, type SubscriberProvisionerOptions, type Queryable } from './subscriber.js'
export { OpensipsEvents, parseDlgList, parseUlDump, parseUdpUrl, type EventsLogger, type OpensipsEventsOptions, type RegisteredContact } from './events.js'
export { CallTracker, userOf, type ContactRegistration, type TelephonyPresence } from './tracker.js'
export { AsyncQueue } from './queue.js'

/** The events the Gateway listens to: registrations and their refreshes (usrloc), our own call events (opensips.cfg.tpl), the CDRs and missed calls (acc). */
export const SUBSCRIBED_EVENTS = [
  'E_UL_CONTACT_INSERT',
  'E_UL_CONTACT_UPDATE',
  'E_UL_CONTACT_DELETE',
  'E_UL_AOR_DELETE',
  'E_TWAKEPHONE_CALLING',
  'E_TWAKEPHONE_RINGING',
  'E_TWAKEPHONE_ANSWERED',
  'E_ACC_CDR',
  'E_ACC_MISSED_EVENT'
]

// Everything OpenSIPS-specific stays inside this package: the Gateway and the app only see the provider contract.

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface OpensipsConfig {
  /** Public SIP-over-WebSocket URL browsers register to (wss:// in production, ws:// on a local test stack). */
  websocketUrl: string
  /** SIP domain of the accounts (`sip:101@<domain>`), which is also the digest realm. */
  domain: string
  iceServers?: IceServer[]
  /** The per-user SIP secret, generated and kept by the Gateway, provisioned in `subscriber`. */
  sipSecretFor(extension: string): Promise<string>
  /** Releases what `sipSecretFor` holds (the provisioner's connection pool) when the Gateway stops. */
  onClose?(): Promise<void>
  /**
   * Where to hear OpenSIPS (ADR 0011): its MI socket (`mi_datagram`, `udp:host:port`), the address this process
   * listens on for the events (`host[:port]`; the loopback by default) and, when OpenSIPS must be given another
   * one (a wildcard `listen`, a container), the address it sends them to (`advertise`), and the addresses they may
   * come from besides the MI host (`from`: OpenSIPS sends them from the address the kernel picks). Without it the provider has
   * no events: no presence of the others, no history.
   */
  events?: { miUrl: string; listen?: string; advertise?: string; from?: string[]; expireSec?: number; timeoutMs?: number }
  logger?: EventsLogger
}

const START_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

const notYet = (what: string) => Object.assign(new Error(`${what} through the Gateway is not available yet; the softphone does it directly for now`), { statusCode: 501 })

/**
 * The SIP server registers browsers and routes their calls; call control happens in the softphone (JsSIP). The
 * Gateway's part is the media session (where to register and as whom) and, since step 4, what OpenSIPS tells it:
 * who is registered and in a call (presence), how each call went (history). Click-to-call comes later.
 */
export class OpensipsProvider implements TelephonyProvider, MediaProvider {
  readonly id = 'opensips'
  /** The presence of users without an extension: nothing but what they set themselves. */
  private readonly unmapped = new Map<string, Presence>()
  private readonly queue: AsyncQueue<RoutedEvent>
  private readonly tracker: CallTracker
  private readonly events?: OpensipsEvents
  private subscribed = false
  private closed = false
  private startTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly config: OpensipsConfig) {
    for (const [name, value] of Object.entries({ websocketUrl: config.websocketUrl, domain: config.domain })) {
      if (typeof value !== 'string' || !value) throw new Error(`OpenSIPS provider: ${name} is required`)
    }
    if (!/^wss?:\/\//.test(config.websocketUrl)) throw new Error('OpenSIPS provider: websocketUrl must be a ws:// or wss:// URL')
    const log = config.logger ?? console
    // A consumer stuck (a database that hangs) must not make the Gateway grow without bound: past 10 000 waiting
    // events, some are dropped, and said so. Presences go first: the next one replaces them, a call event has none.
    this.queue = new AsyncQueue<RoutedEvent>(
      10_000,
      dropped => log.warn(`OpenSIPS events: the Gateway does not keep up, events dropped (${dropped} so far)`),
      e => e.event.type === 'presence.changed'
    )
    this.tracker = new CallTracker((extension, event) => this.queue.push({ extension, event }))
    if (config.events) {
      this.events = new OpensipsEvents({
        miUrl: config.events.miUrl,
        ...(config.events.listen ? { listen: config.events.listen } : {}),
        ...(config.events.advertise ? { advertise: config.events.advertise } : {}),
        ...(config.events.from?.length ? { from: config.events.from } : {}),
        ...(config.events.expireSec ? { expireSec: config.events.expireSec } : {}),
        ...(config.events.timeoutMs ? { timeoutMs: config.events.timeoutMs } : {}),
        events: SUBSCRIBED_EVENTS,
        onEvent: (method, params) => this.tracker.handle(method, params),
        onResync: () => this.resync(),
        onRenewed: () => this.tracker.sweep(),
        // The subscription lapsed in OpenSIPS: the registrations it told no longer hold (everyone offline) until
        // the next resync, which also ends the calls it no longer has. A failed renewal alone changes nothing.
        onExpired: () => {
          if (!this.closed) this.tracker.reset()
        },
        logger: log
      })
      this.startEvents(0, log)
    }
  }

  /** Binds the event socket; a failure (address in use, not ours yet) is tried again with a growing delay. */
  private startEvents(attempt: number, log: EventsLogger) {
    this.events?.start().catch(err => {
      if (this.closed) return
      const delay = START_RETRY_MS[Math.min(attempt, START_RETRY_MS.length - 1)]!
      log.warn(`OpenSIPS events not started: ${err instanceof Error ? err.message : String(err)}; retrying in ${delay / 1000} s`)
      this.startTimer = setTimeout(() => this.startEvents(attempt + 1, log), delay)
      this.startTimer.unref?.()
    })
  }

  /**
   * What OpenSIPS holds now, read again after each (re)subscription and restart: registrations, then dialogs. What
   * is known is taken before each question: an event that comes while the answer is on its way is newer than it.
   */
  private async resync() {
    if (!this.events) return
    const contacts = this.tracker.knownContacts()
    this.tracker.seedRegistrations(parseUlDump(await this.events.call('ul_dump')), contacts)
    const calls = this.tracker.knownCalls()
    this.tracker.seedDialogs(parseDlgList(await this.events.call('dlg_list')), calls)
  }

  /** DEGRADED while the events are configured but not subscribed (OpenSIPS down or restarting): calls still go through. */
  getStatus(): ProviderStatus {
    return !this.events || this.events.connected ? 'CONNECTED' : 'DEGRADED'
  }

  getStatusReason(): string | undefined {
    return this.events?.reason
  }

  async getCapabilities(): Promise<Capabilities> {
    return {
      // The browser does the calling; the Gateway cannot originate for it yet.
      calling: { outbound: false, inbound: true, answer: false, hangup: false, hold: false, transfer: false, dtmf: false },
      media: { browserAudio: true },
      // Presences are told as they change only while OpenSIPS's events come; the history is filled from them.
      presence: { read: true, write: true, realtime: !!this.events?.live, statuses: ['available', 'busy', 'away', 'dnd', 'offline'] },
      history: !!this.events,
      conference: { dialIn: false, dialOut: false }
    }
  }

  /** The presence of a user with an extension comes from the SIP server (registered, in a call) and what they set. */
  async getPresence(user: User): Promise<Presence> {
    if (user.extension) return this.tracker.presenceOf(user.extension)
    return this.unmapped.get(`${user.tenantId}:${user.id}`) ?? { status: 'available', source: 'system' }
  }

  async setPresence(user: User, presence: Presence) {
    if (user.extension) this.tracker.setUserPresence(user.extension, presence)
    else this.unmapped.set(`${user.tenantId}:${user.id}`, presence)
  }

  /** The presence of every extension the SIP server told about. */
  presences(): Map<string, Presence> {
    return this.tracker.presences()
  }

  async getSession(user: User, endpoint: Endpoint): Promise<MediaSession> {
    if (endpoint.type !== 'browser') return { type: 'external' }
    if (!user.extension) throw Object.assign(new Error('No extension is assigned to this user'), { statusCode: 404 })
    return {
      type: 'sip-webrtc',
      websocketUrl: this.config.websocketUrl,
      domain: this.config.domain,
      username: user.extension,
      credential: await this.config.sipSecretFor(user.extension),
      iceServers: this.config.iceServers ?? []
    }
  }

  async originate(_request: OriginateRequest): Promise<Call> {
    throw notYet('Click-to-call')
  }
  async answer() {
    throw notYet('Answering')
  }
  async hangup() {
    throw notYet('Hanging up')
  }
  async hold() {
    throw notYet('Holding')
  }
  async resume() {
    throw notYet('Resuming')
  }
  async transfer() {
    throw notYet('Transferring')
  }
  async sendDTMF() {
    throw notYet('Sending DTMF')
  }

  /** The call and presence events, as the SIP server tells them; ends when the provider closes. One consumer. */
  subscribe(): AsyncIterable<RoutedEvent> {
    if (this.subscribed) throw new Error('OpenSIPS provider: subscribe() takes one consumer')
    this.subscribed = true
    return this.queue
  }

  async close() {
    this.closed = true
    clearTimeout(this.startTimer)
    await this.events?.stop()
    this.queue.close()
    await this.config.onClose?.()
  }
}

export const opensipsProviderFactory: ProviderFactory<OpensipsConfig> = {
  type: 'opensips',
  create: config => new OpensipsProvider(config)
}
