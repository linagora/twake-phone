import type { Call, CallDirection, CallState, Presence, TelephonyEvent } from '@twake/telephony-types'
import type { AriChannel, AriEvent } from './ari.js'

/** User legs are PJSIP channels of an extension endpoint (trunk legs are not users). */
const USER_LEG = /^PJSIP\/(?!trunk-)(.+)-[0-9a-f]{8}$/

export const extensionOf = (channelName: string): string | null => USER_LEG.exec(channelName)?.[1] ?? null

interface Leg {
  id: string
  extension: string
  direction?: CallDirection
  remoteNumber?: string
  state: CallState
  announced: boolean
  everConnected: boolean
  startedAt: string
  connectedAt?: string
  /** Id the API knows this call by, when it differs from the channel id (calls placed through Local channels). */
  publicId?: string
}

export interface Hint {
  direction: CallDirection
  remoteNumber: string
  /** The id returned by the API for this call, for legs the API did not create itself. */
  callId?: string
}

type Emit = (extension: string, event: TelephonyEvent) => void

/**
 * Turns the raw ARI event stream into normalised call and presence events.
 * Pure state machine: no I/O, so it is unit-testable with recorded events.
 */
export class CallTracker {
  private readonly legs = new Map<string, Leg>()
  private readonly hints = new Map<string, Hint>()
  private readonly localHints = new Map<string, Hint>()
  private readonly deviceStates = new Map<string, string>()
  private readonly presence = new Map<string, Presence>()

  constructor(
    private readonly emit: Emit,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  hint(channelId: string, hint: Hint) {
    this.hints.set(channelId, hint)
  }

  /**
   * A call placed through a Local channel pair: the user's phone is the PJSIP channel dialled by the `;2` half.
   * `base` is the Local channel name without its `;1`/`;2` suffix.
   */
  hintLocal(base: string, hint: Hint) {
    this.localHints.set(base, hint)
  }

  private legByCallId(callId: string): Leg | undefined {
    for (const leg of this.legs.values()) if ((leg.publicId ?? leg.id) === callId) return leg
    return undefined
  }

  getCall(id: string): Call | null {
    const leg = this.legByCallId(id)
    return leg && leg.direction ? this.toCall(leg) : null
  }

  getPresence(extension: string): Presence {
    return this.presence.get(extension) ?? this.computePresence(extension)
  }

  handle(e: AriEvent) {
    switch (e.type) {
      case 'ChannelCreated':
        if (e.channel) this.ensureLeg(e.channel)
        break
      case 'Dial':
        // ARI puts the caller of a Dial in `caller`; accept `channel` too for older shapes.
        if (!e.dialstatus && (e.caller ?? e.channel) && e.peer) this.onDialBegin((e.caller ?? e.channel)!, e.peer)
        break
      case 'ChannelStateChange':
        if (e.channel) this.onState(e.channel)
        break
      case 'ChannelHold':
        if (e.channel) this.setState(e.channel, 'held', 'call.held')
        break
      case 'ChannelUnhold':
        if (e.channel) this.setState(e.channel, 'connected', 'call.resumed')
        break
      case 'ChannelDestroyed':
        if (e.channel) this.onDestroyed(e.channel, e.cause ?? 0)
        break
      case 'DeviceStateChanged':
        if (e.device_state) this.onDeviceState(e.device_state.name, e.device_state.state)
        break
    }
  }

  /**
   * ARI emits no hold event when hold is requested through its API, so the provider
   * reports it itself, on the call of the user who asked.
   */
  markHeld(callId: string, held: boolean) {
    const leg = this.legByCallId(callId)
    if (leg) this.setState({ id: leg.id }, held ? 'held' : 'connected', held ? 'call.held' : 'call.resumed')
  }

  /** Seeds device states read at (re)connection. */
  seedDeviceStates(states: { name: string; state: string }[]) {
    for (const s of states) this.onDeviceState(s.name, s.state)
  }

  private ensureLeg(channel: AriChannel): Leg | null {
    const extension = extensionOf(channel.name)
    if (!extension) return null
    let leg = this.legs.get(channel.id)
    if (!leg) {
      leg = { id: channel.id, extension, state: 'new', announced: false, everConnected: false, startedAt: this.now() }
      this.legs.set(channel.id, leg)
      const hint = this.hints.get(channel.id)
      if (hint) this.resolve(leg, hint.direction, hint.remoteNumber)
    }
    return leg
  }

  private resolve(leg: Leg, direction: CallDirection, remoteNumber: string) {
    if (leg.direction) return
    leg.direction = direction
    leg.remoteNumber = remoteNumber
    this.announce(leg)
  }

  private announce(leg: Leg) {
    if (leg.announced || !leg.direction) return
    leg.announced = true
    this.emit(leg.extension, { type: 'call.created', timestamp: this.now(), payload: { call: this.toCall(leg) } })
  }

  private onDialBegin(caller: AriChannel, peer: AriChannel) {
    const local = this.localHints.get(caller.name.replace(/;\d$/, ''))
    if (local) {
      const phone = this.ensureLeg(peer)
      if (phone) {
        if (local.callId) phone.publicId = local.callId
        this.resolve(phone, local.direction, local.remoteNumber)
      }
      return
    }
    const callerLeg = this.ensureLeg(caller)
    if (callerLeg) this.resolve(callerLeg, 'outbound', caller.dialplan.exten)
    const peerLeg = this.ensureLeg(peer)
    if (peerLeg) this.resolve(peerLeg, 'inbound', caller.caller.number)
  }

  private onState(channel: AriChannel) {
    const leg = this.ensureLeg(channel)
    if (!leg) return
    if (!leg.direction) {
      // No Dial event seen: infer from the identity placed on the channel.
      const outbound = channel.caller.number === leg.extension
      this.resolve(leg, outbound ? 'outbound' : 'inbound', outbound ? channel.dialplan.exten : channel.caller.number)
    }
    if (channel.state === 'Ringing') this.setState(channel, 'ringing', 'call.ringing')
    else if (channel.state === 'Up') {
      leg.everConnected = true
      leg.connectedAt ??= this.now()
      this.setState(channel, 'connected', 'call.connected')
    }
  }

  private setState(channel: { id: string }, state: CallState, type: 'call.ringing' | 'call.connected' | 'call.held' | 'call.resumed') {
    const leg = this.legs.get(channel.id)
    if (!leg || leg.state === state) return
    leg.state = state
    this.emit(leg.extension, { type, timestamp: this.now(), payload: { call: this.toCall(leg) } })
    this.refreshPresence(leg.extension)
  }

  private onDestroyed(channel: AriChannel, cause: number) {
    const leg = this.legs.get(channel.id)
    this.hints.delete(channel.id)
    if (channel.name.startsWith('Local/') && channel.name.endsWith(';1')) this.localHints.delete(channel.name.replace(/;\d$/, ''))
    if (!leg) return
    this.legs.delete(channel.id)
    const state = this.finalState(leg, cause)
    leg.state = state
    const call = { ...this.toCall(leg), endedAt: this.now() }
    this.emit(leg.extension, {
      type: state === 'failed' ? 'call.failed' : 'call.ended',
      timestamp: this.now(),
      payload: { call }
    })
    this.refreshPresence(leg.extension)
  }

  private finalState(leg: Leg, cause: number): CallState {
    if (leg.everConnected) return 'ended'
    if (leg.direction === 'inbound') return cause === 17 || cause === 21 ? 'rejected' : 'missed'
    return cause === 16 || cause === 0 ? 'ended' : 'failed'
  }

  private onDeviceState(name: string, state: string) {
    this.deviceStates.set(name, state)
    const m = /^(?:PJSIP\/|Stasis:(?:dnd|away))(.+)$/.exec(name)
    if (m && m[1] && !m[1].startsWith('trunk-')) this.refreshPresence(m[1])
  }

  private computePresence(extension: string): Presence {
    const since = this.now()
    if (this.deviceStates.get(`Stasis:dnd${extension}`) === 'BUSY') return { status: 'dnd', source: 'user', since }
    if (this.deviceStates.get(`Stasis:away${extension}`) === 'BUSY') return { status: 'away', source: 'user', since }
    for (const leg of this.legs.values()) {
      if (leg.extension === extension && (leg.state === 'connected' || leg.state === 'held')) {
        return { status: 'busy', source: 'telephony', since }
      }
    }
    if (this.deviceStates.get(`PJSIP/${extension}`) === 'UNAVAILABLE') return { status: 'offline', source: 'telephony', since }
    return { status: 'available', source: 'telephony', since }
  }

  private refreshPresence(extension: string) {
    const next = this.computePresence(extension)
    const prev = this.presence.get(extension)
    if (prev?.status === next.status && prev.source === next.source) return
    this.presence.set(extension, next)
    this.emit(extension, {
      type: 'presence.changed',
      timestamp: this.now(),
      // userId is the provider-side identity here; the Gateway maps it to the Twake user.
      payload: { userId: extension, presence: next }
    })
  }

  private toCall(leg: Leg): Call {
    return {
      id: leg.publicId ?? leg.id,
      direction: leg.direction ?? 'inbound',
      state: leg.state,
      remoteNumber: leg.remoteNumber ?? '',
      startedAt: leg.startedAt,
      ...(leg.connectedAt ? { connectedAt: leg.connectedAt } : {})
    }
  }
}
