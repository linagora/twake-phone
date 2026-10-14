import type { MediaProvider, ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Call, Capabilities, Endpoint, MediaSession, OriginateRequest, Presence, ProviderStatus, User } from '@twake/telephony-types'

export { SubscriberProvisioner, digestHashes, SUBSCRIBER_SCHEMA, SUBSCRIBER_TABLE_VERSION, type SubscriberProvisionerOptions, type Queryable } from './subscriber.js'

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
}

const notYet = (what: string) => Object.assign(new Error(`${what} through the Gateway arrives with the OpenSIPS events (step 4); the softphone does it directly for now`), { statusCode: 501 })

/**
 * Step 3: the SIP server registers browsers and routes their calls; call control happens in the softphone (JsSIP).
 * The Gateway's part is the media session: where to register and as whom. Events, presence, history and
 * click-to-call come with step 4 (`event_route` of OpenSIPS towards the Gateway).
 */
export class OpensipsProvider implements TelephonyProvider, MediaProvider {
  readonly id = 'opensips'
  private readonly presences = new Map<string, Presence>()

  constructor(private readonly config: OpensipsConfig) {
    for (const [name, value] of Object.entries({ websocketUrl: config.websocketUrl, domain: config.domain })) {
      if (typeof value !== 'string' || !value) throw new Error(`OpenSIPS provider: ${name} is required`)
    }
    if (!/^wss?:\/\//.test(config.websocketUrl)) throw new Error('OpenSIPS provider: websocketUrl must be a ws:// or wss:// URL')
  }

  getStatus(): ProviderStatus {
    return 'CONNECTED'
  }

  async getCapabilities(): Promise<Capabilities> {
    return {
      // The browser does the calling; the Gateway cannot originate for it yet (step 4).
      calling: { outbound: false, inbound: true, answer: false, hangup: false, hold: false, transfer: false, dtmf: false },
      media: { browserAudio: true },
      presence: { read: true, write: true, realtime: false, statuses: ['available', 'busy', 'away', 'dnd', 'offline'] },
      history: false,
      conference: { dialIn: false, dialOut: false }
    }
  }

  async getPresence(user: User): Promise<Presence> {
    return this.presences.get(`${user.tenantId}:${user.id}`) ?? { status: 'available', source: 'system' }
  }

  async setPresence(user: User, presence: Presence) {
    this.presences.set(`${user.tenantId}:${user.id}`, presence)
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

  /** No event stream yet: the iterator ends at once, so the Gateway's pump has nothing to wait on. */
  async *subscribe(): AsyncIterable<RoutedEvent> {}

  async close() {
    await this.config.onClose?.()
  }
}

export const opensipsProviderFactory: ProviderFactory<OpensipsConfig> = {
  type: 'opensips',
  create: config => new OpensipsProvider(config)
}
