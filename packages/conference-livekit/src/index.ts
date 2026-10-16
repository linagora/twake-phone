import { randomInt } from 'node:crypto'
import type { ConferenceBridgeProvider } from '@twake/telephony-provider-sdk'
import type { ConferenceParticipant, DialInConfiguration, Meeting } from '@twake/telephony-types'
import { LiveKitApi, LiveKitError, type Fetch } from './livekit-api.js'

export { LiveKitApi, LiveKitError, signToken, verifyWebhook } from './livekit-api.js'
export type { Fetch } from './livekit-api.js'
export { MeetApi, MeetError, type MeetRoom } from './meet-api.js'

// LiveKit SIP details (rooms, SIP trunks, dispatch rules) stay inside this package.
export interface LiveKitConferenceConfig {
  /** LiveKit server URL reachable by the Gateway (http/https). */
  url: string
  apiKey: string
  apiSecret: string
  /** Numbers shown to people who dial in (E.164, or the internal extension for the dev PBX). */
  dialInNumbers: { country: string; e164: string }[]
  /** The called number the inbound trunk accepts (what the PBX sends to LiveKit). Default: any (only the PBX is let in). */
  inboundNumber?: string
  /**
   * The addresses (IPs or CIDRs) LiveKit SIP takes calls from: the PBX's (ADR 0018: OpenSIPS is the only trunk LiveKit
   * sees). At least one: LiveKit refuses an inbound trunk that names neither a number nor an address.
   */
  inboundAddresses: string[]
  /** Where LiveKit sends dial-out calls: the PBX's SIP address (host:port). */
  outboundAddress: string
  /** The credentials LiveKit answers the PBX's challenge with on dial-out (OpenSIPS's MEET_SIP_USER and MEET_SIP_PASSWORD). */
  outboundAuth?: { username: string; password: string }
  /** Caller id of a dial-out nobody asked for by name (one normally carries the extension of whoever asked for it). */
  outboundNumber?: string
  /** How long a dial-out rings before it is given up, in seconds. Default 30. */
  ringingTimeoutSec?: number
  /**
   * How long a call a room places may last, in seconds: LiveKit SIP hangs up then (OpenSIPS's MEET_MAX_CALL_SEC bounds
   * it on its side too). Default 7200.
   */
  maxCallSec?: number
  /** Hide, mask or show phone numbers of participants (tenant privacy setting). */
  numberPrivacy?: 'show' | 'mask' | 'hide'
  fetch?: Fetch
}

const TRUNK_IN = 'twake-meet-in'
const TRUNK_OUT = 'twake-meet-out'

/** What a dial-out says when the call did not go through: the SIP status, as the PBX or the callee answered. */
export interface DialFailure {
  sipStatus: number
  sipReason: string
}

/** The digits of a room's PIN: one try per call (LiveKit SIP), the calls to the access number capped (OpenSIPS). */
export const PIN_DIGITS = 10
/** A room's PIN, drawn by a cryptographic generator: nothing of it follows from the room nor from another PIN. */
const randomPin = (random: (max: number) => number) => String(random(10 ** PIN_DIGITS)).padStart(PIN_DIGITS, '0')
/** The header LiveKit SIP carries the SIP server's grant of a room's call in (provider-opensips' GRANT_HEADER). */
export const GRANT_HEADER = 'X-Twake-Grant'
/** How long a request to LiveKit may take, in milliseconds; a dial-out waits for the answer, its ringing and a minute more. */
const REQUEST_TIMEOUT_MS = 10_000
const DIAL_EXTRA_MS = 60_000

export const maskNumber = (n: string) => (n.length <= 4 ? '****' : `${n.slice(0, 3)}${'*'.repeat(n.length - 5)}${n.slice(-2)}`)

/** "room:identity" — a participant id carries its room so removal/mute need no lookup. */
export const participantId = (room: string, identity: string) => `${room}:${identity}`
export const splitParticipantId = (id: string): { room: string; identity: string } => {
  const i = id.lastIndexOf(':')
  if (i <= 0) throw Object.assign(new Error('Invalid participant id'), { statusCode: 400 })
  return { room: id.slice(0, i), identity: id.slice(i + 1) }
}

export class LiveKitConferenceBridge implements ConferenceBridgeProvider {
  private readonly api: LiveKitApi
  private inboundTrunkId?: Promise<string>
  private outboundTrunkId?: Promise<string>
  /** meetingId -> dispatch rule id (kept so removeDialIn is exact; rebuilt from LiveKit when restarted). */
  private readonly rules = new Map<string, string>()

  constructor(
    private readonly config: LiveKitConferenceConfig,
    /** A whole number from 0 to `max` excluded: crypto's randomInt (a test seam). */
    private readonly random: (max: number) => number = max => randomInt(0, max)
  ) {
    if (!config.inboundAddresses?.some(a => a.trim())) throw new Error("LiveKit SIP needs the addresses it takes calls from (the PBX's): LiveKit refuses an inbound trunk without them")
    this.api = new LiveKitApi(config.url, config.apiKey, config.apiSecret, config.fetch, REQUEST_TIMEOUT_MS)
  }

  get dialInNumbers() {
    return this.config.dialInNumbers
  }

  private get inboundNumber() {
    return this.config.inboundNumber ?? ''
  }

  /** The inbound trunk as the configuration says, written again over the one found (the PBX may have moved). */
  private ensureInbound(): Promise<string> {
    return (this.inboundTrunkId ??= (async () => {
      const trunk = { name: TRUNK_IN, numbers: this.inboundNumber ? [this.inboundNumber] : [], allowed_addresses: this.config.inboundAddresses }
      const list = await this.api.call<{ items?: { sip_trunk_id: string; name: string }[] }>('livekit.SIP', 'ListSIPInboundTrunk', {})
      const found = await this.oneOf(list.items, TRUNK_IN)
      if (found) {
        await this.api.call('livekit.SIP', 'UpdateSIPInboundTrunk', { sip_trunk_id: found.sip_trunk_id, replace: trunk })
        return found.sip_trunk_id
      }
      const created = await this.api.call<{ sip_trunk_id: string }>('livekit.SIP', 'CreateSIPInboundTrunk', { trunk })
      return created.sip_trunk_id
    })().catch(err => {
      this.inboundTrunkId = undefined
      throw err
    }))
  }

  /**
   * The outbound trunk as the configuration says, written again over the one found: the PBX may have moved (a stale
   * address sends calls nowhere) or changed the credentials it challenges with.
   */
  private ensureOutbound(): Promise<string> {
    return (this.outboundTrunkId ??= (async () => {
      const auth = this.config.outboundAuth
      const trunk = {
        name: TRUNK_OUT,
        address: this.config.outboundAddress,
        transport: 'SIP_TRANSPORT_UDP',
        numbers: [this.config.outboundNumber ?? 'twake'],
        ...(auth ? { auth_username: auth.username, auth_password: auth.password } : {})
      }
      const list = await this.api.call<{ items?: { sip_trunk_id: string; name: string }[] }>('livekit.SIP', 'ListSIPOutboundTrunk', {})
      const found = await this.oneOf(list.items, TRUNK_OUT)
      if (found) {
        await this.api.call('livekit.SIP', 'UpdateSIPOutboundTrunk', { sip_trunk_id: found.sip_trunk_id, replace: trunk })
        return found.sip_trunk_id
      }
      const created = await this.api.call<{ sip_trunk_id: string }>('livekit.SIP', 'CreateSIPOutboundTrunk', { trunk })
      return created.sip_trunk_id
    })().catch(err => {
      this.outboundTrunkId = undefined
      throw err
    }))
  }

  /**
   * The trunk of that name kept (the first LiveKit lists), the others deleted: two Gateways started together may each
   * have created one, and LiveKit would take either.
   */
  private async oneOf(items: { sip_trunk_id: string; name: string }[] | undefined, name: string) {
    const named = (items ?? []).filter(t => t.name === name)
    for (const extra of named.slice(1)) await this.api.call('livekit.SIP', 'DeleteSIPTrunk', { sip_trunk_id: extra.sip_trunk_id })
    return named[0]
  }

  /**
   * `run` with the trunk this process keeps; once more with the trunk written again when LiveKit no longer knows it
   * (its Redis emptied, the trunk deleted by hand), instead of failing until the Gateway restarts.
   */
  private async withTrunk<T>(which: 'in' | 'out', run: (trunk: string) => Promise<T>): Promise<T> {
    const ensure = () => (which === 'in' ? this.ensureInbound() : this.ensureOutbound())
    try {
      return await run(await ensure())
    } catch (err) {
      if (!(err instanceof LiveKitError && err.twirpCode === 'not_found' && /trunk/i.test(err.message))) throw err
      if (which === 'in') this.inboundTrunkId = undefined
      else this.outboundTrunkId = undefined
      return run(await ensure())
    }
  }

  /**
   * Makes sure LiveKit accepts calls for the dial-in number and can place dial-out calls. When Meet manages
   * the dial-in itself, this is all the Gateway has to prepare: Meet creates the per-room rules and PINs.
   */
  async ensureTrunks(): Promise<void> {
    await Promise.all([this.ensureInbound(), this.ensureOutbound()])
  }

  createDialIn: ConferenceBridgeProvider['createDialIn'] = async (meeting: Meeting): Promise<DialInConfiguration> => {
    if (!this.config.dialInNumbers.length) throw Object.assign(new Error('No dial-in number configured'), { statusCode: 501 })
    const existing = this.rules.get(meeting.id)
    if (existing) await this.api.call('livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: existing }).catch(() => {})
    // A PIN another room's rule has already: LiveKit refuses the rule, another PIN is drawn.
    for (let attempt = 1; ; attempt++) {
      const pin = randomPin(this.random)
      try {
        await this.createRule(meeting.id, pin)
        return { numbers: this.config.dialInNumbers, meetingCode: meeting.id, pin }
      } catch (err) {
        if (attempt >= 5 || !(err instanceof LiveKitError && /already exists/i.test(err.message))) throw err
      }
    }
  }

  private async createRule(meetingId: string, pin: string) {
    const rule = await this.withTrunk('in', trunk =>
      this.api.call<{ sip_dispatch_rule_id: string }>('livekit.SIP', 'CreateSIPDispatchRule', {
        dispatch_rule: { name: `twake-meet-${meetingId}`, trunk_ids: [trunk], rule: { dispatch_rule_direct: { room_name: meetingId, pin } } }
      })
    )
    this.rules.set(meetingId, rule.sip_dispatch_rule_id)
  }

  /**
   * The room's rule with the PIN the Gateway shows (`pin`), created again when LiveKit no longer has it, or has it on a
   * trunk that is gone (its Redis emptied, deleted by hand): the PIN shown always lets in.
   */
  async ensureDialIn(meetingId: string, pin: string): Promise<void> {
    const trunk = await this.ensureInbound()
    const list = await this.api.call<{ items?: { sip_dispatch_rule_id: string; name: string; trunk_ids?: string[] }[] }>('livekit.SIP', 'ListSIPDispatchRule', {})
    const found = list.items?.find(r => r.name === `twake-meet-${meetingId}`)
    if (found && (found.trunk_ids ?? []).includes(trunk)) {
      this.rules.set(meetingId, found.sip_dispatch_rule_id)
      return
    }
    if (found) await this.api.call('livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: found.sip_dispatch_rule_id }).catch(() => {})
    this.rules.delete(meetingId)
    await this.createRule(meetingId, pin)
  }

  removeDialIn: ConferenceBridgeProvider['removeDialIn'] = async meetingId => {
    let id = this.rules.get(meetingId)
    if (!id) {
      const list = await this.api.call<{ items?: { sip_dispatch_rule_id: string; name: string }[] }>('livekit.SIP', 'ListSIPDispatchRule', {})
      id = list.items?.find(r => r.name === `twake-meet-${meetingId}`)?.sip_dispatch_rule_id
    }
    if (!id) return
    await this.api.call('livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: id })
    this.rules.delete(meetingId)
  }

  /**
   * Has the room call a number through the PBX, at the name of whoever asked (`from`, their extension: the PBX treats
   * the call as theirs, rights and caps included), with the PBX's grant of that call (`grant`, sent in GRANT_HEADER).
   * Waits for the answer: a call that does not go through fails with statusCode 409, code DIAL_FAILED and the SIP
   * status the PBX or the callee answered (`sipStatus`, `sipReason`; 480 when nobody answered in time).
   */
  dialParticipant: ConferenceBridgeProvider['dialParticipant'] = async (meetingId, number, options = {}) => {
    if (!/^\+?[0-9*#]{2,20}$/.test(number)) throw Object.assign(new Error('Invalid phone number'), { statusCode: 400 })
    if (options.from !== undefined && !/^[A-Za-z0-9._+-]{1,64}$/.test(options.from)) throw Object.assign(new Error('Invalid caller'), { statusCode: 400 })
    if (options.grant !== undefined && !/^[0-9a-f]{32}$/.test(options.grant)) throw Object.assign(new Error('Invalid grant'), { statusCode: 400 })
    const identity = `phone-${number.replace(/\D/g, '')}-${this.random(2 ** 40).toString(16).padStart(10, '0')}`
    const ringingSec = this.config.ringingTimeoutSec ?? 30
    try {
      await this.withTrunk('out', trunk =>
        this.api.call(
          'livekit.SIP',
          'CreateSIPParticipant',
          {
            sip_trunk_id: trunk,
            sip_call_to: number,
            ...(options.from ? { sip_number: options.from } : {}),
            ...(options.grant ? { headers: { [GRANT_HEADER]: options.grant } } : {}),
            room_name: meetingId,
            participant_identity: identity,
            participant_name: this.display(number),
            participant_attributes: { 'twake.kind': 'phone', 'twake.number': number },
            wait_until_answered: true,
            ringing_timeout: `${ringingSec}s`,
            max_call_duration: `${this.config.maxCallSec ?? 7200}s`
          },
          { timeoutMs: ringingSec * 1000 + DIAL_EXTRA_MS }
        )
      )
    } catch (err) {
      const failure = err instanceof LiveKitError ? dialFailure(err) : undefined
      if (!failure) throw err
      throw Object.assign(new Error(`The call to ${number} did not go through (${failure.sipStatus} ${failure.sipReason})`), { statusCode: 409, code: 'DIAL_FAILED', ...failure })
    }
    return this.toParticipant(meetingId, { identity, name: this.display(number), attributes: { 'twake.kind': 'phone', 'twake.number': number } })
  }

  disconnectParticipant: ConferenceBridgeProvider['disconnectParticipant'] = async id => {
    const { room, identity } = splitParticipantId(id)
    await this.api.call('livekit.RoomService', 'RemoveParticipant', { room, identity })
  }

  muteParticipant: ConferenceBridgeProvider['muteParticipant'] = async id => {
    const { room, identity } = splitParticipantId(id)
    const p = await this.api.call<{ tracks?: { sid: string; type?: string | number; muted?: boolean }[] }>('livekit.RoomService', 'GetParticipant', { room, identity })
    const audio = (p.tracks ?? []).filter(t => (t.type === 'AUDIO' || t.type === 0) && !t.muted)
    for (const t of audio) await this.api.call('livekit.RoomService', 'MutePublishedTrack', { room, identity, track_sid: t.sid, muted: true })
  }

  /** Participants currently in the room (web and phone), numbers filtered by the privacy setting. */
  async listParticipants(meetingId: string): Promise<ConferenceParticipant[]> {
    const res = await this.api.call<{ participants?: LkParticipant[] }>('livekit.RoomService', 'ListParticipants', { room: meetingId })
    return (res.participants ?? []).map(p => this.toParticipant(meetingId, p))
  }

  /** Maps a LiveKit webhook event to a Twake conference event, or undefined for events we do not expose. */
  fromWebhook(event: { event?: string; room?: { name?: string }; participant?: LkParticipant }) {
    const type = event.event === 'participant_joined' ? 'conference.participant.joined' : event.event === 'participant_left' ? 'conference.participant.left' : undefined
    if (!type || !event.room?.name || !event.participant) return undefined
    return { type, timestamp: new Date().toISOString(), payload: { participant: this.toParticipant(event.room.name, event.participant) } } as const
  }

  private display(number: string) {
    const mode = this.config.numberPrivacy ?? 'show'
    return mode === 'show' ? number : mode === 'mask' ? maskNumber(number) : 'Phone'
  }

  private toParticipant(room: string, p: LkParticipant): ConferenceParticipant {
    const phone = p.kind === 3 || p.kind === 'SIP' || p.attributes?.['twake.kind'] === 'phone' || p.attributes?.['sip.callID'] !== undefined
    const raw = p.attributes?.['twake.number'] ?? p.attributes?.['sip.phoneNumber']
    const mode = this.config.numberPrivacy ?? 'show'
    const number = phone && raw && mode !== 'hide' ? (mode === 'mask' ? maskNumber(raw) : raw) : undefined
    const muted = (p.tracks ?? []).some(t => (t.type === 'AUDIO' || t.type === 0) && t.muted)
    return {
      id: participantId(room, p.identity),
      meetingId: room,
      kind: phone ? 'phone' : 'web',
      ...(p.name ? { displayName: phone && mode !== 'show' ? this.display(raw ?? p.name) : p.name } : {}),
      ...(number ? { number } : {}),
      muted
    }
  }
}

/**
 * The SIP status of a dial-out that failed, from the Twirp error's metadata, else from its message ("sip status 486:
 * ...", or LiveKit's own form, "sip status: 486: ..."). Nobody answered before the ringing timeout (LiveKit SIP: canceled
 * or deadline exceeded, "sip request timed out", without a SIP status): 480.
 */
const dialFailure = (err: LiveKitError): DialFailure | undefined => {
  const code = Number(err.meta.sip_status_code)
  if (Number.isInteger(code) && code >= 300 && code < 700) return { sipStatus: code, sipReason: err.meta.sip_status ?? '' }
  const m = /sip status:? (\d{3}):?\s*([^"]*)/i.exec(err.message)
  if (m) return { sipStatus: Number(m[1]), sipReason: (m[2] ?? '').trim() }
  if (err.twirpCode === 'canceled' || err.twirpCode === 'deadline_exceeded' || /timed out/i.test(err.message)) return { sipStatus: 480, sipReason: 'No Answer' }
  return undefined
}

interface LkParticipant {
  identity: string
  name?: string
  kind?: number | string
  attributes?: Record<string, string>
  tracks?: { sid?: string; type?: string | number; muted?: boolean }[]
}
