import type { CallDirection, CallState, DidRange, OutboundAssignment, OutboundPolicy, OutboundProfile, PresenceStatus, TelephonyAlert, Trunk, WebhookEventType } from '@twake/telephony-types'

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

/**
 * The places of a claim (claimWebhookDeliveries): one to each tenant in turn, the earliest due first, and within a
 * tenant to each of its subscriptions in turn, within what the caps leave once what all Gateways hold is counted.
 * How many to take of each subscription.
 */
export const allocateClaims = (
  limit: number,
  caps: Pick<WebhookClaimCaps, 'perSubscription' | 'perTenant'>,
  tenants: readonly string[],
  ready: readonly { id: string; tenantId: string }[],
  held: readonly { tenantId: string; subscriptionId: string; n: number }[]
): { subscriptionId: string; n: number }[] => {
  const roomT = new Map(tenants.map(t => [t, caps.perTenant - held.filter(h => h.tenantId === t).reduce((a, h) => a + h.n, 0)]))
  const roomS = new Map(ready.map(r => [r.id, caps.perSubscription - (held.find(h => h.subscriptionId === r.id)?.n ?? 0)]))
  const subsOf = new Map(tenants.map(t => [t, ready.filter(r => r.tenantId === t).map(r => r.id)]))
  const next = new Map(tenants.map(t => [t, 0]))
  const want = new Map<string, number>()
  let left = limit
  for (let progress = true; left > 0 && progress; ) {
    progress = false
    for (const t of tenants) {
      if (left === 0) break
      if ((roomT.get(t) ?? 0) <= 0) continue
      const subs = subsOf.get(t)!
      for (let i = 0; i < subs.length; i++) {
        const k = (next.get(t)! + i) % subs.length
        const id = subs[k]!
        if ((roomS.get(id) ?? 0) <= 0) continue
        want.set(id, (want.get(id) ?? 0) + 1)
        roomS.set(id, roomS.get(id)! - 1)
        roomT.set(t, roomT.get(t)! - 1)
        next.set(t, k + 1)
        left--
        progress = true
        break
      }
    }
  }
  return [...want].map(([subscriptionId, n]) => ({ subscriptionId, n }))
}

/**
 * A change of state told once (setWebhookState): `holder` holds the lease of the role (takeWebhookLease) or nothing
 * is written. It is dated on the store's clock (the database's) unless `at` is given (tests), and must be newer than
 * what was told.
 */
export interface WebhookStateChange {
  tenantId: string
  subject: string
  state: string
  at?: string
  holder: string
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

export interface Store {
  listProviders(): Promise<ProviderRecord[]>
  upsertProvider(record: ProviderRecord): Promise<void>

  getMappingByUser(tenantId: string, userId: string): Promise<UserMapping | null>
  getMappingByExtension(tenantId: string, extension: string): Promise<UserMapping | null>
  upsertMapping(mapping: UserMapping): Promise<void>
  /** Every mapping of a tenant, by user id. */
  listMappings(tenantId: string): Promise<UserMapping[]>
  deleteMapping(tenantId: string, userId: string): Promise<void>

  /** Idempotent on (tenant, user, callId). */
  addHistory(entry: HistoryEntry): Promise<void>
  listHistory(tenantId: string, userId: string, query?: HistoryQuery): Promise<HistoryPage>
  /** Deletes the history of a user (retention, right to erasure). Returns the number of rows. */
  deleteHistory(tenantId: string, userId: string): Promise<number>

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
  /**
   * Counts a test or a replay asked of a subscription (at `at`, the store's clock otherwise), unless `limit` were
   * asked of it within `windowMs` before, or `tenantLimit` of the tenant's (false then, nothing counted): whatever
   * Gateway or administrator asks, and a subscription deleted and made again counts the same.
   */
  takeWebhookSend(tenantId: string, subscriptionId: string, at: string | undefined, limit: number, windowMs: number, tenantLimit?: number): Promise<boolean>
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
   * Queues `body` for one subscription of the tenant, whatever it takes (a test): the delivery, null without it, or
   * `full` when it has `maxPending` pending already (nothing queued).
   */
  enqueueWebhookDelivery(tenantId: string, subscriptionId: string, eventId: string, eventType: string, body: string, at: string | undefined, maxPending?: number): Promise<WebhookDeliveryRecord | 'full' | null>
  /**
   * Takes up to `limit` pending deliveries due now, whatever tenant, that no other Gateway holds, of enabled
   * subscriptions not paused, with attempts left: each one counts an attempt and is held for `caps.leaseMs` (then due
   * again, if its outcome never came). Within `caps` (what all Gateways hold counted), each tenant's earliest due in
   * turn: a tenant whose subscriber never answers, or answers slowly, holds a few deliveries at most, never the
   * others'. Its cost does not grow with what waits: each subscription's next due is read by an index, and one tenant
   * is claimed by one Gateway at a time (another passes it over meanwhile). Two Gateways never take the same one.
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
   * still pending (not replayed); null when the subscription of the tenant has none of that id.
   */
  replayWebhookDelivery(tenantId: string, subscriptionId: string, id: string, at?: string, maxPending?: number): Promise<WebhookDeliveryRecord | 'pending' | 'full' | null>
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
   * Takes the lease of `role` for `holder` for `ms` (on the database's clock), or renews it: whether it holds it
   * (false while another holds it and its lease has not lapsed). `healthy` (true by default): whether `holder` hears
   * what it would tell (its event streams are up); a healthy one takes the lease from one that is not, at once,
   * and one that is not takes it only once it lapsed (better than nobody).
   */
  takeWebhookLease(role: string, holder: string, ms: number, healthy?: boolean): Promise<boolean>
  /** What was told of the tenant's subjects starting with `prefix` (`trunk:`): the subject and its state. */
  listWebhookStates(tenantId: string, prefix: string): Promise<{ subject: string; state: string }[]>
  /** The time on the store's clock (the database's): the hub dates the queue on it, whatever its own clock says. */
  clock(): Promise<string>

  close(): Promise<void>
}

export const MAX_PAGE = 200
export const clampLimit = (limit?: number) => Math.min(Math.max(limit ?? 50, 1), MAX_PAGE)
