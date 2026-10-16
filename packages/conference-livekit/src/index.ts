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
  /**
   * How long the inbound trunk and a room's rule, once checked at LiveKit, are taken as they were, in milliseconds:
   * a room read again and again lists LiveKit's trunks and rules once in that time (third review n°7). Default 30 s.
   */
  checkTtlMs?: number
  fetch?: Fetch
}

const TRUNK_IN = 'twake-meet-in'
const TRUNK_OUT = 'twake-meet-out'
/** The name of the dispatch rule the Gateway makes for a room. */
const RULE_PREFIX = 'twake-meet-'

/** A dispatch rule as LiveKit lists it (ListSIPDispatchRule). */
interface ListedRule {
  sip_dispatch_rule_id: string
  name: string
  trunk_ids?: string[]
  rule?: { dispatch_rule_direct?: { room_name?: string; pin?: string } }
}
const pinOf = (r: ListedRule) => r.rule?.dispatch_rule_direct?.pin ?? ''

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
  /** When the inbound trunk was last seen at LiveKit (ms since the epoch). */
  private inboundCheckedAt = 0
  /** meetingId -> the PIN its rule was last seen with at LiveKit, and when (ensureDialIn). */
  private readonly checked = new Map<string, { pin: string; at: number }>()

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
   * The inbound trunk this process keeps, if LiveKit still lists it; written again otherwise (its Redis emptied, the
   * trunk deleted by hand). LiveKit takes a dispatch rule on a trunk it no longer has (no not_found, second review
   * n°3): without this, the rules made on it would let nobody in until the Gateway restarts.
   */
  private async liveInbound(): Promise<string> {
    const cached = this.inboundTrunkId
    if (!cached) return this.ensureInbound()
    const trunk = await cached
    if (Date.now() - this.inboundCheckedAt < this.ttl) return trunk
    const list = await this.api.call<{ items?: { sip_trunk_id: string; name: string }[] }>('livekit.SIP', 'ListSIPInboundTrunk', { trunk_ids: [trunk] })
    if ((list.items ?? []).some(t => t.sip_trunk_id === trunk)) {
      this.inboundCheckedAt = Date.now()
      return trunk
    }
    if (this.inboundTrunkId === cached) this.inboundTrunkId = undefined
    this.checked.clear()
    return this.ensureInbound()
  }

  private get ttl() {
    return this.config.checkTtlMs ?? 30_000
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
    const ensure = () => (which === 'in' ? this.liveInbound() : this.ensureOutbound())
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
        dispatch_rule: { name: `${RULE_PREFIX}${meetingId}`, trunk_ids: [trunk], rule: { dispatch_rule_direct: { room_name: meetingId, pin } } }
      })
    )
    this.rules.set(meetingId, rule.sip_dispatch_rule_id)
  }

  /** The rules LiveKit has for the room (by their name), on the trunk given only (LiveKit filters), or on any. */
  private async roomRules(meetingId: string, trunk?: string): Promise<ListedRule[]> {
    const list = await this.api.call<{ items?: ListedRule[] }>('livekit.SIP', 'ListSIPDispatchRule', trunk ? { trunk_ids: [trunk] } : {})
    return (list.items ?? []).filter(r => r.name === `${RULE_PREFIX}${meetingId}`)
  }

  /**
   * The room's rule with the PIN the Gateway shows (`pin`), and no other: created again when LiveKit no longer has it,
   * or has it on a trunk that is gone (its Redis emptied, deleted by hand); a rule of the room with another PIN (left
   * by two reads of a room at once, third review n°5) or a second one deleted. The PIN shown always lets in, and only
   * it. Checked at LiveKit once in `checkTtlMs` for the same PIN.
   */
  async ensureDialIn(meetingId: string, pin: string): Promise<void> {
    const seen = this.checked.get(meetingId)
    if (seen && seen.pin === pin && Date.now() - seen.at < this.ttl) return
    const trunk = await this.liveInbound()
    const rules = await this.roomRules(meetingId)
    const keep = rules.find(r => pinOf(r) === pin && (r.trunk_ids ?? []).includes(trunk))
    for (const r of rules) if (r !== keep) await this.api.call('livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: r.sip_dispatch_rule_id }).catch(() => {})
    if (keep) this.rules.set(meetingId, keep.sip_dispatch_rule_id)
    else {
      this.rules.delete(meetingId)
      await this.createRule(meetingId, pin)
    }
    this.checked.set(meetingId, { pin, at: Date.now() })
  }

  /** Deletes the room's rules with that PIN (one drawn by a Gateway that lost the race to another, third review n°5). */
  async dropDialIn(meetingId: string, pin: string): Promise<void> {
    for (const r of await this.roomRules(meetingId)) {
      if (pinOf(r) !== pin) continue
      await this.api.call('livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: r.sip_dispatch_rule_id })
      if (this.rules.get(meetingId) === r.sip_dispatch_rule_id) this.rules.delete(meetingId)
    }
    if (this.checked.get(meetingId)?.pin === pin) this.checked.delete(meetingId)
  }

  /** Every rule of the room goes: none left letting anyone in once it is closed (third review n°5). */
  removeDialIn: ConferenceBridgeProvider['removeDialIn'] = async meetingId => {
    for (const r of await this.roomRules(meetingId)) await this.api.call('livekit.SIP', 'DeleteSIPDispatchRule', { sip_dispatch_rule_id: r.sip_dispatch_rule_id })
    this.rules.delete(meetingId)
    this.checked.delete(meetingId)
  }

  /**
   * The rules the Gateway made (named `twake-meet-<room>`), each with its room and PIN, on any trunk: what a sweep at
   * start reads (third review n°4).
   */
  async listDialIns(): Promise<{ meetingId: string; pin: string }[]> {
    const list = await this.api.call<{ items?: ListedRule[] }>('livekit.SIP', 'ListSIPDispatchRule', {})
    return (list.items ?? []).filter(r => r.name.startsWith(RULE_PREFIX)).map(r => ({ meetingId: r.name.slice(RULE_PREFIX.length), pin: pinOf(r) }))
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
    // Drawn at random, without the number (third review 8b, n°2): the id of the participant is shown to everyone in a
    // conference's room, whose numbers of the public network are masked; the number is in the attributes.
    const identity = `phone-${[0, 1].map(() => this.random(2 ** 40).toString(16).padStart(10, '0')).join('')}`
    const ringingSec = this.config.ringingTimeoutSec ?? 30
    let answered: { sip_call_id?: unknown } | undefined
    try {
      answered = await this.withTrunk('out', trunk =>
        this.api.call<{ sip_call_id?: unknown } | undefined>(
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
    // The id LiveKit gave the call (`SCL_…`): LiveKit SIP writes it as the From tag of its INVITE, which the PBX keeps
    // with the grant the call took (review 8b, n°3).
    const sipCallId = typeof answered?.sip_call_id === 'string' && answered.sip_call_id ? answered.sip_call_id : undefined
    return { ...this.toParticipant(meetingId, { identity, name: this.display(number), attributes: { 'twake.kind': 'phone', 'twake.number': number } }), ...(sipCallId ? { sipCallId } : {}) }
  }

  /**
   * Whether LiveKit's outbound trunk still sends the rooms' calls where the configuration says (review 8b, n°3): its
   * address and its user. Someone holding a key of the LiveKit server can point it elsewhere; then it is written again
   * at the next call (false here, for the caller to refuse this one and say so). A trunk LiveKit no longer has is
   * written again too (true: nothing was sent elsewhere).
   */
  async outboundIntact(): Promise<boolean> {
    const trunk = await this.ensureOutbound()
    const list = await this.api.call<{ items?: { sip_trunk_id: string; address?: string; auth_username?: string }[] }>('livekit.SIP', 'ListSIPOutboundTrunk', { trunk_ids: [trunk] })
    const found = (list.items ?? []).find(t => t.sip_trunk_id === trunk)
    if (!found) {
      if (this.outboundTrunkId) this.outboundTrunkId = undefined
      return true
    }
    const user = this.config.outboundAuth?.username
    if (found.address === this.config.outboundAddress && (user === undefined || found.auth_username === user)) return true
    this.outboundTrunkId = undefined
    return false
  }

  /**
   * Each participant of the room as its call is: its id, the number it was called at as the Gateway gave it (never
   * masked: who is in it, for the Gateway only; '' for one without a number, a web participant), and the SIP Call-ID
   * of its call (`sip.callIDFull`, as LiveKit SIP v1.17.0 writes it), by which the SIP server's events say whose phone
   * it rang and who answered it (a member of a group, a forward's target: second review 8b, n°4).
   */
  async participantCalls(meetingId: string): Promise<ParticipantCall[]> {
    const res = await this.api.call<{ participants?: LkParticipant[] }>('livekit.RoomService', 'ListParticipants', { room: meetingId })
    return (res.participants ?? []).map(p => {
      const callId = p.attributes?.['sip.callIDFull']
      return { id: participantId(meetingId, p.identity), number: p.attributes?.['twake.number'] ?? p.attributes?.['sip.phoneNumber'] ?? '', ...(callId ? { callId } : {}) }
    })
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

  /**
   * Ends the room for everyone in it (RoomService DeleteRoom, step 8b): LiveKit SIP hangs up each of its calls there.
   * A room LiveKit does not have (never joined, or closed already) is no error.
   */
  async deleteRoom(meetingId: string): Promise<void> {
    try {
      await this.api.call('livekit.RoomService', 'DeleteRoom', { room: meetingId })
    } catch (err) {
      if (err instanceof LiveKitError && (err.status === 404 || err.twirpCode === 'not_found')) return
      throw err
    }
  }

  /** Which of these rooms LiveKit has now (RoomService ListRooms, step 8b): the others ended, or never began. */
  async openRooms(names: string[]): Promise<Set<string>> {
    if (!names.length) return new Set()
    const res = await this.api.call<{ rooms?: { name?: string }[] }>('livekit.RoomService', 'ListRooms', { names })
    return new Set((res.rooms ?? []).flatMap(r => (r.name && names.includes(r.name) ? [r.name] : [])))
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

/** A participant of a room as its call is (participantCalls). */
export interface ParticipantCall {
  id: string
  number: string
  callId?: string
}

interface LkParticipant {
  identity: string
  name?: string
  kind?: number | string
  attributes?: Record<string, string>
  tracks?: { sid?: string; type?: string | number; muted?: boolean }[]
}
