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
  /** The called number the inbound trunk accepts (what the PBX sends to LiveKit). Default: the first dial-in number. */
  inboundNumber?: string
  /** Where LiveKit sends dial-out calls: the PBX's SIP address (host:port). */
  outboundAddress: string
  /** Caller id used on dial-out. */
  outboundNumber?: string
  /** Hide, mask or show phone numbers of participants (tenant privacy setting). */
  numberPrivacy?: 'show' | 'mask' | 'hide'
  fetch?: Fetch
}

const TRUNK_IN = 'twake-meet-in'
const TRUNK_OUT = 'twake-meet-out'

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
    return this.config.inboundNumber ?? this.config.dialInNumbers[0]?.e164 ?? ''
  }

  private ensureInbound(): Promise<string> {
    return (this.inboundTrunkId ??= (async () => {
      const list = await this.api.call<{ items?: { sip_trunk_id: string; name: string }[] }>('livekit.SIP', 'ListSIPInboundTrunk', {})
      const found = list.items?.find(t => t.name === TRUNK_IN)
      if (found) return found.sip_trunk_id
      const created = await this.api.call<{ sip_trunk_id: string }>('livekit.SIP', 'CreateSIPInboundTrunk', {
        trunk: { name: TRUNK_IN, numbers: [this.inboundNumber] }
      })
      return created.sip_trunk_id
    })().catch(err => {
      this.inboundTrunkId = undefined
      throw err
    }))
  }

  private ensureOutbound(): Promise<string> {
    return (this.outboundTrunkId ??= (async () => {
      const list = await this.api.call<{ items?: { sip_trunk_id: string; name: string; address?: string }[] }>('livekit.SIP', 'ListSIPOutboundTrunk', {})
      const found = list.items?.find(t => t.name === TRUNK_OUT)
      if (found && found.address === this.config.outboundAddress) return found.sip_trunk_id
      // The PBX moved (new address or SIP port): the stale trunk would send calls nowhere.
      if (found) await this.api.call('livekit.SIP', 'DeleteSIPTrunk', { sip_trunk_id: found.sip_trunk_id })
      const created = await this.api.call<{ sip_trunk_id: string }>('livekit.SIP', 'CreateSIPOutboundTrunk', {
        trunk: { name: TRUNK_OUT, address: this.config.outboundAddress, transport: 'SIP_TRANSPORT_UDP', numbers: [this.config.outboundNumber ?? 'twake'] }
      })
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
    const pin = randomPin(this.random)
    const rule = await this.api.call<{ sip_dispatch_rule_id: string }>('livekit.SIP', 'CreateSIPDispatchRule', {
      name: `twake-meet-${meeting.id}`,
      trunk_ids: [trunk],
      rule: { dispatch_rule_direct: { room_name: meeting.id, pin } }
    })
    this.rules.set(meeting.id, rule.sip_dispatch_rule_id)
    return { numbers: this.config.dialInNumbers, meetingCode: meeting.id, pin }
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

  dialParticipant: ConferenceBridgeProvider['dialParticipant'] = async (meetingId, number) => {
    if (!/^\+?[0-9*#]{2,20}$/.test(number)) throw Object.assign(new Error('Invalid phone number'), { statusCode: 400 })
    const trunk = await this.ensureOutbound()
    const identity = `phone-${number.replace(/\D/g, '')}-${Math.floor(this.random() * 1e6)}`
    await this.api.call('livekit.SIP', 'CreateSIPParticipant', {
      sip_trunk_id: trunk,
      sip_call_to: number,
      room_name: meetingId,
      participant_identity: identity,
      participant_name: this.display(number),
      participant_attributes: { 'twake.kind': 'phone', 'twake.number': number },
      wait_until_answered: false
    })
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

interface LkParticipant {
  identity: string
  name?: string
  kind?: number | string
  attributes?: Record<string, string>
  tracks?: { sid?: string; type?: string | number; muted?: boolean }[]
}
