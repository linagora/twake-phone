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
  secretEnc: string
  createdAt: string
  updatedAt: string
  /** The administrator who created it. */
  createdBy?: string
}

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
  /** What the outcome is recorded with (completeWebhookDelivery): an outcome of a lease taken back since is ignored. */
  claim: string
}

/** The outcome of an attempt: delivered, or failed and due again at `retryAt` (absent: failed for good). */
export type WebhookAttemptResult =
  | { delivered: true; at: string; status: number }
  | { delivered: false; at: string; status?: number; error: string; retryAt?: string }

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
   * Replaces one of the tenant (false when it has none of that id). Disabled, its pending deliveries are failed
   * (`disabled`): nothing it was owed is sent once it is enabled again, unless replayed.
   */
  updateWebhookSubscription(record: WebhookSubscriptionRecord): Promise<boolean>
  /** Removes one and its deliveries. Whether it was there. */
  deleteWebhookSubscription(tenantId: string, id: string): Promise<boolean>
  /** The domains the tenant allows its subscriptions to point to, as written. */
  getWebhookDomains(tenantId: string): Promise<string[]>
  setWebhookDomains(tenantId: string, domains: string[]): Promise<void>
  /**
   * Queues `body` (the event `eventId` of type `eventType`) for each enabled subscription of the tenant that takes
   * this type, once per subscription and event whoever queues it again (another Gateway heard it too). Due at `at`.
   * How many deliveries were queued.
   */
  enqueueWebhookEvent(tenantId: string, eventId: string, eventType: WebhookEventType, body: string, at: string): Promise<number>
  /** Queues `body` for one subscription of the tenant, whatever it takes (a test): the delivery, or null without it. */
  enqueueWebhookDelivery(tenantId: string, subscriptionId: string, eventId: string, eventType: string, body: string, at: string): Promise<WebhookDeliveryRecord | null>
  /**
   * Takes up to `limit` pending deliveries due at `now` (the earliest due first), whatever tenant, that no other
   * Gateway holds: each one counts an attempt and is held until `leaseUntil` (then due again, if its outcome never
   * came). Two Gateways never take the same one at the same time.
   */
  claimWebhookDeliveries(now: string, leaseUntil: string, limit: number): Promise<ClaimedDelivery[]>
  /** Records the outcome of an attempt taken with `claim`; ignored (false) when the lease was taken back since. */
  completeWebhookDelivery(id: string, claim: string, result: WebhookAttemptResult): Promise<boolean>
  /** A page of a subscription's deliveries, the latest first (clamped as a page). */
  listWebhookDeliveries(tenantId: string, subscriptionId: string, query?: WebhookDeliveryQuery): Promise<WebhookDeliveryRecord[]>
  /**
   * Sends a delivery again (its attempts from zero, due at `at`): the delivery as it is then; `pending` when it is
   * still pending (not replayed); null when the subscription of the tenant has none of that id.
   */
  replayWebhookDelivery(tenantId: string, subscriptionId: string, id: string, at: string): Promise<WebhookDeliveryRecord | 'pending' | null>
  /** Removes the deliveries of every tenant created before `before` (ISO), unless pending; how many. */
  purgeWebhookDeliveries(before: string): Promise<number>

  /**
   * Keeps what the subscribers were last told of `subject` (step 10a: `trunk:<id>` its health, `presence:<user>` a
   * person's status) as `state` since `at`, if it changed: what it was before (undefined when never kept), or null
   * when it was already that (nothing written). Of two Gateways writing the same change, only one sees it changed:
   * the event is told once.
   */
  setWebhookState(tenantId: string, subject: string, state: string, at: string): Promise<string | undefined | null>

  close(): Promise<void>
}

export const MAX_PAGE = 200
export const clampLimit = (limit?: number) => Math.min(Math.max(limit ?? 50, 1), MAX_PAGE)
