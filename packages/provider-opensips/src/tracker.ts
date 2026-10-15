import type { Call, CallState, Presence, PresenceStatus, TelephonyEvent } from '@twake/telephony-types'

// Turns what OpenSIPS tells (registrations from usrloc, our own E_TWAKEPHONE_* events, the CDRs and missed calls of
// acc) into the vendor-neutral call and presence events of the Gateway. Pure state machine: no I/O, unit-tested
// with the events as OpenSIPS sends them.

interface TrackedCall {
  id: string
  caller: string
  /** The extension the call is going to now: the one dialled, or where its rules forwarded it. */
  callee: string
  /** What the caller dialled: what their history shows, wherever the call went. */
  dialled: string
  startedAt: string
  /** The callee's phone rang: it knows about the call (and is busy with it), so a call that does not go through is a missed one for it. */
  rang: boolean
  /** Refused on the callee's behalf by their "do not disturb": theirs all the same, a missed call for them. */
  dnd?: boolean
  connectedAt?: string
}

/** What the SIP server knows of an extension: registered or not, in a call or not. */
export type TelephonyPresence = 'offline' | 'available' | 'busy'

type Emit = (extension: string, event: TelephonyEvent) => void

/** A contact with an expiry, as the events and `ul_dump` give it. */
export interface ContactRegistration {
  uri: string
  /** When the registration lapses unless refreshed (ms since the epoch); absent: until told otherwise. */
  expiresAt?: number
}

/** Longer than OpenSIPS's dialog timeout (4 h): a call whose end was never told (a lost datagram) is forgotten. */
const MAX_CALL_MS = 5 * 3_600_000
/** The ended calls remembered, so that a late event (a RINGING after the MISSED, a CDR resent) does not bring one back. */
const MAX_TOMBSTONES = 10_000
/** A contact past its expiry is dropped after this much more: its refresh may be on its way. */
const EXPIRY_GRACE_MS = 10_000

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
/** The user part of an address of record (`101` or `101@domain`). */
export const userOf = (aor: string) => aor.replace(/^sips?:/, '').split('@')[0] ?? aor
/** A number, as acc gives it (a number, or digits in a string). */
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
const epochMs = (v: unknown): number | undefined => {
  const n = num(v)
  return n !== undefined && n > 0 ? n * 1000 : undefined
}
const iso = (ms: number) => new Date(ms).toISOString()
/** usrloc's `expires`: an absolute time in seconds; a small number would be seconds from now; 0 never expires. */
const expiryOf = (v: unknown, nowMs: number): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e9 ? n * 1000 : nowMs + n * 1000
}

const REFUSED = new Set([486, 600, 603])
/**
 * Declined by the callee: 603 (what the softphone answers when its user refuses) or 600. A 486 is not: a second
 * window already in a call answers it, and tm prefers it to the other windows' silence.
 */
const DECLINED = new Set([600, 603])
/** How the caller sees a call that did not go through, from the final SIP status: refused, or not reachable. */
const failedState = (code: number): CallState => (REFUSED.has(code) ? 'rejected' : code === 487 ? 'ended' : 'failed')

export class CallTracker {
  private readonly contacts = new Map<string, Map<string, number | undefined>>()
  private readonly calls = new Map<string, TrackedCall>()
  /** How many calls keep each extension busy: the caller's from the start, the callee's once its phone rang. */
  private readonly busy = new Map<string, number>()
  /** Call-IDs that ended, oldest first, bounded. */
  private readonly ended = new Set<string>()
  /** What each extension's person chose (dnd, away…), with its end when it has one. */
  private readonly userPresence = new Map<string, Presence>()
  /** The presence last told for each extension, so that only changes are told; offline ones are forgotten once told. */
  private readonly told = new Map<string, Presence>()

  constructor(
    private readonly emit: Emit,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** The contacts known now, to take before asking `ul_dump`: a resync only removes what was known before it. */
  knownContacts(): Map<string, Set<string>> {
    return new Map([...this.contacts].map(([ext, set]) => [ext, new Set(set.keys())]))
  }

  /** The calls known now, to take before asking `dlg_list`: a resync only ends what was known before it. */
  knownCalls(): Set<string> {
    return new Set(this.calls.keys())
  }

  /**
   * The registrations as OpenSIPS held them when it answered `ul_dump`: replaces what was `known` before the
   * question (all that is known when not given). A registration told while the answer was on its way is kept.
   */
  seedRegistrations(aors: { aor: string; contacts: (string | ContactRegistration)[] }[], known = this.knownContacts()) {
    const dump = new Map<string, Map<string, number | undefined>>()
    for (const { aor, contacts } of aors) {
      const ext = userOf(aor)
      const set = dump.get(ext) ?? new Map<string, number | undefined>()
      for (const c of contacts) typeof c === 'string' ? set.set(c, undefined) : set.set(c.uri, c.expiresAt)
      if (set.size) dump.set(ext, set)
    }
    for (const [ext, uris] of known) {
      const set = this.contacts.get(ext)
      if (!set) continue
      for (const uri of uris) if (!dump.get(ext)?.has(uri)) set.delete(uri)
      if (set.size === 0) this.contacts.delete(ext)
    }
    for (const [ext, fresh] of dump) {
      const set = this.contacts.get(ext) ?? new Map<string, number | undefined>()
      for (const [uri, expiresAt] of fresh) set.set(uri, expiresAt)
      this.contacts.set(ext, set)
    }
    this.tellPresences()
  }

  /**
   * The dialogs OpenSIPS held when it answered `dlg_list`: a call `known` before the question that OpenSIPS no
   * longer has is over (its CDR was lost: no tombstone, a late CDR still records it); one we do not know is in
   * progress (states 1 to 4: unconfirmed, ringing, answered, confirmed), and one we track that went further
   * meanwhile is told so. A call that started while the answer was on its way is left alone.
   */
  seedDialogs(dialogs: { callid: string; state: number; caller: string; callee: string; dialled?: string; startedAt?: string }[], known = this.knownCalls()) {
    const live = dialogs.filter(d => d.state >= 1 && d.state <= 4)
    const alive = new Set(live.map(d => d.callid))
    for (const id of known) {
      const call = this.calls.get(id)
      if (call && !alive.has(id)) this.end(call, this.now(), 'ended', call.connectedAt ? 'ended' : 'missed', false)
    }
    for (const d of live) {
      if (this.ended.has(d.callid)) continue
      let call = this.calls.get(d.callid)
      if (!call) {
        if (!d.caller || !d.callee) continue
        call = this.start(d.callid, d.caller, d.callee, d.startedAt ?? this.now(), d.dialled)
        if (d.state === 1) this.tell(call, call.caller, 'call.created', 'new')
      }
      if (d.state >= 3 && !call.connectedAt) {
        this.rings(call)
        call.connectedAt = d.startedAt ?? this.now()
        this.tellBoth(call, 'call.connected', 'connected')
      } else if (d.state === 2 && !call.rang) {
        this.rings(call)
        this.tellBoth(call, 'call.ringing', 'ringing')
      }
    }
    this.tellPresences()
  }

  /**
   * The subscription lapsed (OpenSIPS gone for longer than its life): the registrations are forgotten, everyone
   * is offline until the next resync says otherwise. The calls are kept: that resync ends those OpenSIPS no longer
   * has, with their history, and a CDR that comes meanwhile still records its call.
   */
  reset() {
    this.contacts.clear()
    this.tellPresences()
  }

  /** Housekeeping, run on a timer: registrations past their expiry, calls whose end never came, choices past their end. */
  sweep() {
    const now = this.now()
    const nowMs = Date.parse(now)
    this.expireUserPresences(nowMs)
    for (const [ext, set] of [...this.contacts]) {
      for (const [uri, expiresAt] of [...set]) if (expiresAt !== undefined && expiresAt + EXPIRY_GRACE_MS < nowMs) set.delete(uri)
      if (set.size === 0) this.contacts.delete(ext)
    }
    const limit = nowMs - MAX_CALL_MS
    for (const c of [...this.calls.values()]) if (Date.parse(c.startedAt) < limit) this.end(c, now, 'ended', c.connectedAt ? 'ended' : 'missed', false)
    this.tellPresences()
  }

  handle(method: string, p: Record<string, unknown>) {
    const now = this.now()
    switch (method) {
      case 'E_UL_CONTACT_INSERT':
      case 'E_UL_CONTACT_UPDATE': {
        const ext = userOf(str(p.aor))
        const uri = str(p.uri)
        if (!ext || !uri) return
        const set = this.contacts.get(ext) ?? new Map<string, number | undefined>()
        set.set(uri, expiryOf(p.expires, Date.parse(now)))
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
        // The only event a call is born from: its callee hears of it once its phone rings.
        // `callee` is where the call goes once the rules of the one dialled (an immediate forward) applied.
        const id = str(p.callid)
        const caller = userOf(str(p.caller))
        const callee = userOf(str(p.callee))
        if (!id || !caller || !callee || this.calls.has(id) || this.ended.has(id)) return
        this.tell(this.start(id, caller, callee, now, userOf(str(p.dialled)) || undefined), caller, 'call.created', 'new')
        break
      }
      case 'E_TWAKEPHONE_FORWARDED': {
        // The callee was busy, declined or did not answer, and its rules sent the call on (`callee`, the new one;
        // `code`, the status that made it go): for the one it leaves, a call its phone rang for is missed (or
        // declined); the new one hears of it when its phone rings.
        const call = this.find(p, now)
        if (call) this.moveTo(call, userOf(str(p.callee)), Number(p.code) || 0, now)
        break
      }
      case 'E_TWAKEPHONE_DND': {
        // Refused for `callee`, who does not want to be disturbed (and has nowhere to forward to): the missed call
        // event that follows ends it, as a missed call for them.
        const call = this.find(p, now)
        if (!call) return
        this.moveTo(call, userOf(str(p.callee)), 0, now)
        call.dnd = true
        break
      }
      case 'E_TWAKEPHONE_RINGING': {
        const call = this.find(p, now)
        if (!call || call.rang) return
        this.rings(call)
        this.tellBoth(call, 'call.ringing', 'ringing')
        break
      }
      case 'E_TWAKEPHONE_ANSWERED': {
        const call = this.find(p, now)
        if (!call || call.connectedAt) return
        this.rings(call)
        call.connectedAt = now
        this.tellBoth(call, 'call.connected', 'connected')
        break
      }
      case 'E_ACC_CDR': {
        // The reference end of an answered call, on OpenSIPS's clock: `time` is when it was answered, the
        // duration how long it lasted (milliseconds when acc gives them).
        const created = epochMs(p.created)
        const call = this.find(p, created !== undefined ? iso(created) : now)
        if (!call) return
        // Answered: both sides knew of it.
        this.rings(call)
        const answeredMs = epochMs(p.time)
        const ms = num(p.ms_duration)
        const sec = num(p.duration)
        const durationMs = ms !== undefined && ms >= 0 ? ms : sec !== undefined && sec >= 0 ? sec * 1000 : undefined
        if (answeredMs !== undefined) call.connectedAt = iso(answeredMs)
        call.connectedAt ??= now
        const endedAt = answeredMs !== undefined && durationMs !== undefined ? iso(answeredMs + durationMs) : now
        this.end(call, endedAt, 'ended', 'ended')
        break
      }
      case 'E_ACC_MISSED_EVENT': {
        // A call that did not go through: the final status says why (busy, declined, cancelled, nobody there).
        const call = this.calls.get(str(p.callid))
        if (!call) return
        const code = Number(p.sip_code) || 0
        const at = epochMs(p.time)
        // Refused by a "do not disturb": the callee's phone stayed silent, but the call is theirs, missed.
        if (call.dnd) this.rings(call)
        this.end(call, at !== undefined ? iso(at) : now, call.dnd ? 'rejected' : failedState(code), DECLINED.has(code) ? 'rejected' : 'missed')
        break
      }
      default:
        return
    }
    this.tellPresences()
  }

  /** The effective presence of an extension: a call beats everything, then not being registered, then what the user set. */
  presenceOf(extension: string, nowMs = Date.parse(this.now())): Presence {
    const user = this.userPresenceOf(extension, nowMs)
    const telephony = this.telephonyPresence(extension)
    if (telephony !== 'available') return { status: telephony, source: 'telephony' }
    return user ?? { status: 'available', source: 'telephony' }
  }

  telephonyPresence(extension: string): TelephonyPresence {
    if (this.busy.has(extension)) return 'busy'
    return this.contacts.has(extension) ? 'available' : 'offline'
  }

  /** What the user chose (dnd, away…), kept while the SIP server has nothing stronger to say, until its end if it has one. */
  setUserPresence(extension: string, presence: Presence) {
    this.userPresence.set(extension, presence)
    this.tellPresences()
  }

  /** Forgets what the user of an extension chose (the extension is no longer theirs, or nobody holds it). */
  clearUserPresence(extension: string) {
    if (!this.userPresence.delete(extension)) return
    this.tellPresences()
  }

  /** The extensions whose user chose something, still in force. */
  userPresences(): Map<string, Presence> {
    const nowMs = Date.parse(this.now())
    return new Map([...this.userPresence].filter(([, p]) => !this.expired(p, nowMs)))
  }

  /** The earliest end of a choice still in force (ms since the epoch), for a timer that tells it when it comes. */
  nextUserPresenceEnd(): number | undefined {
    const ends = [...this.userPresence.values()].map(p => (p.until ? Date.parse(p.until) : NaN)).filter(Number.isFinite)
    return ends.length ? Math.min(...ends) : undefined
  }

  /** The choices whose end has come are dropped, and the presences that change with them told. */
  expire() {
    this.tellPresences()
  }

  private userPresenceOf(extension: string, nowMs: number): Presence | undefined {
    const p = this.userPresence.get(extension)
    return p && !this.expired(p, nowMs) ? p : undefined
  }

  private expired(p: Presence, nowMs: number) {
    return p.until !== undefined && Date.parse(p.until) <= nowMs
  }

  private expireUserPresences(nowMs: number) {
    for (const [ext, p] of [...this.userPresence]) if (this.expired(p, nowMs)) this.userPresence.delete(ext)
  }

  /** Every extension whose presence was told and is not plain offline (registered, in a call, or set by its user). */
  presences(): Map<string, Presence> {
    return new Map(this.told)
  }

  /** The calls in progress, for a look at the state. */
  activeCalls(): Call[] {
    return [...this.calls.values()].map(c => this.toCall(c, c.caller, c.connectedAt ? 'connected' : c.rang ? 'ringing' : 'new'))
  }

  /**
   * The call these parameters name. One whose CALLING was lost is born of the first later event that names both
   * parties (ringing, answer, CDR); one that ended is never brought back.
   */
  private find(p: Record<string, unknown>, startedAt: string): TrackedCall | undefined {
    const id = str(p.callid)
    if (!id || this.ended.has(id)) return undefined
    const call = this.calls.get(id)
    if (call) return call
    const caller = userOf(str(p.caller))
    const callee = userOf(str(p.callee))
    return caller && callee ? this.start(id, caller, callee, startedAt, userOf(str(p.dialled)) || undefined) : undefined
  }

  /** The call goes to `to` now: the callee it leaves is told it ended (missed, or declined) if its phone rang for it. */
  private moveTo(call: TrackedCall, to: string, code: number, now: string) {
    if (!to || call.callee === to) return
    if (call.rang) {
      this.count(call.callee, -1)
      if (call.callee !== call.caller) this.emit(call.callee, { type: 'call.ended', timestamp: this.now(), payload: { call: this.toCall(call, call.callee, DECLINED.has(code) ? 'rejected' : 'missed', now) } })
    }
    call.callee = to
    call.rang = false
  }

  private start(id: string, caller: string, callee: string, startedAt: string, dialled = callee): TrackedCall {
    const call: TrackedCall = { id, caller, callee, dialled, startedAt, rang: false }
    this.calls.set(id, call)
    this.count(caller, 1)
    return call
  }

  /** The callee's phone rings: it is busy from now on. */
  private rings(call: TrackedCall) {
    if (call.rang) return
    call.rang = true
    this.count(call.callee, 1)
  }

  private count(extension: string, delta: number) {
    const n = (this.busy.get(extension) ?? 0) + delta
    if (n > 0) this.busy.set(extension, n)
    else this.busy.delete(extension)
  }

  private toCall(c: TrackedCall, viewer: string, state: CallState, endedAt?: string): Call {
    const outbound = viewer === c.caller
    return {
      id: c.id,
      direction: outbound ? 'outbound' : 'inbound',
      state,
      remoteNumber: outbound ? c.dialled : c.caller,
      startedAt: c.startedAt,
      ...(c.connectedAt ? { connectedAt: c.connectedAt } : {}),
      ...(endedAt ? { endedAt } : {})
    }
  }

  private tell(c: TrackedCall, ext: string, type: 'call.created' | 'call.ringing' | 'call.connected', state: CallState) {
    this.emit(ext, { type, timestamp: this.now(), payload: { call: this.toCall(c, ext, state) } })
  }

  private tellBoth(c: TrackedCall, type: 'call.created' | 'call.ringing' | 'call.connected', state: CallState) {
    for (const ext of c.caller === c.callee ? [c.caller] : [c.caller, c.callee]) this.tell(c, ext, type, state)
  }

  /**
   * Tells each side how its call ended; the callee only hears of a call its phone rang for. An end OpenSIPS told
   * leaves a tombstone; one deduced (a resync, a call too old) does not, so the real end may still come.
   */
  private end(c: TrackedCall, endedAt: string, callerState: CallState, calleeState: CallState, tombstone = true) {
    this.calls.delete(c.id)
    this.count(c.caller, -1)
    if (c.rang) this.count(c.callee, -1)
    if (tombstone) {
      this.ended.add(c.id)
      if (this.ended.size > MAX_TOMBSTONES) this.ended.delete(this.ended.values().next().value!)
    }
    const timestamp = this.now()
    const event = (ext: string, state: CallState): TelephonyEvent => ({ type: state === 'failed' ? 'call.failed' : 'call.ended', timestamp, payload: { call: this.toCall(c, ext, state, endedAt) } })
    this.emit(c.caller, event(c.caller, callerState))
    if (c.rang && c.callee !== c.caller) this.emit(c.callee, event(c.callee, calleeState))
  }

  /** Tells the presence of every extension whose effective presence changed since it was last told. */
  private tellPresences() {
    const timestamp = this.now()
    const nowMs = Date.parse(timestamp)
    this.expireUserPresences(nowMs)
    const extensions = new Set<string>([...this.contacts.keys(), ...this.told.keys(), ...this.userPresence.keys(), ...this.busy.keys()])
    for (const ext of extensions) {
      const presence = this.presenceOf(ext, nowMs)
      const before = this.told.get(ext)
      const offline = presence.status === 'offline' && !this.userPresence.has(ext)
      // A new end or message for the same choice is a change too: whoever shows it must show the new one.
      const same = (a: Presence, b: Presence) => a.status === b.status && a.source === b.source && a.until === b.until && a.message === b.message
      if (before ? same(before, presence) : offline) continue
      const since = presence.since ?? timestamp
      // Back to plain offline: told once, then forgotten (an extension dialled once costs nothing afterwards).
      if (offline) this.told.delete(ext)
      else this.told.set(ext, { ...presence, since })
      this.emit(ext, { type: 'presence.changed', timestamp, payload: { userId: '', presence: { ...presence, since } } })
    }
  }
}

export type { PresenceStatus }
