import type { CallDirection, CallState, DidRange, PresenceStatus, Trunk } from '@twake/telephony-types'

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

  close(): Promise<void>
}

export const MAX_PAGE = 200
export const clampLimit = (limit?: number) => Math.min(Math.max(limit ?? 50, 1), MAX_PAGE)
