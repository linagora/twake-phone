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
   * sees). Empty: any, for a LiveKit SIP nobody else can reach.
   */
  inboundAddresses?: string[]
  /** Where LiveKit sends dial-out calls: the PBX's SIP address (host:port). */
  outboundAddress: string
  /** The credentials LiveKit answers the PBX's challenge with on dial-out (OpenSIPS's MEET_SIP_USER and MEET_SIP_PASSWORD). */
  outboundAuth?: { username: string; password: string }
  /** Caller id of a dial-out nobody asked for by name (one normally carries the extension of whoever asked for it). */
  outboundNumber?: string
  /** How long a dial-out rings before it is given up, in seconds. Default 30. */
  ringingTimeoutSec?: number
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

const pad = (n: number) => String(n).padStart(6, '0')
/** 6-digit PIN, not predictable from the room id. */
const randomPin = (random: () => number) => pad(Math.floor(random() * 1_000_000))

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
    private readonly random: () => number = Math.random
  ) {
    this.api = new LiveKitApi(config.url, config.apiKey, config.apiSecret, config.fetch)
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
      const trunk = { name: TRUNK_IN, numbers: this.inboundNumber ? [this.inboundNumber] : [], allowed_addresses: this.config.inboundAddresses ?? [] }
      const list = await this.api.call<{ items?: { sip_trunk_id: string; name: string }[] }>('livekit.SIP', 'ListSIPInboundTrunk', {})
      const found = list.items?.find(t => t.name === TRUNK_IN)
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
      const found = list.items?.find(t => t.name === TRUNK_OUT)
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
   * Makes sure LiveKit accepts calls for the dial-in number and can place dial-out calls. When Meet manages
   * the dial-in itself, this is all the Gateway has to prepare: Meet creates the per-room rules and PINs.
   */
  async ensureTrunks(): Promise<void> {
    await Promise.all([this.ensureInbound(), this.ensureOutbound()])
  }

  createDialIn: ConferenceBridgeProvider['createDialIn'] = async (meeting: Meeting): Promise<DialInConfiguration> => {
    if (!this.config.dialInNumbers.length) throw Object.assign(new Error('No dial-in number configured'), { statusCode: 501 })
    const trunk = await this.ensureInbound()
    const existing = this.rules.get(meeting.id)
    if (existing) await this.api.call('livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: existing }).catch(() => {})
    // A PIN another room's rule has already: LiveKit refuses the rule, another PIN is drawn.
    for (let attempt = 1; ; attempt++) {
      const pin = randomPin(this.random)
      try {
        const rule = await this.api.call<{ sip_dispatch_rule_id: string }>('livekit.SIP', 'CreateSIPDispatchRule', {
          dispatch_rule: { name: `twake-meet-${meeting.id}`, trunk_ids: [trunk], rule: { dispatch_rule_direct: { room_name: meeting.id, pin } } }
        })
        this.rules.set(meeting.id, rule.sip_dispatch_rule_id)
        return { numbers: this.config.dialInNumbers, meetingCode: meeting.id, pin }
      } catch (err) {
        if (attempt >= 5 || !(err instanceof LiveKitError && /already exists/i.test(err.message))) throw err
      }
    }
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
   * the call as theirs, rights and caps included). Waits for the answer: a call that does not go through fails with
   * statusCode 409, code DIAL_FAILED and the SIP status the PBX or the callee answered (`sipStatus`, `sipReason`).
   */
  dialParticipant: ConferenceBridgeProvider['dialParticipant'] = async (meetingId, number, options = {}) => {
    if (!/^\+?[0-9*#]{2,20}$/.test(number)) throw Object.assign(new Error('Invalid phone number'), { statusCode: 400 })
    if (options.from !== undefined && !/^[A-Za-z0-9._+-]{1,64}$/.test(options.from)) throw Object.assign(new Error('Invalid caller'), { statusCode: 400 })
    const trunk = await this.ensureOutbound()
    const identity = `phone-${number.replace(/\D/g, '')}-${Math.floor(this.random() * 1e6)}`
    try {
      await this.api.call('livekit.SIP', 'CreateSIPParticipant', {
        sip_trunk_id: trunk,
        sip_call_to: number,
        ...(options.from ? { sip_number: options.from } : {}),
        room_name: meetingId,
        participant_identity: identity,
        participant_name: this.display(number),
        participant_attributes: { 'twake.kind': 'phone', 'twake.number': number },
        wait_until_answered: true,
        ringing_timeout: `${this.config.ringingTimeoutSec ?? 30}s`
      })
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

/** The SIP status of a dial-out that failed, from the Twirp error's metadata, else from its message ("sip status 486: ..."). */
const dialFailure = (err: LiveKitError): DialFailure | undefined => {
  const code = Number(err.meta.sip_status_code)
  if (Number.isInteger(code) && code >= 300 && code < 700) return { sipStatus: code, sipReason: err.meta.sip_status ?? '' }
  const m = /sip status (\d{3}):?\s*([^"]*)/i.exec(err.message)
  return m ? { sipStatus: Number(m[1]), sipReason: (m[2] ?? '').trim() } : undefined
}

interface LkParticipant {
  identity: string
  name?: string
  kind?: number | string
  attributes?: Record<string, string>
  tracks?: { sid?: string; type?: string | number; muted?: boolean }[]
}
