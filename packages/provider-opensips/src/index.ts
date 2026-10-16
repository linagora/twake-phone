import type { CallParties, MediaProvider, ProviderFactory, RoomCallGrant, RoomCallGrantToken, RoutedEvent, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { Call, Capabilities, DidRange, Endpoint, ForwardingRules, MediaSession, OriginateRequest, OutboundAssignment, OutboundPolicy, OutboundProfile, Presence, ProviderStatus, RingGroup, Trunk, TrunkStatus, User } from '@twake/telephony-types'
import type { CallGroups } from './call-groups.js'
import type { CallRules } from './call-rules.js'
import type { PushTargets } from './push-targets.js'
import type { DialOutGrants } from './dial-out-grants.js'
import type { OutboundTables } from './outbound.js'
import { trunkStatusFrom, type TrunkTables } from './trunks.js'
import { OpensipsEvents, parseDlgContext, parseDlgList, parseUlDump, type EventsLogger } from './events.js'
import { AsyncQueue } from './queue.js'
import { CallTracker } from './tracker.js'

export { SubscriberProvisioner, digestHashes, SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, EXTRA_COLUMNS, SUBSCRIBER_TABLE_VERSION, ACC_TABLE_VERSION, MISSED_CALLS_TABLE_VERSION, type SubscriberProvisionerOptions, type Queryable } from './subscriber.js'
export { OpensipsEvents, parseDlgContext, parseDlgList, parseUlDump, parseUdpUrl, type EventsLogger, type OpensipsEventsOptions, type RegisteredContact } from './events.js'
export { CallTracker, alertOf, userOf, isExternalParty, EMERGENCY_BURST, EMERGENCY_BURST_WINDOW_MS, type ContactRegistration, type TelephonyPresence } from './tracker.js'
export { CallRules, CALL_RULES_SCHEMA, DND_MESSAGE_MAX, NOANSWER_DELAY, type CallRulesOptions, type DndRule, type ExtensionHolder } from './call-rules.js'
export { CallGroups, CALL_GROUPS_SCHEMA, DISPLAY_NAMES_SCHEMA, GROUP_MEMBERS_MAX, NAME_MAX, sipDisplayName, type CallGroupsOptions } from './call-groups.js'
export { PushTargets, PUSH_TARGETS_SCHEMA, type PushTargetsOptions } from './push-targets.js'
export { DialOutGrants, DIAL_OUT_GRANTS_SCHEMA, GRANT_HEADER, GRANT_TTL_SEC, JOIN_HEADER, JOIN_TOKEN, REPLACES, type DialOutGrantsOptions } from './dial-out-grants.js'
export { AsyncQueue } from './queue.js'
export { TrunkTables, TRUNK_SCHEMA, TRUNK_SQL, DEFAULT_TRUNK_SOCKET, SOURCES_SET, DISPATCHER_TABLE_VERSION, DIALPLAN_TABLE_VERSION, REGISTRANT_TABLE_VERSION, codecFlags, projectTrunks, trunkSecret, trunkStatusFrom, type TrunkTablesOptions } from './trunks.js'
export { OutboundTables, OUTBOUND_SCHEMA, ACC_EXTERNAL_SQL, FRAUD_PROFILE, FRAUD_RULE_INTERNATIONAL, FRAUD_RULE_NATIONAL, FRAUD_TABLE_VERSION, FRAUD_OVERSEAS_PREFIXES, DR_TABLE_VERSIONS, DIALOG_TABLE_VERSION, OUTBOUND_TIME_ZONE, CAP_MAX, PROFILE_ID, fraudRow, projectOutbound, type OutboundTablesOptions } from './outbound.js'
export { DIALPLAN_RULES, DIALPLAN_SQL, DP_CLASSIFY, DP_INBOUND, DP_NORMALISE, OUTBOUND_ALLOWABLE, OUTBOUND_ALLOWED, classify, countryAllowed, translate, type DialplanRule, type NumberClass } from './numbering.js'

/**
 * The event the Gateway raises itself through the MI after each subscription to tell it hears OpenSIPS
 * (opensips.cfg.tpl declares it, and never raises it).
 */
export const PROBE_EVENT = 'E_TWAKEPHONE_PROBE'

/**
 * The events the Gateway listens to: registrations and their refreshes (usrloc), our own call events (opensips.cfg.tpl),
 * the CDRs and missed calls (acc), the thresholds crossed (fraud_detection) and the caps reached (step 6b).
 */
export const SUBSCRIBED_EVENTS = [
  'E_UL_CONTACT_INSERT',
  'E_UL_CONTACT_UPDATE',
  'E_UL_CONTACT_DELETE',
  'E_UL_AOR_DELETE',
  'E_TWAKEPHONE_CALLING',
  'E_TWAKEPHONE_RINGING',
  'E_TWAKEPHONE_ANSWERED',
  'E_TWAKEPHONE_FORWARDED',
  'E_TWAKEPHONE_DND',
  'E_TWAKEPHONE_WAKE',
  PROBE_EVENT,
  'E_ACC_CDR',
  'E_ACC_MISSED_EVENT',
  'E_FRD_WARNING',
  'E_FRD_CRITICAL',
  'E_TWAKEPHONE_LIMIT',
  'E_TWAKEPHONE_RIGHTS',
  'E_TWAKEPHONE_EMERGENCY',
  'E_TWAKEPHONE_PIN'
]

// Everything OpenSIPS-specific stays inside this package: the Gateway and the app only see the provider contract.

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface OpensipsConfig {
  /** Public SIP-over-WebSocket URL browsers register to (wss:// in production, ws:// on a local test stack). */
  websocketUrl: string
  /** SIP domain of the accounts (`sip:101@<domain>`), which is also the digest realm. */
  domain: string
  iceServers?: IceServer[]
  /** The per-user SIP secret, generated and kept by the Gateway, provisioned in `subscriber`. */
  sipSecretFor(extension: string): Promise<string>
  /** Releases what `sipSecretFor` holds (the provisioner's connection pool) when the Gateway stops. */
  onClose?(): Promise<void>
  /**
   * Where to hear OpenSIPS (ADR 0011): its MI socket (`mi_datagram`, `udp:host:port`), the address this process
   * listens on for the events (`host[:port]`; the loopback by default) and, when OpenSIPS must be given another
   * one (a wildcard `listen`, a container), the address it sends them to (`advertise`), and the addresses they may
   * come from besides the MI host (`from`: OpenSIPS sends them from the address the kernel picks). Without it the provider has
   * no events: no presence of the others, no history.
   */
  events?: { miUrl: string; listen?: string; advertise?: string; from?: string[]; expireSec?: number; timeoutMs?: number }
  /**
   * The `call_rules` OpenSIPS reads at each call (ADR 0013): forwards, and the "do not disturb" of the people who
   * chose one. Without it, no forwarding, and a "do not disturb" is only a presence.
   */
  callRules?: CallRules
  /**
   * The `call_groups` and `display_names` OpenSIPS reads at each call (ADR 0014): simultaneous ring groups, and the
   * directory name each party is shown of the other. Without it, no groups, and the names are the phones' own.
   */
  callGroups?: CallGroups
  /**
   * The `push_targets` OpenSIPS reads when a call finds no window of the extension it reaches (ADR 0015): who can be
   * woken. Without it (or without the events, which tell whom to wake), a call to someone without a window fails or
   * forwards at once, as before.
   */
  pushTargets?: PushTargets
  /**
   * The grants OpenSIPS takes for each call a room of Meet places (ADR 0018, route[meet_source]): written before the
   * Gateway asks LiveKit for the call. Without it, OpenSIPS refuses every call of the rooms.
   */
  dialOutGrants?: DialOutGrants
  /**
   * The trunks and direct numbers OpenSIPS reads (ADR 0016): its dispatcher, registrations and numbering plan are
   * reloaded through the MI when they change. Without it, no call to or from the public network.
   */
  trunks?: TrunkTables
  /**
   * The rights profiles, caps and volume thresholds OpenSIPS applies to the calls to the public network (ADR 0017):
   * its fraud_detection reloads the thresholds through the MI when they change. Without it, what the trunks allow.
   */
  outbound?: OutboundTables
  /**
   * The SIP accounts (`subscriber`) OpenSIPS authenticates and routes by: `reconcile` removes those the Gateway
   * wrote for a user who no longer holds the extension, and returns their extensions (SubscriberProvisioner's
   * reconcileAccounts). Without it, an account outlives its holder's mapping.
   */
  accounts?: { reconcile(holders: { extension: string; userId: string }[]): Promise<string[]> }
  /** What is wrong with OpenSIPS's tables (SubscriberProvisioner's schemaProblem): the provider is DEGRADED while so. */
  schemaProblem?: () => string | undefined
  logger?: EventsLogger
}

const START_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** setTimeout's longest delay (about 24 days): a later end is waited for in several steps. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** One of our extensions, as a dialog names it; a tag that a Replaces header carries as it is (REPLACES). */
const EXTENSION = /^[0-9]{2,20}$/
const TAG = /^[A-Za-z0-9._~!%*+-]{1,50}$/

const noExtension = () => Object.assign(new Error('No extension is assigned to this user'), { statusCode: 404 })

const notYet = (what: string) => Object.assign(new Error(`${what} through the Gateway is not available yet; the softphone does it directly for now`), { statusCode: 501 })

/**
 * The SIP server registers browsers and routes their calls; call control happens in the softphone (JsSIP). The
 * Gateway's part is the media session (where to register and as whom) and, since step 4, what OpenSIPS tells it:
 * who is registered and in a call (presence), how each call went (history). Click-to-call comes later.
 */
export class OpensipsProvider implements TelephonyProvider, MediaProvider {
  readonly id = 'opensips'
  /** The presence of users without an extension: nothing but what they set themselves. */
  private readonly unmapped = new Map<string, Presence>()
  /** The extensions whose "do not disturb" this provider wrote in `call_rules` (even past its end): leaving it lifts it there. */
  private readonly dndWritten = new Set<string>()
  private readonly queue: AsyncQueue<RoutedEvent>
  private readonly tracker: CallTracker
  private readonly events?: OpensipsEvents
  private subscribed = false
  private closed = false
  private startTimer?: ReturnType<typeof setTimeout>
  /** Tells the end of a chosen presence (a "do not disturb" until a date) when it comes. */
  private expiryTimer?: ReturnType<typeof setTimeout>
  /** Whether OpenSIPS reloaded the numbering plan the Gateway wrote at its start (once per start of the provider). */
  private dialplanLoaded = false
  /** What OpenSIPS was asked to reload and did not: asked again at the next change, whatever it changes. */
  private readonly pendingReloads = new Set<string>()

  constructor(private readonly config: OpensipsConfig) {
    for (const [name, value] of Object.entries({ websocketUrl: config.websocketUrl, domain: config.domain })) {
      if (typeof value !== 'string' || !value) throw new Error(`OpenSIPS provider: ${name} is required`)
    }
    if (!/^wss?:\/\//.test(config.websocketUrl)) throw new Error('OpenSIPS provider: websocketUrl must be a ws:// or wss:// URL')
    const log = config.logger ?? console
    // A consumer stuck (a database that hangs) must not make the Gateway grow without bound: past 10 000 waiting
    // events, some are dropped, and said so. Presences go first: the next one replaces them, a call event has none.
    this.queue = new AsyncQueue<RoutedEvent>(
      10_000,
      dropped => log.warn(`OpenSIPS events: the Gateway does not keep up, events dropped (${dropped} so far)`),
      e => e.event.type === 'presence.changed'
    )
    this.tracker = new CallTracker((extension, event) => this.queue.push({ extension, event }))
    if (config.events) {
      this.events = new OpensipsEvents({
        miUrl: config.events.miUrl,
        ...(config.events.listen ? { listen: config.events.listen } : {}),
        ...(config.events.advertise ? { advertise: config.events.advertise } : {}),
        ...(config.events.from?.length ? { from: config.events.from } : {}),
        ...(config.events.expireSec ? { expireSec: config.events.expireSec } : {}),
        ...(config.events.timeoutMs ? { timeoutMs: config.events.timeoutMs } : {}),
        events: SUBSCRIBED_EVENTS,
        onEvent: (method, params) => this.tracker.handle(method, params),
        onResync: () => this.resync(),
        onRenewed: () => this.tracker.sweep(),
        // The rows of push_targets live as long as this subscription, once the Gateway heard OpenSIPS since it was
        // made or renewed: OpenSIPS holds a call for someone to wake only while a Gateway hears it (a Gateway gone, or
        // deaf, its rows lapse with its subscription).
        probeEvent: PROBE_EVENT,
        onHeard: expireSec => {
          void this.config.pushTargets?.keepAlive(expireSec).catch((err: unknown) => log.warn(`push_targets not kept alive: ${err instanceof Error ? err.message : String(err)}`))
        },
        // The subscription lapsed in OpenSIPS: the registrations it told no longer hold (everyone offline) until
        // the next resync, which also ends the calls it no longer has. A failed renewal alone changes nothing.
        onExpired: () => {
          if (!this.closed) this.tracker.reset()
        },
        logger: log
      })
      this.startEvents(0, log)
    }
  }

  /** Binds the event socket; a failure (address in use, not ours yet) is tried again with a growing delay. */
  private startEvents(attempt: number, log: EventsLogger) {
    this.events?.start().catch(err => {
      if (this.closed) return
      const delay = START_RETRY_MS[Math.min(attempt, START_RETRY_MS.length - 1)]!
      log.warn(`OpenSIPS events not started: ${err instanceof Error ? err.message : String(err)}; retrying in ${delay / 1000} s`)
      this.startTimer = setTimeout(() => this.startEvents(attempt + 1, log), delay)
      this.startTimer.unref?.()
    })
  }

  /**
   * What OpenSIPS holds now, read again after each (re)subscription and restart: registrations, then dialogs. What
   * is known is taken before each question: an event that comes while the answer is on its way is newer than it.
   */
  private async resync() {
    if (!this.events) return
    const contacts = this.tracker.knownContacts()
    this.tracker.seedRegistrations(parseUlDump(await this.events.call('ul_dump')), contacts)
    const calls = this.tracker.knownCalls()
    this.tracker.seedDialogs(parseDlgList(await this.events.call('dlg_list')), calls)
  }

  /**
   * DEGRADED while the events are configured but not subscribed (OpenSIPS down or restarting: calls still go through),
   * or while OpenSIPS's tables lack what the CDRs and the caps need (`schemaProblem`).
   */
  getStatus(): ProviderStatus {
    if (this.config.schemaProblem?.()) return 'DEGRADED'
    return !this.events || this.events.connected ? 'CONNECTED' : 'DEGRADED'
  }

  getStatusReason(): string | undefined {
    return this.config.schemaProblem?.() ?? this.events?.reason
  }

  async getCapabilities(): Promise<Capabilities> {
    return {
      // The browser does the calling; the Gateway cannot originate for it yet.
      calling: { outbound: false, inbound: true, answer: false, hangup: false, hold: false, transfer: false, dtmf: false },
      media: { browserAudio: true },
      // Presences are told as they change only while OpenSIPS's events come; the history is filled from them.
      presence: { read: true, write: true, realtime: !!this.events?.live, statuses: ['available', 'busy', 'away', 'dnd', 'offline'] },
      history: !!this.events,
      forwarding: !!this.config.callRules,
      groups: !!this.config.callGroups,
      push: !!this.config.pushTargets && !!this.events,
      trunks: !!this.config.trunks,
      outboundPolicy: !!this.config.trunks && !!this.config.outbound,
      conference: { dialIn: false, dialOut: false }
    }
  }

  /** The presence of a user with an extension comes from the SIP server (registered, in a call) and what they set. */
  async getPresence(user: User): Promise<Presence> {
    if (user.extension) return this.tracker.presenceOf(user.extension)
    const chosen = this.unmapped.get(`${user.tenantId}:${user.id}`)
    return chosen && !(chosen.until && Date.parse(chosen.until) <= Date.now()) ? chosen : { status: 'available', source: 'system' }
  }

  /**
   * What the user chose. A "do not disturb" is written in `call_rules` first (OpenSIPS refuses or forwards their
   * calls while it lasts, and lifts it at its end by itself); leaving it lifts it there. Any other change (away,
   * available after away) is the Gateway's alone: it does not wait on OpenSIPS's database.
   */
  async setPresence(user: User, presence: Presence) {
    if (!user.extension) {
      this.unmapped.set(`${user.tenantId}:${user.id}`, presence)
      return
    }
    const dnd = presence.status === 'dnd'
    if (dnd || this.dndWritten.has(user.extension)) {
      await this.config.callRules?.setDnd(user.extension, dnd ? { ...(presence.until ? { until: presence.until } : {}), ...(presence.message ? { message: presence.message } : {}) } : null, user.id)
      if (dnd) this.dndWritten.add(user.extension)
      else this.dndWritten.delete(user.extension)
    }
    this.tracker.setUserPresence(user.extension, presence)
    this.armExpiry()
  }

  /**
   * The choices the Gateway kept, at its start: applied, and every other one forgotten, here and in `call_rules`
   * (a "do not disturb" left there by someone who no longer holds the extension, or lifted while this was down).
   */
  async restorePresences(entries: { user: User; presence: Presence }[]) {
    const mapped = entries.filter((e): e is { user: User & { extension: string }; presence: Presence } => !!e.user.extension)
    for (const e of entries) if (!e.user.extension) this.unmapped.set(`${e.user.tenantId}:${e.user.id}`, e.presence)
    const keep = new Set(mapped.map(e => e.user.extension))
    for (const ext of this.tracker.userPresences().keys()) if (!keep.has(ext)) this.tracker.clearUserPresence(ext)
    const dnd = mapped.filter(e => e.presence.status === 'dnd').map(e => e.user.extension)
    await this.config.callRules?.clearDndExcept(dnd)
    for (const ext of [...this.dndWritten]) if (!dnd.includes(ext)) this.dndWritten.delete(ext)
    for (const { user, presence } of mapped) await this.setPresence(user, presence)
    this.armExpiry()
  }

  /**
   * Who holds each extension of the tenant now, after any change (a synchronisation, an administrator): the rules
   * of an extension that changed holder go, and so do the forwards to one (ADR 0013); the names OpenSIPS shows are
   * those of the directory (ADR 0014). The SIP account of an extension nobody holds goes, and so does that of an
   * extension whose holder changed (the newcomer's session writes their own): the account says whom it was written
   * for. Its windows go from OpenSIPS's location table at once (MI `ul_rm`): a call to the number finds nobody
   * there, and the number is free for a group. The presences follow with `restorePresences`.
   */
  async syncExtensions(holders: { extension: string; userId: string; displayName?: string }[]) {
    await this.config.callRules?.reconcile(holders)
    await this.config.callGroups?.reconcile(holders)
    await this.config.pushTargets?.reconcile(holders)
    const removed = (await this.config.accounts?.reconcile(holders.map(({ extension, userId }) => ({ extension, userId })))) ?? []
    for (const extension of removed) {
      // Without the MI (no events, OpenSIPS down), the windows go when their registration ends: it can no longer be renewed.
      if (!this.events) break
      await this.events.call('ul_rm', ['location', extension]).catch((err: unknown) =>
        (this.config.logger ?? console).warn(`OpenSIPS: the windows of ${extension} not removed (${err instanceof Error ? err.message : String(err)}); they go when their registration ends`)
      )
    }
  }

  /** One timer, for the earliest end of a chosen presence: the others are told it ended when it does. */
  private armExpiry() {
    clearTimeout(this.expiryTimer)
    const end = this.tracker.nextUserPresenceEnd()
    if (end === undefined || this.closed) return
    this.expiryTimer = setTimeout(() => {
      this.tracker.expire()
      this.armExpiry()
    }, Math.min(Math.max(end - Date.now(), 0) + 50, MAX_TIMER_MS))
    this.expiryTimer.unref?.()
  }

  /**
   * Who can be woken for a call (ADR 0015): written in `push_targets`, which OpenSIPS reads when a call finds no
   * window. Without the events, nobody: OpenSIPS would hold the call, and nobody would hear whom to wake.
   */
  async setWakeable(holders: { extension: string; userId: string }[]) {
    if (!this.config.pushTargets) return
    await this.config.pushTargets.set(this.events ? holders : [])
  }

  /** One person's line of setWakeable: whether `holder` can be woken now; the others are not written. */
  async setWakeableOne(holder: { extension: string; userId: string }, on: boolean) {
    if (!this.config.pushTargets) return
    await this.config.pushTargets.setOne(holder, on && !!this.events)
  }

  /**
   * The access number of Meet's rooms as OpenSIPS has it (its shared variables meet_on and meet_number, MI shv_get):
   * `number` undefined when Meet is off there. Undefined when it cannot be asked (no MI) or did not say.
   */
  async getMeetAccess(): Promise<{ number?: string } | undefined> {
    if (!this.events) return undefined
    const vars = (await this.events.call<{ VARs?: { name?: string; value?: unknown }[] } | undefined>('shv_get'))?.VARs
    if (!Array.isArray(vars)) return undefined
    const on = vars.find(v => v.name === 'meet_on')?.value
    const number = vars.find(v => v.name === 'meet_number')?.value
    if (on === undefined) return undefined
    return Number(on) === 1 && typeof number === 'string' ? { number } : {}
  }

  /**
   * A room of Meet may call `number` at the name of `extension`, once, within `ttlSec` seconds (route[meet_source]);
   * in the place of a call of `number` (`replaces`), or to the window of `extension` that waits for `join` (step 8b),
   * a call of the conference `room`. `taken`: the call that took it, as OpenSIPS wrote it (review 8b, n°3).
   */
  async grantRoomCall(grant: RoomCallGrant): Promise<RoomCallGrantToken> {
    const grants = this.config.dialOutGrants
    if (!grants) throw Object.assign(new Error('The SIP server cannot let a room call'), { statusCode: 501 })
    const conference = {
      ...(grant.replaces !== undefined ? { replaces: grant.replaces } : {}),
      ...(grant.join !== undefined ? { join: grant.join } : {}),
      ...(grant.room !== undefined ? { room: grant.room } : {})
    }
    const token = await grants.grant(grant.extension, grant.number, grant.ttlSec, conference)
    return { token, revoke: () => grants.revoke(token), taken: () => grants.taken(token) }
  }

  /**
   * Ends a call OpenSIPS has, by its Call-ID (MI dlg_end_dlg, review 8b, n°3): a BYE to both sides, a CANCEL if it
   * still rings. False for a call it does not have (404: over already, failed, never there; OpenSIPS 3.6.9 looks among
   * the dialogs not ended only).
   */
  async endRoomCall(callId: string): Promise<boolean> {
    if (!this.events) throw Object.assign(new Error('The SIP server cannot end a call'), { statusCode: 501 })
    return this.events.call('dlg_end_dlg', { dialog_id: callId }).then(
      () => true,
      (err: unknown) => {
        if ((err as { code?: unknown }).code !== 404) throw err
        return false
      }
    )
  }

  /**
   * The call `callId` as OpenSIPS's dialog holds it (MI dlg_list_ctx, step 8b): answered and confirmed (state 4),
   * between two extensions (no trunk, no room in its values), with the extension it reached (`callee`, written at
   * the ringing and by the member of a group who answered) and the tag of the answer (`callee_tag`, written at the
   * 2xx). Undefined without the MI, for a call it does not have (No such dialog, 404), or one not answered yet. An MI
   * that does not answer, or answers another error, is not "no such call" (review 8b, n°10): 503, SIP_SERVER_UNAVAILABLE.
   */
  async callBetweenExtensions(callId: string): Promise<CallParties | 'external' | undefined> {
    if (!this.events || !callId) return undefined
    const dialog = await this.events.call('dlg_list_ctx', { callid: callId }).then(parseDlgContext, (err: unknown) => {
      if ((err as { code?: unknown }).code === 404) return undefined
      const log = this.config.logger ?? console
      log.warn(`OpenSIPS: the call ${callId} not read (${err instanceof Error ? err.message : String(err)})`)
      throw Object.assign(new Error('The SIP server did not say where the call is'), { statusCode: 503, code: 'SIP_SERVER_UNAVAILABLE' })
    })
    if (!dialog || dialog.callid !== callId || dialog.state !== 4) return undefined
    if (dialog.values.trunk !== undefined || dialog.values.meet !== undefined) return 'external'
    const callee = dialog.values.callee ?? ''
    const calleeTag = dialog.values.callee_tag ?? ''
    if (!EXTENSION.test(dialog.caller) || !EXTENSION.test(callee) || dialog.caller === callee || !TAG.test(dialog.callerTag) || !TAG.test(calleeTag)) return undefined
    return { callId, caller: dialog.caller, callerTag: dialog.callerTag, callee, calleeTag }
  }

  /**
   * The trunks and direct numbers of the tenant (ADR 0016), written into OpenSIPS's database; then OpenSIPS reloads
   * what changed: its dispatcher (the operator's servers), its registrations (only when they changed: an operator
   * stops answering an address that registers too often, ARCHITECTURE §13), and, once per start, its numbering plan.
   * A reload that fails fails the change (502, code TRUNK_RELOAD_FAILED: written, not applied; asked again at the next
   * change). Without the MI, OpenSIPS reads them at its next start (logged).
   */
  async setTrunks(trunks: (Trunk & { password?: string })[], dids: DidRange[]) {
    if (!this.config.trunks) throw Object.assign(new Error('Trunks are not available on this platform'), { statusCode: 501 })
    const changed = await this.config.trunks.set(trunks, dids)
    const log = this.config.logger ?? console
    const wanted = new Set([...this.pendingReloads, ...(changed.dispatcher ? ['ds_reload'] : []), ...(changed.registrant ? ['reg_reload'] : []), ...(this.dialplanLoaded ? [] : ['dp_reload'])])
    const reloads = ['ds_reload', 'reg_reload', 'dp_reload'].filter(m => wanted.has(m))
    if (!reloads.length) return
    if (!this.events) {
      log.warn(`OpenSIPS: trunks written, ${reloads.join(', ')} not asked (no MI): OpenSIPS reads them at its next start`)
      return
    }
    const failed: string[] = []
    for (const method of reloads) {
      try {
        await this.events.call(method)
        this.pendingReloads.delete(method)
        if (method === 'dp_reload') this.dialplanLoaded = true
      } catch (err) {
        this.pendingReloads.add(method)
        failed.push(`${method} (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    if (failed.length) {
      log.warn(`OpenSIPS: trunks written, ${failed.join(', ')} failed: not applied until it reloads them or restarts`)
      throw Object.assign(new Error(`OpenSIPS did not reload the trunks: ${failed.join(', ')}`), { statusCode: 502, code: 'TRUNK_RELOAD_FAILED' })
    }
  }

  /**
   * How the tenant's trunks are doing (step 7): OpenSIPS is asked through the MI (`ds_list`, `reg_list`) how it sees
   * the servers and registrations of the trunks the database holds for the tenant. Undefined without the MI.
   */
  async getTrunkStatus(): Promise<TrunkStatus[] | undefined> {
    if (!this.config.trunks) throw Object.assign(new Error('Trunks are not available on this platform'), { statusCode: 501 })
    if (!this.events) return undefined
    const sets = await this.config.trunks.sets()
    if (!sets.length) return []
    const [ds, reg] = await Promise.all([this.events.call('ds_list'), sets.some(s => s.aor) ? this.events.call('reg_list') : Promise.resolve(undefined)])
    return trunkStatusFrom(sets, ds, reg)
  }

  /**
   * The outbound policy of the tenant (ADR 0017), written into OpenSIPS's database: the next call reads the rights
   * and caps; the thresholds apply once OpenSIPS reloaded them (fraud_reload, only when they changed). A reload that
   * fails fails the change (502, code OUTBOUND_RELOAD_FAILED: written, asked again at the next change). Without the
   * MI, OpenSIPS reads them at its next start.
   */
  async setOutboundPolicy(policy: OutboundPolicy, profiles: OutboundProfile[], assignments: OutboundAssignment[]) {
    if (!this.config.outbound) throw Object.assign(new Error('Outbound policies are not available on this platform'), { statusCode: 501 })
    const changed = await this.config.outbound.set(policy, profiles, assignments)
    if (!changed.fraud && !this.pendingReloads.has('fraud_reload')) return
    if (!this.events) {
      ;(this.config.logger ?? console).warn('OpenSIPS: thresholds written, fraud_reload not asked (no MI): OpenSIPS reads them at its next start')
      return
    }
    try {
      await this.events.call('fraud_reload')
      this.pendingReloads.delete('fraud_reload')
    } catch (err) {
      this.pendingReloads.add('fraud_reload')
      const why = err instanceof Error ? err.message : String(err)
      ;(this.config.logger ?? console).warn(`OpenSIPS: thresholds written, fraud_reload failed (${why}): not applied until it reloads them or restarts`)
      throw Object.assign(new Error(`OpenSIPS did not reload the thresholds: ${why}`), { statusCode: 502, code: 'OUTBOUND_RELOAD_FAILED' })
    }
  }

  async getForwarding(user: User): Promise<ForwardingRules> {
    if (!user.extension) throw noExtension()
    if (!this.config.callRules) return {}
    return this.config.callRules.getForwarding(user.extension)
  }

  async setForwarding(user: User, rules: ForwardingRules) {
    if (!user.extension) throw noExtension()
    if (!this.config.callRules) throw Object.assign(new Error('Forwarding is not available on this platform'), { statusCode: 501 })
    await this.config.callRules.setForwarding(user.extension, rules, user.id)
  }

  private groups() {
    if (!this.config.callGroups) throw Object.assign(new Error('Call groups are not available on this platform'), { statusCode: 501 })
    return this.config.callGroups
  }

  async listGroups(): Promise<RingGroup[]> {
    return this.groups().list()
  }

  async setGroup(group: RingGroup, mode: 'create' | 'replace') {
    await this.groups().set(group, mode)
  }

  async deleteGroup(number: string) {
    return this.groups().delete(number)
  }

  /** The presence of every extension the SIP server told about. */
  presences(): Map<string, Presence> {
    return this.tracker.presences()
  }

  async getSession(user: User, endpoint: Endpoint): Promise<MediaSession> {
    if (endpoint.type !== 'browser') return { type: 'external' }
    if (!user.extension) throw Object.assign(new Error('No extension is assigned to this user'), { statusCode: 404 })
    return {
      type: 'sip-webrtc',
      websocketUrl: this.config.websocketUrl,
      domain: this.config.domain,
      username: user.extension,
      credential: await this.config.sipSecretFor(user.extension),
      iceServers: this.config.iceServers ?? []
    }
  }

  async originate(_request: OriginateRequest): Promise<Call> {
    throw notYet('Click-to-call')
  }
  async answer() {
    throw notYet('Answering')
  }
  async hangup() {
    throw notYet('Hanging up')
  }
  async hold() {
    throw notYet('Holding')
  }
  async resume() {
    throw notYet('Resuming')
  }
  async transfer() {
    throw notYet('Transferring')
  }
  async sendDTMF() {
    throw notYet('Sending DTMF')
  }

  /** The call and presence events, as the SIP server tells them; ends when the provider closes. One consumer. */
  subscribe(): AsyncIterable<RoutedEvent> {
    if (this.subscribed) throw new Error('OpenSIPS provider: subscribe() takes one consumer')
    this.subscribed = true
    return this.queue
  }

  async close() {
    this.closed = true
    clearTimeout(this.startTimer)
    clearTimeout(this.expiryTimer)
    await this.events?.stop()
    // Nobody hears whom to wake any more: no call waits for this tenant's browsers (best effort, bounded by the
    // database's own timeout).
    await this.config.pushTargets?.release().catch(() => undefined)
    this.queue.close()
    await this.config.onClose?.()
  }
}

export const opensipsProviderFactory: ProviderFactory<OpensipsConfig> = {
  type: 'opensips',
  create: config => new OpensipsProvider(config)
}
