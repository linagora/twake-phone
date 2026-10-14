import type { Call, CallState, Presence, PresenceStatus, TelephonyEvent } from '@twake/telephony-types'

// Turns what OpenSIPS tells (registrations from usrloc, our own E_TWAKEPHONE_* events, the CDRs and missed calls of
// acc) into the vendor-neutral call and presence events of the Gateway. Pure state machine: no I/O, unit-tested
// with the events as OpenSIPS sends them.

interface TrackedCall {
  id: string
  caller: string
  callee: string
  startedAt: string
  /** The callee's phone rang: it knows about the call, so a call that does not go through is a missed one for it. */
  rang: boolean
  connectedAt?: string
}

/** What the SIP server knows of an extension: registered or not, in a call or not. */
export type TelephonyPresence = 'offline' | 'available' | 'busy'

type Emit = (extension: string, event: TelephonyEvent) => void

/** Longer than OpenSIPS's dialog timeout (4 h): a call whose end was never told (a lost datagram) is forgotten. */
const MAX_CALL_MS = 5 * 3_600_000

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
/** The user part of an address of record (`101` or `101@domain`). */
export const userOf = (aor: string) => aor.replace(/^sips?:/, '').split('@')[0] ?? aor
const epoch = (v: unknown, fallback: string) => (typeof v === 'number' && v > 0 ? new Date(v * 1000).toISOString() : fallback)

/** How the caller sees a call that did not go through, from the final SIP status: refused, or not reachable. */
const failedState = (code: number): CallState => (code === 486 || code === 603 || code === 600 ? 'rejected' : code === 487 ? 'ended' : 'failed')

export class CallTracker {
  private readonly contacts = new Map<string, Set<string>>()
  private readonly calls = new Map<string, TrackedCall>()
  private readonly userPresence = new Map<string, Presence>()
  /** The presence last told for each extension, so that only changes are told. */
  private readonly told = new Map<string, Presence>()

  constructor(
    private readonly emit: Emit,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** The registrations as OpenSIPS holds them now (`ul_dump`): replaces what the events built so far. */
  seedRegistrations(aors: { aor: string; contacts: string[] }[]) {
    const seen = new Set<string>()
    for (const { aor, contacts } of aors) {
      const ext = userOf(aor)
      seen.add(ext)
      if (contacts.length) this.contacts.set(ext, new Set(contacts))
      else this.contacts.delete(ext)
    }
    for (const ext of [...this.contacts.keys()]) if (!seen.has(ext)) this.contacts.delete(ext)
    this.tellPresences()
  }

  /**
   * The dialogs OpenSIPS holds now (`dlg_list`): a call we track that OpenSIPS no longer has is over (its CDR
   * was lost), a confirmed one we do not know is a call in progress.
   */
  seedDialogs(dialogs: { callid: string; state: number; caller: string; callee: string; startedAt: string }[]) {
    const alive = new Set(dialogs.map(d => d.callid))
    for (const call of [...this.calls.values()]) if (!alive.has(call.id)) this.end(call, this.now(), 'ended', call.connectedAt ? 'ended' : 'missed', call.rang)
    for (const d of dialogs) {
      if (this.calls.has(d.callid) || d.state < 4) continue
      const call: TrackedCall = { id: d.callid, caller: d.caller, callee: d.callee, startedAt: d.startedAt, rang: true, connectedAt: d.startedAt }
      this.calls.set(d.callid, call)
      this.tellBoth(call, 'call.connected', 'connected')
    }
    this.tellPresences()
  }

  /** Nothing is known any more (OpenSIPS gone): everyone is offline until the next resync says otherwise. */
  reset() {
    this.contacts.clear()
    this.calls.clear()
    this.tellPresences()
  }

  handle(method: string, p: Record<string, unknown>) {
    const now = this.now()
    switch (method) {
      case 'E_UL_CONTACT_INSERT': {
        const ext = userOf(str(p.aor))
        if (!ext) return
        const set = this.contacts.get(ext) ?? new Set<string>()
        set.add(str(p.uri))
        this.contacts.set(ext, set)
        break
      }
      case 'E_UL_CONTACT_DELETE': {
        const ext = userOf(str(p.aor))
        const set = this.contacts.get(ext)
        set?.delete(str(p.uri))
        if (set && set.size === 0) this.contacts.delete(ext)
        break
      }
      case 'E_UL_AOR_DELETE':
        this.contacts.delete(userOf(str(p.aor)))
        break
      case 'E_TWAKEPHONE_CALLING': {
        const call = this.known(p, now)
        if (call) this.tellBoth(call, 'call.created', 'new')
        break
      }
      case 'E_TWAKEPHONE_RINGING': {
        const call = this.known(p, now)
        if (!call) return
        call.rang = true
        this.tellBoth(call, 'call.ringing', 'ringing')
        break
      }
      case 'E_TWAKEPHONE_ANSWERED': {
        const call = this.known(p, now)
        if (!call) return
        call.rang = true
        call.connectedAt = now
        this.tellBoth(call, 'call.connected', 'connected')
        break
      }
      case 'E_ACC_CDR': {
        // The reference end of an answered call: the dialog is over, with its duration.
        const call = this.known(p, epoch(p.created, now))
        if (!call) return
        const endedAt = epoch(p.time, now)
        const duration = typeof p.duration === 'number' ? p.duration : 0
        call.connectedAt ??= new Date(Date.parse(endedAt) - duration * 1000).toISOString()
        this.end(call, endedAt, 'ended', 'ended')
        break
      }
      case 'E_ACC_MISSED_EVENT': {
        // A call that did not go through: the final status says why (busy, declined, cancelled, nobody there).
        const call = this.known(p, epoch(p.created, now))
        if (!call) return
        const code = Number(p.sip_code) || 0
        const endedAt = epoch(p.time, now)
        this.end(call, endedAt, failedState(code), code === 486 || code === 603 || code === 600 ? 'rejected' : 'missed', call.rang)
        break
      }
      default:
        return
    }
    this.forgetStale(now)
    this.tellPresences()
  }

  /** The effective presence of an extension: a call beats everything, then not being registered, then what the user set. */
  presenceOf(extension: string): Presence {
    const user = this.userPresence.get(extension)
    const telephony = this.telephonyPresence(extension)
    if (telephony !== 'available') return { status: telephony, source: 'telephony' }
    return user ?? { status: 'available', source: 'telephony' }
  }

  telephonyPresence(extension: string): TelephonyPresence {
    for (const c of this.calls.values()) if (c.caller === extension || c.callee === extension) return 'busy'
    return this.contacts.has(extension) ? 'available' : 'offline'
  }

  /** What the user chose (dnd, away…), kept while the SIP server has nothing stronger to say. */
  setUserPresence(extension: string, presence: Presence) {
    this.userPresence.set(extension, presence)
    this.tellPresences()
  }

  /** Every extension whose presence was told (registered, in a call, or set by its user). */
  presences(): Map<string, Presence> {
    return new Map(this.told)
  }

  /** The calls in progress, for a look at the state. */
  activeCalls(): Call[] {
    return [...this.calls.values()].map(c => this.toCall(c, c.caller, c.connectedAt ? 'connected' : c.rang ? 'ringing' : 'new'))
  }

  /** The call these parameters name, created from them when the start was not seen (a Gateway started mid-call). */
  private known(p: Record<string, unknown>, startedAt: string): TrackedCall | undefined {
    const id = str(p.callid)
    if (!id) return undefined
    let call = this.calls.get(id)
    if (!call) {
      const caller = userOf(str(p.caller))
      const callee = userOf(str(p.callee))
      if (!caller || !callee) return undefined
      call = { id, caller, callee, startedAt, rang: false }
      this.calls.set(id, call)
    }
    return call
  }

  private toCall(c: TrackedCall, viewer: string, state: CallState, endedAt?: string): Call {
    const outbound = viewer === c.caller
    return {
      id: c.id,
      direction: outbound ? 'outbound' : 'inbound',
      state,
      remoteNumber: outbound ? c.callee : c.caller,
      startedAt: c.startedAt,
      ...(c.connectedAt ? { connectedAt: c.connectedAt } : {}),
      ...(endedAt ? { endedAt } : {})
    }
  }

  private tellBoth(c: TrackedCall, type: 'call.created' | 'call.ringing' | 'call.connected', state: CallState) {
    const timestamp = this.now()
    for (const ext of c.caller === c.callee ? [c.caller] : [c.caller, c.callee]) this.emit(ext, { type, timestamp, payload: { call: this.toCall(c, ext, state) } })
  }

  /** Tells each side how its call ended; the callee only hears of a call its phone rang for. */
  private end(c: TrackedCall, endedAt: string, callerState: CallState, calleeState: CallState, tellCallee = true) {
    this.calls.delete(c.id)
    const timestamp = this.now()
    const event = (ext: string, state: CallState): TelephonyEvent => ({ type: state === 'failed' ? 'call.failed' : 'call.ended', timestamp, payload: { call: this.toCall(c, ext, state, endedAt) } })
    this.emit(c.caller, event(c.caller, callerState))
    if (tellCallee && c.callee !== c.caller) this.emit(c.callee, event(c.callee, calleeState))
  }

  private forgetStale(now: string) {
    const limit = Date.parse(now) - MAX_CALL_MS
    for (const c of [...this.calls.values()]) if (Date.parse(c.startedAt) < limit) this.end(c, now, 'ended', c.connectedAt ? 'ended' : 'missed', c.rang)
  }

  /** Tells the presence of every extension whose effective presence changed since it was last told. */
  private tellPresences() {
    const extensions = new Set<string>([...this.contacts.keys(), ...this.told.keys(), ...this.userPresence.keys()])
    for (const c of this.calls.values()) extensions.add(c.caller).add(c.callee)
    const timestamp = this.now()
    for (const ext of extensions) {
      const presence = this.presenceOf(ext)
      const before = this.told.get(ext)
      if (before && before.status === presence.status && before.source === presence.source) continue
      const since = presence.since ?? timestamp
      this.told.set(ext, { ...presence, since })
      this.emit(ext, { type: 'presence.changed', timestamp, payload: { userId: '', presence: { ...presence, since } } })
    }
  }
}

export type { PresenceStatus }
