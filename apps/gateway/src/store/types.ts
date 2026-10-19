import type { CallDirection, CallState, DidRange, OperatorCdr, OutboundAssignment, OutboundPolicy, OutboundProfile, PresenceStatus, TelephonyAlert, Trunk, WebhookEventType } from '@twake/telephony-types'

export interface ProviderRecord {
  tenantId: string
  site?: string
  type: string
  /** JSON as stored: secrets appear as references, resolved when the provider is built. */
  config: unknown
}

export type MappingSource = 'manual' | 'ldap'

export interface UserMapping {
  tenantId: string
  userId: string
  extension: string
  displayName?: string
  department?: string
  /** Who wrote it: an administrator (or DEV_USER_MAP), or the directory synchronisation. Absent means manual. */
  source?: MappingSource
  /** When the synchronisation last wrote this row (ISO 8601); an unchanged row keeps its date. */
  syncedAt?: string
}

export interface HistoryEntry {
  tenantId: string
  userId: string
  callId: string
  direction: CallDirection
  remoteNumber: string
  startedAt: string
  endedAt?: string
  durationSec: number
  state: CallState
  answered: boolean
  /** A conference's call (step 8b, ADR 0019): the room called the person in the place of a call of theirs. */
  conference?: boolean
  /** A call a mailbox took (step 11a, ADR 0022): answered by it for the caller, missed for the person called. */
  voicemail?: boolean
  /** The operator whose record of the call (`operatorCdr`, its id there) was reconciled with it (step 10b, ADR 0021). */
  operator?: string
  operatorCdr?: string
  /** Known from the operator's record only (the platform never had the call: received while it could not be reached). */
  operatorOnly?: boolean
  /** Known from the operator alone, and forwarded by it to the fallback (second review 10b, n°4): missed here. */
  operatorForwarded?: boolean
}

/**
 * A record of a call by the operator as the store keeps it (step 10b): `calling` and `called` gone once the person
 * whose call it was erased their history. Once reconciled, its `outcome` (OperatorCdrOutcome).
 */
export interface OperatorCdrRecord extends Omit<OperatorCdr, 'calling' | 'called'> {
  tenantId: string
  operator: string
  calling?: string
  called?: string
  outcome?: OperatorCdrOutcome['outcome']
  callId?: string
  userId?: string
}

/**
 * What became of a record of the operator: reconciled with the call `callId` of the history (`matched`: every
 * person's entry of it), entered alone in a person's history (`orphan`: `entry`, a call the platform never had),
 * neither (`unmatched`), a forward the operator placed (`forwarded`), no call it could read (`invalid`, settled as
 * it is kept), or a call erased with someone's history (`erased`, its numbers gone, second review 10b, n°5). `erase`:
 * its numbers go, whatever it became (the person whose call it was erased their history since, review 10b, n°1).
 */
export interface OperatorCdrOutcome {
  id: string
  outcome: 'matched' | 'orphan' | 'unmatched' | 'forwarded' | 'invalid' | 'erased'
  callId?: string
  entry?: HistoryEntry
  erase?: true
}

/**
 * The entries of the history a record of the operator may be of (historyNear): one way, the number on the other side
 * among `remotes` (in E.164 as e164Of writes it; any when absent), or of one person (`userId`), started from `from`
 * to `to`; none known from an operator's record alone; those reconciled with a record already too when `reconciled`.
 * By pages of `limit`, in the order of (startedAt, callId, userId): `after`, the last entry of the page before.
 */
export interface HistoryNearQuery {
  direction: CallDirection
  remotes?: readonly string[]
  userId?: string
  from: string
  to: string
  reconciled?: boolean
  limit: number
  after?: { startedAt: string; callId: string; userId: string }
}

/** The records of the operator since a date, by what became of them; `unmatched` split by way (an outbound one the platform never placed is worth a look). */
export interface OperatorCdrStats {
  total: number
  matched: number
  orphan: number
  unmatchedInbound: number
  unmatchedOutbound: number
  forwarded: number
  pending: number
  invalid: number
  /** Calls erased with someone's history (second review 10b, n°5): neither reconciled nor missed. */
  erased: number
}

/**
 * When an erased entry of the history was, by way, without any number (second review 10b, n°2), and a keyed print of
 * the number on the other side (third review n°5: HMAC with a key of the Gateway, never the number), when kept.
 */
export interface ErasedCall {
  direction: CallDirection
  startedAt: string
  endedAt: string
  remoteKey?: string
}

/**
 * What an erasure keeps of the calls erased (third review 10b, n°3): given only for an organisation with an operator,
 * the entries started from `since` on (those a record read later may be of), each with the print `keyOf` gives of its
 * number on the other side (E.164), when the Gateway has a key. Nothing otherwise.
 */
export interface ErasedCallsKept {
  since: string
  keyOf?: (remote: string) => string
}

/** A missed call: inbound, never answered, and not declined by the user (state `missed`, not `rejected`). */
export const isMissed = (e: Pick<HistoryEntry, 'direction' | 'answered' | 'state'>) => e.direction === 'inbound' && !e.answered && e.state === 'missed'

/** A call the user declined: inbound, never answered, refused (state `rejected`). */
export const isDeclined = (e: Pick<HistoryEntry, 'direction' | 'answered' | 'state'>) => e.direction === 'inbound' && !e.answered && e.state === 'rejected'

export interface HistoryQuery {
  direction?: CallDirection
  /** missed: inbound never answered nor declined; declined: inbound the user refused; answered; failed. */
  status?: 'missed' | 'declined' | 'answered' | 'failed'
  /** Substring of the remote number. */
  number?: string
  from?: string
  to?: string
  limit?: number
  /** Cursor: only entries started strictly before this instant. */
  before?: string
}

export interface HistoryPage {
  items: HistoryEntry[]
  /** Pass as `before` to get the next page; absent on the last page. */
  next?: string
}

/**
 * Persistence of the Gateway. Every method takes the tenant: an implementation must never return or touch
 * data of another tenant.
 */
/** A Meet room whose phone access (dial-in PIN, dial-out) is managed by a Twake user. */
export interface ConferenceRecord {
  tenantId: string
  meetingId: string
  ownerUserId: string
  pin?: string
  createdAt: string
}

/** What a person chose as presence (absent, do not disturb…), kept per user: it survives a restart and stays theirs. */
export interface UserPresenceRecord {
  tenantId: string
  userId: string
  status: PresenceStatus
  /** When they chose it (ISO 8601). */
  since: string
  /** When it ends by itself (ISO 8601); absent: until they change it. */
  until?: string
  /** For their callers (a "do not disturb" refuses calls with it). */
  message?: string
}

/**
 * What saving a push subscription did (Store.savePushSubscription). `moved` without `previousUserId`: taken from
 * someone the store cannot name (another request saved the same browser at the same moment); whoever needs to know
 * whose it was recomputes the whole tenant.
 */
export interface PushSaveResult {
  outcome: 'added' | 'unchanged' | 'updated' | 'moved' | 'refused'
  previousUserId?: string
}

/**
 * A browser's subscription to notifications (Web Push, ADR 0015): where its push service takes messages for it
 * (`endpoint`, unique: one per browser profile and application key) and the keys a message is encrypted with. Whose it
 * is: the person signed in when it was given. A browser given to someone else of the tenant moves to them.
 */
export interface PushSubscriptionRecord {
  tenantId: string
  userId: string
  endpoint: string
  /** The browser's public key (P-256, base64url) and authentication secret (base64url), RFC 8291. */
  p256dh: string
  auth: string
  createdAt: string
}

/** The Gateway's VAPID keys (RFC 8292): the public one in clear, the private one encrypted with SECRETS_KEY. */
export interface VapidKeysRecord {
  publicKey: string
  privateKeyEnc: string
}

/**
 * A trunk to an operator (step 6, ADR 0016), as an administrator set it: its settings in `config`, its password
 * apart, encrypted with SECRETS_KEY (or an `env:NAME` reference, kept as it is). The first one kept serves the callers
 * no direct number names.
 */
export interface TrunkRecord {
  tenantId: string
  id: string
  config: Omit<Trunk, 'id' | 'hasPassword'>
  passwordEnc?: string
}

/** A range of direct numbers of a trunk (SDA), and the extension or group it rings. */
export interface DidRecord extends DidRange {
  tenantId: string
}

/** The rules of a tenant's calls to the public network (step 6b, ADR 0017), as an administrator set them. */
export interface OutboundRecord {
  tenantId: string
  policy: OutboundPolicy
  profiles: OutboundProfile[]
  assignments: OutboundAssignment[]
}
/** The rules of a record, without its tenant. */
export type OutboundRules = Omit<OutboundRecord, 'tenantId'>
/**
 * Hands rules to the SIP server: the new ones (`undo` false), or, once they could not be kept, those kept before
 * (`undo` true).
 */
export type OutboundHand = (rules: OutboundRules, undo: boolean) => Promise<void>

/** What the SIP server raised for the administrators (step 6b): when, and what. */
export interface AlertRecord {
  tenantId: string
  at: string
  alert: TelephonyAlert
}

/**
 * An alert as kept: one per kind, param, scope and extension while it repeats (`count` times, the last at `lastAt`,
 * what the last one said in `alert`, what the first one said in `first`), a new one past ALERT_DEDUP_MS of silence.
 * Listed by their last repeat, the latest first (second review 6b, n°8: an attack that goes on for days stays on
 * top), `id` breaking ties.
 */
export interface StoredAlert extends AlertRecord {
  id: string
  lastAt: string
  count: number
  first: TelephonyAlert
  /** When an administrator acknowledged it, and who (step 7): a repeat after that opens a new alert. */
  acknowledgedAt?: string
  acknowledgedBy?: string
}

/** Where a page of alerts starts: after this one (its last repeat and id). */
export interface AlertCursor {
  lastAt: string
  id: string
}

/** A page of the alerts of a tenant: `before` the last one of the page before, of one `kind` or `param`, `limit` at most. */
export interface AlertQuery {
  limit?: number
  before?: AlertCursor
  kind?: TelephonyAlert['kind']
  param?: string
  /** Those not acknowledged yet (`open`), or those acknowledged. */
  state?: 'open' | 'acknowledged'
}

/**
 * A tool an administrator subscribed to the organisation's events (step 10a, ADR 0020): where it listens, which
 * events it takes, and the secret its deliveries are signed with, encrypted with SECRETS_KEY (shown once, never read
 * back by the API). Disabled, it gets nothing.
 */
export interface WebhookSubscriptionRecord {
  tenantId: string
  id: string
  url: string
  events: WebhookEventType[]
  description?: string
  enabled: boolean
  /** Why it is disabled when the platform did it: `failing` (its deliveries failed for a day in a row). */
  disabledReason?: 'failing'
  secretEnc: string
  /** The secret it replaced, which still signs (a second `v1`) until `secretPrevUntil`. */
  secretPrevEnc?: string
  secretPrevUntil?: string
  /** Attempts failed in a row (none since a delivery went through), since `failingSince`. */
  failures: number
  failingSince?: string
  /** Its deliveries wait until then (the circuit breaker). */
  pausedUntil?: string
  /** Events recorded failed (`backlog`) since it was last enabled or resumed, the latest at `backlogAt`. */
  backlog?: number
  backlogAt?: string
  createdAt: string
  updatedAt: string
  /** The administrator who created it. */
  createdBy?: string
}

/** How a subscription's deliveries have been going, after an attempt was recorded (completeWebhookDelivery). */
export interface WebhookHealth {
  failures: number
  failingSince?: string
  /** When the outcome was dated (the store's clock): the breaker reckons from it. */
  at: string
}

/** What queueing an event takes besides it: the person it is about (erased with their history), the pending cap. */
export interface WebhookQueueOptions {
  subjectUser?: string
  /**
   * Pending deliveries a subscription has at most: an event queued past them is recorded failed (`backlog`) at once,
   * for the log (an administrator may replay it), and never sent by itself.
   */
  maxPending?: number
  /** Told the subscriptions an event was recorded failed for (`backlog`), once it is written. */
  onBacklog?: (subscriptionIds: string[]) => void
}

/** What claimWebhookDeliveries leaves to others: in flight at the same time, whatever the Gateways. */
export interface WebhookClaimCaps {
  /** Deliveries of one subscription in flight at most (its subscriber handles them in order, mostly). */
  perSubscription: number
  /** Deliveries of one tenant in flight at most: the others always find room. */
  perTenant: number
  /**
   * Places of the claim (the free places of a Gateway) that only the first delivery in flight of a tenant takes
   * (default none): a tenant holding some takes another only while more than these are free. However many tenants
   * keep their share busy, one that holds none and has a delivery due finds a place at once (until as many such
   * tenants came at once; then the next place that frees is theirs).
   */
  reserve?: number
  /** A delivery that used them all is not taken again (sweepWebhookDeliveries fails it once its last lease lapsed). */
  maxAttempts: number
  /** How long a delivery taken is held (from the store's clock), when the claim names no `leaseUntil`. */
  leaseMs?: number
}

/** A time the tests give a store instead of its clock (the database's): every write is dated on it otherwise. */
export interface WebhookClaimTime {
  now: string
  leaseUntil: string
}

/** A subscription with a delivery due (claimWebhookDeliveries): its tenant, and when deliveries were last taken of it. */
export interface ReadyWebhookSubscription {
  id: string
  tenantId: string
  claimedAt?: string
  /** When its earliest delivery due was due. */
  dueAt?: string
  /** How many of its deliveries are due, counted up to perSubscription (no bound when absent): no more places. */
  dueCount?: number
}

/** What all Gateways hold of a subscription now (taken, their lease running). */
export interface HeldWebhookDeliveries {
  tenantId: string
  subscriptionId: string
  n: number
}

/** Served after anything taken before this claim, in the order of this claim. */
const SERVED_NOW = 1e15

interface ClaimTenant {
  id: string
  inFlight: number
  served: number
  due: number
  subs: { id: string; held: number; claimed: number; due: number; dueCount: number; given: number }[]
}

const claimTenants = (caps: Pick<WebhookClaimCaps, 'perSubscription'>, ready: readonly ReadyWebhookSubscription[], held: readonly HeldWebhookDeliveries[]) => {
  const heldOf = new Map(held.map(h => [h.subscriptionId, h.n]))
  const inFlight = new Map<string, number>()
  for (const h of held) inFlight.set(h.tenantId, (inFlight.get(h.tenantId) ?? 0) + h.n)
  const tenants = new Map<string, ClaimTenant>()
  for (const r of ready) {
    const claimed = r.claimedAt ? Date.parse(r.claimedAt) : -Infinity
    const due = r.dueAt ? Date.parse(r.dueAt) : Infinity
    let t = tenants.get(r.tenantId)
    if (!t) tenants.set(r.tenantId, (t = { id: r.tenantId, inFlight: inFlight.get(r.tenantId) ?? 0, served: -Infinity, due: Infinity, subs: [] }))
    t.served = Math.max(t.served, claimed)
    t.due = Math.min(t.due, due)
    t.subs.push({ id: r.id, held: heldOf.get(r.id) ?? 0, claimed, due, dueCount: r.dueCount ?? Infinity, given: 0 })
  }
  /** Negative when `a` comes first; equal infinities are equal (never NaN). */
  const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  /**
   * The subscription of a tenant served next: the one holding fewest, then the one taken from least recently, then
   * the earliest due; none that has no more due than places it was given (a place it would leave empty).
   */
  const subOf = (t: ClaimTenant) => {
    let best: ClaimTenant['subs'][number] | undefined
    for (const x of t.subs) {
      if (x.held >= caps.perSubscription || x.given >= x.dueCount) continue
      if (!best || (cmp(x.held, best.held) || cmp(x.claimed, best.claimed) || cmp(x.due, best.due) || byId(x.id, best.id)) < 0) best = x
    }
    return best
  }
  /** Which tenant comes first: the one holding fewest deliveries, then the one served least recently, then the earliest due. */
  const before = (a: ClaimTenant, b: ClaimTenant) => cmp(a.inFlight, b.inFlight) || cmp(a.served, b.served) || cmp(a.due, b.due) || byId(a.id, b.id)
  return { tenants: [...tenants.values()], subOf, before }
}

/**
 * The tenants a claim serves, in the order it serves them (claimWebhookDeliveries; the database locks them in that
 * order): those with room left, the one holding fewest deliveries first, then the one served least recently.
 */
export const claimOrder = (caps: Pick<WebhookClaimCaps, 'perSubscription' | 'perTenant'>, ready: readonly ReadyWebhookSubscription[], held: readonly HeldWebhookDeliveries[]): string[] => {
  const { tenants, subOf, before } = claimTenants(caps, ready, held)
  return tenants
    .filter(t => t.inFlight < caps.perTenant && subOf(t))
    .sort(before)
    .map(t => t.id)
}

/**
 * The places of a claim (claimWebhookDeliveries), one at a time: each to the tenant holding fewest deliveries (what
 * all Gateways hold counted, and what this claim gave), then to the one served least recently; within it, to its
 * subscription holding fewest, then the one taken from least recently; within the caps, a tenant holding some
 * taking another only while more than `reserve` are free. Whatever the others keep busy, a tenant with a delivery
 * due and none in flight takes the next place. How many to take of each subscription.
 */
export const allocateClaims = (
  limit: number,
  caps: Pick<WebhookClaimCaps, 'perSubscription' | 'perTenant' | 'reserve'>,
  ready: readonly ReadyWebhookSubscription[],
  held: readonly HeldWebhookDeliveries[]
): { subscriptionId: string; n: number }[] => {
  const { tenants, subOf, before } = claimTenants(caps, ready, held)
  const reserve = caps.reserve ?? 0
  let order = 0
  const want = new Map<string, number>()
  for (let free = limit; free > 0; free--) {
    let best: ClaimTenant | undefined
    for (const t of tenants) {
      // A tenant's first delivery in flight takes any place; another one leaves `reserve` free.
      if (t.inFlight >= caps.perTenant || (t.inFlight > 0 && free <= reserve) || !subOf(t)) continue
      if (!best || before(t, best) < 0) best = t
    }
    if (!best) break
    const sub = subOf(best)!
    best.inFlight++
    sub.held++
    sub.given++
    best.served = sub.claimed = SERVED_NOW + order++
    want.set(sub.id, (want.get(sub.id) ?? 0) + 1)
  }
  return [...want].map(([subscriptionId, n]) => ({ subscriptionId, n }))
}

/** The tests and replays an administrator may ask, whatever Gateway or administrator asks (enqueueWebhookDelivery). */
export interface WebhookSendQuota {
  /** Asked of one subscription within `windowMs` at most (a subscription deleted and made again counts the same). */
  perSubscription: number
  /** Asked of all the tenant's within `windowMs` at most. */
  perTenant?: number
  windowMs: number
}

/**
 * The lease of a role taken or renewed (takeWebhookLease): its holder writes from `writeFrom` (on the store's
 * clock), once what the previous holder was writing is done, and until `writeUntil` (a third of the lease before its
 * end: the next holder writes a third later still), unless it renews it meanwhile.
 */
export interface WebhookLease {
  writeFrom: string
  writeUntil: string
  /**
   * One more for each lease of the role taken (from another holder, or by the same once it lapsed or was given back),
   * the same while it is renewed: a fencing token that no clock moves.
   */
  generation: number
}

/**
 * A change of state told once (setWebhookState): `holder` holds the lease of the role (takeWebhookLease) or nothing
 * is written. It is dated on the store's clock (the database's) unless `at` is given (tests), and must be newer than
 * what was told. `known`: only of a subject something is kept of (told again from what a Gateway remembers): one the
 * store keeps nothing of, never told or erased since (by any Gateway), is neither written nor told.
 */
export interface WebhookStateChange {
  tenantId: string
  subject: string
  state: string
  at?: string
  holder: string
  known?: boolean
}

/**
 * The event that tells a change, queued with it (the same transaction), from what it was before and when the change
 * is dated: null to tell none (written all the same).
 */
export type WebhookStateEvent = (previous: string | undefined, at: string) => { id: string; type: WebhookEventType; body: string; subjectUser?: string } | null

/** The role of the Gateway that tells the changes of state of every tenant (webhook_leases). */
export const WEBHOOK_STATE_ROLE = 'webhook-state'

/**
 * Where a delivery stands: `pending` (due at `nextAttemptAt`, or being sent: a Gateway took it until then),
 * `delivered` (answered 2xx), `failed` (its attempts used, or refused for good: its domain no longer allowed, its
 * subscription disabled).
 */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed'

/** One event for one subscription, and how its delivery went. `body`: the exact JSON sent at each attempt. */
export interface WebhookDeliveryRecord {
  tenantId: string
  id: string
  subscriptionId: string
  eventId: string
  eventType: string
  body: string
  status: WebhookDeliveryStatus
  attempts: number
  createdAt: string
  nextAttemptAt?: string
  lastAttemptAt?: string
  /** The HTTP status of the last answer, when there was one. */
  lastStatus?: number
  /** Why the last attempt failed, in a few words (never an address). */
  lastError?: string
  deliveredAt?: string
}

/** A delivery a Gateway took to send (claimWebhookDeliveries): until `leaseUntil`, the others leave it. */
export interface ClaimedDelivery extends WebhookDeliveryRecord {
  url: string
  secretEnc: string
  /** The secret it replaced, while it still signs. */
  secretPrevEnc?: string
  /** What the outcome is recorded with (completeWebhookDelivery): an outcome of a lease taken back since is ignored. */
  claim: string
}

/**
 * The outcome of an attempt: delivered, or failed and due again at `retryAt` (absent: failed for good). `at` and
 * `retryAt` on the database's clock (the hub corrects its own).
 */
/**
 * The outcome of an attempt, dated on the store's clock unless `at` is given (tests). A failure is retried `retryInMs`
 * later (or at `retryAt`), or failed for good without either.
 */
export type WebhookAttemptResult =
  | { delivered: true; at?: string; status: number }
  | { delivered: false; at?: string; status?: number; error: string; retryAt?: string; retryInMs?: number }

/** A page of a subscription's deliveries, the latest first: `before` the last one of the page before. */
export interface WebhookDeliveryQuery {
  limit?: number
  before?: { createdAt: string; id: string }
  status?: WebhookDeliveryStatus
}

/** How long the log of deliveries is kept (purged by the Gateway every hour). */
export const WEBHOOK_RETENTION_DAYS = 30

/** How long the alerts are kept (from their last repeat): purged by the Gateway every hour (purgeAlerts). */
export const ALERT_RETENTION_DAYS = 90
/** An alert that repeats within this time of its last one counts in it, instead of a new one. */
export const ALERT_DEDUP_MS = 3_600_000
/** What makes two alerts the same one. */
export const alertKey = (a: TelephonyAlert) => [a.kind, a.param, a.scope ?? '', a.extension ?? ''].join('|')

/**
 * The lease a write is made under (step 11b): `holder` holds the lease of `role` (takeWebhookLease) taken at
 * `generation` (its fencing token), within its write window, or the store writes nothing.
 */
export interface FencedLease {
  role: string
  holder: string
  generation: number
}

/**
 * What became of a message's transcription (step 11b, ADR 0023): on its way (`pending`), its text (`done`), none
 * (`none`, `reason` why), or erased (`erased`: its text gone, its notice still to withdraw).
 */
export type TranscriptStatus = 'pending' | 'done' | 'none' | 'erased'
/**
 * The bot's notice of the message in Chat: to send (`pending`), sent (`sent`, `noticeRoom` and `noticeEvent` say
 * where), sent before its transcription (`early`: its text to come), to complete with it once settled (`edit`: a
 * replacement, `noticeEdit` once sent), none (`none`: no bot, no Matrix account, the message gone), to withdraw
 * (`redact`, the replacement with it, then the row goes).
 */
export type TranscriptNotice = 'pending' | 'sent' | 'early' | 'edit' | 'none' | 'redact'

/**
 * A message of a mailbox the Gateway transcribes and tells the bot of (step 11b): by tenant, holder (the id the
 * mailboxes know them by, HolderRecord) and message. `extension`: where its mailbox was reached when it was left (to
 * read its recording); `receivedAt`: when (the retention period).
 */
export interface TranscriptRecord {
  tenantId: string
  holder: string
  messageId: string
  extension: string
  receivedAt: string
  status: TranscriptStatus
  reason?: 'too-long' | 'busy' | 'failed'
  text?: string
  /** The tries of the transcription so far, and when the next one is due. */
  attempts: number
  nextAt: string
  notice: TranscriptNotice
  /** The tries of the notice (or of its withdrawal) so far, and when the next one is due: their own, apart from the transcription's. */
  noticeAttempts: number
  noticeNextAt: string
  noticeRoom?: string
  noticeEvent?: string
  /** The replacement of an `early` notice, with the transcription (an `m.replace` event): withdrawn with it. */
  noticeEdit?: string
  /** On the store's clock: when it was written down, and when it last changed (the Gateways tell the change to the holder's screens). */
  createdAt: string
  updatedAt: string
}

/**
 * A holder as a text of PostgreSQL keeps it (a column, a JSON value): the id the mailboxes know a person by carries a
 * NUL before its rank (`<id>\0<rank>`, HolderRecord), which such a text cannot hold. Written `%00` (and `%` as `%25`, so
 * that it reads back as it was).
 */
export const holderIn = (holder: string) => holder.replace(/%/g, '%25').split('\u0000').join('%00')
export const holderOut = (kept: string) => kept.replace(/%(25|00)/g, (_, c: string) => (c === '25' ? '%' : '\u0000'))

/** The two queues of the transcriptions (dueTranscripts), each its own: the transcriptions, and the notices with their withdrawals. */
export type TranscriptLane = 'transcribe' | 'notice'

/** Which transcriptions an erasure takes (eraseTranscripts): a holder's (one message of theirs), or those received before a date. */
export type TranscriptMatch = { holder: string; messageId?: string } | { before: string }

/** What an erasure did: how many it erased, and how many of them had a notice in Chat (to withdraw, or left there). */
export interface TranscriptErasure {
  erased: number
  notices: number
}

/** A message to transcribe (addTranscript): `pending`, or `none` with why. */
export type NewTranscript = Pick<TranscriptRecord, 'tenantId' | 'holder' | 'messageId' | 'extension' | 'receivedAt'> & {
  status: 'pending' | 'none'
  reason?: 'too-long' | 'busy' | 'failed'
  notice: 'pending' | 'none'
}

/** A change of a transcription (updateTranscript). */
export type TranscriptChange = Partial<Pick<TranscriptRecord, 'status' | 'reason' | 'text' | 'attempts' | 'nextAt' | 'notice' | 'noticeAttempts' | 'noticeNextAt' | 'noticeRoom' | 'noticeEvent' | 'noticeEdit'>>

export interface Store {
  listProviders(): Promise<ProviderRecord[]>
  upsertProvider(record: ProviderRecord): Promise<void>

  getMappingByUser(tenantId: string, userId: string): Promise<UserMapping | null>
  getMappingByExtension(tenantId: string, extension: string): Promise<UserMapping | null>
  upsertMapping(mapping: UserMapping): Promise<void>
  /** Every mapping of a tenant, by user id. */
  listMappings(tenantId: string): Promise<UserMapping[]>
  /**
   * Their extension let go. Their erasure (historyErasedAt, numbersErasedAt) goes with them only when they `left` (the
   * account removed, third review 10b, n°3: neither who nor their numbers); kept otherwise, until purged (fourth review
   * n°2: given another extension, a record read later of a call from before is still told erased).
   */
  deleteMapping(tenantId: string, userId: string, opts?: { left?: boolean }): Promise<void>

  /** Idempotent on (tenant, user, callId). */
  addHistory(entry: HistoryEntry): Promise<void>
  listHistory(tenantId: string, userId: string, query?: HistoryQuery): Promise<HistoryPage>
  /**
   * Deletes the history of a user (retention, right to erasure), in one transaction under the lock of their history,
   * and keeps when, with their direct numbers `numbers` (E.164) then (historyErasedAt, numbersErasedAt: a record of
   * the operator read later never brings a call of before back, review 10b, n°1). The operator's records of their
   * calls lose their numbers (kept as read, never read again): those reconciled with their entries, those to or from
   * `numbers` that started before, and those not reconciled yet that one of their entries would take (same way, same
   * number, the same window as matchCdrs: second review n°2); those not reconciled yet are settled `erased`. When
   * their entries were is kept a few days, without a number (erasedCalls), only as `calls` says (third review n°3).
   * Returns the number of rows of history.
   */
  deleteHistory(tenantId: string, userId: string, numbers?: readonly string[], calls?: ErasedCallsKept): Promise<number>
  /** When the user last erased their history (deleteHistory), if they did. */
  historyErasedAt(tenantId: string, userId: string): Promise<string | undefined>
  /** When each of `numbers` was last erased with the history of whom it rang (second review 10b, n°3), those that were. */
  numbersErasedAt(tenantId: string, numbers: readonly string[]): Promise<Map<string, string>>
  /** The erased entries (deleteHistory) that started from `from` to `to`, by way, without any number. */
  erasedCalls(tenantId: string, from: string, to: string): Promise<ErasedCall[]>
  /**
   * When an extension, or the range of direct numbers `number` (E.164) is in, last changed hands (second review 10b,
   * n°3): a mapping deleted or given another extension, a range changed or deleted, or either taken again after.
   * Undefined when neither did in the last days.
   */
  numberChangedAt(tenantId: string, extension: string, number: string): Promise<string | undefined>

  /** Which of these ids of the operator's records (step 10b) the store keeps already. */
  knownOperatorCdrs(tenantId: string, operator: string, ids: readonly string[]): Promise<string[]>
  /** Keeps the records not kept yet (idempotent on the operator's id), dated as read now. */
  addOperatorCdrs(tenantId: string, operator: string, cdrs: readonly OperatorCdr[]): Promise<void>
  /** The records not reconciled yet that were read before `readBefore`, oldest first, `limit` at most. */
  pendingOperatorCdrs(tenantId: string, operator: string, readBefore: string, limit: number): Promise<OperatorCdrRecord[]>
  /**
   * The entries a record of the operator may be of (HistoryNearQuery), oldest first, `limit` at most: a narrow read,
   * by way, number and time (review 10b, n°3), however long the history of the tenant.
   */
  historyNear(tenantId: string, query: HistoryNearQuery): Promise<HistoryEntry[]>
  /** The forwards the operator placed (records `forwarded`) on `line` that started from `from` to `to`, whatever became of them. */
  operatorForwardsNear(tenantId: string, operator: string, line: string, from: string, to: string): Promise<OperatorCdrRecord[]>
  /**
   * Keeps what became of records, in one transaction, the first word kept: a record already settled is left as it
   * is; `matched` links each entry of its call that no record has yet (none: the record is `unmatched`); `orphan`
   * adds its entry (none added when it is there already).
   */
  settleOperatorCdrs(tenantId: string, operator: string, outcomes: readonly OperatorCdrOutcome[]): Promise<void>
  /** The records of the operator that started from `since` on, by outcome. */
  operatorCdrStats(tenantId: string, operator: string, since: string): Promise<OperatorCdrStats>
  /** Removes the records of the operator that started before `before` (retention), every tenant. */
  purgeOperatorCdrs(before: string): Promise<number>
  /**
   * Removes, every tenant, what erasures and changes of hands keep from before `before` (third review 10b, n°3): the
   * erased calls (erasedCalls), the changes of hands (numberChangedAt) and the erasures themselves (historyErasedAt,
   * numbersErasedAt), operator or not. How many rows.
   */
  purgeErasures(before: string): Promise<number>
  /**
   * What the platform knows of its operator for a tenant (review 10b, n°8: the same for every Gateway, kept across a
   * restart): the state of each line, of the last read of the records, a round asked. JSON values, by key.
   */
  getOperatorState(tenantId: string, key: string): Promise<unknown>
  listOperatorState(tenantId: string, prefix: string): Promise<{ key: string; value: unknown }[]>
  putOperatorState(tenantId: string, key: string, value: unknown): Promise<void>
  /** Removes a key; only while its value is still `ifValue` when given (third review 10b, n°1). Whether it was removed. */
  deleteOperatorState(tenantId: string, key: string, ifValue?: unknown): Promise<boolean>
  /** Counts one more use of `key` for the tenant, unless `max` were counted in the last `windowMs` (false), whatever Gateway asks. */
  takeOperatorQuota(tenantId: string, key: string, windowMs: number, max: number): Promise<boolean>

  /**
   * The transcriptions of the messages (step 11b, ADR 0023), written under the lease of the mailboxes (`lease`, its
   * fencing token): nothing is written, and the answer says `fenced`, when its holder no longer holds it at that
   * generation within its write window. A message already there is left as it is (`exists`); a `pending` one past
   * `maxPending` pending ones of the tenant is kept as `none`, `busy` (the answer says `busy`).
   */
  addTranscript(record: NewTranscript, lease: FencedLease, maxPending: number, whenFull?: 'busy' | 'wait'): Promise<'added' | 'exists' | 'busy' | 'full' | 'fenced'>
  /** Changes one; false when it is not there, or under a lease no longer held (nothing written). Dated on the store's clock. */
  updateTranscript(tenantId: string, holder: string, messageId: string, change: TranscriptChange, lease: FencedLease, ifNotice?: TranscriptNotice): Promise<boolean>
  /** Removes one (its notice withdrawn); false when it is not there, or under a lease no longer held. */
  deleteTranscript(tenantId: string, holder: string, messageId: string, lease: FencedLease): Promise<boolean>
  /**
   * Erases the transcriptions of the tenant that match (TranscriptMatch): of one holder, one message of one holder, or
   * received before `before` (the retention period). Each one's text goes at once. With `withdraw` (a bot to withdraw
   * the notices), one whose notice was sent stays as `erased`, its notice to withdraw (`redact`), the others go;
   * without, they all go, the notices left in Chat counted. Checked against the lease in the very statement that
   * erases: null when it is no longer held (nothing written).
   */
  eraseTranscripts(tenantId: string, match: TranscriptMatch, lease: FencedLease, withdraw: boolean): Promise<TranscriptErasure | null>
  /** A holder's transcriptions (of `messageIds` when given), erased ones left out unless `withErased`. */
  listTranscripts(tenantId: string, holder: string, messageIds?: string[], withErased?: boolean): Promise<TranscriptRecord[]>
  /**
   * What is due in one queue, `limit` at most. `transcribe`: a transcription pending whose next try (`nextAt`) came,
   * oldest first. `notice` (its next try, `noticeNextAt`, come): a notice to withdraw first, then a notice to send once
   * the transcription is no longer pending, or written down more than `noticeWaitMs` ago (sent without its text).
   */
  dueTranscripts(tenantId: string, lane: TranscriptLane, limit: number, noticeWaitMs?: number): Promise<TranscriptRecord[]>
  /** How many of the tenant's transcriptions written down before `before` still wait (a transcription, a notice, a withdrawal). */
  staleTranscripts(tenantId: string, before: string): Promise<number>
  /** The transcriptions of the tenant that changed after `since` (store's clock) and are `done` or `none`, oldest change first. */
  transcriptsChangedSince(tenantId: string, since: string, limit: number): Promise<TranscriptRecord[]>

  /** Favourite contacts of a user, oldest first. Ids are the directory's; the store never interprets them. */
  listFavorites(tenantId: string, userId: string): Promise<string[]>
  /** Idempotent. */
  addFavorite(tenantId: string, userId: string, contactId: string): Promise<void>
  removeFavorite(tenantId: string, userId: string, contactId: string): Promise<void>

  /** What the user chose, unless its end has passed. */
  getUserPresence(tenantId: string, userId: string): Promise<UserPresenceRecord | null>
  setUserPresence(record: UserPresenceRecord): Promise<void>
  deleteUserPresence(tenantId: string, userId: string): Promise<void>
  /** Every choice of a tenant still in force (those past their end are dropped), by user id. */
  listUserPresences(tenantId: string): Promise<UserPresenceRecord[]>

  getSipSecret(tenantId: string, userId: string): Promise<{ secretEnc: string; rotatedAt: string } | null>
  setSipSecret(tenantId: string, userId: string, secretEnc: string): Promise<void>

  /** The first user to claim a meeting owns it. Meeting ids are unique across tenants (one LiveKit serves all). */
  claimConference(record: ConferenceRecord): Promise<ConferenceRecord>
  getConference(meetingId: string): Promise<ConferenceRecord | null>
  setConferencePin(meetingId: string, pin: string | null): Promise<void>
  /**
   * Sets the room's PIN to `to` only if it is still `from` (null: none): true when it did. Of two Gateways drawing a
   * new PIN for a room at once, one only wins (third review n°5).
   */
  replaceConferencePin(meetingId: string, from: string | null, to: string | null): Promise<boolean>
  /** The rooms of a tenant, or of one owner in it. */
  countConferences(tenantId: string, ownerUserId?: string): Promise<number>
  /** The rooms of one owner, oldest first. */
  listConferences(tenantId: string, ownerUserId: string): Promise<ConferenceRecord[]>
  deleteConference(meetingId: string): Promise<void>

  /** A person's subscriptions, oldest first. */
  listPushSubscriptions(tenantId: string, userId: string): Promise<PushSubscriptionRecord[]>
  /** The people of a tenant with at least one subscription, by user id. */
  listPushUsers(tenantId: string): Promise<string[]>
  /**
   * Adds or replaces the subscription of `endpoint` within its tenant: 'added' (new), 'unchanged' (this person's
   * already, same keys: nothing written), 'updated' (theirs, new keys), 'moved' (a browser given to them by someone
   * else of the tenant, `previousUserId`). One another tenant has stays theirs: 'refused', nothing written.
   */
  savePushSubscription(record: PushSubscriptionRecord): Promise<PushSaveResult>
  /** Removes `endpoint` if it is this person's. Whether it was. */
  deletePushSubscription(tenantId: string, userId: string, endpoint: string): Promise<boolean>
  /** Removes `endpoint` (its push service says it is gone), whoever had it; who that was. */
  deletePushEndpoint(endpoint: string): Promise<{ tenantId: string; userId: string } | null>

  getVapidKeys(): Promise<VapidKeysRecord | null>
  /** Keeps `keys` unless some are kept already (another instance was first): those kept, either way. */
  initVapidKeys(keys: VapidKeysRecord): Promise<VapidKeysRecord>

  /** The trunks of a tenant, in the order they were first kept. */
  listTrunks(tenantId: string): Promise<TrunkRecord[]>
  /** Adds or replaces a trunk; a replaced one keeps its place. */
  upsertTrunk(record: TrunkRecord): Promise<void>
  /** Adds or replaces these trunks together: all of them, or none when one cannot be kept. */
  upsertTrunks(records: TrunkRecord[]): Promise<void>
  /** Removes a trunk and its direct numbers. Whether it was there. */
  deleteTrunk(tenantId: string, id: string): Promise<boolean>
  /** The direct numbers of a tenant, by first number. */
  listDids(tenantId: string): Promise<DidRecord[]>
  /** Adds or replaces a range; its trunk must exist in the tenant (else it throws). */
  upsertDid(record: DidRecord): Promise<void>
  deleteDid(tenantId: string, id: string): Promise<boolean>

  /** The outbound rules of a tenant; null when none was ever set. */
  getOutbound(tenantId: string): Promise<OutboundRecord | null>
  /**
   * Replaces them whole, one writer of the tenant's rules at a time whatever process writes (with a version or not).
   * With `expected`, only if what is kept is still that version (outboundVersion; none kept: the version of
   * EMPTY_OUTBOUND): 409 OUTBOUND_STALE otherwise, and nothing handed. `hand`, in the same turn, after the check and
   * before the write: the new rules; when it fails, or the write does, the rules kept before (then the error).
   * The SIP server is thus only ever handed what the store keeps, in the order it keeps it.
   */
  setOutbound(record: OutboundRecord, expected?: string, hand?: OutboundHand): Promise<void>
  /** Runs `run` with the rules kept (EMPTY_OUTBOUND when none), in the same turn as setOutbound: none written meanwhile. */
  holdOutbound(tenantId: string, run: (kept: OutboundRules) => Promise<void>): Promise<void>
  /** Keeps an alert: a repeat of an open one (same alertKey, within ALERT_DEDUP_MS of its last, not acknowledged) counts in it. */
  addAlert(record: AlertRecord): Promise<void>
  /** The alerts of a tenant, the latest repeated first, `limit` at most (clamped as a page). */
  listAlerts(tenantId: string, query?: AlertQuery): Promise<StoredAlert[]>
  /**
   * Marks an alert of the tenant acknowledged, by `by` at `at` (ISO), if it is still as the administrator saw it: its
   * last repeat at `seen` (ISO) and `count` repeats. Repeated since (even within the same millisecond, or a repeat
   * dated before the last one), it stays open (returned without `acknowledgedAt`: they look again).
   * Its repeats open a new one once it is acknowledged. The alert as kept then (the first acknowledgement stays),
   * null when the tenant has none of that id.
   */
  acknowledgeAlert(tenantId: string, id: string, by: string, at: string, seen: string, count: number): Promise<StoredAlert | null>
  /** Removes the alerts of every tenant whose last repeat is before `before` (ISO); how many. */
  purgeAlerts(before: string): Promise<number>

  /** The subscriptions of a tenant, oldest first. */
  listWebhookSubscriptions(tenantId: string): Promise<WebhookSubscriptionRecord[]>
  getWebhookSubscription(tenantId: string, id: string): Promise<WebhookSubscriptionRecord | null>
  /**
   * Adds one, unless the tenant has `max` already (false then, nothing written): the count and the write go together,
   * whatever Gateway writes.
   */
  addWebhookSubscription(record: WebhookSubscriptionRecord, max: number): Promise<boolean>
  /**
   * Writes what an administrator sets of one of the tenant (its address, events, description, whether enabled, and
   * `updatedAt`), never its secret nor its health; false when it has none of that id. Disabled, its pending
   * deliveries are failed (`disabled`): nothing it was owed is sent once it is enabled again, unless replayed.
   * Enabled, it starts afresh (no failures, no pause, no reason it was disabled for).
   */
  updateWebhookSubscription(record: WebhookSubscriptionRecord): Promise<boolean>
  /**
   * A new secret for one of the tenant (`secretEnc`): the current one goes on signing until `keepPreviousUntil`, as
   * the previous one (a second renewal replaces it). One write: two renewals at once, or a renewal during an update,
   * lose neither. False when the tenant has none of that id.
   */
  renewWebhookSecret(tenantId: string, id: string, secretEnc: string, keepPreviousUntil: string | null, at: string): Promise<boolean>
  /** Its deliveries wait until `until` (the circuit breaker: its subscriber kept failing); null lifts the pause. */
  pauseWebhookSubscription(tenantId: string, id: string, until: string | null): Promise<void>
  /**
   * Starts it afresh without closing what it waits to send (an administrator repaired its subscriber): no pause, no
   * failures, no backlog counted. False when the tenant has none of that id.
   */
  resumeWebhookSubscription(tenantId: string, id: string): Promise<boolean>
  /**
   * Disables one that kept failing (`disabledReason` 'failing'), its pending deliveries failed (`disabled`): true when
   * it was enabled until then (the administrators are told once).
   */
  disableFailingWebhookSubscription(tenantId: string, id: string, at: string): Promise<boolean>
  /** Removes one and its deliveries. Whether it was there. */
  deleteWebhookSubscription(tenantId: string, id: string): Promise<boolean>
  /** The domains the tenant allows its subscriptions to point to, as written. */
  getWebhookDomains(tenantId: string): Promise<string[]>
  setWebhookDomains(tenantId: string, domains: string[]): Promise<void>
  /**
   * Queues `body` (the event `eventId` of type `eventType`) for each enabled subscription of the tenant that takes
   * this type, once per subscription and event whoever queues it again (another Gateway heard it too). Due at `at`
   * (the store's clock without it). How many deliveries were queued pending (those past `maxPending` are recorded
   * failed and counted in their subscription's `backlog`: not counted here).
   */
  enqueueWebhookEvent(tenantId: string, eventId: string, eventType: WebhookEventType, body: string, at: string | undefined, options?: WebhookQueueOptions): Promise<number>
  /**
   * Queues `body` for one subscription of the tenant, whatever it takes (a test): the delivery, null without it,
   * `full` when it has `maxPending` pending already (counted in the write itself), or `rate` when `quota` is used up
   * (nothing queued). The quota counts the delivery queued only, in the same transaction: one refused costs none.
   */
  enqueueWebhookDelivery(tenantId: string, subscriptionId: string, eventId: string, eventType: string, body: string, at: string | undefined, maxPending?: number, quota?: WebhookSendQuota): Promise<WebhookDeliveryRecord | 'full' | 'rate' | null>
  /**
   * Takes up to `limit` pending deliveries due now, whatever tenant, that no other Gateway holds, of enabled
   * subscriptions not paused, with attempts left: each one counts an attempt and is held for `caps.leaseMs` (then due
   * again, if its outcome never came). Within `caps` (what all Gateways hold counted), as allocateClaims shares them:
   * the tenant holding fewest first, then the one served least recently, `reserve` places kept for a tenant holding
   * none; a tenant whose subscriber never answers, or answers slowly, holds a few deliveries at most, never the
   * others'. Its cost does not grow with what waits: each subscription's next due is read by an index, and one tenant
   * is claimed by one Gateway at a time (another passes it over meanwhile, and serves the next one with room). Two
   * Gateways never take the same one.
   * `at`: the time the tests give instead of the store's clock.
   */
  claimWebhookDeliveries(limit: number, caps: WebhookClaimCaps, at?: WebhookClaimTime): Promise<ClaimedDelivery[]>
  /** Fails (`abandoned`) the deliveries whose last attempt never came back (their lease lapsed): how many. */
  sweepWebhookDeliveries(maxAttempts: number, now?: string): Promise<number>
  /**
   * Records the outcome of an attempt taken with `claim`, and counts it in its subscription's health (a delivery
   * starts it afresh, a failure adds one): the health then, or null when ignored (the lease was taken back since).
   */
  completeWebhookDelivery(id: string, claim: string, result: WebhookAttemptResult): Promise<WebhookHealth | null>
  /** A page of a subscription's deliveries, the latest first (clamped as a page). */
  listWebhookDeliveries(tenantId: string, subscriptionId: string, query?: WebhookDeliveryQuery): Promise<WebhookDeliveryRecord[]>
  /**
   * Sends a delivery again (its attempts from zero, due at `at`): the delivery as it is then; `pending` when it is
   * still pending (not replayed); `full` and `rate` as enqueueWebhookDelivery says them; null when the subscription
   * of the tenant has none of that id.
   */
  replayWebhookDelivery(tenantId: string, subscriptionId: string, id: string, at?: string, maxPending?: number, quota?: WebhookSendQuota): Promise<WebhookDeliveryRecord | 'pending' | 'full' | 'rate' | null>
  /**
   * Removes the deliveries of every tenant created before `before` (ISO), unless pending: by batches, one Gateway at
   * a time (another one that tries meanwhile removes nothing). How many. What was told of each subject is kept,
   * whatever its age (one row per person and trunk; a person's goes with their mapping or their erasure), unless it is
   * `removed` (a trunk no longer watched) since before `before`.
   */
  purgeWebhookDeliveries(before: string): Promise<number>
  /**
   * The right to erasure (DELETE /me/history): the deliveries about the person (`subject_user`) that are no longer
   * pending, and what was told of their presence; those still pending are sent, then kept without their body. How
   * many deliveries.
   */
  eraseWebhookSubject(tenantId: string, userId: string): Promise<number>

  /**
   * Keeps what the subscribers were last told of `subject` (step 10a: `trunk:<id>` its health, `presence:<user>` a
   * person's status) as `state` since now (the store's clock, or `at`), if it changed, and queues the event `event`
   * makes of it in the same transaction (both or neither): what it was before (undefined when never kept) and how
   * many deliveries, or null when nothing was written: it was already that, what was told is not older, or `holder`
   * no longer holds the lease of WEBHOOK_STATE_ROLE (another Gateway tells the changes now).
   */
  setWebhookState(change: WebhookStateChange, event: WebhookStateEvent, options?: WebhookQueueOptions): Promise<{ previous: string | undefined; queued: number } | null>
  /**
   * Takes the lease of `role` for `holder` for `ms` (on the database's clock), or renews it: the lease, or null while
   * another holds it and its lease has not lapsed. `heard` (0 by default): how many tenants `holder` hears the events
   * of; one that hears more takes the lease at once from one that hears fewer. Its holder writes (setWebhookState)
   * until a third of `ms` before its end only, and one that took it from another holder whose writes may be under way
   * writes from `writeFrom` (that third later): a renewal never waits for the writes, and two holders never write at
   * the same time. `ms` 0 gives it back.
   */
  takeWebhookLease(role: string, holder: string, ms: number, heard?: number): Promise<WebhookLease | null>
  /** What was told of the tenant's subjects starting with `prefix` (`trunk:`): the subject and its state. */
  listWebhookStates(tenantId: string, prefix: string): Promise<{ subject: string; state: string }[]>
  /** The time on the store's clock (the database's): the hub dates the queue on it, whatever its own clock says. */
  clock(): Promise<string>

  close(): Promise<void>
}

export const MAX_PAGE = 200
export const clampLimit = (limit?: number) => Math.min(Math.max(limit ?? 50, 1), MAX_PAGE)
