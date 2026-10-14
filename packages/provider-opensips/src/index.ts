import type { MediaProvider, ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Call, Capabilities, Endpoint, MediaSession, OriginateRequest, Presence, ProviderStatus, User } from '@twake/telephony-types'
import { OpensipsEvents, parseDlgList, parseUlDump, type EventsLogger } from './events.js'
import { AsyncQueue } from './queue.js'
import { CallTracker } from './tracker.js'

export { SubscriberProvisioner, digestHashes, SUBSCRIBER_SCHEMA, SUBSCRIBER_TABLE_VERSION, ACC_TABLE_VERSION, MISSED_CALLS_TABLE_VERSION, type SubscriberProvisionerOptions, type Queryable } from './subscriber.js'
export { OpensipsEvents, parseDlgList, parseUlDump, parseUdpUrl, type EventsLogger, type OpensipsEventsOptions } from './events.js'
export { CallTracker, userOf, type TelephonyPresence } from './tracker.js'

/** The events the Gateway listens to: registrations (usrloc), our own call events (opensips.cfg.tpl), the CDRs and missed calls (acc). */
export const SUBSCRIBED_EVENTS = [
  'E_UL_CONTACT_INSERT',
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
   * Where to hear OpenSIPS (ADR 0011): its MI socket (`mi_datagram`, `udp:host:port`) and the address this process
   * listens on for the events (`host[:port]`, reachable from OpenSIPS; the loopback by default). Without it the
   * provider has no events: no presence of the others, no history.
   */
  events?: { miUrl: string; listen?: string; expireSec?: number }
  logger?: EventsLogger
}

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
  private readonly queue = new AsyncQueue<RoutedEvent>()
  private readonly tracker: CallTracker
  private readonly events?: OpensipsEvents
  private subscribed = false

  constructor(private readonly config: OpensipsConfig) {
    for (const [name, value] of Object.entries({ websocketUrl: config.websocketUrl, domain: config.domain })) {
      if (typeof value !== 'string' || !value) throw new Error(`OpenSIPS provider: ${name} is required`)
    }
    if (!/^wss?:\/\//.test(config.websocketUrl)) throw new Error('OpenSIPS provider: websocketUrl must be a ws:// or wss:// URL')
    this.tracker = new CallTracker((extension, event) => this.queue.push({ extension, event }))
    if (config.events) {
      const log = config.logger ?? console
      this.events = new OpensipsEvents({
        miUrl: config.events.miUrl,
        ...(config.events.listen ? { listen: config.events.listen } : {}),
        ...(config.events.expireSec ? { expireSec: config.events.expireSec } : {}),
        events: SUBSCRIBED_EVENTS,
        onEvent: (method, params) => this.tracker.handle(method, params),
        onResync: () => this.resync(),
        logger: log
      })
      this.events.start().catch(err => log.warn(`OpenSIPS events not started: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  /** What OpenSIPS holds now, read again after each (re)subscription: registrations, then dialogs. */
  private async resync() {
    if (!this.events) return
    this.tracker.seedRegistrations(parseUlDump(await this.events.call('ul_dump')))
    this.tracker.seedDialogs(parseDlgList(await this.events.call('dlg_list')))
  }

  /** DEGRADED while the events are configured but not subscribed (OpenSIPS down or restarting): calls still go through. */
  getStatus(): ProviderStatus {
    return !this.events || this.events.connected ? 'CONNECTED' : 'DEGRADED'
  }

  async getCapabilities(): Promise<Capabilities> {
    return {
      // The browser does the calling; the Gateway cannot originate for it yet.
      calling: { outbound: false, inbound: true, answer: false, hangup: false, hold: false, transfer: false, dtmf: false },
      media: { browserAudio: true },
      presence: { read: true, write: true, realtime: !!this.events, statuses: ['available', 'busy', 'away', 'dnd', 'offline'] },
      history: false,
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
    this.events?.stop()
    this.queue.close()
    await this.config.onClose?.()
  }
}

export const opensipsProviderFactory: ProviderFactory<OpensipsConfig> = {
  type: 'opensips',
  create: config => new OpensipsProvider(config)
}
