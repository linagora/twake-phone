import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  type Session
} from 'sip.js'
import { holdModifier, type SessionDescriptionHandler } from 'sip.js/lib/platform/web/index.js'
import type { MediaSession } from '@twake/telephony-types'

/** Media plane only: SIP-over-WebSocket + WebRTC. Call control and presence stay on the Gateway API. */
export type SipWebrtcSession = Extract<MediaSession, { type: 'sip-webrtc' }>

export type SoftCallState = 'new' | 'ringing' | 'connected' | 'held' | 'ended'

export interface SoftCall {
  readonly id: string
  readonly direction: 'inbound' | 'outbound'
  readonly remoteNumber: string
  readonly state: SoftCallState
  answer(): Promise<void>
  reject(): Promise<void>
  hangup(): Promise<void>
  hold(): Promise<void>
  resume(): Promise<void>
  setMuted(muted: boolean): void
  sendDtmf(tone: string): boolean
  /** Inbound RTP packet counters, to tell whether audio actually flows. */
  stats(): Promise<{ packetsReceived: number; packetsSent: number }>
}

export type RegistrationState = 'unregistered' | 'registered' | 'failed'

export interface SoftphoneOptions {
  /** Fetched at each (re)start so short-lived credentials can be used. */
  getSession(): Promise<SipWebrtcSession>
  remoteAudio: HTMLAudioElement
  onRegistration?(state: RegistrationState): void
  onIncoming?(call: SoftCall): void
  onCallChange?(call: SoftCall): void
}

class WebCall implements SoftCall {
  state: SoftCallState = 'new'
  private muted = false

  constructor(
    readonly id: string,
    readonly direction: 'inbound' | 'outbound',
    readonly remoteNumber: string,
    private readonly session: Session,
    private readonly audio: HTMLAudioElement,
    private readonly changed: (call: WebCall) => void
  ) {
    session.stateChange.addListener(s => {
      if (s === SessionState.Established) {
        this.attachRemoteAudio()
        this.set('connected')
      } else if (s === SessionState.Terminated) this.set('ended')
    })
  }

  private set(state: SoftCallState) {
    if (this.state === state) return
    this.state = state
    this.changed(this)
  }

  ringing() {
    this.set('ringing')
  }

  private get pc(): RTCPeerConnection | undefined {
    return (this.session.sessionDescriptionHandler as SessionDescriptionHandler | undefined)?.peerConnection
  }

  private attachRemoteAudio() {
    const stream = new MediaStream()
    this.pc?.getReceivers().forEach(r => r.track && stream.addTrack(r.track))
    this.audio.srcObject = stream
    void this.audio.play().catch(() => {
      // autoplay restrictions: the UI must resume playback on a user gesture
    })
  }

  async answer() {
    if (!(this.session instanceof Invitation)) throw new Error('Only inbound calls can be answered')
    await this.session.accept()
  }

  async reject() {
    if (this.session instanceof Invitation) await this.session.reject()
    else await this.hangup()
  }

  async hangup() {
    switch (this.session.state) {
      case SessionState.Initial:
      case SessionState.Establishing:
        if (this.session instanceof Inviter) await this.session.cancel()
        else if (this.session instanceof Invitation) await this.session.reject()
        break
      case SessionState.Established:
        await this.session.bye()
        break
    }
  }

  private async reinvite(hold: boolean) {
    await this.session.invite({
      requestDelegate: { onAccept: () => this.set(hold ? 'held' : 'connected') },
      sessionDescriptionHandlerModifiers: hold ? [holdModifier] : []
    })
  }

  hold() {
    return this.reinvite(true)
  }

  resume() {
    return this.reinvite(false)
  }

  setMuted(muted: boolean) {
    this.muted = muted
    this.pc?.getSenders().forEach(s => {
      if (s.track) s.track.enabled = !this.muted
    })
  }

  sendDtmf(tone: string) {
    return (this.session.sessionDescriptionHandler as SessionDescriptionHandler | undefined)?.sendDtmf(tone) ?? false
  }

  async stats() {
    let packetsReceived = 0
    let packetsSent = 0
    const report = await this.pc?.getStats()
    report?.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') packetsReceived += r.packetsReceived ?? 0
      if (r.type === 'outbound-rtp' && r.kind === 'audio') packetsSent += r.packetsSent ?? 0
    })
    return { packetsReceived, packetsSent }
  }
}

const reconnectDelay = (attempt: number) => Math.floor(Math.random() * Math.min(30_000, 500 * 2 ** attempt))

export class Softphone {
  private ua?: UserAgent
  private registerer?: Registerer
  private domain = ''
  private stopped = false
  private attempt = 0
  private timer?: ReturnType<typeof setTimeout>
  private restartTimer?: ReturnType<typeof setTimeout>
  private restartAttempt = 0
  private pagehideBound = false

  constructor(private readonly options: SoftphoneOptions) {}

  async start() {
    this.stopped = false
    await this.boot()
  }

  private async boot() {
    const session = await this.options.getSession()
    this.domain = new URL(session.websocketUrl).hostname
    const uri = UserAgent.makeURI(`sip:${session.username}@${this.domain}`)
    if (!uri) throw new Error('Invalid SIP identity')
    this.ua = new UserAgent({
      uri,
      transportOptions: { server: session.websocketUrl },
      authorizationUsername: session.username,
      authorizationPassword: session.credential,
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: session.iceServers },
        constraints: { audio: true, video: false }
      },
      delegate: {
        onInvite: invitation => {
          const call = this.wrap(invitation, 'inbound', invitation.remoteIdentity.uri.user ?? '')
          this.options.onIncoming?.(call)
          call.ringing()
        },
        onDisconnect: () => {
          this.options.onRegistration?.('unregistered')
          this.scheduleReconnect()
        }
      }
    })
    await this.ua.start()
    this.registerer = new Registerer(this.ua)
    this.registerer.stateChange.addListener(s => {
      if (s === RegistererState.Registered) this.options.onRegistration?.('registered')
      else if (s === RegistererState.Unregistered) {
        this.options.onRegistration?.('unregistered')
        // A refresh refused by the PBX (secret changed, contact evicted): rebuild everything with a fresh session.
        if (!this.stopped) this.scheduleRestart()
      }
    })
    // Leaving the page: drop the registration so the PBX does not keep ringing a window that is gone.
    if (!this.pagehideBound) {
      this.pagehideBound = true
      window.addEventListener('pagehide', () => void this.registerer?.unregister().catch(() => undefined))
    }
    try {
      await this.registerer.register()
    } catch (error) {
      this.options.onRegistration?.('failed')
      throw error
    }
  }

  async call(target: string): Promise<SoftCall> {
    if (!this.ua) throw new Error('Softphone not started')
    const uri = UserAgent.makeURI(`sip:${target}@${this.domain}`)
    if (!uri) throw new Error('Invalid target')
    const inviter = new Inviter(this.ua, uri)
    const call = this.wrap(inviter, 'outbound', target)
    await inviter.invite()
    return call
  }

  /**
   * The WebSocket to the PBX drops on network changes and PBX restarts. Without a reconnect the page would
   * stay deaf until reloaded: retry with exponential backoff and jitter, then register again.
   */
  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = undefined
      if (this.stopped) return
      try {
        await this.ua?.stop().catch(() => undefined)
        await this.boot()
        this.restartAttempt = 0
      } catch {
        this.restartAttempt++
        this.scheduleRestart()
      }
    }, reconnectDelay(this.restartAttempt))
  }

  private scheduleReconnect() {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(async () => {
      this.timer = undefined
      if (this.stopped || !this.ua) return
      try {
        await this.ua.reconnect()
        await this.registerer?.register()
        // The Registerer keeps its "Registered" state across a transport drop, so no state change is emitted.
        this.options.onRegistration?.('registered')
        this.attempt = 0
      } catch {
        this.attempt++
        this.scheduleReconnect()
      }
    }, reconnectDelay(this.attempt))
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.restartTimer)
    await this.registerer?.unregister().catch(() => undefined)
    await this.ua?.stop()
  }

  private wrap(session: Session, direction: 'inbound' | 'outbound', remote: string) {
    return new WebCall(session.id, direction, remote, session, this.options.remoteAudio, c => this.options.onCallChange?.(c))
  }
}
