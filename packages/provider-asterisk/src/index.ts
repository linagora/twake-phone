import { randomUUID } from 'node:crypto'
import type { MediaProvider, ProviderFactory, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import { SipWebrtcMediaProvider, type IceServer } from './sip-media.js'
import type {
  Call,
  Capabilities,
  Endpoint,
  MediaSession,
  OriginateRequest,
  Presence,
  PresenceStatus,
  ProviderStatus,
  User
} from '@twake/telephony-types'
import { AriClient, type AriConfig } from './ari.js'
import { AsyncQueue } from './queue.js'
import { CallTracker, type Hint } from './tracker.js'

export { miniPbxProvisioner, type SecretProvisioner } from './provisioner.js'

// Everything Asterisk-specific (ARI, PJSIP endpoints, device states) stays inside this package.

export interface AsteriskConfig {
  ari: Omit<AriConfig, 'app'> & { app?: string }
  /** Public SIP-over-WSS URL browsers register to. */
  websocketUrl: string
  iceServers?: IceServer[]
  /** Dev PBXs use a static SIP secret; production must plug a short-lived credential source. */
  sipSecretFor(extension: string): Promise<string>
  /** Endpoint used to reach external numbers (E.164). Absent: external calls are refused. */
  trunkEndpoint?: string
  /**
   * Dialplan context whose extensions ring every registered window of an extension, e.g. `twake-ring`
   * (`Dial(${PJSIP_DIAL_CONTACTS(${EXTEN})})`). Without it, calls go straight to `PJSIP/<ext>`, which in Asterisk
   * reaches a single contact: with several windows open the one that rings may not be the one in use.
   */
  originateContext?: string
  /**
   * Send external numbers through a dialplan context of the PBX (e.g. MiniPBX's `minipbx-internal`), so its own
   * outbound rules apply (blocked international calls, emergency numbers, caller checks), instead of dialling the
   * trunk directly, which bypasses them. Numbers arrive in E.164 and are turned into what that dialplan expects.
   */
  externalDial?: ExternalDial
}

export interface ExternalDial {
  context: string
  /** E.164 prefix of the PBX's own country, e.g. "+33"... */
  e164Prefix?: string
  /** ...replaced by its national trunk prefix, e.g. "0": +33612345678 becomes 0612345678. */
  nationalPrefix?: string
}

/** Dial string for a number in E.164: national form for the PBX's country, "00…" international form otherwise. */
export const externalDialString = (target: string, cfg: ExternalDial): string => {
  const digits = target.replace(/\D/g, '')
  if (!target.startsWith('+')) return target
  if (cfg.e164Prefix && target.startsWith(cfg.e164Prefix)) return `${cfg.nationalPrefix ?? ''}${target.slice(cfg.e164Prefix.length).replace(/\D/g, '')}`
  return `00${digits}`
}

const INTERNAL_EXTENSION = /^\d{2,6}$/

const requireExtension = (user: User): string => {
  if (!user.extension) throw Object.assign(new Error('User has no telephony identity'), { statusCode: 409 })
  return user.extension
}

export class AsteriskProvider implements TelephonyProvider, MediaProvider {
  readonly id = 'asterisk'
  private readonly ari: AriClient
  private readonly queue = new AsyncQueue<RoutedEvent>()
  private readonly tracker: CallTracker
  private readonly media: SipWebrtcMediaProvider
  private readonly flows = new Map<string, { bridgeId?: string; target: string; extension: string }>()
  private readonly idempotent = new Map<string, Call>()
  private status: ProviderStatus = 'DISCONNECTED'
  private stopEvents: () => void

  constructor(private readonly config: AsteriskConfig) {
    const app = config.ari.app ?? 'twake'
    this.ari = new AriClient({ ...config.ari, app })
    this.tracker = new CallTracker((extension, event) => this.queue.push({ extension, event }))
    this.media = new SipWebrtcMediaProvider({
      websocketUrl: config.websocketUrl,
      iceServers: config.iceServers ?? [],
      credentialFor: async user => {
        const extension = requireExtension(user)
        return { username: extension, credential: await config.sipSecretFor(extension) }
      }
    })
    this.stopEvents = this.ari.events({
      onUp: () => {
        this.status = 'CONNECTED'
        void this.seedDeviceStates()
      },
      onDown: () => {
        this.status = 'DISCONNECTED'
      },
      onEvent: e => {
        this.tracker.handle(e)
        void this.orchestrate(e).catch(() => {
          // a failed second leg must not break the event loop; the origin leg is hung up below
        })
      }
    })
  }

  getStatus(): ProviderStatus {
    return this.status
  }

  async getCapabilities(): Promise<Capabilities> {
    return {
      calling: {
        outbound: true,
        inbound: true,
        // Answering is done by the endpoint itself (browser SIP); the PBX leg is not Stasis-controlled.
        answer: false,
        hangup: true,
        hold: true,
        transfer: false,
        dtmf: true
      },
      media: { browserAudio: true },
      presence: { read: true, write: true, realtime: true, statuses: ['available', 'busy', 'away', 'dnd', 'offline'] },
      history: false,
      conference: { dialIn: false, dialOut: false }
    }
  }

  getSession(user: User, endpoint: Endpoint): Promise<MediaSession> {
    return this.media.getSession(user, endpoint)
  }

  async getPresence(user: User): Promise<Presence> {
    return this.tracker.getPresence(requireExtension(user))
  }

  async setPresence(user: User, presence: Presence): Promise<void> {
    const ext = requireExtension(user)
    const set = (name: string, busy: boolean) =>
      this.ari.request('PUT', `/deviceStates/Stasis:${name}${ext}`, { deviceState: busy ? 'BUSY' : 'NOT_INUSE' })
    const status: PresenceStatus = presence.status
    if (status === 'dnd' || status === 'away' || status === 'available') {
      await Promise.all([set('dnd', status === 'dnd'), set('away', status === 'away')])
    } else {
      throw Object.assign(new Error(`Presence ${status} is derived from telephony and cannot be set`), { statusCode: 400 })
    }
  }

  async originate(request: OriginateRequest): Promise<Call> {
    const extension = requireExtension(request.user)
    // Without the ARI event link the PBX cannot hand the call over to us: fail loudly, do not ring in vain.
    if (this.status !== 'CONNECTED') {
      throw Object.assign(new Error('Telephony provider is not connected'), { statusCode: 503 })
    }
    const key = request.idempotencyKey && `${extension}:${request.idempotencyKey}`
    const known = key ? this.idempotent.get(key) : undefined
    if (known) return known
    this.peerEndpoint(request.target)
    // ARI originates straight to the endpoint and bypasses the dialplan's DND check: enforce it here.
    if (INTERNAL_EXTENSION.test(request.target) && this.tracker.getPresence(request.target).status === 'dnd') {
      throw Object.assign(new Error('Target is in do-not-disturb'), { statusCode: 486 })
    }

    const id = randomUUID()
    this.flows.set(id, { target: request.target, extension })
    this.tracker.hint(id, { direction: 'outbound', remoteNumber: request.target })
    // Click-to-call: the user's endpoint is rung first, then the target is dialled and bridged.
    const first = await this.ari.request<{ name?: string }>('POST', '/channels', {
      endpoint: this.ringEndpoint(extension),
      app: this.config.ari.app ?? 'twake',
      appArgs: 'dial',
      callerId: extension,
      channelId: id,
      timeout: 30
    })
    // Through a Local channel the user's phone is a different channel than the one we created: say what it stands for.
    this.hintLocal(first.name, { direction: 'outbound', remoteNumber: request.target, callId: id })
    const call: Call = { id, direction: 'outbound', state: 'new', remoteNumber: request.target }
    if (key) this.idempotent.set(key, call)
    return call
  }

  async answer(): Promise<void> {
    throw Object.assign(new Error('Calls are answered by the endpoint'), { statusCode: 409 })
  }

  async hangup(callId: string): Promise<void> {
    await this.ari.request('DELETE', `/channels/${callId}`)
  }

  async hold(callId: string): Promise<void> {
    await this.ari.request('POST', `/channels/${await this.peerOf(callId)}/hold`)
    this.tracker.markHeld(callId, true)
  }

  async resume(callId: string): Promise<void> {
    await this.ari.request('DELETE', `/channels/${await this.peerOf(callId)}/hold`)
    this.tracker.markHeld(callId, false)
  }

  async transfer(): Promise<void> {
    throw Object.assign(new Error('Transfer is not supported by this provider'), { statusCode: 501 })
  }

  async sendDTMF(callId: string, digits: string): Promise<void> {
    await this.ari.request('POST', `/channels/${await this.peerOf(callId)}/dtmf`, { dtmf: digits })
  }

  subscribe(): AsyncIterable<RoutedEvent> {
    return this.queue
  }

  async close(): Promise<void> {
    this.stopEvents()
    this.queue.close()
  }

  private peerEndpoint(target: string): string {
    if (INTERNAL_EXTENSION.test(target)) return this.ringEndpoint(target)
    const external = this.config.externalDial
    if (external) return `Local/${externalDialString(target, external)}@${external.context}/n`
    if (!this.config.trunkEndpoint) throw Object.assign(new Error('External calls are not enabled'), { statusCode: 403 })
    return `PJSIP/${target}@${this.config.trunkEndpoint}`
  }

  /** Where to send a call for an internal extension: every window if the PBX provides the ring-all context. */
  private ringEndpoint(extension: string): string {
    const context = this.config.originateContext
    return context ? `Local/${extension}@${context}/n` : `PJSIP/${extension}`
  }

  /** The party the user talks to: the other channel of the bridge the leg is in. */
  private async peerOf(callId: string): Promise<string> {
    const bridges = await this.ari.request<{ channels: string[] }[]>('GET', '/bridges')
    const peer = bridges.find(b => b.channels.includes(callId))?.channels.find(c => c !== callId)
    if (!peer) throw Object.assign(new Error('Call is not bridged'), { statusCode: 409 })
    return peer
  }

  private hintLocal(name: string | undefined, hint: Hint) {
    if (name?.startsWith('Local/')) this.tracker.hintLocal(name.replace(/;\d$/, ''), hint)
  }

  private async seedDeviceStates() {
    try {
      this.tracker.seedDeviceStates(await this.ari.request('GET', '/deviceStates'))
    } catch {
      // presence falls back to events only
    }
  }

  /** Second leg and bridge of click-to-call originated calls. */
  private async orchestrate(e: { type: string; channel?: { id: string }; args?: string[] }) {
    const id = e.channel?.id
    if (!id) return
    const flowId = id.endsWith('-b') ? id.slice(0, -2) : id
    const flow = this.flows.get(flowId)
    if (!flow) return

    if (e.type === 'StasisStart' && id === flowId) {
      const bridge = await this.ari.request<{ id: string }>('POST', '/bridges', { type: 'mixing' })
      flow.bridgeId = bridge.id
      await this.ari.request('POST', `/bridges/${bridge.id}/addChannel`, { channel: id })
      const bId = `${flowId}-b`
      this.tracker.hint(bId, { direction: 'inbound', remoteNumber: flow.extension })
      try {
        const second = await this.ari.request<{ name?: string }>('POST', '/channels', {
          endpoint: this.peerEndpoint(flow.target),
          app: this.config.ari.app ?? 'twake',
          appArgs: 'peer',
          callerId: flow.extension,
          channelId: bId,
          timeout: 30
        })
        this.hintLocal(second.name, { direction: 'inbound', remoteNumber: flow.extension, callId: bId })
      } catch (error) {
        await this.ari.request('DELETE', `/channels/${flowId}`).catch(() => undefined)
        throw error
      }
    } else if (e.type === 'StasisStart' && id === `${flowId}-b` && flow.bridgeId) {
      await this.ari.request('POST', `/bridges/${flow.bridgeId}/addChannel`, { channel: id })
    } else if (e.type === 'ChannelDestroyed') {
      // One side is gone: release the other side and the bridge.
      const other = id === flowId ? `${flowId}-b` : flowId
      await this.ari.request('DELETE', `/channels/${other}`).catch(() => undefined)
      if (flow.bridgeId) await this.ari.request('DELETE', `/bridges/${flow.bridgeId}`).catch(() => undefined)
      this.flows.delete(flowId)
    }
  }
}

export const asteriskProviderFactory: ProviderFactory<AsteriskConfig> = {
  type: 'asterisk',
  create: config => new AsteriskProvider(config)
}
