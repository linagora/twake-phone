import type { Call, Capabilities, ConferenceParticipant, Contact, DialInConfiguration, DidRange, EmergencySite, ForwardingRules, FraudRule, MediaSession, OperatorLineForwards, OutboundAssignment, OutboundCaps, OutboundPolicy, OutboundProfile, Presence, PresenceStatus, RingGroup, TelephonyAlert, TelephonyEvent, Trunk, TrunkInput, TrunkStatus, Voicemail, WebhookEventType } from '@twake/telephony-types'

export type {
  Contact,
  ContactNumber,
  DidRange,
  EmergencySite,
  ForwardingRules,
  FraudRule,
  FraudThreshold,
  OperatorFallback,
  OperatorForward,
  OperatorForwardNature,
  OperatorLineForwards,
  OutboundAssignment,
  OutboundCaps,
  OutboundPolicy,
  OutboundProfile,
  RingGroup,
  TelephonyAlert,
  Trunk,
  TrunkAuth,
  TrunkCodec,
  TrunkInput,
  TrunkNumberFormat,
  TrunkOperator,
  TrunkOutboundClass,
  TrunkRegistrationState,
  TrunkServerState,
  TrunkStatus,
  Voicemail,
  WebhookEvent,
  WebhookEventType
} from '@twake/telephony-types'
// The rules the Gateway checks an administrator's settings with (step 7): the app checks them the same way before sending.
export {
  EXTENSION_FORMAT,
  FRAUD_DEFAULTS,
  FRAUD_PARAMS,
  OPERATOR_NO_ANSWER_MAX_SEC,
  OPERATOR_NO_ANSWER_MIN_SEC,
  OUTBOUND_CAPS,
  OUTBOUND_CAP_DEFAULTS,
  RESERVED_NUMBER,
  TRUNK_CODECS,
  TRUNK_COUNTRY,
  TRUNK_COUNTRY_EXCLUDED,
  TRUNK_OUTBOUND_CLASSES,
  TRUNK_OUTBOUND_DEFAULT,
  WEBHOOK_EVENT_TYPES,
  isReservedNumber,
  isValidExtension
} from '@twake/telephony-types'

import { backoffDelay } from './backoff.js'

/** How long a stream the Gateway did not acknowledge must stay open to count as established. */
const ESTABLISHED_AFTER_MS = 2_000

export { formatNumber, toDialTarget, toE164 } from './phoneNumber.js'
export { backoffDelay } from './backoff.js'

export interface TelephonyClientOptions {
  baseUrl: string
  getToken: () => Promise<string>
  /** URL of the user's Cozy instance. Sent with a Cozy token so the Gateway can ask that instance who it belongs to. */
  getInstance?: () => string
}

export interface HistoryItem {
  id: string
  direction: 'inbound' | 'outbound'
  remoteNumber: string
  startedAt: string
  endedAt?: string
  durationSec: number
  state: string
  answered: boolean
  missed: boolean
  /** A conference's call (step 8b): the room called the person in the place of a call of theirs. */
  conference?: boolean
  /** Taken by a mailbox (step 11a): the caller left a message (or could have), the person called has it. */
  voicemail?: boolean
  /**
   * Where the call is known from (step 10b): `opensips`, the SIP server; with the operator (`ovh`) when its record of
   * the call was reconciled with it; the operator alone for a call the platform never had (received while it could
   * not be reached).
   */
  sources?: string[]
  /**
   * Known from the operator alone, and forwarded there to the fallback number (second review 10b, n°4): the platform
   * could not be reached, the phone did not ring; missed, whoever took it at the fallback.
   */
  forwardedToFallback?: boolean
}

/**
 * Why the operator could not be read or written (OperatorErrorCode of the Gateway), or why a line is not kept as
 * asked: two trunks ask two fallbacks of it (`conflict`).
 */
export type OperatorProblem = 'unauthorized' | 'forbidden' | 'not-found' | 'refused' | 'rate' | 'unreachable' | 'conflict'

/** One line of a trunk at the operator, as the platform last saw it (step 10b). */
export interface OperatorLine {
  line: string
  /** The forwards set there, each as it is (to a number, the voicemail...), as last read. */
  forwards?: OperatorLineForwards
  /** A trunk asks the Gateway to keep its fallback there. */
  managed: boolean
  /** What is there is what is asked (absent: not read since it was asked). */
  inSync?: boolean
  readAt?: string
  appliedAt?: string
  /** When the Gateway found it changed there (the manager) and put it back. */
  restoredAt?: string
  error?: OperatorProblem
  /** The operator did not keep what was asked: not written again until the trunk is saved. */
  rejected?: true
  /**
   * What was there before the platform first wrote its fallback (third review 10b, n°8): put back when the fallback is
   * removed, if the platform can write it (to a number, the voicemail or a fax). Absent: not known (nothing put back).
   */
  original?: OperatorLineForwards
  /** Why it will not be put back (fourth review 10b, n°3): it would bring the calls back to the platform, or go where the trunk may not call. */
  originalRefused?: OperatorRestoreRefusal
}

/** Why the forwards of before a line are not put back (fourth review 10b, n°3). */
export type OperatorRestoreRefusal = 'loop' | 'outbound'

/** What is set at the operator on a line now (POST /admin/operator/lines), or why it could not be read. */
export interface OperatorLineRead {
  line: string
  forwards?: OperatorLineForwards
  error?: OperatorProblem
}

/**
 * A removal of the forwards of a line at the operator not done yet (second review 10b, n°1): kept by the Gateway and
 * tried again at each round until the operator has it, whatever became of the trunk that asked it.
 */
export interface OperatorRemoval {
  line: string
  since: string
  trunkId?: string
  triedAt?: string
  error?: OperatorProblem
  /** What it puts back (third review 10b, n°8): what was there before the platform took the line. */
  original?: OperatorLineForwards
  /** Why that will not be put back (fourth review 10b, n°3). */
  originalRefused?: OperatorRestoreRefusal
}

/**
 * What became of a removal of the last days (third review 10b, n°2 and n°4): done (`restored`: the forwards of before
 * put back), left as it was because someone changed it in the manager since (`changed`), let go because the operator
 * has no such line (`gone`), or by an administrator (`abandoned`).
 */
export interface OperatorClosedRemoval {
  line: string
  at: string
  outcome: 'done' | 'changed' | 'gone' | 'abandoned'
  trunkId?: string
  restored?: true
  /** Done without the forwards of before (fourth review 10b, n°3 and n°4): refused by the rules, or not kept by the operator (`refused`). */
  unrestored?: OperatorRestoreRefusal | 'refused'
}

/** The operator of the trunks, as the administration shows it (GET /admin/operator). */
export interface OperatorStatus {
  configured: boolean
  operator?: string
  trunks?: { id: string; lines: OperatorLine[] }[]
  /** The removals at the operator still owed. */
  removals?: OperatorRemoval[]
  /** What became of the removals of the last days, the latest first. */
  closedRemovals?: OperatorClosedRemoval[]
  cdrs?: {
    readAt?: string
    read?: number
    /** The lines whose records could not be read, and why. */
    lines?: { line: string; error: OperatorProblem }[]
    since: string
    stats: { total: number; matched: number; orphan: number; unmatchedInbound: number; unmatchedOutbound: number; forwarded: number; pending: number; invalid: number; erased: number }
  }
}

export interface HistoryFilter {
  direction?: 'inbound' | 'outbound'
  status?: 'missed' | 'declined' | 'answered' | 'failed'
  number?: string
  from?: string
  to?: string
  limit?: number
  before?: string
}

/** What a person chose as presence, as the Gateway keeps it: absent or "do not disturb" may end at a date, with a message. */
export interface PresenceChoice {
  status: PresenceStatus
  since: string
  until?: string
  message?: string
}

/** One's own presence: what the others see, and what one chose (absent once it ended, or never chosen). */
export type MyPresence = Presence & { choice?: PresenceChoice }

export interface Conference {
  /** Identifier used by every conference call (the Meet room id, which is also its LiveKit room name). */
  meetingId: string
  /** Last part of the Meet link. */
  slug?: string
  url?: string
  dialIn: DialInConfiguration
  participants?: ConferenceParticipant[]
}

/** The room of a call become a conference (step 8b): no dial-in, its participants. */
export interface CallConference {
  meetingId: string
  participants: ConferenceParticipant[]
  /**
   * Step 8c: the call was with the public network, which no room's call replaces: the room called this number again
   * and the call is kept until the person confirms (confirmConference) or gives up (endCallConference).
   */
  awaiting?: string
}

/** What became of each person of the old room in a passage to Meet (step 8d). */
export type VisioPersonStatus = 'pending' | 'calling' | 'swapped' | 'called' | 'failed' | 'gone'
/** The passage of a conference to a room of Meet: its link, and each person (`swapped`: a phone that took Meet's call in the place of its own; `called`: a number called again by a new call). */
export interface CallVisio {
  meetingId: string
  slug: string
  url?: string
  /** `running`: the calls are being made; `done`; `halted`: a call was diverted, nothing more is called; `left`: the old room ended. */
  state: 'running' | 'done' | 'halted' | 'left'
  people: { number: string; kind: 'extension' | 'number' | 'other'; status: VisioPersonStatus; reason?: string }[]
}

export interface SyncReport {
  startedAt: string
  finishedAt: string
  durationMs: number
  seen: number
  withExtension: number
  created: number
  updated: number
  unchanged: number
  removed: number
  /** `group`: the person's extension is a ring group's number; `reserved`: an emergency number or another short number of the French plan; `invalid`: not of the internal plan, 2 to 6 digits, the first not 0 (`heldBy` is then empty). */
  conflicts: { userId: string; extension: string; heldBy: string; group?: true; reserved?: true; invalid?: true }[]
  error?: string
}

export interface DirectoryAdmin {
  source: { type: string; url?: string; tenantId?: string; baseDn?: string; userFilter?: string; attributes?: Record<string, string> }
  sync: { available: boolean; running: boolean; intervalMs?: number; last?: SyncReport }
}

/** A person who holds an extension, as administrators see them (step 7). */
export interface AdminUser {
  userId: string
  extension: string
  displayName?: string
  department?: string
}

/** The rules of the calls to the public network, with what holds when nothing is said (`defaults`). */
export interface OutboundSettings {
  policy: OutboundPolicy
  profiles: OutboundProfile[]
  assignments: OutboundAssignment[]
  /** What was read: sent back with a change, which is refused (409 OUTBOUND_STALE) when the setting changed since. */
  version: string
  defaults: { fraud: { national: FraudRule; international: FraudRule }; caps: { user: OutboundCaps; tenant: OutboundCaps } }
}

/** An alert as kept: its last repeat's fields, `count` repeats from `at` to `lastAt`, what the first said, and its acknowledgement. */
export type AdminAlert = TelephonyAlert & {
  id: string
  at: string
  lastAt: string
  count: number
  first: { value?: number; number?: string }
  acknowledgedAt?: string
  acknowledgedBy?: string
}

/**
 * A subscription to the events of the organisation (step 10a): where they are sent, which ones. `deliverable`: false
 * when its domain is no longer allowed (nothing is sent to it then). Its secret is never read back.
 */
export interface WebhookSubscription {
  id: string
  url: string
  events: WebhookEventType[]
  description?: string
  enabled: boolean
  /** `failing`: disabled by the Gateway after a day of failed deliveries (enabling it again starts afresh). */
  disabledReason?: 'failing'
  deliverable: boolean
  /** Deliveries failed in a row (none when the last one went through). */
  failures?: number
  /** Nothing is tried until then: the subscriber failed too often in a row (a test or `resumeWebhook` lifts it). */
  pausedUntil?: string
  /** Events not queued since it was last enabled or resumed (too many pending), the latest at `backlogAt`. */
  backlog?: number
  backlogAt?: string
  /** The secret before the last renewal still signs (a second `v1`) until then. */
  previousSecretUntil?: string
  createdAt: string
  updatedAt: string
}

export interface WebhookSubscriptionInput {
  url: string
  events: WebhookEventType[]
  description?: string
  enabled?: boolean
}

/** One event sent (or being sent) to a subscription, and how it went. `lastError`: why the last attempt failed. */
export interface WebhookDelivery {
  id: string
  eventId: string
  eventType: WebhookEventType | 'webhook.test'
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  createdAt: string
  nextAttemptAt?: string
  lastAttemptAt?: string
  lastStatus?: number
  lastError?: string
  deliveredAt?: string
}

export interface AlertFilter {
  kind?: TelephonyAlert['kind']
  param?: string
  state?: 'open' | 'acknowledged'
  limit?: number
  before?: string
}

/** Extracts the Meet room id from a pasted link or code (abc-defg-hij). */
export const parseMeetingId = (input: string): string | null => {
  const raw = input.trim()
  if (!raw) return null
  let candidate = raw
  try {
    const url = new URL(raw)
    candidate = url.pathname.split('/').filter(Boolean).pop() ?? ''
  } catch {
    // not a link: the input is taken as the identifier itself
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(candidate) ? candidate : null
}

/** What GET /me/push-subscriptions says. */
export interface PushState {
  available: boolean
  /** The Gateway's VAPID public key (base64url), when available. */
  publicKey?: string
  subscriptions: number
}

export class TelephonyClient {
  constructor(private readonly options: TelephonyClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.options.baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.options.getToken()}`,
        ...(this.options.getInstance ? { 'x-cozy-instance': this.options.getInstance() } : {}),
        ...init.headers
      }
    })
    if (!res.ok) {
      // The Gateway says why it refused (a forward target that is not an extension…): `code` for the screen to put
      // into words, `detail` as it said it.
      const body = await Promise.resolve()
        .then(() => res.json())
        .then((b: { code?: unknown; message?: unknown }) => b, () => undefined)
      const code = typeof body?.code === 'string' ? body.code : undefined
      const detail = typeof body?.message === 'string' ? body.message : undefined
      throw Object.assign(new Error(`Gateway ${res.status} on ${path}`), { status: res.status, ...(code ? { code } : {}), ...(detail ? { detail } : {}) })
    }
    if (res.status === 204) {
      // Drain the empty body: a response left unread shows up as an aborted request in the browser.
      await res.text()
      return undefined as T
    }
    return (await res.json()) as T
  }

  getMe() {
    return this.request<{ id: string; displayName: string; extension?: string; features?: { directory?: boolean; admin?: boolean } }>('/me')
  }

  /** The directory source and its synchronisation, for administrators (403 otherwise; 501 without a directory). */
  getDirectoryAdmin() {
    return this.request<DirectoryAdmin>('/admin/directory')
  }

  /** Starts copying the directory's accounts into the user ↔ extension mappings (409: already running); follow it with getDirectoryAdmin. */
  syncDirectory() {
    return this.request<DirectoryAdmin['sync']>('/admin/directory/sync', { method: 'POST' })
  }

  /** The ring groups of the organisation, for administrators (403 otherwise; 501: the PBX has none). */
  listGroups() {
    return this.request<{ items: RingGroup[] }>('/admin/groups')
  }

  /** Creates a group; refusals carry a `code` (GROUP_EXISTS when the organisation has one of that number, GROUP_NUMBER_TAKEN…). */
  createGroup(group: RingGroup) {
    const { number, name, members } = group
    return this.request<RingGroup>('/admin/groups', { method: 'POST', body: JSON.stringify({ number, name, members }) })
  }

  /** Replaces the name and members of an existing group (404: there is none of that number). */
  setGroup(group: RingGroup) {
    const { number, name, members } = group
    return this.request<RingGroup>(`/admin/groups/${encodeURIComponent(number)}`, { method: 'PUT', body: JSON.stringify({ name, members }) })
  }

  async deleteGroup(number: string) {
    await this.request<void>(`/admin/groups/${encodeURIComponent(number)}`, { method: 'DELETE' })
  }

  /** The people who hold an extension (administrators only). */
  listAdminUsers() {
    return this.request<{ items: AdminUser[] }>('/admin/users')
  }

  /** The trunks of the organisation, never their passwords (`hasPassword`). 501: the platform has none. */
  listTrunks() {
    return this.request<{ items: Trunk[] }>('/admin/trunks')
  }

  /** How each trunk is doing (registration, servers); `available` false when the platform cannot say now. */
  getTrunkStatus() {
    return this.request<{ available: boolean; items: TrunkStatus[] }>('/admin/trunks/status')
  }

  /**
   * Creates or replaces a trunk; `password` absent keeps the one kept, `null` removes it. Refusals carry a `code`.
   * `pending`: the removals at the operator of the lines it no longer names not done yet (202, third review 10b, n°11).
   */
  setTrunk(id: string, trunk: TrunkInput) {
    return this.request<Trunk & { pending?: OperatorRemoval[] }>(`/admin/trunks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(trunk) })
  }

  /** The operator of the trunks (step 10b): its lines, their fallback, the records of calls reconciled. */
  getOperatorStatus() {
    return this.request<OperatorStatus>('/admin/operator')
  }

  /** Reads the operator now (429 OPERATOR_RATE: a moment ago already). */
  syncOperator() {
    return this.request<OperatorStatus>('/admin/operator/sync', { method: 'POST' })
  }

  /** What is set at the operator on these lines now, read only (shown before a first fallback replaces it). */
  readOperatorLines(lines: string[]) {
    return this.request<{ items: OperatorLineRead[] }>('/admin/operator/lines', { method: 'POST', body: JSON.stringify({ lines }) })
  }

  /**
   * The trunk no longer asks a fallback at the operator, and the forwards of its lines are removed there. `pending`:
   * the removals the operator does not have yet (202), tried again at each round.
   */
  removeOperatorFallback(trunkId: string) {
    return this.request<{ trunk: Trunk; pending: OperatorRemoval[] }>(`/admin/trunks/${encodeURIComponent(trunkId)}/operator/fallback`, { method: 'DELETE' })
  }

  /** Lets a removal at the operator go (third review 10b, n°4): nothing more is written on that line (404: none owed). */
  async abandonOperatorRemoval(line: string): Promise<void> {
    await this.request<void>(`/admin/operator/removals/${encodeURIComponent(line)}`, { method: 'DELETE' })
  }

  /**
   * Removes a trunk and its direct numbers (409 TRUNK_DEFAULT: the default trunk while another one is left). Returns
   * the removals of its fallback at the operator not done yet (202), none when all is done.
   */
  async deleteTrunk(id: string): Promise<OperatorRemoval[]> {
    const res = await this.request<{ pending?: OperatorRemoval[] } | undefined>(`/admin/trunks/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res?.pending ?? []
  }

  listDids() {
    return this.request<{ items: DidRange[] }>('/admin/dids')
  }

  /** Creates or replaces a range of direct numbers. */
  setDid(range: DidRange) {
    const { id, ...body } = range
    return this.request<DidRange>(`/admin/dids/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
  }

  async deleteDid(id: string) {
    await this.request<void>(`/admin/dids/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** The sites of the organisation for its emergency calls (step 6c, ADR 0024). */
  listSites() {
    return this.request<{ items: EmergencySite[] }>('/admin/sites')
  }

  /** Creates or replaces a site, with its people: each is in one site, the one named last. */
  setSite(site: EmergencySite) {
    const { id, ...body } = site
    return this.request<EmergencySite>(`/admin/sites/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
  }

  async deleteSite(id: string) {
    await this.request<void>(`/admin/sites/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** Where one's emergency calls leave from: the site one is in (none: the direct number, then the organisation's); `enabled` false without trunks. */
  getEmergencySite() {
    return this.request<{ enabled: boolean; site?: { name: string; address: string; number: string } }>('/me/emergency-site')
  }

  /** The rights profiles, who has which, the caps and thresholds, and their defaults. */
  getOutbound() {
    return this.request<OutboundSettings>('/admin/outbound')
  }

  /**
   * Replaces them whole (profiles, policy, assignments), made from the `version` read: refused (409 OUTBOUND_STALE)
   * when another administrator changed them since, read them again before writing. Always with it: the Gateway takes
   * a change without one (a script that replaces whatever there is), an app never sends one.
   */
  setOutbound(settings: Pick<OutboundSettings, 'policy' | 'profiles' | 'assignments' | 'version'>) {
    const { policy, profiles, assignments, version } = settings
    return this.request<OutboundSettings>('/admin/outbound', { method: 'PUT', body: JSON.stringify({ policy, profiles, assignments, version }) })
  }

  /**
   * Gives one person a profile, or the default one (`null`), from the `version` read: refused (409 OUTBOUND_STALE)
   * when the setting changed since, this person's profile included. Answers the whole setting it makes, with its
   * version: show that, never this version with what was read before.
   */
  setUserProfile(userId: string, profileId: string | null, version: string) {
    return this.request<{ userId: string; profileId: string | null } & OutboundSettings>(`/admin/outbound/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify({ profileId, version }) })
  }

  /** The domains webhooks may be sent to (step 10a). */
  getWebhookDomains() {
    return this.request<{ domains: string[] }>('/webhooks/domains')
  }

  /** Replaces them: host names, or `*.example.org` for its subdomains. */
  setWebhookDomains(domains: string[]) {
    return this.request<{ domains: string[] }>('/webhooks/domains', { method: 'PUT', body: JSON.stringify({ domains }) })
  }

  listWebhooks() {
    return this.request<{ items: WebhookSubscription[] }>('/webhooks')
  }

  /** A new subscription, with its signing secret: shown this once. */
  createWebhook(input: WebhookSubscriptionInput) {
    return this.request<WebhookSubscription & { secret: string }>('/webhooks', { method: 'POST', body: JSON.stringify(input) })
  }

  updateWebhook(id: string, input: WebhookSubscriptionInput) {
    return this.request<WebhookSubscription>(`/webhooks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
  }

  async deleteWebhook(id: string) {
    await this.request<void>(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /**
   * A new signing secret, in use at once: shown this once. The one it replaces still signs until
   * `previousSecretUntil` (a day), unless `revoke` (a secret that leaked): then it signs no more at all.
   */
  renewWebhookSecret(id: string, opts: { revoke?: boolean } = {}) {
    return this.request<{ secret: string; previousSecretUntil?: string }>(`/webhooks/${encodeURIComponent(id)}/secret${opts.revoke ? '?grace=0' : ''}`, { method: 'POST' })
  }

  /** Starts the subscription afresh (its subscriber repaired): no pause, no failures counted; what waits is sent. */
  resumeWebhook(id: string) {
    return this.request<WebhookSubscription>(`/webhooks/${encodeURIComponent(id)}/resume`, { method: 'POST' })
  }

  /** Sends a `webhook.test` to the subscription now. */
  testWebhook(id: string) {
    return this.request<WebhookDelivery>(`/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' })
  }

  /** A page of the deliveries of a subscription, the latest first (`next`: the `before` of the next page). */
  listWebhookDeliveries(id: string, filter: { status?: WebhookDelivery['status']; limit?: number; before?: string } = {}) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params.set(k, String(v))
    const qs = params.toString()
    return this.request<{ items: WebhookDelivery[]; next?: string }>(`/webhooks/${encodeURIComponent(id)}/deliveries${qs ? `?${qs}` : ''}`)
  }

  /** Sends a delivery that is over again (the same event, the same id). */
  replayWebhookDelivery(id: string, deliveryId: string) {
    return this.request<WebhookDelivery>(`/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`, { method: 'POST' })
  }

  /** A page of alerts, the latest repeated first (`next`: the `before` of the next page). */
  listAlerts(filter: AlertFilter = {}) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params.set(k, String(v))
    const qs = params.toString()
    return this.request<{ items: AdminAlert[]; next?: string }>(`/admin/alerts${qs ? `?${qs}` : ''}`)
  }

  /**
   * Acknowledges an alert as it was seen (`lastAt` and `count`, its last repeat and how many shown): refused (409
   * ALERT_CHANGED) when it repeated since, so that a repeat nobody saw is never acknowledged.
   */
  acknowledgeAlert(id: string, lastAt: string, count: number) {
    return this.request<AdminAlert>(`/admin/alerts/${encodeURIComponent(id)}/acknowledge`, { method: 'POST', body: JSON.stringify({ lastAt, count }) })
  }

  getMediaSession() {
    return this.request<MediaSession>('/me/media-session')
  }

  hangup(callId: string) {
    return this.action(callId, 'hangup')
  }

  hold(callId: string) {
    return this.action(callId, 'hold')
  }

  resume(callId: string) {
    return this.action(callId, 'resume')
  }

  private async action(callId: string, name: string) {
    await this.request<void>(`/calls/${callId}/${name}`, { method: 'POST' })
  }

  async getHistory(filter: HistoryFilter = {}) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params.set(k, String(v))
    const qs = params.toString()
    return this.request<{ items: HistoryItem[]; next?: string }>(`/calls/history${qs ? `?${qs}` : ''}`)
  }

  getCapabilities() {
    return this.request<Capabilities>('/capabilities')
  }

  /** The messages of the person's mailbox, newest first (step 11a; 501: the platform has no mailboxes). */
  listVoicemails() {
    return this.request<{ items: Voicemail[] }>('/voicemails')
  }

  /** The recording of a message, to play (a WAV); 404 when it is not in the person's mailbox. */
  async getVoicemailAudio(id: string): Promise<Blob> {
    const path = `/voicemails/${encodeURIComponent(id)}/audio`
    const res = await fetch(`${this.options.baseUrl}/api/v1${path}`, {
      headers: { authorization: `Bearer ${await this.options.getToken()}`, ...(this.options.getInstance ? { 'x-cozy-instance': this.options.getInstance() } : {}) }
    })
    if (!res.ok) {
      await res.text().catch(() => undefined)
      throw Object.assign(new Error(`Gateway ${res.status} on ${path}`), { status: res.status })
    }
    return res.blob()
  }

  /** Marks a message as listened to, on every screen of the person (a `voicemail.updated` event follows). */
  markVoicemailRead(id: string) {
    return this.request<void>(`/voicemails/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' })
  }

  /** Deletes a message, for good (a `voicemail.deleted` event follows). */
  deleteVoicemail(id: string) {
    return this.request<void>(`/voicemails/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** People matching the words of `q` in the organisation's directory (`truncated`: refine the search). 501: no directory. */
  searchDirectory(q: string, limit = 20) {
    return this.request<{ items: Contact[]; truncated: boolean }>(`/directory?${new URLSearchParams({ q, limit: String(limit) })}`)
  }

  getContact(id: string) {
    return this.request<Contact>(`/directory/${encodeURIComponent(id)}`)
  }

  getFavorites() {
    return this.request<{ items: Contact[] }>('/me/favorites')
  }

  async addFavorite(id: string) {
    await this.request<void>(`/me/favorites/${encodeURIComponent(id)}`, { method: 'PUT' })
  }

  async removeFavorite(id: string) {
    await this.request<void>(`/me/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  getPresence() {
    return this.request<MyPresence>('/me/presence')
  }

  /** The presence of everyone in the organisation, by extension; `realtime` false: the platform does not tell it. */
  getPresences() {
    return this.request<{ realtime: boolean; items: { extension: string; userId: string; presence: Presence }[] }>('/presence')
  }

  /** A status; an absence or a "do not disturb" may end by itself (`until`, ISO 8601) and carry a message for callers. */
  setPresence(status: PresenceStatus, options: { until?: string; message?: string } = {}) {
    return this.request<MyPresence>('/me/presence', { method: 'PUT', body: JSON.stringify({ status, ...options }) })
  }

  /**
   * Notifications of calls while no window of the app is open (Web Push): whether this platform offers them, the key
   * a browser subscribes with, and how many browsers of the person are subscribed.
   */
  getPushSubscriptions() {
    return this.request<PushState>('/me/push-subscriptions')
  }

  /** Keeps this browser's subscription (`PushSubscription.toJSON()`) for the person (501: not on this platform). */
  addPushSubscription(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return this.request<PushState>('/me/push-subscriptions', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys }) })
  }

  /** Forgets this browser's subscription (whether it was kept or not). */
  async removePushSubscription(endpoint: string) {
    await this.request<void>('/me/push-subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint }) })
  }

  /** Where one's calls go instead of ringing (501: not on this platform; 404: no extension). */
  getForwarding() {
    return this.request<ForwardingRules>('/me/forwarding')
  }

  /** Replaces those rules (400 with `code`: a target that is not an extension of the organisation, one's own, a bad delay). */
  setForwarding(rules: ForwardingRules) {
    return this.request<ForwardingRules>('/me/forwarding', { method: 'PUT', body: JSON.stringify(rules) })
  }

  originate(target: string, idempotencyKey: string) {
    return this.request<Call>('/calls', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ target })
    })
  }

  /** Opens the phone panel of a Meet room the user can access, given the slug of its link. */
  openConference(slug: string) {
    return this.request<Conference>('/conferences', { method: 'POST', body: JSON.stringify({ slug }) })
  }

  /** Creates a new Meet room owned by the user and opens its phone panel. */
  createConference() {
    return this.request<Conference>('/conferences', { method: 'POST', body: JSON.stringify({ create: true }) })
  }

  getConference(meetingId: string) {
    return this.request<Conference>(`/conferences/${encodeURIComponent(meetingId)}`)
  }

  closeConference(meetingId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}`, { method: 'DELETE' })
  }

  /**
   * « Ajouter un participant » (step 8b): the call `callId` becomes a conference in a room of its own; `join` is the
   * token the softphone drew for the room's call to this window (expectConference). Answered once both are in it
   * (409 with `code`: CONFERENCE_EXTERNAL, CALL_NOT_ANSWERED, DIAL_FAILED). The third is then invited by phone.
   */
  makeConference(callId: string, join: string) {
    return this.request<CallConference>(`/calls/${encodeURIComponent(callId)}/conference`, { method: 'POST', body: JSON.stringify({ join }) })
  }

  /**
   * The participants of a call's conference (GET /conferences/:id). `call`: the SIP Call-ID of the reader's own call
   * in it (header X-Twake-Call, out of the URL that proxies write in their logs), whose participant comes back marked
   * `you`.
   */
  getCallConference(meetingId: string, { call }: { call?: string } = {}) {
    return this.request<CallConference>(`/conferences/${encodeURIComponent(meetingId)}`, call ? { headers: { 'x-twake-call': call } } : {})
  }

  /**
   * « Passer en conférence » (step 8c): the person hears their correspondent in the room; the SIP server ends the
   * original call (the one the room records) if it is still there. Replayable; refused (409 CONFERENCE_CANCELLED) once given up.
   */
  confirmConference(meetingId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}/confirm`, { method: 'POST' })
  }

  /**
   * « Passer en visio » (step 8d): a room of Meet (restricted access) is opened for the person, `url` to open in the
   * browser, and each person on the phone is called again from it, behind the answer (202): read the state with
   * getVisio. A second ask gives the same passage. 501 `VISIO_UNAVAILABLE` without Meet; 409 `CONFERENCE_AWAITING` while a
   * call with the operator waits for the person's word.
   */
  startVisio(meetingId: string) {
    return this.request<CallVisio>(`/conferences/${encodeURIComponent(meetingId)}/visio`, { method: 'POST' })
  }

  /** The passage of the conference to Meet, or null when there is none (read again after a reload of the page). */
  async getVisio(meetingId: string): Promise<CallVisio | null> {
    try {
      return await this.request<CallVisio>(`/conferences/${encodeURIComponent(meetingId)}/visio`)
    } catch (err) {
      if ((err as { code?: string }).code === 'VISIO_NONE') return null
      throw err
    }
  }

  /**
   * « Terminer l'ancienne salle » (step 8d): the old room ends once no one is left in it. `left: false` and who stays
   * (a person that could not be called again, or added meanwhile) otherwise. Replayable.
   */
  leaveVisio(meetingId: string) {
    return this.request<{ left: boolean; remaining: string[] } | undefined>(`/conferences/${encodeURIComponent(meetingId)}/visio/leave`, { method: 'POST' })
  }

  /** « Annuler » (step 8c): ends the room, the original call is the person's again. Refused (409 CONFERENCE_CONFIRMED) once confirmed. */
  cancelConference(meetingId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}/cancel`, { method: 'POST' })
  }

  /** Ends a call's conference for everyone in it (« Terminer pour tous »). */
  endCallConference(meetingId: string) {
    return this.closeConference(meetingId)
  }

  /** Dial-out: makes the phone ring and joins the room when answered. */
  inviteByPhone(meetingId: string, number: string) {
    return this.request<ConferenceParticipant>(`/conferences/${encodeURIComponent(meetingId)}/participants`, { method: 'POST', body: JSON.stringify({ number }) })
  }

  removeParticipant(meetingId: string, participantId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}`, { method: 'DELETE' })
  }

  muteParticipant(meetingId: string, participantId: string) {
    return this.request<void>(`/conferences/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}/mute`, { method: 'POST' })
  }

  /**
   * Opens the event stream and keeps it open (exponential backoff + jitter). A browser cannot send headers on a
   * WebSocket, so each attempt first trades the credentials for a single-use ticket over an authenticated call.
   * `onOpen` runs each time the stream is established, the first time and after each reconnection: what was told
   * while it was closed is lost, so that is when to read the state again. Established means the Gateway accepted
   * the session (its first message, `stream.ready`) or kept it open for a while: a socket it closes right after
   * the upgrade (its directory or database down) is a failed attempt, and the next one waits longer. `onClose`
   * runs when an established stream closes. Returns a function that stops it.
   */
  connect(onEvent: (event: TelephonyEvent) => void, { onOpen, onClose }: { onOpen?: () => void; onClose?: () => void } = {}): () => void {
    let stopped = false
    let attempt = 0
    let ws: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settle: ReturnType<typeof setTimeout> | undefined
    let established = false
    const establish = () => {
      clearTimeout(settle)
      if (established || stopped) return
      established = true
      attempt = 0
      onOpen?.()
    }

    const open = async () => {
      if (stopped) return
      try {
        const { ticket } = await this.request<{ ticket: string }>('/ws-ticket', { method: 'POST' })
        const url = new URL(`${this.options.baseUrl}/api/v1/ws`)
        url.protocol = url.protocol.replace('http', 'ws')
        url.searchParams.set('ticket', ticket)
        ws = new WebSocket(url)
      } catch {
        return retry()
      }
      established = false
      // A Gateway that does not say `stream.ready` (an older one): open for a while is accepted.
      ws.onopen = () => {
        settle = setTimeout(establish, ESTABLISHED_AFTER_MS)
      }
      ws.onmessage = e => {
        establish()
        const message = JSON.parse(String(e.data)) as TelephonyEvent | { type: 'stream.ready' }
        if (message.type !== 'stream.ready') onEvent(message)
      }
      ws.onclose = () => {
        clearTimeout(settle)
        if (established && !stopped) onClose?.()
        established = false
        retry()
      }
    }
    const retry = () => {
      if (stopped) return
      timer = setTimeout(() => void open(), backoffDelay(attempt++))
    }

    void open()
    return () => {
      stopped = true
      clearTimeout(timer)
      clearTimeout(settle)
      ws?.close()
    }
  }
}
