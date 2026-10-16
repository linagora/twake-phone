import { UA, WebSocketInterface } from 'jssip'
import type { EndEvent, ReferEvent, ReferOptions, RTCSession } from 'jssip/lib/RTCSession.js'
import type { UAConfiguration } from 'jssip/lib/UA.js'
import type { MediaSession } from '@twake/telephony-types'
import { WebAudioRinger, type RingerLike, type Sinkable } from './ringer.js'

export { WebAudioRinger, RESUME_WAIT_MS, type AudioContextLike, type RingerLike, type Sinkable } from './ringer.js'

/**
 * Media plane only: SIP over WebSocket (JsSIP) and WebRTC in the browser. The Gateway says where to register and as
 * whom (`/me/media-session`); call control for the user's own calls happens here, directly with the SIP server.
 */
export type SipWebrtcSession = Extract<MediaSession, { type: 'sip-webrtc' }>

export type SoftCallState = 'new' | 'ringing' | 'connected' | 'held' | 'ended'

/**
 * Why a call ended, as the SIP layer reports it: the UI tells the user, the history keeps it. `dnd`: the person
 * called does not want to be disturbed (and gave no forward); their message, when they left one, is `endMessage`.
 * `answered-elsewhere`: a call ringing here was taken by another phone (a colleague of a ring group, or another
 * device of ours): the CANCEL said so (`Reason: SIP;cause=200`). `refused`: the SIP server does not put this number
 * through to the public network (an emergency number, a premium one...): why is `endRefusal`.
 */
export type EndReason = 'hangup' | 'rejected' | 'busy' | 'no-answer' | 'unavailable' | 'cancelled' | 'failed' | 'transferred' | 'dnd' | 'answered-elsewhere' | 'refused' | 'conference'

/**
 * A call a room places (step 8 and 8b, ADR 0018 and 0019), as the SIP server says in ROOM_HEADER (it removes any a
 * phone sends): `meet`, a room of Meet calls; `conference`, the room of a conference calls in the place of a call of
 * ours (Replaces), or the room of the conference we make (JOIN_HEADER, the token our window drew), or the room of a
 * conference calls us to join it; CONFERENCE_HEADER then names that room. Neither held nor transferred, and no other
 * call is placed during one: the room is the conference.
 */
export type RoomKind = 'meet' | 'conference'
export const ROOM_HEADER = 'Twake-Room'
export const JOIN_HEADER = 'Twake-Join'
export const CONFERENCE_HEADER = 'Twake-Conference'

/**
 * Why the SIP server refused a call to the public network (step 6, ADR 0016), as its REFUSED_HEADER says (with 403,
 * 484 or 503): an emergency number while no operator is connected (to call from another phone), a premium,
 * international or overseas one (not allowed), a number that is none (`invalid`), no trunk to reach the operator, or
 * one that does not work (`no-trunk`). Any other word: `not-allowed`. A transfer refused because the call is with the
 * public network says `transfer-external` (a CallError of that code).
 */
export type CallRefusal = 'emergency' | 'premium' | 'international' | 'overseas' | 'invalid' | 'no-trunk' | 'rights' | 'limit' | 'fraud' | 'policy-unavailable' | 'not-allowed'
export const REFUSED_HEADER = 'Twake-Call-Refused'
// Step 6b: `rights` (the caller's profile does not call that kind of number), `limit` (a cap reached), `fraud` (a
// volume threshold crossed), `policy-unavailable` (the rules could not be read in time: refused, never let through).
const REFUSALS: readonly CallRefusal[] = ['emergency', 'premium', 'international', 'overseas', 'invalid', 'no-trunk', 'rights', 'limit', 'fraud', 'policy-unavailable']
/** The refusal a response carries, if it is one of the SIP server's. */
export const callRefusal = (status: number | undefined, header: string | undefined): CallRefusal | undefined => {
  const word = header?.trim().toLowerCase()
  if (!word || (status !== 403 && status !== 484 && status !== 503)) return undefined
  return REFUSALS.includes(word as CallRefusal) ? (word as CallRefusal) : 'not-allowed'
}

/**
 * How the SIP server refuses a call to someone in "do not disturb": 480 with DND_HEADER set to 1 (a reason phrase may
 * be rewritten on the way), their message in DND_MESSAGE_HEADER.
 */
export const DND_HEADER = 'Twake-Dnd'
export const DND_MESSAGE_HEADER = 'Twake-Dnd-Message'

export type DtmfTransport = 'RFC2833' | 'INFO'

/**
 * Who answered, as the SIP server asserts it in the 2xx of our INVITE (`P-Asserted-Identity`, ADR 0014): the member
 * of a ring group who took the call, and their directory name. The server removes any the far end sent, and only
 * the user part and the quoted name are read; anything that is not plainly that is ignored.
 */
export const assertedIdentity = (header: string | undefined): { number: string; name: string } | undefined => {
  const m = /^\s*(?:"([^"\\]*)"\s*)?<sips?:([+0-9A-Za-z*#._-]{1,64})@[^<>\s]*>\s*(?:;.*)?$/.exec(header ?? '')
  if (!m) return undefined
  return { number: m[2]!, name: (m[1] ?? '').trim() }
}

/** A CANCEL whose `Reason` says another phone answered (RFC 3326, cause 200: "Call completed elsewhere"). */
export const answeredElsewhere = (reason: string | undefined) => /^\s*SIP\s*;(?:.*;)?\s*cause\s*=\s*200\s*(?:;|$)/i.test(reason ?? '')

/** The person's choice of devices (`deviceId`s of `enumerateDevices`); unset or empty: the browser's default. */
export interface AudioDevices {
  microphoneId?: string
  /** Where the far end's voice goes (`setSinkId`, where the browser has it). */
  outputId?: string
  /** Where the ringtone goes; the output device when unset. */
  ringerId?: string
}

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
  | 'transfer-external'
  | 'transfer-failed'
  | 'transfer-no-answer'
  | 'room-call'
  | 'call-held'
  | 'conference-pending'

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
  /**
   * The call's SIP Call-ID: what the SIP server, and the Gateway after it, name the call (POST /calls/:id/conference).
   * Not `id`, which also tells our side of the call apart (JsSIP adds the From tag).
   */
  readonly sipCallId: string
  readonly direction: 'inbound' | 'outbound'
  /** The far end's number; for a call we placed, the one who answered once they did (a member of a ring group). */
  readonly remoteNumber: string
  /**
   * The far end's name: the directory's, as the SIP server put it in the From (an incoming call) or asserted it in
   * the answer (a call we placed); else what the far end gave, if anything. Never trusted for anything but display.
   */
  readonly remoteName: string
  readonly state: SoftCallState
  readonly startedAt: Date
  readonly connectedAt?: Date
  readonly endedAt?: Date
  readonly endReason?: EndReason
  /** SIP status code the call ended with, when a response ended it (404 nobody registered, 480 a dead contact...). */
  readonly endStatus?: number
  /** What the person called left for their callers (a "do not disturb" message), as the SIP server relayed it. */
  readonly endMessage?: string
  /** Why the SIP server refused the number (endReason `refused`). */
  readonly endRefusal?: CallRefusal
  /** The far end put us on hold (re-INVITE with sendonly or inactive). */
  readonly remoteHold: boolean
  readonly muted: boolean
  /** A re-INVITE of ours (hold, resume) is waiting for the far end's answer: no other offer until then. */
  readonly renegotiating: boolean
  /** A transfer of this call (REFER) is waiting for the far end's report. */
  readonly transferring: boolean
  /**
   * A conference is being made of this call (step 8b, between expectConference and the room's call): neither held nor
   * transferred meanwhile (`conference-pending`), or the room would take the far end back unheld (second review 8b, n°2).
   */
  readonly conferencing: boolean
  /** Set when this call took the place of another one of ours (an attended transfer completed by the far end). */
  readonly replacedCallId?: string
  /** Set when this call is a consultation placed during another one of ours (held meanwhile), for an attended transfer. */
  readonly consultationOf?: string
  /** A room calls (ROOM_HEADER): the call is neither held nor transferred. */
  readonly room?: RoomKind
  /**
   * The room of the conference we make out of our call `conferenceOf` (step 8b): answered at once; that call is
   * kept quiet meanwhile and ends (endReason `conference`) once its far end has moved to the room.
   */
  readonly conferenceOf?: string
  /**
   * The room of the conference this call is in (step 8b), as the SIP server named it (CONFERENCE_HEADER) for a call of
   * a room that is a conference: the Gateway lets each of its participants read who is there (GET /conferences/:id).
   */
  readonly conferenceRoom?: string
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
  /** RTP packet counters, to tell whether audio actually flows, and the devices in use (as the browser names them). */
  stats(): Promise<{ packetsReceived: number; packetsSent: number; microphoneId?: string; outputId?: string }>
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
  /** Devices to use from the start; `setDevices()` later. */
  devices?: AudioDevices
  /** The browser blocks sound (ringtone, voice) until the person clicks or types somewhere on the page, or not any more. */
  onAudioBlocked?(blocked: boolean): void
  /** The browser's devices changed (headset plugged or unplugged): a settings screen refreshes its lists. */
  onDevicesChange?(): void
  /** Test seam: the ringtone. */
  createRinger?(): RingerLike
}

/** The part of JsSIP's UA the softphone uses (and tests fake). */
export interface UserAgentLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each event has its own payload, as in JsSIP's own typing
  on(event: string, listener: (...args: any[]) => void): unknown
  start(): void
  stop(): void
  unregister(options?: { all?: boolean }): void
  isRegistered(): boolean
  call(target: string, options?: Record<string, unknown>): RTCSession
}

/** What `accept` of JsSIP's REFER and Replaces events takes (typed `Function` in its declarations). */
type AcceptReferred = (initCallback: (session: RTCSession) => void, options?: object) => void

/** What JsSIP's `refer()` returns (typed `void` in its declarations): the subscription to the far end's reports. */
interface ReferSubscriberLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each event has its own payload, as in JsSIP's own typing
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

/**
 * Media options of every call we place or answer: our microphone when the softphone opened it itself (the chosen
 * device, or the default one when it is gone), else JsSIP opens the default one. Audio only, either way.
 */
const mediaOptions = (iceServers: RTCIceServer[], microphone?: MediaStream) => ({
  ...(microphone ? { mediaStream: microphone } : {}),
  mediaConstraints: { audio: true, video: false },
  pcConfig: { iceServers },
  rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
})

/** How long a test ring from a settings screen lasts. */
export const RING_TEST_MS = 2_500

class WebCall implements SoftCall {
  state: SoftCallState = 'new'
  readonly startedAt = new Date()
  connectedAt?: Date
  endedAt?: Date
  endReason?: EndReason
  endStatus?: number
  endMessage?: string
  endRefusal?: CallRefusal
  remoteHold = false
  muted = false
  renegotiating = false
  transferring = false
  conferencing = false
  remoteNumber: string
  remoteName: string
  private reofferPending?: { reject: (e: Error) => void }
  /** The transfer waiting for the far end's report, to settle if the call ends first. */
  private referPending?: (err: CallError) => void
  /** The far end reported our transfer got through: the end that follows is ours, and a success. */
  transferred = false
  readonly replacedCallId?: string
  readonly consultationOf?: string
  readonly room?: RoomKind
  readonly conferenceOf?: string
  readonly conferenceRoom?: string
  readonly sipCallId: string
  private readonly startMuted: boolean
  /** This call became a conference (its far end moved to the room, or we did): its end is that, not a hang-up. */
  becameConference = false

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
    /** Opens the microphone when a call needs it (the chosen one when it is there); `blocked` says the browser refused to play. */
    private readonly hooks: { microphone(): Promise<MediaStream | undefined>; blocked(): void },
    links: CallLinks = {}
  ) {
    if (links.replacedCallId) this.replacedCallId = links.replacedCallId
    if (links.consultationOf) this.consultationOf = links.consultationOf
    if (links.room) this.room = links.room
    if (links.conferenceOf) this.conferenceOf = links.conferenceOf
    if (links.conferenceRoom) this.conferenceRoom = links.conferenceRoom
    this.sipCallId = links.sipCallId ?? ''
    this.startMuted = links.startMuted ?? false
    this.remoteNumber = session.remote_identity?.uri?.user ?? ''
    this.remoteName = session.remote_identity?.display_name ?? ''
    // An outgoing session has its peer connection before anyone can listen; an incoming one gets it on answer().
    const pc = session.connection as unknown as RTCPeerConnection | undefined
    if (pc) this.attachRemoteAudio(pc)
    else session.on('peerconnection', (e: { peerconnection: RTCPeerConnection }) => this.attachRemoteAudio(e.peerconnection))
    session.on('progress', () => this.set('ringing'))
    session.on('accepted', (e: { response?: { getHeader?: (name: string) => string | undefined } }) => {
      // Our call answered: who took it (a ring group rings several people), as the SIP server asserts it. The
      // address a transfer names stays the session's (remoteUri): that is the dialog the SIP server knows.
      const asserted = direction === 'outbound' ? assertedIdentity(e?.response?.getHeader?.('P-Asserted-Identity')) : undefined
      if (asserted) {
        this.remoteNumber = asserted.number
        this.remoteName = asserted.name
      }
      this.connectedAt ??= new Date()
      this.watchMicrophone()
      this.set('connected')
    })
    session.on('confirmed', () => {
      this.connectedAt ??= new Date()
      this.watchMicrophone()
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
      this.endReason = this.transferred ? 'transferred' : this.becameConference ? 'conference' : toReason(e.cause)
      // A response (the far end's 404, 480, 486, 603...) carries a status; a request (a BYE) does not.
      const status = e.message && 'status_code' in e.message ? (e.message as { status_code?: unknown }).status_code : undefined
      this.endStatus = typeof status === 'number' ? status : undefined
      // 477 "Send failed": the SIP server could not deliver to the far end (a registration left on a dead
      // connection); for the person it is the same as nobody there.
      if (this.endStatus === 477 && this.endReason === 'failed') this.endReason = 'unavailable'
      // 408: nobody answered in time (JsSIP counts it as unavailable), such as a call held for someone without a
      // window whose browser did not wake.
      if (this.endStatus === 408 && this.endReason === 'unavailable') this.endReason = 'no-answer'
      // A call ringing here, cancelled because another phone took it (the SIP server's CANCEL says so).
      const request = e.message as { method?: string; getHeader?: (name: string) => string | undefined } | undefined
      if (direction === 'inbound' && this.endReason === 'cancelled' && request?.method === 'CANCEL' && answeredElsewhere(request.getHeader?.('Reason'))) this.endReason = 'answered-elsewhere'
      // 480 with `Twake-Dnd: 1`: refused on their behalf by the SIP server, with the message they left, if any.
      const response = e.message as { getHeader?: (name: string) => string | undefined } | undefined
      if (this.endStatus === 480 && response?.getHeader?.(DND_HEADER)?.trim() === '1') {
        this.endReason = 'dnd'
        const message = response.getHeader?.(DND_MESSAGE_HEADER)?.trim()
        if (message) this.endMessage = message
      }
      // A number the SIP server does not put through to the public network, and why.
      const refusal = callRefusal(this.endStatus, response?.getHeader?.(REFUSED_HEADER))
      if (refusal && direction === 'outbound') {
        this.endReason = 'refused'
        this.endRefusal = refusal
      }
      this.reofferPending?.reject(new CallError('call-ended', 'Call ended'))
      this.reofferPending = undefined
      this.renegotiating = false
      // A transfer still waiting for its report (the far end hung up first) is over too, and not a success.
      this.referPending?.(new CallError('call-ended', 'Call ended'))
      this.transferring = false
      this.audio.srcObject = null
      this.audio.remove()
      // JsSIP only stops what it opened itself: the microphones the softphone opened are let go here, so that the
      // browser's "microphone in use" light goes out with the call.
      for (const track of this.ownTracks) track.stop()
      this.ownTracks.clear()
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
    return this.session.connection ?? undefined
  }

  private attachRemoteAudio(pc: RTCPeerConnection) {
    pc.addEventListener('track', e => {
      const stream = e.streams[0] ?? new MediaStream([e.track])
      this.audio.srcObject = stream
      void this.play()
    })
  }

  /**
   * Plays the far end; tells the softphone when the browser wants a gesture first (it asks the person once). A
   * `play()` cut short because the call ended or its stream changed is not a blocked sound.
   */
  play() {
    return this.audio.play().then(
      () => true,
      (err: unknown) => {
        if ((err as { name?: string } | null)?.name !== 'NotAllowedError' || this.state === 'ended') return true
        this.hooks.blocked()
        return false
      }
    )
  }

  /** The sender of our microphone, once the peer connection has it (after the answer, for an incoming call). */
  private microphoneSender() {
    return this.pc?.getSenders().find(s => s.track?.kind === 'audio')
  }

  private watchedTracks = new WeakSet<MediaStreamTrack>()
  /** Microphone tracks the softphone opened for this call (JsSIP does not stop those): stopped when the call ends. */
  private readonly ownTracks = new Set<MediaStreamTrack>()
  /** Microphone switches run one after the other: two at once would leave a live track nobody references. */
  private switching: Promise<void> = Promise.resolve()

  /** A microphone stream opened for this call is ours to stop, and its track is watched for an unplugged headset. */
  adopt(stream: MediaStream | undefined) {
    if (!stream) return
    for (const track of stream.getAudioTracks()) {
      this.ownTracks.add(track)
      if (this.state === 'ended') track.stop()
    }
    this.watchMicrophone()
  }

  /** A headset unplugged ends its track: the call goes on with the chosen microphone, or the default one. */
  private watchMicrophone() {
    const track = this.microphoneSender()?.track
    if (!track || this.watchedTracks.has(track)) return
    this.watchedTracks.add(track)
    track.addEventListener('ended', () => {
      if (this.state !== 'ended' && this.microphoneSender()?.track === track) void this.useMicrophone(undefined, true).catch(() => undefined)
    })
  }

  /**
   * Switches the microphone of the call in progress (`replaceTrack`: no renegotiation); the mute state is kept.
   * `wanted` is the chosen device: nothing to do when the call already uses it; with no choice, the microphone is
   * only reopened when `force` says so (a device change alone leaves a working default microphone alone).
   */
  useMicrophone(wanted: string | undefined, force = false) {
    const run = async () => {
      const sender = this.microphoneSender()
      if (!sender?.track) return
      const current = sender.track
      if (current.readyState === 'live' && (wanted ? current.getSettings().deviceId === wanted : !force)) return
      const stream = await this.hooks.microphone()
      const track = stream?.getAudioTracks()[0]
      if (!track) return
      // The call may have ended, or the track may have changed hands, while the microphone was being opened.
      if (this.state === 'ended' || this.microphoneSender() !== sender) return track.stop()
      track.enabled = !this.muted
      const old = sender.track
      await sender.replaceTrack(track)
      this.adopt(stream)
      if (old && old !== track) {
        old.stop()
        this.ownTracks.delete(old)
      }
    }
    this.switching = this.switching.then(run, run)
    return this.switching
  }

  /** Where the far end's voice goes; the default device for an empty id. */
  async setOutput(deviceId: string) {
    const sinkable = this.audio as Sinkable
    if (sinkable.setSinkId) await sinkable.setSinkId(deviceId).catch(() => undefined)
  }

  /** The far end's address, as the SIP server knows it (`sip:103@domain`): what a transfer names. */
  get remoteUri() {
    return this.session.remote_identity.uri.toString()
  }

  async answer() {
    if (this.direction !== 'inbound') throw new CallError('not-inbound', 'Only inbound calls can be answered')
    const microphone = await this.hooks.microphone()
    if (this.state === 'ended') {
      microphone?.getTracks().forEach(track => track.stop())
      throw new CallError('call-ended', 'Call ended')
    }
    // The microphone off from its first packet when the call it continues had it off (step 8b): the tracks first,
    // then JsSIP's own state (which it applies to the tracks it adds afterwards, and reports as muted).
    if (this.startMuted) microphone?.getAudioTracks().forEach(track => (track.enabled = false))
    this.adopt(microphone)
    this.session.answer(mediaOptions(this.iceServers, microphone))
    if (this.startMuted) this.session.mute({ audio: true })
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
    if (this.room) return Promise.reject(new CallError('room-call', 'A call of a room is not held'))
    if (this.conferencing) return Promise.reject(new CallError('conference-pending', 'The call is becoming a conference'))
    if (this.state === 'held') return Promise.resolve()
    return this.reoffer(done => this.session.hold({}, done), 'Hold')
  }

  /** A conference is being made of this call, or no more (the softphone's pending join). */
  setConferencing(on: boolean) {
    if (this.conferencing === on) return
    this.conferencing = on
    this.changed(this)
  }

  /**
   * Quiet while the conference we make out of it begins (step 8b): our microphone off and the far end's voice too,
   * which the room carries already; back as it was when the conference does not begin.
   */
  quiet(on: boolean) {
    if (this.state === 'ended' || this.quieted === on) return
    this.quieted = on
    this.audio.muted = on
    if (on) {
      this.mutedBefore = this.muted
      this.session.mute({ audio: true })
    } else if (!this.mutedBefore) this.session.unmute({ audio: true })
  }
  private quieted = false
  private mutedBefore = false

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
      subscriber.on('requestFailed', (e: { response?: { status_code?: number; reason_phrase?: string; getHeader?: (name: string) => string | undefined } | null; cause?: string }) => {
        const status = e.response?.status_code
        const detail = e.response ? `${e.response.status_code} ${e.response.reason_phrase ?? ''}`.trim() : (e.cause ?? 'no answer')
        // A call with the public network: the SIP server transfers none yet (step 6a).
        const external = status === 403 && e.response?.getHeader?.(REFUSED_HEADER)?.trim().toLowerCase() === 'transfer-external'
        settle(new CallError(external ? 'transfer-external' : 'transfer-refused', `Transfer refused: ${detail}`, status, status === undefined ? 'no-answer' : STATUS_TO_REASON[status] ?? 'failed'))
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
    if (this.room) throw new CallError('room-call', 'A call of a room is not transferred')
    if (this.conferencing) throw new CallError('conference-pending', 'The call is becoming a conference')
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
    if (this.room || consultation.room) throw new CallError('room-call', 'A call of a room is not transferred')
    if (this.conferencing) throw new CallError('conference-pending', 'The call is becoming a conference')
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
    report?.forEach((r: { type?: string; kind?: string; packetsReceived?: number; packetsSent?: number }) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') packetsReceived += r.packetsReceived ?? 0
      if (r.type === 'outbound-rtp' && r.kind === 'audio') packetsSent += r.packetsSent ?? 0
    })
    const microphoneId = this.microphoneSender()?.track?.getSettings().deviceId
    const outputId = (this.audio as HTMLAudioElement & { sinkId?: string }).sinkId
    return { packetsReceived, packetsSent, ...(microphoneId ? { microphoneId } : {}), ...(outputId ? { outputId } : {}) }
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

/** How long the window waits for the room of the conference it asked for (the Gateway places that call at once). */
const JOIN_WAIT_MS = 60_000

/** What links a call to another one of ours. */
interface CallLinks {
  replacedCallId?: string
  consultationOf?: string
  room?: RoomKind
  conferenceOf?: string
  /** The SIP Call-ID of its INVITE (JsSIP's request), not one of the links: carried along with them. */
  sipCallId?: string
  /** The room of its conference (CONFERENCE_HEADER), likewise. */
  conferenceRoom?: string
  /**
   * Answered with the microphone off (step 8b): the call it continues had it off, and moving to the room of a
   * conference must not open it.
   */
  startMuted?: boolean
}

/** The room a call's INVITE says calls (ROOM_HEADER), if it is one. */
const roomOf = (request: { getHeader?: (name: string) => string | undefined } | undefined): RoomKind | undefined => {
  const value = request?.getHeader?.(ROOM_HEADER)?.trim().toLowerCase()
  return value === 'meet' || value === 'conference' ? value : undefined
}

/** The room of a conference a call's INVITE names (CONFERENCE_HEADER): a name the Gateway gave, nothing else. */
const conferenceRoomOf = (request: { getHeader?: (name: string) => string | undefined } | undefined): string | undefined => {
  const value = request?.getHeader?.(CONFERENCE_HEADER)?.trim()
  return value && /^twake-call-[0-9a-f]{16}$/.test(value) ? value : undefined
}

const restartDelay = (attempt: number) => Math.floor(Math.random() * Math.min(30_000, 500 * 2 ** attempt))

/** Random bytes as lowercase hex (getRandomValues: also on a page served over plain HTTP, unlike randomUUID). */
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('')

/** A random version 4 UUID (RFC 9562), for the `+sip.instance` of the registration (RFC 5626). */
const randomUuid = () => {
  const h = randomHex(16)
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

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
  /** The conference asked for one of our calls (step 8b): the token its room's call carries (JOIN_HEADER), for a while. */
  private pendingJoin?: { token: string; of: string; timer: ReturnType<typeof setTimeout> }
  /** The conference asked (or none): its call says it is becoming one (`conferencing`). */
  private setPendingJoin(next?: { token: string; of: string; timer: ReturnType<typeof setTimeout> }) {
    const before = this.pendingJoin
    if (before) clearTimeout(before.timer)
    this.pendingJoin = next
    if (before && before.of !== next?.of) this.calls.get(before.of)?.setConferencing(false)
    if (next) this.calls.get(next.of)?.setConferencing(true)
  }
  /** Our SIP domain, from the media session: the only place a transfer, ours or asked of us, may point to. */
  private domain = ''
  private devices: AudioDevices
  private ringer?: RingerLike
  private audioBlocked = false
  private readonly onDeviceChange = () => {
    // The chosen output may be gone, or back: the elements are pointed at it again (the browser falls back to
    // its default when it is missing). A microphone that is gone ends its track, the calls handle that
    // themselves; the chosen one coming back is taken up again.
    void this.applyOutputs()
    void this.applyMicrophone()
    this.options.onDevicesChange?.()
  }
  private readonly onGesture = () => void this.unblockAudio()
  private readonly onPagehide = () => {
    try {
      this.ua?.unregister()
    } catch {
      // the socket may be gone already
    }
  }
  private pagehideBound = false
  private readonly calls = new Map<string, WebCall>()
  /**
   * The Contact this softphone registers, and its instance, kept across the restarts of its user agent (JsSIP draws
   * new ones for each): the registration of the new user agent replaces that of the old one, which may sit on a
   * connection that died (the restart came from a REGISTER lost with its WebSocket). New ones would leave it behind
   * until it expires: OpenSIPS would keep trying it, and the unregistration at sign-out would not remove it.
   */
  private readonly contactUri = `sip:${randomHex(6)}@${randomHex(6)}.invalid;transport=ws`
  private readonly instanceId = randomUuid()

  constructor(private readonly options: SoftphoneOptions) {
    this.devices = { ...options.devices }
  }

  /** The devices in use. */
  get audioDevices(): AudioDevices {
    return { ...this.devices }
  }

  /** The browser refuses to play sound until the person clicks or types on the page. */
  get soundBlocked() {
    return this.audioBlocked
  }

  /** Applies the person's choice to the calls in progress and the ringtone, at once. */
  async setDevices(devices: AudioDevices) {
    this.devices = { ...devices }
    await Promise.all([this.applyOutputs(), this.applyMicrophone(true)])
  }

  /**
   * Opens the microphone for a call: the chosen one, or the default one when it is gone (or not yet known to the
   * browser: before the first permission, Chromium lists devices without ids). Nothing outside a browser: JsSIP
   * then opens the default one itself.
   */
  private async acquireMicrophone(): Promise<MediaStream | undefined> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return undefined
    const id = this.devices.microphoneId
    if (id) {
      const chosen = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } }).catch(() => undefined)
      if (chosen) return chosen
    }
    return navigator.mediaDevices.getUserMedia({ audio: true })
  }

  private async applyMicrophone(force = false) {
    await Promise.all(this.activeWebCalls().map(c => c.useMicrophone(this.devices.microphoneId, force).catch(() => undefined)))
  }

  private async applyOutputs() {
    const output = this.devices.outputId ?? ''
    await Promise.all([this.ringer?.setSink(this.devices.ringerId ?? output), ...this.activeWebCalls().map(c => c.setOutput(output))])
  }

  /** Rings for a moment (a settings screen's "test" button); resolves false when the browser blocks sound. */
  async ringTest(ms = RING_TEST_MS) {
    const ringer = this.getRinger()
    const ok = await ringer.start()
    setTimeout(() => !this.activeCalls().some(c => c.direction === 'inbound' && c.state === 'ringing') && ringer.stop(), ms)
    this.setBlocked(!ok)
    return ok
  }

  /** After a user gesture (the app's button, or any click): plays what the browser blocked. */
  async unblockAudio() {
    const results = await Promise.all([this.ringer?.resume() ?? true, ...this.activeWebCalls().filter(c => c.state === 'connected' || c.state === 'held').map(c => c.play())])
    // Still blocked (the gesture did not count): the next one is waited for again.
    this.setBlocked(results.some(ok => !ok))
    return !this.audioBlocked
  }

  private setBlocked(blocked: boolean) {
    if (blocked !== this.audioBlocked) {
      this.audioBlocked = blocked
      this.options.onAudioBlocked?.(blocked)
    }
    if (typeof document === 'undefined') return
    // The next click or key anywhere is the gesture the browser wants (a touch only counts once it is a click).
    // Adding a listener already there is a no-op, so a gesture that did not unblock arms the next one again.
    for (const type of ['click', 'keydown']) {
      if (blocked) document.addEventListener(type, this.onGesture, { once: true, capture: true })
      else document.removeEventListener(type, this.onGesture, { capture: true })
    }
  }

  private getRinger() {
    if (this.ringer) return this.ringer
    this.ringer = this.options.createRinger?.() ?? new WebAudioRinger(this.options.audioContainer ?? document.body)
    void this.ringer.setSink(this.devices.ringerId ?? this.devices.outputId ?? '')
    return this.ringer
  }

  /** Rings while a call of ours rings in (not one answered at once for a transfer), quiet otherwise. */
  private updateRinger() {
    const ringing = this.activeCalls().some(c => c.direction === 'inbound' && c.state === 'ringing' && !c.replacedCallId && !c.conferenceOf)
    if (ringing) {
      void this.getRinger()
        .start()
        .then(ok => this.setBlocked(!ok))
    } else this.ringer?.stop()
  }

  get registered() {
    return this.ua?.isRegistered() ?? false
  }

  /** Calls that are not over, oldest first. */
  activeCalls(): SoftCall[] {
    return this.activeWebCalls()
  }

  private activeWebCalls(): WebCall[] {
    return [...this.calls.values()].filter(c => c.state !== 'ended')
  }

  async start() {
    this.stopped = false
    if (typeof navigator !== 'undefined') navigator.mediaDevices?.addEventListener('devicechange', this.onDeviceChange)
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
      contact_uri: this.contactUri,
      instance_id: this.instanceId,
      session_timers: false,
      user_agent: 'TwakePhone'
    }
    const ua = this.options.createUserAgent?.(config) ?? new UA(config)
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
    ua.on('newRTCSession', (e: { originator: string; session: RTCSession; request?: { call_id?: string; getHeader?: (name: string) => string | undefined } }) => {
      if (!live()) return
      // The INVITE received, or the one JsSIP is about to send: its Call-ID is the call's, as the SIP server names it.
      const sipCallId = typeof e.request?.call_id === 'string' ? e.request.call_id : undefined
      const direction = e.originator === 'remote' ? 'inbound' : 'outbound'
      const room = direction === 'inbound' ? roomOf(e.request) : undefined
      const join = direction === 'inbound' ? e.request?.getHeader?.(JOIN_HEADER)?.trim() : undefined
      const conferenceRoom = room === 'conference' ? conferenceRoomOf(e.request) : undefined
      if (join) {
        // The room of a conference calls the window that asked for it (step 8b), and only that one: answered at once.
        // Any other window of ours, or a token it no longer waits for, says there is no such call: never a refusal
        // (603), which would stop the window that waits for it from answering.
        const pending = this.pendingJoin
        const of = pending && pending.token === join ? this.calls.get(pending.of) : undefined
        if (!of || of.state === 'ended' || room !== 'conference') {
          e.session.terminate({ status_code: 481, reason_phrase: 'Call Does Not Exist' })
          return
        }
        // Our call no longer on line, both ways (one of us holds it, or put it on hold meanwhile): the room would take
        // the far end back unheld, its microphone open (second review 8b, n°2). The conference does not begin.
        if (of.state !== 'connected' || of.remoteHold || of.renegotiating || of.transferring) {
          this.setPendingJoin(undefined)
          e.session.terminate({ status_code: 481, reason_phrase: 'Call Does Not Exist' })
          return
        }
        this.setPendingJoin(undefined)
        const call = this.wrap(e.session, 'inbound', { room, conferenceOf: of.id, sipCallId, startMuted: of.muted, ...(conferenceRoom ? { conferenceRoom } : {}) })
        this.options.onCallChange?.(call)
        void call.setOutput(this.devices.outputId ?? '')
        setTimeout(() => void call.answer().catch(() => undefined), 0)
        return
      }
      if (direction === 'inbound' && this.replacing?.session === e.session) {
        // The far end of an attended transfer takes the place of the person who consulted us: no ringing, the
        // call is answered at once and the one it replaces ends when it is through (RFC 3891). The room of a
        // conference does so too (step 8b): our call became that conference.
        const { replaces } = this.replacing
        this.replacing = undefined
        // The microphone as it was in the call replaced: a person who had it off keeps it off in the conference.
        const call = this.wrap(e.session, 'inbound', { replacedCallId: replaces.id, sipCallId, startMuted: replaces.muted, ...(room ? { room } : {}), ...(conferenceRoom ? { conferenceRoom } : {}) })
        this.options.onCallChange?.(call)
        void call.setOutput(this.devices.outputId ?? '')
        // After its newRTCSession, JsSIP still sends the 180: the answer comes right after it.
        setTimeout(() => void call.answer().catch(() => undefined), 0)
        return
      }
      if (direction === 'inbound' && this.activeCalls().length) {
        // One ringing call at a time (no call waiting yet): the second caller hears busy.
        e.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' })
        return
      }
      // Ours: placed by call() (a consultation, when one is being placed during a call) or by JsSIP for a REFER
      // the far end sent us. Every new call is announced, so the app shows it before anything else happens to it.
      const call = this.wrap(e.session, direction, { sipCallId, ...(direction === 'outbound' ? { consultationOf: this.pendingConsultationOf } : room ? { room } : {}), ...(conferenceRoom ? { conferenceRoom } : {}) })
      this.pendingConsultationOf = undefined
      void call.setOutput(this.devices.outputId ?? '')
      if (direction === 'inbound') this.options.onIncoming?.(call)
      this.options.onCallChange?.(call)
      if (direction === 'inbound') this.updateRinger()
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
    if (current?.room) throw new CallError('room-call', 'No other call during a call of a room')
    if (current && current.state !== 'connected' && current.state !== 'held') throw new CallError('call-in-progress', 'A call is already in progress')
    if (current && current.state === 'connected') await current.hold()
    const microphone = await this.acquireMicrophone()
    this.pendingConsultationOf = current?.id
    try {
      const session = this.ua.call(`sip:${target}@${this.domain}`, mediaOptions(this.session.iceServers ?? [], microphone))
      // JsSIP emits newRTCSession for outgoing calls too (synchronously, inside call()): the wrapper already exists.
      const call = this.calls.get(session.id) ?? this.wrap(session, 'outbound', { consultationOf: current?.id })
      call.adopt(microphone)
      return call
    } catch (err) {
      microphone?.getTracks().forEach(track => track.stop())
      throw err
    } finally {
      this.pendingConsultationOf = undefined
    }
  }

  /**
   * Our call `callId` is to become a conference (step 8b): the token the room's call to this window will carry
   * (JOIN_HEADER), to give the Gateway (POST /calls/:id/conference). That call is answered at once when it comes,
   * within a minute, with our microphone as it is in `callId`; the call it continues stays quiet meanwhile
   * (`conferenceOf`). Only a call in progress, both ends on line (neither of us holds it), and one conference asked at
   * a time: another asked meanwhile is refused (`conference-pending`). `cancelConference(token)` forgets it.
   */
  expectConference(callId: string): string {
    const call = this.calls.get(callId)
    if (!call || (call.state !== 'connected' && call.state !== 'held')) throw new CallError('not-established', 'No call in progress')
    if (call.room) throw new CallError('room-call', 'A call of a room is a conference already')
    if (call.state === 'held' || call.remoteHold) throw new CallError('call-held', 'A call on hold does not become a conference')
    if (this.activeCalls().length >= MAX_CALLS) throw new CallError('too-many-calls', 'Two calls are already in progress')
    if (this.pendingJoin) throw new CallError('conference-pending', 'A conference is already being made')
    const token = randomHex(16)
    const timer = setTimeout(() => {
      if (this.pendingJoin?.token === token) this.setPendingJoin(undefined)
    }, JOIN_WAIT_MS)
    this.setPendingJoin({ token, of: callId, timer })
    return token
  }

  /**
   * The conference asked with `token` will not come (the Gateway said no): its room's call is not answered any more.
   * Another one asked since is left alone.
   */
  cancelConference(token: string) {
    if (this.pendingJoin?.token !== token) return
    this.setPendingJoin(undefined)
  }

  /** The call of the room of the conference made out of our call `callId`, while it is not over (step 8b). */
  conferenceCall(callId: string): SoftCall | undefined {
    return this.activeWebCalls().find(c => c.conferenceOf === callId)
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
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.stopped) return
      if (this.activeCalls().length) {
        this.restartWhenIdle = true
        return
      }
      void (async () => {
        try {
          this.ua?.stop()
          await this.boot()
        } catch {
          this.scheduleRestart()
        }
      })()
    }, restartDelay(attempt))
  }

  async stop() {
    this.stopped = true
    if (typeof navigator !== 'undefined') navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange)
    this.ringer?.dispose()
    this.ringer = undefined
    this.setBlocked(false)
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

  private wrap(session: RTCSession, direction: 'inbound' | 'outbound', links: CallLinks = {}) {
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
        if (c.direction === 'inbound') this.updateRinger()
        if (c.state === 'ended') this.consultationOver(c)
        if (c.conferenceOf || (c.replacedCallId && c.room === 'conference')) this.conferenceMoved(c)
        if (c.state === 'ended' && this.restartWhenIdle && !this.activeCalls().length) {
          this.restartWhenIdle = false
          this.scheduleRestart()
        }
      },
      (c, tone) => this.options.onDtmf?.(c, tone),
      iceServers,
      this.domain,
      { microphone: () => this.acquireMicrophone(), blocked: () => this.setBlocked(true) },
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
      // JsSIP has already said 202: the new call is placed once our microphone is open.
      void this.acquireMicrophone().then(
        microphone => (e.accept as AcceptReferred)((s: RTCSession) => this.calls.get(s.id)?.adopt(microphone), { ...mediaOptions(iceServers, microphone), ...(referredBy ? { extraHeaders: [`Referred-By: ${referredBy}`] } : {}) }),
        () => (e.accept as AcceptReferred)(() => undefined, { ...mediaOptions(iceServers), ...(referredBy ? { extraHeaders: [`Referred-By: ${referredBy}`] } : {}) })
      )
    })
    // The far end of an attended transfer replaces the person who consulted us (INVITE with Replaces).
    session.on('replaces', (e: ReferEvent) => {
      // The room of a conference takes the place of a call in progress only (step 8b): not of one we hold (it would
      // come back unheld, our microphone open to the room), nor while we are in another call (a consultation): busy
      // (486), and the conference does not begin.
      if (roomOf(e.request) === 'conference' && (call.state !== 'connected' || call.remoteHold || call.renegotiating || call.transferring || this.activeWebCalls().some(c => c !== call))) {
        e.reject()
        return
      }
      const accept = e.accept as AcceptReferred
      accept((s: RTCSession) => {
        this.replacing = { session: s, replaces: call }
      })
    })
    return call
  }

  /**
   * The room of the conference we make out of our call answered (step 8b): that call goes quiet until its far end
   * moves to the room (it then ends, a conference); the room gone before that, the call is back as it was.
   */
  private conferenceMoved(joined: WebCall) {
    const original = this.calls.get((joined.conferenceOf ?? joined.replacedCallId)!)
    if (!original || original.state === 'ended') return
    // Ours replaced by the room's call (the conference of the far end): JsSIP ends it once that one is through.
    if (!joined.conferenceOf) {
      if (joined.state === 'connected') original.becameConference = true
      return
    }
    if (joined.state === 'connected') {
      original.becameConference = true
      original.quiet(true)
    } else if (joined.state === 'ended') {
      original.becameConference = false
      original.quiet(false)
    }
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
