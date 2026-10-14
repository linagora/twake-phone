import { UA, WebSocketInterface } from 'jssip'
import type { EndEvent, RTCSession } from 'jssip/lib/RTCSession.js'
import type { UAConfiguration } from 'jssip/lib/UA.js'
import type { MediaSession } from '@twake/telephony-types'

/**
 * Media plane only: SIP over WebSocket (JsSIP) and WebRTC in the browser. The Gateway says where to register and as
 * whom (`/me/media-session`); call control for the user's own calls happens here, directly with the SIP server.
 */
export type SipWebrtcSession = Extract<MediaSession, { type: 'sip-webrtc' }>

export type SoftCallState = 'new' | 'ringing' | 'connected' | 'held' | 'ended'

/** Why a call ended, as the SIP layer reports it: the UI tells the user, the history keeps it. */
export type EndReason = 'hangup' | 'rejected' | 'busy' | 'no-answer' | 'unavailable' | 'cancelled' | 'failed'

export type DtmfTransport = 'RFC2833' | 'INFO'

export interface SoftCall {
  readonly id: string
  readonly direction: 'inbound' | 'outbound'
  readonly remoteNumber: string
  /** Display name the far end gave, if any. Never trusted for anything but display. */
  readonly remoteName: string
  readonly state: SoftCallState
  readonly startedAt: Date
  readonly connectedAt?: Date
  readonly endedAt?: Date
  readonly endReason?: EndReason
  /** SIP status code the call ended with, when a response ended it (404 nobody registered, 480 a dead contact...). */
  readonly endStatus?: number
  /** The far end put us on hold (re-INVITE with sendonly or inactive). */
  readonly remoteHold: boolean
  readonly muted: boolean
  /** A re-INVITE of ours (hold, resume) is waiting for the far end's answer: no other offer until then. */
  readonly renegotiating: boolean
  answer(): Promise<void>
  reject(): Promise<void>
  hangup(): Promise<void>
  hold(): Promise<void>
  resume(): Promise<void>
  setMuted(muted: boolean): void
  /** One tone (0-9, *, #, A-D). RFC 4733 in the RTP stream by default, as trunks and PBXs expect; SIP INFO on demand. */
  sendDtmf(tone: string, transport?: DtmfTransport): void
  /** RTP packet counters, to tell whether audio actually flows. */
  stats(): Promise<{ packetsReceived: number; packetsSent: number }>
}

export type RegistrationState = 'unregistered' | 'registered' | 'failed'

export interface SoftphoneOptions {
  /** Fetched at each (re)start so a rotated secret is picked up. */
  getSession(): Promise<SipWebrtcSession>
  remoteAudio: HTMLAudioElement
  /** Display name sent with calls (From header); the far end shows it. */
  displayName?: string
  onRegistration?(state: RegistrationState, detail?: string): void
  onIncoming?(call: SoftCall): void
  onCallChange?(call: SoftCall): void
  /** A tone the far end sent (SIP INFO; RFC 4733 tones stay in the media and are not reported). */
  onDtmf?(call: SoftCall, tone: string): void
  /** Test seam: builds the SIP user agent. */
  createUserAgent?(config: UAConfiguration): UserAgentLike
  /** Test seam: the WebSocket transport. */
  createSocket?(url: string): UAConfiguration['sockets']
}

/** The part of JsSIP's UA the softphone uses (and tests fake). */
export interface UserAgentLike {
  on(event: string, listener: (...args: any[]) => void): unknown
  start(): void
  stop(): void
  unregister(options?: { all?: boolean }): void
  isRegistered(): boolean
  call(target: string, options?: Record<string, unknown>): RTCSession
}

/** JsSIP's causes (Constants.causes) to what the user is told. */
const CAUSE_TO_REASON: Record<string, EndReason> = {
  Terminated: 'hangup',
  Canceled: 'cancelled',
  Rejected: 'rejected',
  Busy: 'busy',
  'No Answer': 'no-answer',
  Expires: 'no-answer',
  'Request Timeout': 'no-answer',
  Unavailable: 'unavailable',
  'Not Found': 'unavailable',
  'Address Incomplete': 'unavailable',
  Redirected: 'unavailable'
}

const toReason = (cause: string | undefined): EndReason => (cause && CAUSE_TO_REASON[cause]) || (cause ? 'failed' : 'hangup')

class WebCall implements SoftCall {
  state: SoftCallState = 'new'
  readonly startedAt = new Date()
  connectedAt?: Date
  endedAt?: Date
  endReason?: EndReason
  endStatus?: number
  remoteHold = false
  muted = false
  renegotiating = false
  readonly remoteNumber: string
  readonly remoteName: string
  private reofferPending?: { reject: (e: Error) => void }

  constructor(
    readonly id: string,
    readonly direction: 'inbound' | 'outbound',
    private readonly session: RTCSession,
    private readonly audio: HTMLAudioElement,
    private readonly changed: (call: WebCall) => void,
    private readonly dtmf: (call: WebCall, tone: string) => void,
    private readonly iceServers: RTCIceServer[]
  ) {
    this.remoteNumber = session.remote_identity?.uri?.user ?? ''
    this.remoteName = session.remote_identity?.display_name ?? ''
    // An outgoing session has its peer connection before anyone can listen; an incoming one gets it on answer().
    const pc = session.connection as unknown as RTCPeerConnection | undefined
    if (pc) this.attachRemoteAudio(pc)
    else session.on('peerconnection', (e: { peerconnection: RTCPeerConnection }) => this.attachRemoteAudio(e.peerconnection))
    session.on('progress', () => this.set('ringing'))
    session.on('accepted', () => {
      this.connectedAt ??= new Date()
      this.set('connected')
    })
    session.on('confirmed', () => {
      this.connectedAt ??= new Date()
      if (this.state !== 'held') this.set('connected')
    })
    session.on('hold', (e: { originator: string }) => {
      if (e.originator === 'local') {
        this.set('held')
      } else {
        this.remoteHold = true
        this.changed(this)
      }
    })
    session.on('unhold', (e: { originator: string }) => {
      if (e.originator === 'local') {
        this.set('connected')
      } else {
        this.remoteHold = false
        this.changed(this)
      }
    })
    session.on('muted', () => {
      this.muted = true
      this.changed(this)
    })
    session.on('unmuted', () => {
      this.muted = false
      this.changed(this)
    })
    session.on('newDTMF', (e: { originator: string; dtmf: { tone: string } }) => {
      if (e.originator === 'remote') this.dtmf(this, e.dtmf.tone)
    })
    const end = (e: EndEvent) => {
      this.endedAt = new Date()
      this.endReason = toReason(e.cause)
      // A response (the far end's 404, 480, 486, 603...) carries a status; a request (a BYE) does not.
      const status = e.message && 'status_code' in e.message ? (e.message as { status_code?: unknown }).status_code : undefined
      this.endStatus = typeof status === 'number' ? status : undefined
      this.reofferPending?.reject(new Error('Call ended'))
      this.reofferPending = undefined
      this.renegotiating = false
      this.set('ended')
    }
    session.on('ended', end)
    session.on('failed', end)
    // An outgoing call is placed as soon as the INVITE leaves; the UI shows it dialing until the far end rings.
    if (direction === 'inbound') this.state = 'ringing'
  }

  private set(state: SoftCallState) {
    if (this.state === state) return
    this.state = state
    this.changed(this)
  }

  private get pc(): RTCPeerConnection | undefined {
    return (this.session.connection as unknown as RTCPeerConnection | undefined) ?? undefined
  }

  private attachRemoteAudio(pc: RTCPeerConnection) {
    pc.addEventListener('track', e => {
      const stream = e.streams[0] ?? new MediaStream([e.track])
      this.audio.srcObject = stream
      void this.audio.play().catch(() => {
        // autoplay restrictions: the UI resumes playback on a user gesture
      })
    })
  }

  async answer() {
    if (this.direction !== 'inbound') throw new Error('Only inbound calls can be answered')
    this.session.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: this.iceServers } })
  }

  /** Decline (603): the caller is told the call was refused, not that the line is busy. */
  async reject() {
    if (this.direction === 'inbound' && this.state === 'ringing') this.session.terminate({ status_code: 603, reason_phrase: 'Decline' })
    else await this.hangup()
  }

  async hangup() {
    if (this.state === 'ended') return
    this.session.terminate()
  }

  /**
   * Sends one offer of ours (hold or resume) and settles when the far end has answered it. JsSIP refuses an offer
   * while another one, ours or the far end's, is still unanswered (a hold just sent, on a slow link): the offer
   * is then retried for a few seconds before giving up.
   */
  private reoffer(start: (done: () => void) => boolean, what: string) {
    return new Promise<void>((resolve, reject) => {
      if (this.state === 'ended') return reject(new Error('Call ended'))
      if (this.reofferPending) return reject(new Error(`${what} refused: another offer is pending`))
      const deadline = Date.now() + REOFFER_RETRY_MS
      const attempt = () => {
        if (this.state === 'ended') return reject(new Error('Call ended'))
        const done = () => {
          this.reofferPending = undefined
          this.renegotiating = false
          this.changed(this)
          resolve()
        }
        if (start(done)) {
          this.reofferPending = { reject }
          this.renegotiating = true
          this.changed(this)
          return
        }
        if (Date.now() >= deadline) return reject(new Error(`${what} refused`))
        setTimeout(attempt, REOFFER_RETRY_EVERY_MS)
      }
      attempt()
    })
  }

  hold() {
    if (this.state === 'held') return Promise.resolve()
    return this.reoffer(done => this.session.hold({}, done), 'Hold')
  }

  resume() {
    if (this.state !== 'held') return Promise.resolve()
    return this.reoffer(done => this.session.unhold({}, done), 'Resume')
  }

  setMuted(muted: boolean) {
    if (muted) this.session.mute({ audio: true })
    else this.session.unmute({ audio: true })
  }

  sendDtmf(tone: string, transport: DtmfTransport = 'RFC2833') {
    if (!/^[0-9A-D*#]$/i.test(tone)) throw new Error('Invalid DTMF tone')
    if (this.state !== 'connected' && this.state !== 'held') throw new Error('No call in progress')
    this.session.sendDTMF(tone, { transportType: transport as never })
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

/** How long an offer is retried while another one is unanswered, and how often. */
const REOFFER_RETRY_MS = 5_000
const REOFFER_RETRY_EVERY_MS = 100

/** Restarts on refused registrations before the softphone gives up (about 30 s apart at the end). */
const MAX_RESTARTS = 12

const restartDelay = (attempt: number) => Math.floor(Math.random() * Math.min(30_000, 500 * 2 ** attempt))

/**
 * One registration for the page. JsSIP reconnects the WebSocket by itself (and registers again) when the network
 * or the SIP server blinks; what it cannot do alone is pick up a rotated secret, hence the restart on a refused
 * registration, with a fresh media session from the Gateway.
 */
export class Softphone {
  private ua?: UserAgentLike
  private session?: SipWebrtcSession
  private stopped = false
  private restartTimer?: ReturnType<typeof setTimeout>
  private restartAttempt = 0
  /** A restart was due during a call: it runs once the last call is over. */
  private restartWhenIdle = false
  private readonly onPagehide = () => {
    try {
      this.ua?.unregister()
    } catch {
      // the socket may be gone already
    }
  }
  private pagehideBound = false
  private readonly calls = new Map<string, WebCall>()

  constructor(private readonly options: SoftphoneOptions) {}

  get registered() {
    return this.ua?.isRegistered() ?? false
  }

  /** Calls that are not over, oldest first. */
  activeCalls(): SoftCall[] {
    return [...this.calls.values()].filter(c => c.state !== 'ended')
  }

  async start() {
    this.stopped = false
    await this.boot()
  }

  private async boot() {
    const session = await this.options.getSession()
    this.session = session
    const domain = session.domain ?? new URL(session.websocketUrl).hostname
    const sockets = this.options.createSocket?.(session.websocketUrl) ?? new WebSocketInterface(session.websocketUrl)
    const config: UAConfiguration = {
      sockets,
      uri: `sip:${session.username}@${domain}`,
      password: session.credential,
      ...(this.options.displayName ? { display_name: this.options.displayName } : {}),
      register: true,
      register_expires: 300,
      session_timers: false,
      user_agent: 'TwakePhone'
    }
    const ua = this.options.createUserAgent?.(config) ?? (new UA(config) as unknown as UserAgentLike)
    this.ua = ua
    // A replaced user agent still emits (its own disconnect, late replies): only the current one speaks.
    const live = () => this.ua === ua
    let registeredOnce = false
    ua.on('registered', () => {
      if (!live()) return
      registeredOnce = true
      this.restartAttempt = 0
      this.options.onRegistration?.('registered')
    })
    ua.on('unregistered', () => live() && this.options.onRegistration?.('unregistered'))
    ua.on('disconnected', (e: { error?: boolean; reason?: string }) => {
      if (live() && !this.stopped) this.options.onRegistration?.('unregistered', e?.reason)
    })
    ua.on('registrationFailed', (e: { cause?: string; response?: { status_code?: number } }) => {
      if (!live()) return
      const detail = e?.response?.status_code ? `${e.response.status_code}` : e?.cause
      this.options.onRegistration?.('failed', detail)
      // Refused (secret rotated, account removed) rather than unreachable: come back with a fresh session.
      if (!this.stopped && (registeredOnce || e?.response)) this.scheduleRestart()
    })
    ua.on('newRTCSession', (e: { originator: string; session: RTCSession }) => {
      if (!live()) return
      const direction = e.originator === 'remote' ? 'inbound' : 'outbound'
      if (direction === 'inbound' && this.activeCalls().length) {
        // One call at a time for now (one audio element, no call waiting): the second caller hears busy.
        e.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' })
        return
      }
      const call = this.wrap(e.session, direction)
      if (direction === 'inbound') {
        this.options.onIncoming?.(call)
        this.options.onCallChange?.(call)
      }
    })
    if (!this.pagehideBound && typeof window !== 'undefined') {
      this.pagehideBound = true
      // Leaving the page: drop the registration so the SIP server does not ring a window that is gone.
      window.addEventListener('pagehide', this.onPagehide)
    }
    ua.start()
  }

  async call(target: string): Promise<SoftCall> {
    if (!this.ua || !this.session) throw new Error('Softphone not started')
    if (this.activeCalls().length) throw new Error('A call is already in progress')
    if (!/^[+0-9A-Za-z*#._-]{1,64}$/.test(target)) throw new Error('Invalid target')
    const domain = this.session.domain ?? new URL(this.session.websocketUrl).hostname
    const session = this.ua.call(`sip:${target}@${domain}`, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: this.session.iceServers },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
    })
    // JsSIP emits newRTCSession for outgoing calls too (synchronously, inside call()): the wrapper already exists.
    return this.calls.get(session.id) ?? this.wrap(session, 'outbound')
  }

  /**
   * Comes back with a fresh media session, later and later (up to 30 s) while registrations keep being refused,
   * never during a call (stopping the user agent would hang it up), and gives up after MAX_RESTARTS.
   */
  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return
    if (this.restartAttempt >= MAX_RESTARTS) {
      this.options.onRegistration?.('failed', 'registration refused repeatedly')
      return
    }
    const attempt = this.restartAttempt++
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = undefined
      if (this.stopped) return
      if (this.activeCalls().length) {
        this.restartWhenIdle = true
        return
      }
      try {
        this.ua?.stop()
        await this.boot()
      } catch {
        this.scheduleRestart()
      }
    }, restartDelay(attempt))
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.restartWhenIdle = false
    if (this.pagehideBound && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPagehide)
      this.pagehideBound = false
    }
    for (const call of this.activeCalls()) await call.hangup().catch(() => undefined)
    this.ua?.stop()
    this.ua = undefined
  }

  private wrap(session: RTCSession, direction: 'inbound' | 'outbound') {
    const existing = this.calls.get(session.id)
    if (existing) return existing
    const call = new WebCall(
      session.id,
      direction,
      session,
      this.options.remoteAudio,
      c => {
        if (c.state === 'ended') this.calls.delete(c.id)
        this.options.onCallChange?.(c)
        if (c.state === 'ended' && this.restartWhenIdle && !this.activeCalls().length) {
          this.restartWhenIdle = false
          this.scheduleRestart()
        }
      },
      (c, tone) => this.options.onDtmf?.(c, tone),
      this.session?.iceServers ?? []
    )
    this.calls.set(session.id, call)
    return call
  }
}
