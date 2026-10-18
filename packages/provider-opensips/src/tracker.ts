import type { Call, CallState, Presence, PresenceStatus, TelephonyAlert, TelephonyEvent } from '@twake/telephony-types'

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
  /**
   * Refused on the callee's behalf by their "do not disturb": theirs all the same, a missed call for them. `told`:
   * the caller was told (they called that extension); otherwise (a colleague the call was forwarded to) the caller
   * only sees a call that did not go through.
   */
  dnd?: { told: boolean }
  /**
   * A call to a simultaneous ring group (ADR 0014): `callee` is the group's number until a member answers, and
   * `ringing` the members whose phone rings meanwhile (each busy with it). The first to answer becomes the callee;
   * the others hear nothing more of it. Nobody answered: each one that rang has a missed call.
   */
  group?: { ringing: Set<string>; told: boolean }
  /**
   * The extensions OpenSIPS held the call for while their browsers were woken (step 5, ADR 0015): the callee, or
   * members of a group, with no window. Not busy (nothing of theirs rings), but the call is theirs: one that does not
   * go through is a missed call for them, as if their phone had rung.
   */
  woken?: Set<string>
  connectedAt?: string
  /**
   * A room's call that takes the place of a call of the callee's, in a conference (step 8b, ADR 0019; the event's
   * `conference`): the callee's only. The caller, whoever made the conference, places it through the room and is
   * neither told of it nor busy with it (their own is the call of the room to them).
   */
  conference?: boolean
  /**
   * The mailbox of the callee (the extension dialled) took the call (step 11a, ADR 0022; E_TWAKEPHONE_VOICEMAIL): for
   * the caller it is answered, for the callee a missed call, told then, whatever rang; the callee is not busy with it.
   */
  voicemail?: boolean
  /** The extensions told the call ended for them while it went on elsewhere (a forward, a group): told once. */
  over?: Set<string>
}

/** What the SIP server knows of an extension: registered or not, in a call or not. */
export type TelephonyPresence = 'offline' | 'available' | 'busy'

type Emit = (extension: string, event: TelephonyEvent) => void

/**
 * A party of the public network, through a trunk (step 6): an E.164 number, or a caller who hid theirs. Nobody's
 * extension: nothing is told to it and it is never busy; it is only the other party of someone's call.
 */
export const isExternalParty = (party: string) => party.startsWith('+') || party === 'anonymous'

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

/** The names fraud_detection gives its thresholds, as the Gateway's (FraudRule). */
const FRAUD_PARAM: Record<string, string> = {
  'calls-per-minute': 'callsPerMinute',
  'total-calls': 'dailyAttempts',
  'concurrent-calls': 'concurrentCalls',
  'sequential-calls': 'sequentialCalls',
  'call-duration': 'callSeconds'
}
const CAP_PARAMS = new Set(['concurrent', 'dailyCalls', 'dailyMinutes', 'monthlyCalls', 'monthlyMinutes'])

/** Emergency calls from one extension within EMERGENCY_BURST_WINDOW_MS that raise an alert (never a refusal). */
export const EMERGENCY_BURST = 3
export const EMERGENCY_BURST_WINDOW_MS = 10 * 60_000

/**
 * An alert for the administrators (step 6b): a threshold of fraud_detection crossed (E_FRD_WARNING, the call goes on;
 * E_FRD_CRITICAL, refused; `user` the extension, `called_number` the number without its +), a cap reached
 * (E_TWAKEPHONE_LIMIT of opensips.cfg.tpl, the call refused), or a number outside the caller's rights
 * (E_TWAKEPHONE_RIGHTS, refused; `param` its class). Null for anything else.
 */
export const alertOf = (method: string, p: Record<string, unknown>): TelephonyAlert | null => {
  if (method === 'E_FRD_WARNING' || method === 'E_FRD_CRITICAL') {
    const param = FRAUD_PARAM[str(p.param)]
    if (!param) return null
    const number = str(p.called_number).replace(/^\+/, '')
    const value = num(p.value)
    const threshold = num(p.threshold)
    return {
      kind: method === 'E_FRD_WARNING' ? 'fraud-warning' : 'fraud-critical',
      param,
      scope: 'user',
      ...(value !== undefined ? { value } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(str(p.user) ? { extension: userOf(str(p.user)) } : {}),
      ...(/^[0-9]{2,15}$/.test(number) ? { number: `+${number}` } : {})
    }
  }
  if (method === 'E_TWAKEPHONE_RIGHTS') {
    const param = str(p.param)
    if (!/^[a-z-]{1,32}$/.test(param)) return null
    return {
      kind: 'rights',
      param,
      scope: 'user',
      ...(str(p.caller) ? { extension: userOf(str(p.caller)) } : {}),
      ...(/^\+[0-9]{2,15}$/.test(str(p.number)) ? { number: str(p.number) } : {})
    }
  }
  if (method === 'E_TWAKEPHONE_LIMIT') {
    const param = str(p.param)
    const scope = str(p.scope)
    if (!CAP_PARAMS.has(param) || (scope !== 'user' && scope !== 'tenant')) return null
    return {
      kind: 'limit',
      param,
      scope,
      ...(str(p.caller) ? { extension: userOf(str(p.caller)) } : {}),
      ...(/^\+[0-9]{2,15}$/.test(str(p.number)) ? { number: str(p.number) } : {})
    }
  }
  return null
}

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
  /** The emergency calls of each extension within EMERGENCY_BURST_WINDOW_MS (ms since the epoch). */
  private readonly emergencies = new Map<string, number[]>()

  private readonly emit: Emit

  constructor(
    emit: Emit,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.emit = (extension, event) => {
      if (!isExternalParty(extension)) emit(extension, event)
    }
  }

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
      for (const c of contacts) {
        if (typeof c === 'string') set.set(c, undefined)
        else set.set(c.uri, c.expiresAt)
      }
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
        const call = this.start(id, caller, callee, now, userOf(str(p.dialled)) || undefined, str(p.conference) === '1')
        if (str(p.group)) call.group = { ringing: new Set(), told: false }
        if (!call.conference) this.tell(call, caller, 'call.created', 'new')
        break
      }
      case 'E_TWAKEPHONE_FORWARDED': {
        // The callee was busy, declined or did not answer, and its rules sent the call on (`callee`, the new one;
        // `code`, the status that made it go): for the one it leaves, a call its phone rang for is missed (or
        // declined); the new one hears of it when its phone rings.
        const call = this.find(p, now)
        if (!call) break
        // A ring group nobody answered, its call gone to the fallback of a direct number (step 6b): a missed call for
        // each member whose phone rang, and the call is no group's any more.
        if (call.group && !str(p.group)) this.leaveGroup(call, now)
        if (call.group) break
        this.moveTo(call, userOf(str(p.callee)), Number(p.code) || 0, now)
        // To a ring group (the fallback of a direct number): its members ring from here on.
        if (str(p.group)) call.group = { ringing: new Set(), told: false }
        break
      }
      case 'E_TWAKEPHONE_DND': {
        // Refused for `callee`, who does not want to be disturbed (and has nowhere to forward to): the missed call
        // event that follows ends it, as a missed call for them. `told` "0": the caller did not call them (a forward
        // led there) and was not told why. The refusal may be the dialled extension's after its forward rang
        // someone else (`code`: how it ended there), who is left with a missed (or declined) call.
        const call = this.find(p, now)
        if (!call || call.group) return
        this.moveTo(call, userOf(str(p.callee)), Number(p.code) || 0, now)
        call.dnd = { told: str(p.told) !== '0' }
        break
      }
      case 'E_FRD_WARNING':
      case 'E_FRD_CRITICAL':
      case 'E_TWAKEPHONE_LIMIT':
      case 'E_TWAKEPHONE_RIGHTS': {
        // For the administrators only: the Gateway keeps it, nobody's phone hears of it.
        const alert = alertOf(method, p)
        if (alert?.extension) this.emit(alert.extension, { type: 'alert.raised', timestamp: now, payload: { alert } })
        return
      }
      case 'E_TWAKEPHONE_PIN': {
        // The access number of the rooms (step 8), for the administrators, under it (nobody's extension): the tries of
        // a PIN of all callers in 10 minutes at MEET_PIN_TRIES_ALL (pin-tries), or MEET_CALLS_ALL calls to it at the same
        // time (meet-calls, the next ones refused).
        const number = str(p.number)
        if (!/^[1-9][0-9]{1,5}$/.test(number)) return
        const param = p.param === undefined ? 'pin-tries' : str(p.param) === 'calls' ? 'meet-calls' : str(p.param)
        if (param !== 'pin-tries' && param !== 'meet-calls') return
        const value = num(p.value)
        const threshold = num(p.threshold)
        const alert: TelephonyAlert = { kind: 'meet', param, scope: 'tenant', number, ...(value !== undefined ? { value } : {}), ...(threshold !== undefined ? { threshold } : {}) }
        this.emit(number, { type: 'alert.raised', timestamp: now, payload: { alert } })
        return
      }
      case 'E_TWAKEPHONE_EMERGENCY': {
        // Never refused, never counted by a cap: emergency calls in a row from one extension (EMERGENCY_BURST within
        // EMERGENCY_BURST_WINDOW_MS) are told to the administrators, each one from there on.
        const ext = userOf(str(p.caller))
        if (!ext || isExternalParty(ext)) return
        const at = Date.parse(now)
        const recent = (this.emergencies.get(ext) ?? []).filter(t => at - t < EMERGENCY_BURST_WINDOW_MS)
        recent.push(at)
        this.emergencies.set(ext, recent)
        if (recent.length >= EMERGENCY_BURST) {
          const number = str(p.number)
          const alert: TelephonyAlert = { kind: 'emergency', param: 'burst', scope: 'user', value: recent.length, threshold: EMERGENCY_BURST, extension: ext, ...(/^[0-9]{2,6}$/.test(number) ? { number } : {}) }
          this.emit(ext, { type: 'alert.raised', timestamp: now, payload: { alert } })
        }
        // Bounded: the oldest extension goes past 10 000.
        if (this.emergencies.size > MAX_TOMBSTONES) this.emergencies.delete(this.emergencies.keys().next().value!)
        return
      }
      case 'E_TWAKEPHONE_WAKE': {
        // Nobody of `callee` (the extension the call reached, or a member of the group dialled) is registered:
        // OpenSIPS holds the call `wait` seconds while the Gateway wakes their browsers.
        const call = this.find(p, now)
        const who = userOf(str(p.callee))
        if (!call || !who || call.connectedAt || who === call.caller) return
        ;(call.woken ??= new Set()).add(who)
        const waitSec = num(p.wait) ?? 0
        this.emit(who, { type: 'call.wake', timestamp: this.now(), payload: { call: this.toCall(call, who, 'ringing'), waitSec, ...(call.group ? { group: call.dialled } : {}) } })
        return
      }
      case 'E_TWAKEPHONE_VOICEMAIL': {
        // The mailbox of `callee`, the extension dialled, answered (step 11a): nobody of theirs answered, refused or
        // could be reached (`code`: what the caller would have been told). Whoever a forward made ring before has the
        // call missed (or declined); the callee too, at once (their phone is free: the mailbox has the call); the caller
        // is in a call, with the mailbox.
        const call = this.find(p, now)
        if (!call || call.connectedAt || call.conference) return
        // The fallback group of a direct number nobody of which answered, then the mailbox of the extension the number
        // rings (second review 11a, n°5): each member whose phone rang has the call missed, never taken by a colleague;
        // the call is no group's any more.
        if (call.group) this.leaveGroup(call, now)
        const code = Number(p.code) || 0
        this.moveTo(call, userOf(str(p.callee)), code, now)
        if (call.rang) this.count(call.callee, -1)
        call.rang = false
        call.woken?.delete(call.callee)
        call.voicemail = true
        call.connectedAt = now
        // Told once: the extension dialled whose phone rang before a forward (or a group) has its missed call already.
        if (call.callee !== call.caller && !call.over?.has(call.callee)) this.emit(call.callee, { type: 'call.ended', timestamp: now, payload: { call: { ...this.toCall(call, call.callee, DECLINED.has(code) ? 'rejected' : 'missed', now), connectedAt: undefined } } })
        this.tell(call, call.caller, 'call.connected', 'connected')
        break
      }
      case 'E_TWAKEPHONE_RINGING': {
        const call = this.find(p, now)
        // A group call: `callee` is the member whose phone rings.
        if (call?.group) {
          this.memberRings(call, userOf(str(p.callee)))
          break
        }
        if (!call || call.rang) return
        this.rings(call)
        this.tellBoth(call, 'call.ringing', 'ringing')
        break
      }
      case 'E_TWAKEPHONE_ANSWERED': {
        const call = this.find(p, now)
        if (!call || call.connectedAt) return
        if (call.group) this.memberAnswers(call, userOf(str(p.callee)))
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
        // Answered (by the member acc names, for a group whose answer was not told): both sides knew of it. By the
        // callee's mailbox (step 11a): the callee was told already, and was never busy with it.
        if (call.group && !call.connectedAt) this.memberAnswers(call, userOf(str(p.callee)))
        if (!call.voicemail) this.rings(call)
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
        // Refused by a "do not disturb": the callee's phone stayed silent, but the call is theirs, missed. A group's
        // members who rang have it as missed whatever its final status (one declining is not the group refusing).
        if (call.dnd) this.rings(call)
        this.end(call, at !== undefined ? iso(at) : now, call.dnd?.told ? 'rejected' : failedState(code), DECLINED.has(code) ? 'rejected' : 'missed')
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
    const dialled = userOf(str(p.dialled)) || undefined
    if (!caller || !callee) return undefined
    // A group call born late: its callee is the group until a member answers (the event names that member).
    if (str(p.group)) {
      const call = this.start(id, caller, dialled ?? callee, startedAt, dialled)
      call.group = { ringing: new Set(), told: false }
      return call
    }
    return this.start(id, caller, callee, startedAt, dialled, str(p.conference) === '1')
  }

  /** A member's phone rings for a group call: it is busy with it, and told; the caller hears it rings once. */
  private memberRings(call: TrackedCall, member: string) {
    const group = call.group!
    if (!member || member === call.caller || call.connectedAt || group.ringing.has(member)) return
    group.ringing.add(member)
    this.count(member, 1)
    this.tell(call, member, 'call.ringing', 'ringing')
    if (!group.told) {
      group.told = true
      this.tell(call, call.caller, 'call.ringing', 'ringing')
    }
  }

  /**
   * A member answers a group call: it becomes the callee (busy already if its phone rang). The others stop ringing:
   * the call was answered, by a colleague; no missed call of theirs.
   */
  private memberAnswers(call: TrackedCall, member: string) {
    const group = call.group!
    if (!member) return
    const others = [...group.ringing].filter(other => other !== member)
    for (const other of others) this.count(other, -1)
    const rang = group.ringing.has(member)
    group.ringing.clear()
    // Those it rang, and those woken for it, hear only that a colleague took the call (`rang`: their phone rang for
    // it; their browsers' notification says so instead of ringing on).
    const taken = (other: string, rang: boolean) => this.emit(other, { type: 'call.taken', timestamp: this.now(), payload: { call: this.toCall(call, other, 'ended'), by: member, ...(rang ? { rang } : {}) } })
    for (const other of others) taken(other, true)
    for (const other of call.woken ?? []) if (other !== member && !others.includes(other)) taken(other, false)
    call.woken?.clear()
    call.callee = member
    call.rang = rang
  }

  /** A group call leaves its group: each member whose phone rang has it missed; the group's number is its callee. */
  private leaveGroup(call: TrackedCall, now: string) {
    for (const m of call.group?.ringing ?? []) {
      this.count(m, -1)
      if (m !== call.caller) {
        this.emit(m, { type: 'call.ended', timestamp: this.now(), payload: { call: this.toCall(call, m, 'missed', now) } })
        ;(call.over ??= new Set()).add(m)
      }
    }
    delete call.group
    call.rang = false
  }

  /** The call goes to `to` now: the callee it leaves is told it ended (missed, or declined) if its phone rang for it. */
  private moveTo(call: TrackedCall, to: string, code: number, now: string) {
    if (!to || call.callee === to) return
    // Woken for it (its browser was, nothing of its rang): missed all the same.
    const woken = call.woken?.delete(call.callee) ?? false
    if (call.rang) this.count(call.callee, -1)
    if ((call.rang || woken) && call.callee !== call.caller) {
      this.emit(call.callee, { type: 'call.ended', timestamp: this.now(), payload: { call: this.toCall(call, call.callee, DECLINED.has(code) ? 'rejected' : 'missed', now) } })
      ;(call.over ??= new Set()).add(call.callee)
    }
    call.callee = to
    call.rang = false
  }

  private start(id: string, caller: string, callee: string, startedAt: string, dialled = callee, conference = false): TrackedCall {
    const call: TrackedCall = { id, caller, callee, dialled, startedAt, rang: false, ...(conference ? { conference } : {}) }
    this.calls.set(id, call)
    if (!conference) this.count(caller, 1)
    return call
  }

  /** The callee's phone rings: it is busy from now on. */
  private rings(call: TrackedCall) {
    if (call.rang) return
    call.rang = true
    this.count(call.callee, 1)
  }

  private count(extension: string, delta: number) {
    if (isExternalParty(extension)) return
    const n = (this.busy.get(extension) ?? 0) + delta
    if (n > 0) this.busy.set(extension, n)
    else this.busy.delete(extension)
  }

  private toCall(c: TrackedCall, viewer: string, state: CallState, endedAt?: string): Call {
    // A conference's call is the callee's, from whoever made it: their own (they are its callee) is the one they made.
    const outbound = viewer === c.caller
    return {
      ...(c.conference ? { conference: true } : {}),
      ...(c.voicemail ? { voicemail: true } : {}),
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
    for (const ext of c.conference || c.caller === c.callee ? [c.callee] : [c.caller, c.callee]) this.tell(c, ext, type, state)
  }

  /**
   * Tells each side how its call ended; the callee only hears of a call its phone rang for. An end OpenSIPS told
   * leaves a tombstone; one deduced (a resync, a call too old) does not, so the real end may still come.
   */
  private end(c: TrackedCall, endedAt: string, callerState: CallState, calleeState: CallState, tombstone = true) {
    this.calls.delete(c.id)
    if (!c.conference) this.count(c.caller, -1)
    if (c.rang) this.count(c.callee, -1)
    // The members of a group whose phone rang and nobody answered: a missed call for each; and so for those woken.
    const rang = [...(c.group?.ringing ?? [])]
    for (const m of rang) this.count(m, -1)
    c.group?.ringing.clear()
    const callee = !c.voicemail && (c.conference || c.callee !== c.caller) && (c.rang || !!c.woken?.has(c.callee))
    const members = [...new Set([...rang, ...[...(c.woken ?? [])].filter(m => m !== c.callee && m !== c.caller)])]
    if (tombstone) {
      this.ended.add(c.id)
      if (this.ended.size > MAX_TOMBSTONES) this.ended.delete(this.ended.values().next().value!)
    }
    const timestamp = this.now()
    const event = (ext: string, state: CallState): TelephonyEvent => ({ type: state === 'failed' ? 'call.failed' : 'call.ended', timestamp, payload: { call: this.toCall(c, ext, state, endedAt) } })
    if (!c.conference) this.emit(c.caller, event(c.caller, callerState))
    if (callee) this.emit(c.callee, event(c.callee, calleeState))
    for (const m of members) this.emit(m, event(m, 'missed'))
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
