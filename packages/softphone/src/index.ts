import { UA, WebSocketInterface } from 'jssip'
import type { EndEvent, ReferEvent, ReferOptions, RTCSession } from 'jssip/lib/RTCSession.js'
import type { UAConfiguration } from 'jssip/lib/UA.js'
import type { MediaSession } from '@twake/telephony-types'

/**
 * Media plane only: SIP over WebSocket (JsSIP) and WebRTC in the browser. The Gateway says where to register and as
 * whom (`/me/media-session`); call control for the user's own calls happens here, directly with the SIP server.
 */
export type SipWebrtcSession = Extract<MediaSession, { type: 'sip-webrtc' }>

export type SoftCallState = 'new' | 'ringing' | 'connected' | 'held' | 'ended'

/** Why a call ended, as the SIP layer reports it: the UI tells the user, the history keeps it. */
export type EndReason = 'hangup' | 'rejected' | 'busy' | 'no-answer' | 'unavailable' | 'cancelled' | 'failed' | 'transferred'

export type DtmfTransport = 'RFC2833' | 'INFO'

/** What went wrong, as a code the app puts into words (the message is for logs). */
export type CallErrorCode =
  | 'not-started'
  | 'invalid-target'
  | 'too-many-calls'
  | 'call-in-progress'
  | 'not-established'
  | 'not-inbound'
  | 'invalid-tone'
  | 'call-ended'
  | 'offer-pending'
  | 'offer-refused'
  | 'transfer-in-progress'
  | 'transfer-self'
  | 'transfer-refused'
  | 'transfer-failed'
  | 'transfer-no-answer'

export class CallError extends Error {
  constructor(
    readonly code: CallErrorCode,
    message: string,
    /** The SIP status that said so, when a response did (a 404 reported for the transfer's new call...). */
    readonly status?: number,
    /** For a failed transfer: what became of the new call, in the words used for a call of ours. */
    readonly reason?: EndReason
  ) {
    super(message)
    this.name = 'CallError'
  }
}

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
  /** A transfer of this call (REFER) is waiting for the far end's report. */
  readonly transferring: boolean
  /** Set when this call took the place of another one of ours (an attended transfer completed by the far end). */
  readonly replacedCallId?: string
  /** Set when this call is a consultation placed during another one of ours (held meanwhile), for an attended transfer. */
  readonly consultationOf?: string
  answer(): Promise<void>
  reject(): Promise<void>
  hangup(): Promise<void>
  hold(): Promise<void>
  resume(): Promise<void>
  setMuted(muted: boolean): void
  /** One tone (0-9, *, #, A-D). RFC 4733 in the RTP stream by default, as trunks and PBXs expect; SIP INFO on demand. */
  sendDtmf(tone: string, transport?: DtmfTransport): void
  /**
   * Blind transfer: the far end is told to call `target` (REFER), and this call ends once it got through. If the
   * target does not answer, the call is resumed and the error says why.
   */
  transfer(target: string): Promise<void>
  /**
   * Attended transfer: `consultation` is our other call, with the person meant; its far end takes our place in it
   * (REFER with Replaces). Both calls end once they are through to each other.
   */
  transferTo(consultation: SoftCall): Promise<void>
  /** RTP packet counters, to tell whether audio actually flows. */
  stats(): Promise<{ packetsReceived: number; packetsSent: number }>
}

export type RegistrationState = 'unregistered' | 'registered' | 'failed'

export interface SoftphoneOptions {
  /** Fetched at each (re)start so a rotated secret is picked up. */
  getSession(): Promise<SipWebrtcSession>
  /** Where the `<audio>` element of each call goes (one per call, removed when it ends); the document body by default. */
  audioContainer?: HTMLElement
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
  /** Test seam: the audio element of a call. */
  createAudio?(): HTMLAudioElement
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

/** What JsSIP's `refer()` returns (typed `void` in its declarations): the subscription to the far end's reports. */
interface ReferSubscriberLike {
  on(event: string, listener: (...args: any[]) => void): unknown
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

/** What a status reported for a transfer's new call means for the person (the rest is a plain failure). */
const STATUS_TO_REASON: Record<number, EndReason> = {
  403: 'rejected',
  404: 'unavailable',
  408: 'no-answer',
  410: 'unavailable',
  477: 'unavailable',
  480: 'unavailable',
  484: 'unavailable',
  486: 'busy',
  487: 'cancelled',
  600: 'busy',
  603: 'rejected'
}

/** A target one can dial: an extension, a number, a SIP user; nothing a URI or a header could be smuggled in. */
const DIALABLE = /^[+0-9A-Za-z*#._-]{1,64}$/

/** Media options of every call we place or answer. */
const mediaOptions = (iceServers: RTCIceServer[]) => ({
  mediaConstraints: { audio: true, video: false },
  pcConfig: { iceServers },
  rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
})

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
  transferring = false
  readonly remoteNumber: string
  readonly remoteName: string
  private reofferPending?: { reject: (e: Error) => void }
  /** The transfer waiting for the far end's report, to settle if the call ends first. */
  private referPending?: (err: CallError) => void
  /** The far end reported our transfer got through: the end that follows is ours, and a success. */
  transferred = false
  readonly replacedCallId?: string
  readonly consultationOf?: string

  constructor(
    readonly id: string,
    readonly direction: 'inbound' | 'outbound',
    readonly session: RTCSession,
    private readonly audio: HTMLAudioElement,
    private readonly changed: (call: WebCall) => void,
    private readonly dtmf: (call: WebCall, tone: string) => void,
    private readonly iceServers: RTCIceServer[],
    /** Our SIP domain: where a transfer's target lives. */
    private readonly domain: string,
    links: { replacedCallId?: string; consultationOf?: string } = {}
  ) {
    if (links.replacedCallId) this.replacedCallId = links.replacedCallId
    if (links.consultationOf) this.consultationOf = links.consultationOf
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
      this.endReason = this.transferred ? 'transferred' : toReason(e.cause)
      // A response (the far end's 404, 480, 486, 603...) carries a status; a request (a BYE) does not.
      const status = e.message && 'status_code' in e.message ? (e.message as { status_code?: unknown }).status_code : undefined
      this.endStatus = typeof status === 'number' ? status : undefined
      // 477 "Send failed": the SIP server could not deliver to the far end (a registration left on a dead
      // connection); for the person it is the same as nobody there.
      if (this.endStatus === 477 && this.endReason === 'failed') this.endReason = 'unavailable'
      this.reofferPending?.reject(new CallError('call-ended', 'Call ended'))
      this.reofferPending = undefined
      this.renegotiating = false
      // A transfer still waiting for its report (the far end hung up first) is over too, and not a success.
      this.referPending?.(new CallError('call-ended', 'Call ended'))
      this.transferring = false
      this.audio.srcObject = null
      this.audio.remove()
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

  /** The far end's address, as the SIP server knows it (`sip:103@domain`): what a transfer names. */
  get remoteUri() {
    return this.session.remote_identity.uri.toString()
  }

  async answer() {
    if (this.direction !== 'inbound') throw new CallError('not-inbound', 'Only inbound calls can be answered')
    this.session.answer(mediaOptions(this.iceServers))
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
      if (this.state === 'ended') return reject(new CallError('call-ended', 'Call ended'))
      if (this.reofferPending) return reject(new CallError('offer-pending', `${what} refused: another offer is pending`))
      const deadline = Date.now() + REOFFER_RETRY_MS
      const attempt = () => {
        if (this.state === 'ended') return reject(new CallError('call-ended', 'Call ended'))
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
        if (Date.now() >= deadline) return reject(new CallError('offer-refused', `${what} refused`))
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
    if (!/^[0-9A-D*#]$/i.test(tone)) throw new CallError('invalid-tone', 'Invalid DTMF tone')
    if (this.state !== 'connected' && this.state !== 'held') throw new CallError('not-established', 'No call in progress')
    this.session.sendDTMF(tone, { transportType: transport as never })
  }

  /**
   * One REFER, settled by the far end's reports (NOTIFY): resolved when its new call got through (a 2xx), rejected
   * when the SIP server refused the REFER, the new call failed (with the status the far end reported), nothing was
   * reported in time, or this call ended first.
   */
  private refer(target: string, options: ReferOptions = {}) {
    return new Promise<void>((resolve, reject) => {
      if (this.state !== 'connected' && this.state !== 'held') return reject(new CallError('not-established', 'No call in progress'))
      if (this.transferring) return reject(new CallError('transfer-in-progress', 'A transfer is already in progress'))
      const subscriber = (this.session.refer as unknown as (t: string, o?: ReferOptions) => ReferSubscriberLike | false)(target, options)
      if (!subscriber) return reject(new CallError('not-established', 'Transfer refused: the call is not established'))
      this.transferring = true
      const settle = (err?: CallError) => {
        if (!this.transferring) return
        clearTimeout(timer)
        this.referPending = undefined
        this.transferring = false
        this.changed(this)
        if (err) reject(err)
        else resolve()
      }
      // A target that rings on, or a far end that never sends the final report: the person gets the call back.
      const timer = setTimeout(() => settle(new CallError('transfer-no-answer', 'Transfer failed: no answer', undefined, 'no-answer')), TRANSFER_TIMEOUT_MS)
      this.referPending = settle
      this.changed(this)
      subscriber.on('requestFailed', (e: { response?: { status_code?: number; reason_phrase?: string } | null; cause?: string }) => {
        const status = e.response?.status_code
        const detail = e.response ? `${e.response.status_code} ${e.response.reason_phrase ?? ''}`.trim() : (e.cause ?? 'no answer')
        settle(new CallError('transfer-refused', `Transfer refused: ${detail}`, status, status === undefined ? 'no-answer' : STATUS_TO_REASON[status] ?? 'failed'))
      })
      subscriber.on('failed', (e: { status_line?: { status_code?: string; reason_phrase?: string } }) => {
        const status = Number(e.status_line?.status_code) || undefined
        const detail = [e.status_line?.status_code, e.status_line?.reason_phrase].filter(Boolean).join(' ')
        settle(new CallError('transfer-failed', `Transfer failed: ${detail}`, status, (status === undefined ? undefined : STATUS_TO_REASON[status]) ?? 'failed'))
      })
      subscriber.on('accepted', () => {
        this.transferred = true
        settle()
      })
    })
  }

  async transfer(target: string) {
    if (!DIALABLE.test(target)) throw new CallError('invalid-target', 'Invalid target')
    const wasConnected = this.state === 'connected'
    // The far end is put on hold while its new call is set up (RFC 5589 §6).
    if (wasConnected) await this.hold()
    try {
      await this.refer(`sip:${target}@${this.domain}`)
    } catch (err) {
      if (wasConnected) await this.resume().catch(() => undefined)
      throw err
    }
    this.session.terminate()
  }

  async transferTo(consultation: SoftCall) {
    const other = consultation as WebCall
    if (other === this) throw new CallError('transfer-self', 'A call cannot be transferred to itself')
    if (!other.session || (other.state !== 'connected' && other.state !== 'held')) throw new CallError('not-established', 'The consultation call is not established')
    const wasConnected = this.state === 'connected'
    if (wasConnected) await this.hold()
    // Refer-To names the consultation's far end, with Replaces for the consultation's dialog: the two parties
    // meet in the consultation's place and both of our calls end.
    try {
      await this.refer(other.remoteUri, { replaces: other.session })
    } catch (err) {
      // Back where we were: in the call if it was in progress, or alone with it once the consultation is gone
      // (its far end hung up before the transfer got through); with the consultation still on, the person decides.
      if (this.state === 'held' && (wasConnected || (other.state as SoftCallState) === 'ended')) await this.resume().catch(() => undefined)
      throw err
    }
    this.session.terminate()
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

/** How long a transfer waits for the far end to report its new call through (a PBX recalls after about as long). */
const TRANSFER_TIMEOUT_MS = 30_000

/** Restarts on refused registrations before the softphone gives up (about 30 s apart at the end). */
const MAX_RESTARTS = 12

/** How long `stop()` waits for the SIP server to confirm the unregistration before closing the socket. */
const UNREGISTER_WAIT_MS = 1_500

/** Calls of ours at once: the one in progress and one on hold (the consultation of an attended transfer). */
const MAX_CALLS = 2

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
  /** An INVITE with Replaces accepted for one of our calls: the session JsSIP is building for it, answered at once. */
  private replacing?: { session: RTCSession; replaces: WebCall }
  /** The call `call()` is placing a consultation during: picked up by the session JsSIP announces for it. */
  private pendingConsultationOf?: string
  /** Our SIP domain, from the media session: the only place a transfer, ours or asked of us, may point to. */
  private domain = ''
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
    this.domain = domain
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
      if (direction === 'inbound' && this.replacing?.session === e.session) {
        // The far end of an attended transfer takes the place of the person who consulted us: no ringing, the
        // call is answered at once and the one it replaces ends when it is through (RFC 3891).
        const { replaces } = this.replacing
        this.replacing = undefined
        const call = this.wrap(e.session, 'inbound', { replacedCallId: replaces.id })
        this.options.onCallChange?.(call)
        // After its newRTCSession, JsSIP still sends the 180: the answer comes right after it.
        setTimeout(() => call.answer().catch(() => undefined), 0)
        return
      }
      if (direction === 'inbound' && this.activeCalls().length) {
        // One ringing call at a time (no call waiting yet): the second caller hears busy.
        e.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' })
        return
      }
      // Ours: placed by call() (a consultation, when one is being placed during a call) or by JsSIP for a REFER
      // the far end sent us. Every new call is announced, so the app shows it before anything else happens to it.
      const call = this.wrap(e.session, direction, direction === 'outbound' ? { consultationOf: this.pendingConsultationOf } : {})
      this.pendingConsultationOf = undefined
      if (direction === 'inbound') this.options.onIncoming?.(call)
      this.options.onCallChange?.(call)
    })
    if (!this.pagehideBound && typeof window !== 'undefined') {
      this.pagehideBound = true
      // Leaving the page: drop the registration so the SIP server does not ring a window that is gone.
      window.addEventListener('pagehide', this.onPagehide)
    }
    ua.start()
  }

  /**
   * Places a call. During a call in progress it is a consultation: the call in progress is put on hold first
   * (the person then transfers it with `transferTo`, or hangs up the consultation and resumes).
   */
  async call(target: string): Promise<SoftCall> {
    if (!this.ua || !this.session) throw new CallError('not-started', 'Softphone not started')
    if (!DIALABLE.test(target)) throw new CallError('invalid-target', 'Invalid target')
    const active = this.activeCalls()
    if (active.length >= MAX_CALLS) throw new CallError('too-many-calls', 'Two calls are already in progress')
    const current = active[0] as WebCall | undefined
    if (current && current.state !== 'connected' && current.state !== 'held') throw new CallError('call-in-progress', 'A call is already in progress')
    if (current && current.state === 'connected') await current.hold()
    this.pendingConsultationOf = current?.id
    try {
      const session = this.ua.call(`sip:${target}@${this.domain}`, mediaOptions(this.session.iceServers ?? []))
      // JsSIP emits newRTCSession for outgoing calls too (synchronously, inside call()): the wrapper already exists.
      return this.calls.get(session.id) ?? this.wrap(session, 'outbound', { consultationOf: current?.id })
    } finally {
      this.pendingConsultationOf = undefined
    }
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
    const ua = this.ua
    this.ua = undefined
    if (!ua) return
    // The unregistration is a round trip (REGISTER, 401, REGISTER, 200): closing the socket at once would leave
    // the registration behind, and the SIP server would keep ringing a window that is gone.
    if (ua.isRegistered()) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, UNREGISTER_WAIT_MS)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        ua.on('unregistered', done)
        ua.on('registrationFailed', done)
        try {
          ua.unregister()
        } catch {
          done()
        }
      })
    }
    ua.stop()
  }

  private createAudio() {
    if (this.options.createAudio) return this.options.createAudio()
    const audio = document.createElement('audio')
    audio.autoplay = true
    audio.dataset['testid'] = 'remote-audio'
    ;(this.options.audioContainer ?? document.body).appendChild(audio)
    return audio
  }

  private wrap(session: RTCSession, direction: 'inbound' | 'outbound', links: { replacedCallId?: string; consultationOf?: string } = {}) {
    const existing = this.calls.get(session.id)
    if (existing) return existing
    const iceServers = this.session?.iceServers ?? []
    const call = new WebCall(
      session.id,
      direction,
      session,
      this.createAudio(),
      c => {
        if (c.state === 'ended') this.calls.delete(c.id)
        this.options.onCallChange?.(c)
        if (c.state === 'ended') this.consultationOver(c)
        if (c.state === 'ended' && this.restartWhenIdle && !this.activeCalls().length) {
          this.restartWhenIdle = false
          this.scheduleRestart()
        }
      },
      (c, tone) => this.options.onDtmf?.(c, tone),
      iceServers,
      this.domain,
      links
    )
    this.calls.set(session.id, call)
    // The far end transfers us (REFER): we call whom it names, as a new call of ours; it hangs up once we are
    // through. A transfer is only ever asked by the person we are talking to, so it is followed without asking,
    // as long as it names a dialable target of our own SIP domain: nobody makes this phone call anywhere else.
    session.on('refer', (e: ReferEvent) => {
      const request = e.request as unknown as { refer_to?: { uri?: { user?: string; host?: string } }; getHeader?: (name: string) => string | undefined }
      const target = request.refer_to?.uri
      if (this.activeCalls().length >= MAX_CALLS || !target?.user || !DIALABLE.test(target.user) || (target.host ?? '').toLowerCase() !== this.domain.toLowerCase()) return e.reject()
      // Who asked for the call goes along with it (RFC 3892): the target sees the transfer for what it is.
      const referredBy = request.getHeader?.('Referred-By')
      e.accept(() => undefined, { ...mediaOptions(iceServers), ...(referredBy ? { extraHeaders: [`Referred-By: ${referredBy}`] } : {}) })
    })
    // The far end of an attended transfer replaces the person who consulted us (INVITE with Replaces).
    session.on('replaces', (e: ReferEvent) => {
      e.accept((s: RTCSession) => {
        this.replacing = { session: s, replaces: call }
      })
    })
    return call
  }

  /**
   * A consultation over without a transfer (nobody there, refused, hung up, dropped by the person): whoever waited
   * on hold for it is taken back, unless a transfer is on its way to them.
   */
  private consultationOver(consultation: WebCall) {
    if (!consultation.consultationOf) return
    const original = this.calls.get(consultation.consultationOf)
    if (original && original.state === 'held' && !original.transferring && !original.transferred) void original.resume().catch(() => undefined)
  }
}
