import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { LiveKitError, PIN_DIGITS, maskNumber, splitParticipantId, verifyWebhook, type LiveKitConferenceBridge, type MeetApi, type MeetRoom, type ParticipantCall } from '@twake/conference-livekit'
import { OUTBOUND_ALLOWED, REPLACES, classify, countryAllowed } from '@twake/provider-opensips'
import type { DialedParticipant, MediaProvider, OperatorProvider, RoomCallGrantToken, TelephonyProvider } from '@twake/telephony-provider-sdk'
import { EXTENSION_FORMAT, FRAUD_DEFAULTS, OUTBOUND_CAP_DEFAULTS, isReservedNumber, type CallDirection, type DidRange, type Endpoint, type ForwardingRules, type Presence, type PresenceStatus, type RingGroup, type TelephonyEvent, type TrunkStatus, type User } from '@twake/telephony-types'
import { adminPolicyFromEnv, isAdmin, type AdminPolicy } from './admin.js'
import { authenticatorFromEnv, TicketStore, type Authenticator, type Identity } from './auth.js'
import { MAX_CONTACT_ID, MAX_FAVORITES, MAX_QUERY, MAX_SEARCH, RateLimiter, type ContactDirectory } from './contacts.js'
import { CALL_ROOM, GATEWAY_ROOM } from './conference-sweep.js'
import { StoreDirectory, seedUserMap, type UserDirectory } from './directory.js'
import type { DirectorySync } from './directory-sync.js'
import { EventBus } from './events.js'
import { historyEntryFor } from './history.js'
import { ENDED_TTL_SEC, MISSED_TTL_SEC, type PushMessage, type WebPush } from './push.js'
import type { ProviderRegistry } from './registry.js'
import { securityHeadersFor, type SecurityOptions } from './security.js'
import { TrunkWatch } from './trunk-health.js'
import { OPERATOR_KEPT_MS, OperatorRoundError, OperatorSync, askKey, erasedNumbersOf, type OperatorRemoval, type OperatorRestoreRefusal } from './operator.js'
import { e164Of } from './e164.js'
import { encrypt } from './crypto.js'
import { newWebhookSecret, parseWebhookDomains } from './webhook-delivery.js'
import { presenceEvent, webhookEventsFor } from './webhook-events.js'
import { DELIVERY_CURSOR, DELIVERY_ID, MAX_WEBHOOKS, WEBHOOK_ID, WEBHOOK_SECRET_GRACE_MS, WEBHOOK_SENDS_PER_MINUTE, WEBHOOK_TENANT_SENDS_PER_MINUTE, WebhookHub, parseSubscription, publicDelivery, publicSubscription, secretContext, type WebhookHubOptions } from './webhooks.js'
import { MAX_DIDS, MAX_TRUNKS, TRUNK_ID, defaultTrunk, inDids, parseDid, parseOperatorLines, parseTrunk, providerTrunks, publicDid, publicTrunk, trunkRecord } from './trunks.js'
import { EMPTY_OUTBOUND, PROFILE_ID, outboundVersion, parseOutbound, staleOutbound, type Outbound } from './outbound.js'
import { MemoryStore } from './store/memory.js'
import { ALERT_RETENTION_DAYS, clampLimit, isMissed, type HistoryEntry, type HistoryQuery, type Store, type StoredAlert, type TrunkRecord, type UserPresenceRecord, type WebhookDeliveryStatus, type WebhookSubscriptionRecord } from './store/types.js'

/** How long a trunk's save waits for its operator (step 10b), and a round asked from the administration. */
const OPERATOR_APPLY_MS = 8_000
const OPERATOR_ROUND_MS = 30_000
/** Rounds asked a minute per tenant, whatever Gateway is asked (review 10b, n°8); reads of lines asked a minute. */
const OPERATOR_SYNCS_PER_MINUTE = 2
const OPERATOR_READS_PER_MINUTE = 10

/** What the SIP server raises for the administrators (TelephonyAlert). */
const ALERT_KINDS = ['fraud-warning', 'fraud-critical', 'limit', 'rights', 'emergency', 'meet', 'webhook', 'operator'] as const
/** An extension as the log names it: the same short hash for the same tenant and extension, never the extension. */
/**
 * The extension of an alert in the log (second review 6b, n°7): a keyed hash (HMAC-SHA-256, with a key the Gateway
 * derives from SECRETS_KEY), the same for one extension of one tenant, that the log alone does not give back (a plain
 * hash of 2 to 6 digits is reversed by trying them all). Without SECRETS_KEY, none: the extension is left out.
 */
const pseudonymizer = (secretsKey: Buffer | undefined) => {
  if (!secretsKey) return undefined
  const key = Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'twake-phone: extensions in the log', 32))
  return (tenantId: string, extension: string) => createHmac('sha256', key).update(`${tenantId}\u0000${extension}`).digest('hex').slice(0, 16)
}
/**
 * The print of the number on the other side of an erased call (third review 10b, n°5): HMAC-SHA-256 with a key the
 * Gateway derives from SECRETS_KEY, the same for one number of one tenant, that the base alone does not give back.
 * Without SECRETS_KEY, none: an erased call is kept by its way and time alone.
 */
const erasedRemoteKey = (secretsKey: Buffer | undefined) => {
  if (!secretsKey) return undefined
  const key = Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'twake-phone: erased calls', 32))
  return (tenantId: string, number: string) => createHmac('sha256', key).update(`${tenantId}\u0000${number}`).digest('hex')
}
/**
 * Why a forward of before to `number` may not be put back on a line of trunk `trunkId` (fourth review 10b, n°3): the
 * rules a fallback at the operator is held to (OPERATOR_FALLBACK_LOOP: a direct number, a line or the number of a
 * trunk), and what the trunk may call (step 6: premium numbers never, overseas and international ones as it allows; its
 * defaults when it is gone).
 */
export const restoreRefusalOf =
  (store: Store) =>
  async (tenantId: string, number: string, trunkId?: string): Promise<OperatorRestoreRefusal | undefined> => {
    const n = e164Of(number)
    if (inDids((await store.listDids(tenantId)).map(publicDid), n)) return 'loop'
    const trunks = await store.listTrunks(tenantId)
    if (trunks.some(t => [...(t.config.operator?.lines ?? []), ...(t.config.defaultNumber ? [t.config.defaultNumber] : [])].some(l => e164Of(l) === n))) return 'loop'
    const trunk = trunks.find(t => t.id === trunkId)
    const kind = classify(n)
    const allowed: readonly string[] = trunk?.config.allowed ?? OUTBOUND_ALLOWED
    if (!kind || !allowed.includes(kind.class)) return 'outbound'
    if (kind.class === 'international' && !countryAllowed(kind.number, trunk?.config.countries ?? [])) return 'outbound'
    return undefined
  }
/** The cursor of a page of alerts (`next`, `before`): the last repeat (ms) and id of the last alert of the page. */
const ALERT_CURSOR = /^([0-9]{1,15})-([1-9][0-9]{0,17})$/
/**
 * An alert as the API shows it: its last repeat's fields, what the first one said (`first`: its value and number), and
 * its acknowledgement (step 7).
 */
const publicAlert = ({ id, at, lastAt, count, alert, first, acknowledgedAt, acknowledgedBy }: StoredAlert) => ({
  id,
  at,
  lastAt,
  count,
  ...alert,
  first: { ...(first.value !== undefined ? { value: first.value } : {}), ...(first.number ? { number: first.number } : {}) },
  ...(acknowledgedAt ? { acknowledgedAt } : {}),
  ...(acknowledgedBy ? { acknowledgedBy } : {})
})

const STATUSES: PresenceStatus[] = ['available', 'busy', 'away', 'dnd', 'offline']
const DIRECTIONS: CallDirection[] = ['inbound', 'outbound']
const HISTORY_STATUS = ['missed', 'declined', 'answered', 'failed']
/** How long recording a call in the history may take before the pump moves on (a database that hangs). */
const HISTORY_WRITE_MS = 5_000
const BROWSER_ENDPOINT: Endpoint = { id: 'browser', type: 'browser', label: 'Twake Phone' }
/** The statuses a person may give an end and a message to: the others last until they change them. */
const TIMED_STATUSES: PresenceStatus[] = ['away', 'dnd']
/** Longest message for callers: it travels in a SIP header. */
const PRESENCE_MESSAGE_MAX = 140
/** Furthest end of a chosen presence: a year (beyond, a forward is the tool). */
const PRESENCE_MAX_MS = 366 * 86_400_000
/** Seconds of ringing before a call goes to the no-answer target (about: the forward may come a second or two later). */
const NOANSWER_DELAY = { min: 5, max: 120, default: 20 }
/** Waits between two attempts at handing a provider the presences kept in the store (its database may be late). */
const RESTORE_RETRY_MS = [1_000, 5_000, 15_000, 30_000]
/** How long someone found without an extension keeps their browsers' subscriptions (BuildOptions.pushPurgeGraceMs). */
const PUSH_PURGE_GRACE_MS = 3_600_000
/** Longest wait of a change for the one before it (a provider whose database hangs): the next one then goes. */
const TURN_MAX_MS = 10_000
/** Presences told again at a time when this Gateway takes the lease of the changes of state (onLead). */
const PRESENCE_BATCH = 20
/** One line of text: no control character (a message for callers ends up in a SIP header). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const CONTROL = /[\u0000-\u001f\u007f]/

/** `promise`, or a rejection once `ms` passed without it settling (it still runs, its result is ignored). */
const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const isMediaProvider =(p: TelephonyProvider): p is TelephonyProvider & MediaProvider => 'getSession' in p

export interface BuildOptions {
  bus?: EventBus
  store?: Store
  /** How long a history write may take before the event goes on without it. Default 5 s. */
  historyWriteTimeoutMs?: number
  /** How long a change to a provider's presences or forwards waits for the one before it, at most. Default 10 s. */
  turnMaxMs?: number
  directory?: UserDirectory
  /** The people one can look up and call. Absent when no directory is configured: the endpoints answer 501. */
  contacts?: ContactDirectory
  /** Searches allowed per user (tests inject a tighter one). Default: 30 per 10 seconds. */
  directorySearchLimiter?: RateLimiter
  /** Push subscriptions given or removed per user (tests inject a tighter one). Default: 20 a minute. */
  pushSubscriptionLimiter?: RateLimiter
  /** Calls a user's rooms may place (step 8; tests inject a tighter one). Default: 10 a minute. */
  dialOutLimiter?: RateLimiter
  /**
   * New rooms a user may open (step 8, each one a dispatch rule at a LiveKit Meet may share; tests inject a tighter
   * one). Default: 20 an hour.
   */
  conferenceLimiter?: RateLimiter
  /**
   * The rooms open at once (step 8, kept in the database, whatever the Gateways): per person and per tenant; tests
   * set lower ones. Default: 50 and 1000 (third review n°6).
   */
  conferenceCaps?: { perPerson?: number; perTenant?: number }
  /** Reads of a room per person (GET /conferences/:id: LiveKit asked; tests inject a tighter one). Default: 60 a minute. */
  conferenceReadLimiter?: RateLimiter
  /**
   * How often the Gateway looks whether the owner of a call's room it made is still in it (second review 8b, n°3),
   * without waiting for LiveKit's webhook. Default: 15 s.
   */
  conferenceOwnerCheckMs?: number
  /**
   * How long someone found without an extension keeps their browsers' subscriptions: removed at the first
   * reconciliation after that (a mapping missing a moment loses nothing). Default: an hour.
   */
  pushPurgeGraceMs?: number
  /** Copies the directory's accounts into the user ↔ extension mappings; administrators can run it from the app. */
  directorySync?: DirectorySync
  /** Who administers the platform. Default: from ADMIN_ROLE and ADMIN_USERS. */
  admin?: AdminPolicy
  security?: SecurityOptions
  auth?: Authenticator
  tickets?: TicketStore
  /**
   * Web Push (ADR 0015): a person's browsers are told of a call while no window of the app is open, when the
   * provider can hold a call for them (capability `push`). Absent: the endpoints say it is not available.
   */
  push?: WebPush
  /** How often the alerts past their retention are removed (step 6b). Default: every hour. */
  alertPurgeIntervalMs?: number
  /**
   * How long the state of a tenant's trunks is kept (step 7): every open Trunks screen reads it every few seconds, each
   * read costs the SIP server a query and a control message. Default 2.5 s.
   */
  trunkStatusCacheMs?: number
  /**
   * The key the passwords of the trunks are encrypted with (SECRETS_KEY, step 6). Absent: a trunk can be kept without
   * a password only.
   */
  secretsKey?: Buffer
  /**
   * The webhook hub (step 10a, ADR 0020), there when `secretsKey` is: which destinations it may reach (https only, the
   * platform's own networks closed, unless opened), and its timings (the tests shorten them). Without `secretsKey`,
   * none: the routes answer 501.
   */
  webhooks?: Partial<Omit<WebhookHubOptions, 'store' | 'key' | 'logger'>>
  /**
   * Tests and replays a subscription may be asked a minute, whatever Gateway or administrator asks (default 10), and
   * all the subscriptions of an organisation together (default 30).
   */
  webhookSendsPerMinute?: number
  webhookTenantSendsPerMinute?: number
  /**
   * How long a person's presence stays the same before it is told (default 2 s): a short call is not two
   * `presence.changed`, only the status it settles on. 0: at once (tests). One that keeps changing is told as it is
   * after webhookPresenceSettleMaxMs all the same (default 10 s).
   */
  webhookPresenceSettleMs?: number
  webhookPresenceSettleMaxMs?: number
  /**
   * How often the trunks are read for `trunk.degraded` and `trunk.recovered` (step 10a), when the hub is there: every
   * 30 s by default; 0: never. `trunkWatchConfirm`: reads in a row a new health is seen before it is told (default 2).
   */
  trunkWatchMs?: number
  trunkWatchConfirm?: number
  /**
   * The operator of the trunks of each tenant that has one (step 10b, ADR 0021: OVHcloud for the organisation of the
   * pilot), read every `operatorSyncMs` (10 minutes by default; 0: never on a schedule) by the Gateway that leads:
   * the fallback forwards of the trunks' lines, the records of calls reconciled with the history once read
   * `operatorSettleMs` ago (5 minutes by default).
   */
  operators?: ReadonlyMap<string, OperatorProvider>
  /** Where the log goes (standard output by default): a test reads it (review 10b, n°22: no key in it). */
  logStream?: { write(line: string): void }
  operatorSyncMs?: number
  operatorSettleMs?: number
  /** Phone access to Meet rooms. Absent when no LiveKit is configured: the endpoints answer 501. */
  conference?: {
    bridge: (tenantId: string) => LiveKitConferenceBridge | undefined
    /** When present, Meet owns rooms, PINs and dial-in; the Gateway acts as a Meet application for the user. */
    meet?: MeetApi
    /**
     * The access number of the rooms (step 8, ADR 0018: OpenSIPS's MEET_NUMBER, sent to LiveKit SIP, which asks for a
     * room's PIN): a direct number may aim at it; it is no extension nor ring group.
     */
    accessNumber?: string
    webhookKey: string
    webhookSecret: string
  }
}

const MEETING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 })
/** A 400 whose `code` the app turns into the person's words (the message stays for the logs and other clients). */
const refused = (code: string, message: string) => Object.assign(new Error(message), { statusCode: 400, code })

/** Validates the query string of the history endpoint: nothing unchecked reaches the store. */
export const parseHistoryQuery = (q: Record<string, string | undefined>): HistoryQuery => {
  const out: HistoryQuery = {}
  if (q.direction) {
    if (!DIRECTIONS.includes(q.direction as CallDirection)) throw bad('invalid direction')
    out.direction = q.direction as CallDirection
  }
  if (q.status) {
    if (!HISTORY_STATUS.includes(q.status)) throw bad('invalid status')
    out.status = q.status as NonNullable<HistoryQuery['status']>
  }
  if (q.number) {
    if (q.number.length > 32) throw bad('invalid number')
    out.number = q.number
  }
  for (const k of ['from', 'to', 'before'] as const) {
    const v = q[k]
    if (v) {
      if (Number.isNaN(Date.parse(v))) throw bad(`invalid ${k}`)
      out[k] = new Date(v).toISOString()
    }
  }
  if (q.limit) {
    const n = Number(q.limit)
    if (!Number.isInteger(n) || n < 1) throw bad('invalid limit')
    out.limit = n
  }
  return out
}

/** A chosen presence as the person's own screens show it (no tenant, no user id). */
const publicChoice = (r: UserPresenceRecord) => ({ status: r.status, since: r.since, ...(r.until ? { until: r.until } : {}), ...(r.message ? { message: r.message } : {}) })
const presenceOfRecord = (r: UserPresenceRecord): Presence => ({ ...publicChoice(r), source: 'user' })

/** Validates a presence the person sets: a status, and for absent or "do not disturb" an end in the future and a message. */
export const parsePresence = (body: unknown, now = Date.now()): { status: PresenceStatus; until?: string; message?: string } => {
  const b = (body ?? {}) as { status?: unknown; until?: unknown; message?: unknown }
  if (!STATUSES.includes(b.status as PresenceStatus)) throw bad('invalid status')
  const status = b.status as PresenceStatus
  const out: { status: PresenceStatus; until?: string; message?: string } = { status }
  const timed = TIMED_STATUSES.includes(status)
  if (b.until !== undefined && b.until !== null && b.until !== '') {
    if (!timed) throw bad('only an absence or a "do not disturb" can have an end')
    const at = typeof b.until === 'string' ? Date.parse(b.until) : NaN
    if (Number.isNaN(at)) throw refused('PRESENCE_UNTIL', 'invalid until')
    if (at <= now) throw refused('PRESENCE_UNTIL', 'until must be in the future')
    if (at > now + PRESENCE_MAX_MS) throw refused('PRESENCE_UNTIL', 'until must be within a year')
    out.until = new Date(at).toISOString()
  }
  if (b.message !== undefined && b.message !== null && b.message !== '') {
    if (!timed) throw bad('only an absence or a "do not disturb" can have a message')
    if (typeof b.message !== 'string') throw bad('invalid message')
    const message = b.message.trim()
    if (message.length > PRESENCE_MESSAGE_MAX || CONTROL.test(message)) throw refused('PRESENCE_MESSAGE', `the message must be one line of at most ${PRESENCE_MESSAGE_MAX} characters`)
    if (message) out.message = message
  }
  return out
}

/**
 * Validates forwarding rules: each target an extension of the organisation (the store maps it to someone), never the
 * person's own; external numbers are refused until the trunk exists. An empty or null field: no forward in that case.
 */
export const parseForwarding = async (body: unknown, user: User, isExtension: (target: string) => Promise<boolean>): Promise<ForwardingRules> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid forwarding rules')
  const b = body as { always?: unknown; busy?: unknown; noAnswer?: unknown }
  const target = async (value: unknown, what: string): Promise<string | undefined> => {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw bad(`invalid ${what} target`)
    const t = value.replace(/\s/g, '')
    if (!t) return undefined
    if (t === user.extension) throw refused('FORWARD_SELF', `${what}: a forward to your own extension would ring you again`)
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(t) || !(await isExtension(t))) {
      throw refused('FORWARD_NOT_EXTENSION', `${what}: only an extension of your organisation can receive your calls for now (forwarding to an outside number comes with the phone line)`)
    }
    return t
  }
  const out: ForwardingRules = {}
  const always = await target(b.always, 'always')
  if (always) out.always = always
  const busy = await target(b.busy, 'busy')
  if (busy) out.busy = busy
  if (b.noAnswer !== undefined && b.noAnswer !== null) {
    if (typeof b.noAnswer !== 'object' || Array.isArray(b.noAnswer)) throw bad('invalid noAnswer')
    const n = b.noAnswer as { target?: unknown; delaySec?: unknown }
    const t = await target(n.target, 'noAnswer')
    const delaySec = n.delaySec === undefined || n.delaySec === null || n.delaySec === '' ? NOANSWER_DELAY.default : Number(n.delaySec)
    if (!Number.isInteger(delaySec) || delaySec < NOANSWER_DELAY.min || delaySec > NOANSWER_DELAY.max) throw refused('FORWARD_DELAY', `noAnswer: the delay must be ${NOANSWER_DELAY.min} to ${NOANSWER_DELAY.max} seconds`)
    if (t) out.noAnswer = { target: t, delaySec }
  }
  return out
}

/**
 * Most members of a group: a call of the SIP server carries 12 destinations at most (MAX_BRANCHES of the packaged
 * OpenSIPS), and the first window of each member must always ring (ADR 0014).
 */
export const GROUP_MEMBERS_MAX = 12
const GROUP_NAME_MAX = 64
/** What a caller dials and a SIP server routes: the characters of an extension. */
const NUMBER = /^[A-Za-z0-9._+-]{1,64}$/

/**
 * Validates a simultaneous ring group an administrator sets: a number that is no extension of the organisation (a
 * group and a person would share it), a name, and 1 to GROUP_MEMBERS_MAX members, each an extension of the
 * organisation or one the group already has (`keep`: a vacant extension stays a member until an administrator takes
 * it out, ADR 0014), in the order given, once each. The size is checked before any member is looked up. A 400 or
 * 409 with a `code` the app turns into words.
 */
export const parseGroup = async (number: string, body: unknown, isExtension: (extension: string) => Promise<boolean>, keep: readonly string[] = []): Promise<RingGroup> => {
  // The internal plan (2 to 6 digits, not 0 first): anything else, dialled, the SIP server takes for a public number.
  if (!EXTENSION_FORMAT.test(number)) throw refused('GROUP_NUMBER', 'invalid group number: 2 to 6 digits, the first not 0')
  // Dialled, an emergency number (or another short number of the French plan) goes to the operator, never to a group.
  if (isReservedNumber(number)) throw refused('GROUP_NUMBER_RESERVED', `${number} is an emergency number or another short number of the French plan: calls to it go to the operator`)
  if (await isExtension(number)) throw Object.assign(new Error(`${number} is an extension: a group needs a number of its own`), { statusCode: 409, code: 'GROUP_NUMBER_TAKEN' })
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid group')
  const b = body as { name?: unknown; members?: unknown }
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > GROUP_NAME_MAX || CONTROL.test(name)) throw refused('GROUP_NAME', `the name must be one line of 1 to ${GROUP_NAME_MAX} characters`)
  if (!Array.isArray(b.members)) throw refused('GROUP_MEMBERS', 'members must be a list of extensions')
  const members: string[] = []
  for (const value of b.members) {
    if (typeof value !== 'string') throw refused('GROUP_MEMBER_NOT_EXTENSION', 'only an extension of your organisation can be a member')
    const m = value.replace(/\s/g, '')
    if (m && !members.includes(m)) members.push(m)
    // One too many is enough to refuse: a huge list costs no lookup.
    if (members.length > GROUP_MEMBERS_MAX) break
  }
  if (members.length === 0 || members.length > GROUP_MEMBERS_MAX) throw refused('GROUP_MEMBERS', `a group has 1 to ${GROUP_MEMBERS_MAX} members`)
  for (const m of members) {
    if (!NUMBER.test(m) || !(keep.includes(m) || (await isExtension(m)))) throw refused('GROUP_MEMBER_NOT_EXTENSION', `${m.slice(0, 64)}: only an extension of your organisation can be a member`)
  }
  return { number, name, members }
}

const publicEntry = (e: HistoryEntry) => ({
  id: e.callId,
  direction: e.direction,
  remoteNumber: e.remoteNumber,
  startedAt: e.startedAt,
  ...(e.endedAt ? { endedAt: e.endedAt } : {}),
  durationSec: e.durationSec,
  state: e.state,
  answered: e.answered,
  // Missed: the phone rang and nobody took the call. One the user declined (state `rejected`) is not.
  missed: isMissed(e),
  ...(e.conference ? { conference: true } : {}),
  // Where it is known from (step 10b): the SIP server, its operator's record reconciled with it, or that record alone.
  sources: e.operatorOnly && e.operator ? [e.operator] : e.operator ? ['opensips', e.operator] : ['opensips'],
  // Forwarded at the operator to the fallback, the platform out of reach (second review 10b, n°4): missed here.
  ...(e.operatorForwarded ? { forwardedToFallback: true } : {})
})

export const buildApp = async (registry: ProviderRegistry, options: BuildOptions = {}) => {
  const bus = options.bus ?? new EventBus()
  const store = options.store ?? new MemoryStore()
  const auth = options.auth ?? authenticatorFromEnv(process.env)
  const admin = options.admin ?? adminPolicyFromEnv(process.env)
  const pseudonym = pseudonymizer(options.secretsKey)
  const tickets = options.tickets ?? new TicketStore()
  const historyWriteMs = options.historyWriteTimeoutMs ?? HISTORY_WRITE_MS
  const turnMaxMs = options.turnMaxMs ?? TURN_MAX_MS
  const trunkStatusMs = options.trunkStatusCacheMs ?? 2_500
  /** The last read of the state of each tenant's trunks, and the tenants whose SIP server did not answer it. */
  const trunkStatus = new Map<string, { at: number; answer: Promise<{ available: boolean; items: TrunkStatus[] }> }>()
  const trunkStatusFailing = new Set<string>()
  let directory = options.directory
  if (!directory) {
    // Dev convenience: a bare in-memory gateway maps users from DEV_USER_MAP.
    const tenant = process.env.DEFAULT_TENANT ?? 'dev'
    await seedUserMap(store, tenant, process.env.DEV_USER_MAP, message => console.warn(`WARNING: DEV_USER_MAP: ${message}`))
    directory = new StoreDirectory(store)
  }
  const dir = directory
  // Who may act on which call: the users whose events carried it. Without this any signed-in user could hang up or
  // hold any call id they can guess.
  const callOwners = new Map<string, Set<string>>()
  const ownerKey = (tenantId: string, userId: string) => `${tenantId}\u0000${userId}`
  const trackOwner = (tenantId: string, userId: string, event: TelephonyEvent) => {
    if (!('call' in event.payload)) return
    const { call } = event.payload
    const owners = callOwners.get(call.id) ?? new Set<string>()
    owners.add(ownerKey(tenantId, userId))
    callOwners.set(call.id, owners)
    // Forget finished calls after a grace period (late actions such as a double click still resolve).
    if (event.type === 'call.ended' || event.type === 'call.failed') setTimeout(() => callOwners.delete(call.id), 5 * 60_000).unref()
  }

  const app = Fastify({
    // Contact ids (directory identifiers) travel in the path; the store bounds them to the same length.
    maxParamLength: MAX_CONTACT_ID,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(options.logStream ? { stream: options.logStream } : {}),
      serializers: {
        // Tickets and dev tokens travel in the query string of the WebSocket: never log them.
        req: req => ({ method: req.method, url: req.url?.split('?')[0] })
      }
    }
  })
  // The webhook hub (step 10a, ADR 0020): only with SECRETS_KEY, which keeps the subscriptions' secrets. It tells the
  // changes of state; a Gateway that hears the events of more tenants (their provider started here, its event stream
  // up) takes the lease from one that hears fewer. A tenant whose provider has not started here is not heard.
  const hub = options.secretsKey
    ? new WebhookHub({
        store,
        key: options.secretsKey,
        streams: () => registry.tenants().map(tenantId => [tenantId, started.get(tenantId)?.eventsConnected?.() ?? started.has(tenantId)] as const),
        ...options.webhooks,
        logger: app.log
      })
    : undefined
  /** Queues an event for the subscribers; never holds the stream of the provider's events (a database that hangs). */
  const publish = (tenantId: string, event: Parameters<WebhookHub['publish']>[1]) => {
    if (!hub) return Promise.resolve(0)
    return hub.publish(tenantId, event).catch((err: unknown) => {
      app.log.error({ err, tenantId, type: event.type }, 'webhook event not queued')
      return 0
    })
  }
  /**
   * A person's presence, told once if it changed (WebhookHub.publishChange). `known`: only if something is kept of
   * what was told of them (told again from what this Gateway remembers: one never told, or erased since on whatever
   * Gateway, is neither written nor told).
   */
  const tellPresence = (tenantId: string, userId: string, extension: string | undefined, status: PresenceStatus, known = false) =>
    hub
      ? hub
          .publishChange(tenantId, `presence:${userId}`, status, ['presence.changed'], (_previous, at) => presenceEvent(tenantId, userId, extension, status, at), { known })
          .catch((err: unknown) => {
            app.log.error({ err, tenantId }, 'webhook presence not queued')
            return null
          })
      : Promise.resolve(null)
  // The presence a person settles on, told once it stayed webhookPresenceSettleMs (not awaited): a call that rings
  // and ends within it is no change. One that keeps changing is told as it stands webhookPresenceSettleMaxMs after it
  // started to.
  const presenceSettleMs = options.webhookPresenceSettleMs ?? 2_000
  const presenceSettleMaxMs = options.webhookPresenceSettleMaxMs ?? 10_000
  const settling = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>()
  const publishPresence = (tenantId: string, userId: string, extension: string | undefined, status: PresenceStatus) => {
    if (!hub?.leading) return
    if (!presenceSettleMs) return void tellPresence(tenantId, userId, extension, status)
    const k = `${tenantId}\u0000${userId}`
    const before = settling.get(k)
    clearTimeout(before?.timer)
    const since = before?.since ?? Date.now()
    const timer = setTimeout(
      () => {
        settling.delete(k)
        void tellPresence(tenantId, userId, extension, status)
      },
      Math.max(0, Math.min(presenceSettleMs, since + presenceSettleMaxMs - Date.now()))
    )
    timer.unref()
    settling.set(k, { timer, since })
  }
  // Action endpoints (hold, hangup...) legitimately carry no body.
  // The raw text is kept: LiveKit webhooks sign the exact bytes of the body.
  app.addContentTypeParser(['application/json', 'application/webhook+json'], { parseAs: 'string' }, (req, body, done) => {
    try {
      ;(req as { rawBody?: string }).rawBody = body as string
      done(null, body ? JSON.parse(body as string) : {})
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }), undefined)
    }
  })
  // An API answers nothing a browser should render, frame or cache.
  app.addHook('onSend', async (req, reply) => {
    for (const [name, value] of Object.entries(securityHeadersFor(req.url.split('?')[0] ?? '/', options.security))) {
      if (!reply.hasHeader(name)) reply.header(name, value)
    }
  })
  // Origins of the Twake apps allowed to call the Gateway from a browser.
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS?.split(',') ?? false,
    // The plugin's default is GET, HEAD and POST: the browser's preflight would refuse every PUT and DELETE.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
    // x-twake-call: the Call-ID of the reader's own call in a conference's room (GET /conferences/:id).
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-cozy-instance', 'x-twake-call']
  })
  await app.register(swagger, { openapi: { info: { title: 'Twake Telephony Gateway', version: '0.1.0' } } })
  await app.register(swaggerUi, { routePrefix: '/docs' })
  await app.register(websocket)

  // The presence of every extension the providers told about, per tenant: what a directory shows next to a contact.
  const presences = new Map<string, Map<string, { userId: string; presence: Presence }>>()
  const presencesOf = (tenantId: string) => {
    const map = presences.get(tenantId) ?? new Map<string, { userId: string; presence: Presence }>()
    presences.set(tenantId, map)
    return map
  }
  /**
   * What is kept of the presences of a tenant, each extension still that of the person it was heard for (the
   * directory's word now): an extension given to another person since, or to nobody, is forgotten (its next event
   * says who has it).
   */
  const checkedPresences = async (tenantId: string) => {
    const map = presencesOf(tenantId)
    const out: { extension: string; userId: string; status: PresenceStatus }[] = []
    for (const [extension, { userId, presence }] of [...map]) {
      const holder = await dir.userIdForExtension(tenantId, extension).catch(() => userId)
      if (holder !== userId) {
        if (map.get(extension)?.userId === userId) map.delete(extension)
        continue
      }
      out.push({ extension, userId, status: presence.status })
    }
    return out
  }
  /** A person erased (or gone): what is kept of their presence goes too, and is never told again. */
  const forgetPresence = (tenantId: string, userId: string) => {
    const map = presencesOf(tenantId)
    for (const [extension, kept] of [...map]) if (kept.userId === userId) map.delete(extension)
    const k = `${tenantId}\u0000${userId}`
    clearTimeout(settling.get(k)?.timer)
    settling.delete(k)
  }
  // Pump provider events to the Twake users they concern, and keep the history of finished calls. A presence is
  // everyone's business in the tenant (the directory shows it); a call is its two parties' only. One event that
  // fails (the directory or the database down a moment) is logged and skipped: the stream goes on.
  const deliver = async (tenantId: string, extension: string, event: TelephonyEvent) => {
    // For the administrators, never the person (step 6b): kept and logged, whoever holds the extension.
    if (event.type === 'alert.raised') {
      const userId = await within(dir.userIdForExtension(tenantId, extension), historyWriteMs, 'alert user').catch(() => undefined)
      const alert = { ...event.payload.alert, ...(userId ? { userId } : {}) }
      // The log says what and how much, never whom nor the number called: the extension as a hash only (the same one
      // across lines, to follow it), the rest in the store, for the administrators.
      const { kind, param, scope, value, threshold } = alert
      app.log.warn({ tenantId, alert: { kind, param, scope, value, threshold, ...(alert.extension && pseudonym ? { ext: pseudonym(tenantId, alert.extension) } : {}) } }, `telephony alert: ${kind} ${param}`)
      await within(store.addAlert({ tenantId, at: event.timestamp, alert }), historyWriteMs, 'alert write').catch(err => app.log.error({ err, tenantId }, 'could not record the alert'))
      return
    }
    const userId = await dir.userIdForExtension(tenantId, extension)
    if (!userId) return
    // A call held for someone without a window: their browsers are woken (not awaited: the stream goes on).
    if (event.type === 'call.wake') {
      wake(tenantId, userId, event.payload)
      return
    }
    // A colleague of the group answered the call this person was woken for: their notifications say so.
    if (event.type === 'call.taken') {
      wokenOver(tenantId, userId, event.payload.call.id, { reason: 'taken', by: event.payload.by })
      // Their phone rang for it: the subscribers' call.ringing ends, answered elsewhere.
      for (const e of webhookEventsFor(tenantId, userId, extension, event)) void publish(tenantId, e)
      return
    }
    // The call no longer waits for this person: answered (on one of their browsers), or over. Nobody answered: the
    // notification of the call becomes that of a missed call.
    if (woken.size && (event.type === 'call.connected' || event.type === 'call.ended' || event.type === 'call.failed')) {
      const { call } = event.payload
      wokenOver(tenantId, userId, call.id, event.type === 'call.connected' ? { reason: 'answered' } : call.state === 'missed' ? { reason: 'missed' } : { reason: 'over' })
    }
    if (event.type === 'presence.changed') {
      const mapped: TelephonyEvent = { ...event, payload: { ...event.payload, userId, extension } }
      presencesOf(tenantId).set(extension, { userId, presence: event.payload.presence })
      bus.broadcast(tenantId, mapped)
      // Each Gateway hears it: told once, when the status changed (never for a new message alone), by the one that
      // holds the lease of the changes of state.
      publishPresence(tenantId, userId, extension, event.payload.presence.status)
      return
    }
    trackOwner(tenantId, userId, event)
    // Recorded before it is told: the app reloads its history when it hears that a call ended. A database that
    // hangs holds the tenant's events for a few seconds at most, not for good.
    const entry = historyEntryFor(tenantId, userId, event)
    if (entry) await within(store.addHistory(entry), historyWriteMs, 'history write').catch(err => app.log.error({ err, callId: entry.callId }, 'could not record call history'))
    bus.publish(tenantId, userId, event)
    // The subscribers (step 10a): what rang, was answered, ended or was missed for this person.
    for (const e of webhookEventsFor(tenantId, userId, extension, event)) void publish(tenantId, e)
  }
  // One change at a time per tenant to what its provider keeps for each person (presences, forwards): a restore
  // hands the store's state whole, and a choice written while it runs would be undone by it. The others wait, for
  // turnMaxMs at most: a provider whose database hangs (its queries have their own bound) holds nobody for good.
  const turns = new Map<string, Promise<unknown>>()
  const inTurn = <T>(tenantId: string, run: () => Promise<T>): Promise<T> => {
    const previous = turns.get(tenantId)
    let waited: Promise<unknown> = Promise.resolve()
    if (previous) {
      let timer: ReturnType<typeof setTimeout> | undefined
      waited = Promise.race([previous, new Promise(resolve => (timer = setTimeout(resolve, turnMaxMs)))]).finally(() => clearTimeout(timer))
    }
    const next = waited.then(run)
    const settled = next.catch(() => undefined)
    turns.set(tenantId, settled)
    void settled.then(() => {
      if (turns.get(tenantId) === settled) turns.delete(tenantId)
    })
    return next
  }
  // What each person chose (absent, "do not disturb" until a date) is the store's: handed to the provider when it
  // starts, and again once the mappings changed, so that a restart forgets nothing and nobody inherits someone
  // else's choice, or rules, with their extension (who holds which extension goes first: syncExtensions).
  // One restore at a time per tenant, retried until it holds: a change heard while one runs (or waits to retry) asks
  // it for one more round, with the mappings as they are then.
  let closing = false
  const restoring = new Map<string, { again: boolean }>()
  const restoreOnce = (tenantId: string, provider: TelephonyProvider) =>
    inTurn(tenantId, async () => {
      if (provider.syncExtensions) await provider.syncExtensions((await store.listMappings(tenantId)).map(m => ({ extension: m.extension, userId: m.userId, ...(m.displayName ? { displayName: m.displayName } : {}) })))
      await purgeLeavers(tenantId)
      await wakeable(tenantId, provider)
      const entries = await Promise.all(
        (await store.listUserPresences(tenantId)).map(async r => ({ user: await dir.forUser(tenantId, r.userId), presence: presenceOfRecord(r) }))
      )
      if (provider.restorePresences) await provider.restorePresences(entries)
      else for (const e of entries) await provider.setPresence(e.user, e.presence)
    })
  const restorePresences = async (tenantId: string, provider: TelephonyProvider): Promise<void> => {
    const running = restoring.get(tenantId)
    if (running) {
      running.again = true
      return
    }
    const state = { again: true }
    restoring.set(tenantId, state)
    let attempt = 0
    try {
      while (state.again && !closing) {
        state.again = false
        try {
          await restoreOnce(tenantId, provider)
          attempt = 0
        } catch (err) {
          if (closing) return
          state.again = true
          const delay = RESTORE_RETRY_MS[Math.min(attempt++, RESTORE_RETRY_MS.length - 1)]!
          app.log.error({ err, tenantId }, `chosen presences not handed to the provider, retrying in ${delay / 1000} s`)
          await new Promise(resolve => setTimeout(resolve, delay).unref())
        }
      }
    } finally {
      restoring.delete(tenantId)
    }
  }
  const started = new Map<string, TelephonyProvider>()
  // The trunks and direct numbers the store keeps (step 6, ADR 0016): handed to the provider when it starts, in the
  // tenant's turn, retried until it holds (its database may be late). What it already has is not written again.
  const trunksFor = async (tenantId: string) => ({ trunks: providerTrunks(await store.listTrunks(tenantId), options.secretsKey), dids: (await store.listDids(tenantId)).map(publicDid) })
  const restoreTrunks = async (tenantId: string, provider: TelephonyProvider) => {
    if (!provider.setTrunks) return
    for (let attempt = 0; !closing; attempt++) {
      try {
        await inTurn(tenantId, async () => {
          const { trunks, dids } = await trunksFor(tenantId)
          await provider.setTrunks!(trunks, dids)
        })
        return
      } catch (err) {
        if (closing) return
        const delay = RESTORE_RETRY_MS[Math.min(attempt, RESTORE_RETRY_MS.length - 1)]!
        app.log.error({ err, tenantId }, `trunks not handed to the provider, retrying in ${delay / 1000} s`)
        await new Promise(resolve => setTimeout(resolve, delay).unref())
      }
    }
  }
  // The outbound rules the store keeps (step 6b, ADR 0017): handed to the provider when it starts, as the trunks; none
  // kept, the empty ones (no profile, no cap, the default thresholds).
  const outboundFor = async (tenantId: string): Promise<Outbound> => {
    const r = await store.getOutbound(tenantId)
    return r ? { policy: r.policy, profiles: r.profiles, assignments: r.assignments } : EMPTY_OUTBOUND
  }
  const restoreOutbound = async (tenantId: string, provider: TelephonyProvider) => {
    if (!provider.setOutboundPolicy) return
    for (let attempt = 0; !closing; attempt++) {
      try {
        if (!(await provider.getCapabilities()).outboundPolicy) return
        // In the store's turn for these rules: a change another Gateway makes meanwhile is handed after this one.
        await inTurn(tenantId, () => store.holdOutbound(tenantId, o => provider.setOutboundPolicy!(o.policy, o.profiles, o.assignments)))
        return
      } catch (err) {
        if (closing) return
        const delay = RESTORE_RETRY_MS[Math.min(attempt, RESTORE_RETRY_MS.length - 1)]!
        app.log.error({ err, tenantId }, `outbound rules not handed to the provider, retrying in ${delay / 1000} s`)
        await new Promise(resolve => setTimeout(resolve, delay).unref())
      }
    }
  }
  // Web Push (ADR 0015). Who can be woken: the holders of an extension with at least one browser subscribed, when
  // the Gateway can send pushes; written where the provider holds calls for them (always in the tenant's turn).
  const push = options.push
  push?.useLogger(app.log)
  /**
   * The people of the tenant who no longer hold an extension lose their browsers' subscriptions (they left), at the
   * first reconciliation once they have been without one for the grace period (since this Gateway first found them
   * so): an extension missing a moment (taken back then given again, moved in two synchronisations) loses nothing.
   */
  const purgeGraceMs = options.pushPurgeGraceMs ?? PUSH_PURGE_GRACE_MS
  /** Since when each person with a subscription was found holding no extension (by ownerKey). */
  const withoutExtension = new Map<string, number>()
  const purgeLeavers = async (tenantId: string) => {
    if (!push) return
    const holders = new Set((await store.listMappings(tenantId)).map(m => m.userId))
    const now = Date.now()
    const users = await store.listPushUsers(tenantId)
    for (const key of withoutExtension.keys()) if (key.startsWith(`${tenantId}\u0000`) && !users.some(u => ownerKey(tenantId, u) === key)) withoutExtension.delete(key)
    for (const userId of users) {
      const key = ownerKey(tenantId, userId)
      if (holders.has(userId)) {
        withoutExtension.delete(key)
        continue
      }
      const since = withoutExtension.get(key)
      if (since === undefined) {
        withoutExtension.set(key, now)
        app.log.info({ tenantId, userId }, 'someone with push subscriptions holds no extension: removed at a reconciliation after the grace period if still so')
        continue
      }
      if (now - since < purgeGraceMs) continue
      for (const s of await store.listPushSubscriptions(tenantId, userId)) await store.deletePushSubscription(tenantId, userId, s.endpoint)
      withoutExtension.delete(key)
      app.log.info({ tenantId, userId }, 'push subscriptions of someone who holds no extension any more removed')
    }
  }
  const wakeable = async (tenantId: string, provider: TelephonyProvider) => {
    if (!provider.setWakeable) return
    const users = push && (await push.publicKey()) ? new Set(await store.listPushUsers(tenantId)) : new Set<string>()
    await provider.setWakeable(users.size ? (await store.listMappings(tenantId)).filter(m => users.has(m.userId)).map(m => ({ extension: m.extension, userId: m.userId })) : [])
  }
  /** One person's line of `wakeable`: whether they can be woken now, the others untouched. */
  const wakeableOne = async (tenantId: string, provider: TelephonyProvider, userId: string) => {
    if (!provider.setWakeableOne) return wakeable(tenantId, provider)
    const mapping = await store.getMappingByUser(tenantId, userId)
    if (!mapping) return
    const on = !!push && !!(await push.publicKey()) && (await store.listPushSubscriptions(tenantId, userId)).length > 0
    await provider.setWakeableOne({ extension: mapping.extension, userId }, on)
  }
  /** Browsers their push service says are gone: their people may no longer be wakeable. */
  const forgetGone = (gone: { tenantId: string; userId: string }[]) => {
    for (const { tenantId, userId } of gone) {
      const provider = started.get(tenantId)
      if (provider) void inTurn(tenantId, () => wakeableOne(tenantId, provider, userId)).catch(err => app.log.error({ err, tenantId }, 'who can be woken not handed to the provider'))
    }
  }
  const sendPush = async (tenantId: string, userId: string, message: PushMessage, ttlSec: number) => {
    if (!push) return
    const { gone } = await push.notify(tenantId, userId, message, ttlSec)
    forgetGone(gone)
  }
  /**
   * The calls each person is being woken for, by tenant, person and call: what their notification shows, whether it
   * was sent, and the pushes about it in order (the end of a call never overtakes its ringing). Set as soon as the
   * provider says so, before anything is read: an end that comes meanwhile is not missed.
   */
  type Shown = Omit<Extract<PushMessage, { type: 'call' }>, 'type' | 'until'>
  const woken = new Map<string, { shown: Shown; sent: boolean; over: boolean; chain: Promise<void> }>()
  const wokenKey = (tenantId: string, userId: string, callId: string) => `${tenantId}\u0000${userId}\u0000${callId}`
  const nameOf = async (tenantId: string, extension: string) => (await within(store.getMappingByExtension(tenantId, extension), historyWriteMs, 'name').catch(() => null))?.displayName?.slice(0, 64)
  const wake = (tenantId: string, userId: string, { call, waitSec, group }: Extract<TelephonyEvent, { type: 'call.wake' }>['payload']) => {
    if (!push) return
    const k = wokenKey(tenantId, userId, call.id)
    if (woken.has(k)) return
    const entry = { shown: { callId: call.id, number: call.remoteNumber } as Shown, sent: false, over: false, chain: Promise.resolve() }
    woken.set(k, entry)
    // Forgotten if its end never comes.
    setTimeout(() => woken.delete(k), (waitSec + 600) * 1000).unref()
    const until = Date.now() + waitSec * 1000
    entry.chain = (async () => {
      // The caller's name and the group's, as the directory gives them: what the notification shows, nothing more.
      const [name, groupName] = await Promise.all([
        nameOf(tenantId, call.remoteNumber),
        group ? within((async () => (await started.get(tenantId)?.listGroups?.())?.find(g => g.number === group)?.name)(), historyWriteMs, 'group name').catch(() => undefined) : undefined
      ])
      entry.shown = { ...entry.shown, ...(name ? { name } : {}), ...(group ? { group: { number: group, ...(groupName ? { name: groupName } : {}) } } : {}) }
      // Over already (the caller hung up while the names were read): no call to answer is shown.
      if (entry.over) return
      entry.sent = true
      await sendPush(tenantId, userId, { type: 'call', ...entry.shown, until }, waitSec)
    })().catch(err => app.log.error({ err, tenantId }, 'push for a call not sent'))
  }
  /**
   * The call `callId` no longer waits for this person: their browsers' notification is replaced, after its ringing.
   * Missed: a missed call (sent even if the ringing never was). Otherwise only where the ringing was shown: answered
   * (by them, on one of their browsers), taken (by `by`, a colleague of the group), over.
   */
  const wokenOver = (tenantId: string, userId: string, callId: string, end: { reason: 'answered' | 'missed' | 'over' } | { reason: 'taken'; by: string }) => {
    const k = wokenKey(tenantId, userId, callId)
    const entry = woken.get(k)
    if (!entry) return
    woken.delete(k)
    entry.over = true
    entry.chain = entry.chain
      .then(async () => {
        if (end.reason === 'missed') return sendPush(tenantId, userId, { type: 'missed', ...entry.shown }, MISSED_TTL_SEC)
        if (!entry.sent) return
        const by = end.reason === 'taken' ? { number: end.by, ...(await nameOf(tenantId, end.by).then(name => (name ? { name } : {}))) } : undefined
        return sendPush(tenantId, userId, { type: 'ended', ...entry.shown, reason: end.reason, ...(by ? { by } : {}) }, ENDED_TTL_SEC)
      })
      .catch(err => app.log.error({ err, tenantId }, 'push for the end of a call not sent'))
  }
  // A synchronisation that changed who holds which extension: the provider hears it at once.
  options.directorySync?.onChange(tenantId => {
    const provider = started.get(tenantId)
    if (provider) void restorePresences(tenantId, provider)
    // Extensions given to someone else, or to nobody: what was heard of them before is forgotten.
    void checkedPresences(tenantId).catch((err: unknown) => app.log.error({ err, tenantId }, 'presences not checked against the directory'))
  })
  registry.onCreate = (tenantId, provider) => {
    started.set(tenantId, provider)
    void restorePresences(tenantId, provider)
    void restoreTrunks(tenantId, provider)
    void restoreOutbound(tenantId, provider)
    void (async () => {
      for await (const { extension, event } of provider.subscribe()) {
        try {
          await deliver(tenantId, extension, event)
        } catch (err) {
          app.log.error({ err, tenantId, type: event.type }, 'provider event not delivered')
        }
      }
    })().catch(err => app.log.error({ err }, 'provider event stream failed'))
  }
  // The alerts past their retention go every hour (and once at start), whoever they belong to (step 6b). With them,
  // what erasures and changes of hands keep past OPERATOR_KEPT_MS, with an operator or not (third review 10b, n°3).
  const purgeAlerts = () =>
    Promise.all([
      store.purgeAlerts(new Date(Date.now() - ALERT_RETENTION_DAYS * 86_400_000).toISOString()).then(
        n => {
          if (n) app.log.info({ purged: n }, 'alerts past their retention removed')
        },
        err => app.log.error({ err }, 'alerts not purged')
      ),
      store.purgeErasures(new Date(Date.now() - OPERATOR_KEPT_MS).toISOString()).then(
        n => {
          if (n) app.log.info({ purged: n }, 'erasures and changes of hands past their days removed')
        },
        err => app.log.error({ err }, 'erasures not purged')
      )
    ])
  const alertPurge = setInterval(() => void purgeAlerts(), options.alertPurgeIntervalMs ?? 3_600_000)
  alertPurge.unref()
  /**
   * How a tenant's trunks are doing (step 7), as its SIP server says: one read for every reader within
   * trunkStatusCacheMs (the screens open, the watch of step 10a), the reads under way included; a failure is logged
   * when it starts and when it ends, not at every read. `available`: false when the provider cannot say or did not.
   */
  const trunkStatusOf = (tenantId: string, provider: TelephonyProvider): Promise<{ available: boolean; items: TrunkStatus[] }> => {
    const kept = trunkStatus.get(tenantId)
    if (kept && Date.now() - kept.at < trunkStatusMs) return kept.answer
    const answer = (async () => {
      try {
        const items = await provider.getTrunkStatus!()
        if (trunkStatusFailing.delete(tenantId)) app.log.info({ tenantId }, 'trunks: the SIP server says how they are doing again')
        return items ? { available: true, items } : { available: false, items: [] }
      } catch (err) {
        if (!trunkStatusFailing.has(tenantId)) {
          trunkStatusFailing.add(tenantId)
          app.log.warn({ err, tenantId }, 'trunks: the SIP server did not say how they are doing')
        }
        return { available: false, items: [] }
      }
    })()
    trunkStatus.set(tenantId, { at: Date.now(), answer })
    return answer
  }
  // The operator of the trunks (step 10b, ADR 0021): what is kept in step with it, by the Gateway that leads.
  const remoteKey = erasedRemoteKey(options.secretsKey)
  const operatorSync = options.operators?.size
    ? new OperatorSync({
        store,
        operators: options.operators,
        ...(hub ? { leading: () => hub.leading } : {}),
        ...(options.operatorSyncMs ? { everyMs: options.operatorSyncMs } : {}),
        ...(options.operatorSettleMs !== undefined ? { settleMs: options.operatorSettleMs } : {}),
        ...(remoteKey ? { remoteKey } : {}),
        restorable: restoreRefusalOf(store),
        logger: app.log
      })
    : undefined
  // trunk.degraded (step 10a, ADR 0020): the trunks of the tenants served, read on a schedule, from what the SIP server
  // already says of them (registration, servers probed).
  const trunkWatch =
    hub && options.trunkWatchMs !== 0
      ? new TrunkWatch({
          leading: () => hub.leading,
          publishChange: (...args) => hub.publishChange(...args),
          tenants: () => [...started.keys()],
          read: async tenantId => {
            const provider = started.get(tenantId)
            if (!provider?.getTrunkStatus || !(await provider.getCapabilities()).trunks) return undefined
            const status = await trunkStatusOf(tenantId, provider)
            return status.available ? status.items : undefined
          },
          names: async tenantId => new Map((await store.listTrunks(tenantId)).map(t => [t.id, t.config.name])),
          told: tenantId => store.listWebhookStates(tenantId, 'trunk:'),
          // Step 10b: whether its fallback is set at the operator (the callers reach it while the trunk is out).
          ...(operatorSync ? { fallback: (tenantId: string, trunkId: string) => operatorSync.fallbackOf(tenantId, trunkId) } : {}),
          ...(options.trunkWatchMs ? { everyMs: options.trunkWatchMs } : {}),
          ...(options.trunkWatchConfirm ? { confirm: options.trunkWatchConfirm } : {}),
          logger: app.log
        })
      : undefined
  // This Gateway tells the changes of state from now on (all tenants), or hears the events of some tenants again
  // (those only): what changed while another one told them (or nobody, the lease lapsing) is told now, each presence
  // it knows, still of the person it was heard for, compared to what was told. A person of whom nothing is kept is
  // neither written nor told (nothing changed for the subscribers: they never heard of them, or they were erased). By
  // batches: the API and the queue keep their share of the database meanwhile.
  hub?.onLead(async tenants => {
    for (const tenantId of tenants ?? [...started.keys()]) {
      const all = await checkedPresences(tenantId)
      for (let i = 0; i < all.length; i += PRESENCE_BATCH) {
        if (closing || !hub.leading) return
        await Promise.all(all.slice(i, i + PRESENCE_BATCH).map(p => tellPresence(tenantId, p.userId, p.extension, p.status, true)))
      }
    }
  })
  app.addHook('onReady', async () => {
    void purgeAlerts()
    hub?.start()
    trunkWatch?.start()
    if (options.operatorSyncMs !== 0) operatorSync?.start()
  })
  app.addHook('onClose', async () => {
    closing = true
    for (const { timer } of settling.values()) clearTimeout(timer)
    settling.clear()
    clearInterval(alertPurge)
    trunkWatch?.stop()
    // Its round under way ends first: the store is closed after (review 10b, n°25).
    await operatorSync?.stop()
    await hub?.stop()
    await registry.closeAll()
    await store.close()
  })

  app.get('/health', async () => ({ status: 'ok' }))
  // Ready while every provider can place calls: DEGRADED (events lost, calls still going through) says so in the
  // body without taking the Gateway out of service.
  app.get('/ready', async (_req, reply) => {
    const providers = registry.all()
    const statuses = providers.map(p => p.getStatus())
    const ready = statuses.every(s => s === 'CONNECTED' || s === 'DEGRADED')
    const degraded = statuses.filter(s => s === 'DEGRADED').length
    // Why, in the providers' few words (no addresses): the details are in the log.
    const reasons = [...new Set(providers.flatMap(p => (p.getStatus() === 'CONNECTED' ? [] : [p.getStatusReason?.()])).filter((r): r is string => !!r))]
    return reply.code(ready ? 200 : 503).send({ ready, ...(degraded ? { degraded } : {}), ...(reasons.length ? { reasons } : {}) })
  })
  app.get('/openapi.json', async () => app.swagger())

  const resolve = async (identity: Identity): Promise<User> => dir.forUser(identity.tenantId, identity.userId, identity.displayName)

  app.register(
    async v1 => {
      const whoIs = async (req: FastifyRequest) => resolve(await auth.authenticate(req))
      const who = async (req: FastifyRequest) => {
        const user = await whoIs(req)
        return { user, provider: registry.forTenant(user.tenantId) }
      }
      // In a turn, before a change for `user`: the extension resolved with the request is still theirs. A
      // synchronisation that gave it to someone else in between ran its restore first: writing now would give the
      // new holder the old one's rules.
      const stillHolds = async (user: User) => {
        const now = await dir.forUser(user.tenantId, user.id)
        if (now.extension !== user.extension) throw Object.assign(new Error('The extension of this user changed, try again'), { statusCode: 409 })
      }

      // features tells the app what this platform offers, so it never has to probe an endpoint to find out.
      v1.get('/me', async req => {
        const identity = await auth.authenticate(req)
        const user = await resolve(identity)
        return { ...user, features: { directory: hasDirectory(user), admin: isAdmin(identity, admin) } }
      })
      v1.get('/me/endpoints', async req => (await whoIs(req), [BROWSER_ENDPOINT]))

      // Media plane: how a browser endpoint reaches the infrastructure. Control stays on the REST API.
      v1.get('/me/media-session', async req => {
        const { user, provider } = await who(req)
        if (!isMediaProvider(provider)) return { type: 'external' }
        return provider.getSession(user, BROWSER_ENDPOINT)
      })

      v1.get('/capabilities', async req => {
        const { user, provider } = await who(req)
        const caps = await provider.getCapabilities()
        const enabled = !!options.conference?.bridge(user.tenantId)
        return { ...caps, conference: { dialIn: enabled, dialOut: enabled } }
      })

      // What the others see, and what the person chose (`choice`: kept in the store, with its end and message).
      const presenceOf = async (user: User, provider: TelephonyProvider) => {
        const [presence, choice] = await Promise.all([provider.getPresence(user), store.getUserPresence(user.tenantId, user.id)])
        return { ...presence, ...(choice ? { choice: publicChoice(choice) } : {}) }
      }
      v1.get('/me/presence', async req => {
        const { user, provider } = await who(req)
        return presenceOf(user, provider)
      })

      // A status, with an end and a message for an absence or a "do not disturb" (`until`, `message`). The provider
      // applies it first (a "do not disturb" refuses or forwards calls while it lasts): stored only once it holds.
      v1.put('/me/presence', async req => {
        const { user, provider } = await who(req)
        const { status, until, message } = parsePresence(req.body)
        await inTurn(user.tenantId, async () => {
          await stillHolds(user)
          const since = new Date().toISOString()
          await provider.setPresence(user, { status, source: 'user', since, ...(until ? { until } : {}), ...(message ? { message } : {}) })
          if (status === 'available') await store.deleteUserPresence(user.tenantId, user.id)
          else await store.setUserPresence({ tenantId: user.tenantId, userId: user.id, status, since, ...(until ? { until } : {}), ...(message ? { message } : {}) })
        })
        // What the others see may differ (in a call, not registered): the provider's events say so.
        return presenceOf(user, provider)
      })

      // Notifications of calls while no window of the app is open (Web Push, ADR 0015): the key a browser subscribes
      // with, and its subscription, the person's own. Available when the Gateway has VAPID keys and the provider can
      // hold a call for someone without a window (capability `push`); a browser may always be forgotten.
      // Subscriptions given or removed per person: 20 a minute (the app gives one at each start, a click another).
      const pushChanges = options.pushSubscriptionLimiter ?? new RateLimiter(20, 60_000)
      const pushState = async (user: User, provider: TelephonyProvider) => {
        const publicKey = push && user.extension && (await provider.getCapabilities()).push ? await push.publicKey() : null
        return publicKey ? { available: true, publicKey, subscriptions: (await store.listPushSubscriptions(user.tenantId, user.id)).length } : { available: false, subscriptions: 0 }
      }
      v1.get('/me/push-subscriptions', async req => {
        const { user, provider } = await who(req)
        return pushState(user, provider)
      })
      v1.post('/me/push-subscriptions', async (req, reply) => {
        const { user, provider } = await who(req)
        withExtension(user)
        if (!push || !(await pushState(user, provider)).available) throw Object.assign(new Error('Notifications are not available on this platform'), { statusCode: 501 })
        // The app gives it again at each start: cheap when known, bounded when someone loops on it.
        if (!pushChanges.allow(ownerKey(user.tenantId, user.id))) return reply.code(429).send({ error: 'too many changes to notifications, slow down' })
        const sub = push.parseSubscription(req.body)
        await stillHolds(user)
        const saved = await push.subscribe(user.tenantId, user.id, sub)
        // Another tenant's browser stays theirs (knowing its address is no reason to take its calls).
        if (saved.outcome === 'refused') throw Object.assign(new Error('This browser subscription belongs to another organisation'), { statusCode: 409, code: 'PUSH_SUBSCRIPTION_TAKEN' })
        // Only this person's line of who can be woken, and that of whoever this browser was given by; written again
        // when the browser is known already (cheap: nothing changes when the line is right), so that a line lost
        // meanwhile (a database of the provider restored) comes back at the next start of the app. Taken from someone
        // the store cannot name (another request saved it at the same moment): the whole tenant.
        await inTurn(user.tenantId, async () => {
          if (saved.outcome === 'moved' && !saved.previousUserId) return wakeable(user.tenantId, provider)
          await wakeableOne(user.tenantId, provider, user.id)
          if (saved.previousUserId) await wakeableOne(user.tenantId, provider, saved.previousUserId)
        })
        return reply.code(201).send(await pushState(user, provider))
      })
      v1.delete('/me/push-subscriptions', async (req, reply) => {
        const { user, provider } = await who(req)
        if (!pushChanges.allow(ownerKey(user.tenantId, user.id))) return reply.code(429).send({ error: 'too many changes to notifications, slow down' })
        const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint
        if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1024) throw bad('invalid endpoint')
        if (await store.deletePushSubscription(user.tenantId, user.id, endpoint)) await inTurn(user.tenantId, () => wakeableOne(user.tenantId, provider, user.id))
        return reply.code(204).send()
      })

      // Where the person's calls go instead of ringing them (capability `forwarding`). Replaced as a whole.
      const forwardingOf = (provider: TelephonyProvider) => {
        if (!provider.getForwarding || !provider.setForwarding) throw Object.assign(new Error('Forwarding is not available on this platform'), { statusCode: 501 })
        return { get: provider.getForwarding.bind(provider), set: provider.setForwarding.bind(provider) }
      }
      const withExtension = (user: User) => {
        if (!user.extension) throw Object.assign(new Error('No extension is assigned to this user'), { statusCode: 404 })
        return user
      }
      v1.get('/me/forwarding', async req => {
        const { user, provider } = await who(req)
        return forwardingOf(provider).get(withExtension(user))
      })
      v1.put('/me/forwarding', async req => {
        const { user, provider } = await who(req)
        const forwarding = forwardingOf(provider)
        const rules = await parseForwarding(req.body, withExtension(user), async target => !!(await store.getMappingByExtension(user.tenantId, target)))
        await inTurn(user.tenantId, async () => {
          await stillHolds(user)
          await forwarding.set(user, rules)
        })
        return forwarding.get(user)
      })

      // The presence of everyone in the caller's tenant, by extension, as the provider's events built it. Only when
      // the provider tells presences as they change (`realtime`): otherwise a directory shows none, rather than
      // everyone offline.
      v1.get('/presence', async req => {
        const { user, provider } = await who(req)
        const realtime = (await provider.getCapabilities()).presence.realtime
        return {
          realtime,
          items: realtime ? [...presencesOf(user.tenantId).entries()].map(([extension, { userId, presence }]) => ({ extension, userId, presence })) : []
        }
      })

      v1.post<{ Body: { target: string } }>('/calls', async (req, reply) => {
        const { user, provider } = await who(req)
        // TODO: E.164 validation, dialing policies, audit log.
        const call = await provider.originate({ user, target: req.body.target, idempotencyKey: req.headers['idempotency-key'] as string | undefined })
        const owners = callOwners.get(call.id) ?? new Set<string>()
        owners.add(ownerKey(user.tenantId, user.id))
        callOwners.set(call.id, owners)
        return reply.code(201).send(call)
      })

      // History of the caller only: tenant and user come from the authenticated identity, never from the request.
      v1.get<{ Querystring: Record<string, string | undefined> }>('/calls/history', async req => {
        const user = await whoIs(req)
        const page = await store.listHistory(user.tenantId, user.id, parseHistoryQuery(req.query))
        return { items: page.items.map(publicEntry), ...(page.next ? { next: page.next } : {}) }
      })

      // The organisation's directory, and the caller's favourites in it. Tenant and user come from the identity.
      const directoryFor = (user: User) => {
        const d = options.contacts
        if (!d || (d.servesTenant && !d.servesTenant(user.tenantId))) throw Object.assign(new Error('No directory configured'), { statusCode: 501 })
        return d
      }
      const hasDirectory = (user: User) => !!options.contacts && (!options.contacts.servesTenant || options.contacts.servesTenant(user.tenantId))
      // What the directory says is relayed; how it failed is not: its address, schema and error codes stay in the log.
      const lookup = async <T>(req: FastifyRequest, run: () => Promise<T>): Promise<T> => {
        try {
          return await run()
        } catch (err) {
          req.log.error({ err }, 'directory lookup failed')
          throw Object.assign(new Error('Directory unavailable'), { statusCode: 503 })
        }
      }
      const contactId = (id: string) => {
        if (!id || id.length > MAX_CONTACT_ID) throw bad('invalid contact id')
        return id
      }
      const searches = options.directorySearchLimiter ?? new RateLimiter(30, 10_000)
      v1.get<{ Querystring: { q?: string; limit?: string } }>('/directory', async (req, reply) => {
        const user = await whoIs(req)
        const q = (req.query.q ?? '').trim()
        if (q.length > MAX_QUERY) throw bad('query too long')
        const limit = req.query.limit ? Number(req.query.limit) : 20
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH) throw bad('invalid limit')
        const directory = directoryFor(user)
        if (!q) return { items: [], truncated: false }
        if (!searches.allow(ownerKey(user.tenantId, user.id))) return reply.code(429).send({ error: 'too many searches, slow down' })
        return lookup(req, () => directory.search(user.tenantId, q, limit))
      })
      v1.get<{ Params: { id: string } }>('/directory/:id', async req => {
        const user = await whoIs(req)
        const directory = directoryFor(user)
        const [contact] = await lookup(req, () => directory.getMany(user.tenantId, [contactId(req.params.id)]))
        if (!contact) throw Object.assign(new Error('Contact not found'), { statusCode: 404 })
        return contact
      })
      v1.get('/me/favorites', async req => {
        const user = await whoIs(req)
        // Without a directory there is nothing to resolve the ids against: an empty list, not an error on every start.
        if (!hasDirectory(user)) return { items: [] }
        const ids = await store.listFavorites(user.tenantId, user.id)
        return { items: ids.length ? await lookup(req, () => options.contacts!.getMany(user.tenantId, ids)) : [] }
      })
      v1.put<{ Params: { id: string } }>('/me/favorites/:id', async (req, reply) => {
        const user = await whoIs(req)
        const id = contactId(req.params.id)
        const directory = directoryFor(user)
        const current = await store.listFavorites(user.tenantId, user.id)
        if (!current.includes(id) && current.length >= MAX_FAVORITES) throw Object.assign(new Error(`At most ${MAX_FAVORITES} favourites`), { statusCode: 409 })
        // Only someone the directory knows can be a favourite: no stray ids in the store.
        if ((await lookup(req, () => directory.getMany(user.tenantId, [id]))).length === 0) throw Object.assign(new Error('Contact not found'), { statusCode: 404 })
        await store.addFavorite(user.tenantId, user.id, id)
        return reply.code(204).send()
      })
      v1.delete<{ Params: { id: string } }>('/me/favorites/:id', async (req, reply) => {
        const user = await whoIs(req)
        await store.removeFavorite(user.tenantId, user.id, contactId(req.params.id))
        return reply.code(204).send()
      })

      // Administration: the directory source and its synchronisation into the mappings. Administrators only.
      const administrator = async (req: FastifyRequest) => {
        const identity = await auth.authenticate(req)
        if (!isAdmin(identity, admin)) throw Object.assign(new Error('Administrators only'), { statusCode: 403 })
        return resolve(identity)
      }
      v1.get('/admin/directory', async req => {
        const user = await administrator(req)
        const directory = directoryFor(user)
        const sync = options.directorySync
        return {
          source: directory.describe?.() ?? { type: 'unknown' },
          sync: sync ? { available: true, ...sync.status() } : { available: false, running: false }
        }
      })
      v1.post('/admin/directory/sync', async (req, reply) => {
        const user = await administrator(req)
        directoryFor(user)
        const sync = options.directorySync
        if (!sync) throw Object.assign(new Error('This directory cannot be synchronised'), { statusCode: 501 })
        if (sync.status().running) return reply.code(409).send({ error: 'a synchronisation is already running' })
        // A large directory takes a while: the run goes on in the background, GET /admin/directory follows it.
        void sync.run()
        return reply.code(202).send(sync.status())
      })

      // Simultaneous ring groups (capability `groups`): administrators only, one change at a time per tenant (with
      // the presences and forwards: the same provider database). A group number is never an extension: the check
      // and the write happen while no directory synchronisation runs (which refuses to give a group's number away
      // either), so neither can slip between the other's check and write.
      const groupsOf = (provider: TelephonyProvider) => {
        if (!provider.listGroups || !provider.setGroup || !provider.deleteGroup) throw Object.assign(new Error('Call groups are not available on this platform'), { statusCode: 501 })
        return { list: provider.listGroups.bind(provider), set: provider.setGroup.bind(provider), remove: provider.deleteGroup.bind(provider) }
      }
      const exclusive = <T>(tenantId: string, fn: () => Promise<T>) => {
        const sync = options.directorySync
        return sync ? sync.exclusive(() => inTurn(tenantId, fn)) : inTurn(tenantId, fn)
      }
      const isExtensionOf = (tenantId: string) => async (extension: string) => !!(await store.getMappingByExtension(tenantId, extension))
      v1.get('/admin/groups', async req => {
        const user = await administrator(req)
        const groups = await groupsOf(registry.forTenant(user.tenantId)).list()
        // Members nobody holds right now: they stay in the group (a position), with no window to ring.
        const held = new Set((await store.listMappings(user.tenantId)).map(m => m.extension))
        return { items: groups.map(g => ({ ...g, vacant: g.members.filter(m => !held.has(m)) })) }
      })
      v1.post<{ Body: { number?: unknown } | undefined }>('/admin/groups', async (req, reply) => {
        const user = await administrator(req)
        const groups = groupsOf(registry.forTenant(user.tenantId))
        const number = typeof req.body?.number === 'string' ? req.body.number.trim() : ''
        if (options.conference?.accessNumber && number === options.conference.accessNumber)
          throw refused('GROUP_NUMBER_RESERVED', `${number} is the access number of the meeting rooms`)
        const group = await exclusive(user.tenantId, async () => {
          const g = await parseGroup(number, req.body, isExtensionOf(user.tenantId))
          await groups.set(g, 'create')
          return g
        })
        return reply.code(201).send(group)
      })
      v1.put<{ Params: { number: string } }>('/admin/groups/:number', async req => {
        const user = await administrator(req)
        const groups = groupsOf(registry.forTenant(user.tenantId))
        return exclusive(user.tenantId, async () => {
          const current = (await groups.list()).find(g => g.number === req.params.number)
          if (!current) throw Object.assign(new Error('No such group'), { statusCode: 404 })
          const group = await parseGroup(req.params.number, req.body, isExtensionOf(user.tenantId), current.members)
          await groups.set(group, 'replace')
          return group
        })
      })
      v1.delete<{ Params: { number: string } }>('/admin/groups/:number', async (req, reply) => {
        const user = await administrator(req)
        const groups = groupsOf(registry.forTenant(user.tenantId))
        if (!(await inTurn(user.tenantId, () => groups.remove(req.params.number)))) throw Object.assign(new Error('No such group'), { statusCode: 404 })
        return reply.code(204).send()
      })

      // Trunks to an operator and their direct numbers (capability `trunks`, ADR 0016): administrators only, one change
      // at a time per tenant. The provider is handed the whole new set first (it checks it, writes what its SIP server
      // reads and has it reload), then the store keeps it. When either fails, the provider is handed the set it had
      // before (what it may have written in part goes), and the request fails: the store and the SIP server never
      // part. A password is never shown again.
      const trunksOf = (provider: TelephonyProvider) => {
        if (!provider.setTrunks) throw Object.assign(new Error('Trunks are not available on this platform'), { statusCode: 501 })
        return provider.setTrunks.bind(provider)
      }
      const notFound = (what: string) => Object.assign(new Error(`No such ${what}`), { statusCode: 404 })
      const changeTrunks = async (tenantId: string, apply: ReturnType<typeof trunksOf>, trunks: TrunkRecord[], dids: DidRange[], keep: () => Promise<unknown>) => {
        const before = await trunksFor(tenantId)
        const undo = (err: unknown) =>
          apply(before.trunks, before.dids).then(
            () => {
              throw err
            },
            (undoErr: unknown) => {
              app.log.error({ err: undoErr, tenantId }, 'trunks: the previous set could not be handed back to the provider')
              throw err
            }
          )
        await apply(providerTrunks(trunks, options.secretsKey), dids).catch(undo)
        await keep().catch(undo)
      }
      // A number rings an extension someone holds, or a ring group of the tenant: nothing else; so does a fallback. A
      // direct number may also aim at the access number of Meet's rooms (step 8), never a fallback.
      const checkTarget = async (tenantId: string, provider: TelephonyProvider, field: string, target: string | undefined, code: string) => {
        if (!target || (await store.getMappingByExtension(tenantId, target))) return
        if (code === 'DID_TARGET' && options.conference?.accessNumber && target === options.conference.accessNumber && options.conference.bridge(tenantId)) return
        if (provider.listGroups && (await provider.listGroups()).some(g => g.number === target)) return
        throw Object.assign(new Error(`${field}: ${target} is no extension nor ring group of this platform`), { statusCode: 400, code })
      }
      v1.get('/admin/trunks', async req => {
        const user = await administrator(req)
        trunksOf(registry.forTenant(user.tenantId))
        return { items: (await store.listTrunks(user.tenantId)).map(publicTrunk) }
      })
      // How each trunk is doing now (step 7): its registration and servers, as the SIP server says. `available`: false
      // when the provider cannot say (no control channel) or did not answer (logged): the screen says it does not know.
      v1.get('/admin/trunks/status', async req => {
        const user = await administrator(req)
        const provider = registry.forTenant(user.tenantId)
        trunksOf(provider)
        if (!provider.getTrunkStatus) return { available: false, items: [] }
        return trunkStatusOf(user.tenantId, provider)
      })
      v1.put<{ Params: { id: string } }>('/admin/trunks/:id', async (req, reply) => {
        const user = await administrator(req)
        const apply = trunksOf(registry.forTenant(user.tenantId))
        const id = req.params.id
        if (!TRUNK_ID.test(id)) throw Object.assign(new Error('id: lower case letters, digits and dashes, 32 at most'), { statusCode: 400, code: 'TRUNK_INVALID' })
        const { record, created, before } = await inTurn(user.tenantId, async () => {
          const records = await store.listTrunks(user.tenantId)
          const current = records.find(t => t.id === id)
          if (!current && records.length >= MAX_TRUNKS) throw Object.assign(new Error(`At most ${MAX_TRUNKS} trunks`), { statusCode: 409, code: 'TRUNK_LIMIT' })
          const parsed = parseTrunk(req.body, current)
          // The default trunk stays so unless another one is made the default: a change that does not say `default`
          // keeps the mark; `default: false` on the default trunk is refused, it would hand the number of everyone
          // without a direct number (and their emergency calls) to another trunk without a word.
          const given = (req.body as Record<string, unknown>).default
          if (given === undefined && current?.config.default) parsed.config = { ...parsed.config, default: true }
          if (given === false && current && defaultTrunk(records)?.id === id)
            throw Object.assign(new Error('This is the default trunk: make another one the default instead'), { statusCode: 409, code: 'TRUNK_DEFAULT' })
          const dids = (await store.listDids(user.tenantId)).map(publicDid)
          await checkTarget(user.tenantId, registry.forTenant(user.tenantId), 'fallbackTarget', parsed.config.fallbackTarget, 'FALLBACK_TARGET')
          // Its fallback at the operator (step 10b): only with an operator, and never one of the organisation's own
          // direct numbers (the operator would forward a call to the number that could not be reached).
          const atOperator = parsed.config.operator?.fallback
          if (atOperator && !operatorSync?.serves(user.tenantId))
            throw Object.assign(new Error('operator.fallback: no operator is configured for this organisation: its fallback cannot be set there'), { statusCode: 409, code: 'OPERATOR_NONE' })
          if (atOperator?.number && inDids(dids, atOperator.number))
            throw Object.assign(new Error(`operator.fallback.number: ${atOperator.number} is one of the direct numbers of this platform`), { statusCode: 409, code: 'OPERATOR_FALLBACK_LOOP' })
          // Nor a line of a trunk at the operator, nor the number a trunk presents (review 10b, n°26): the same loop.
          const others = records.filter(t => t.id !== id)
          const own = [...others, { config: parsed.config }].flatMap(t => [...(t.config.operator?.lines ?? []).map(e164Of), ...(t.config.defaultNumber ? [e164Of(t.config.defaultNumber)] : [])])
          if (atOperator?.number && own.includes(e164Of(atOperator.number)))
            throw Object.assign(new Error(`operator.fallback.number: ${atOperator.number} is a line or the number of a trunk of this platform`), { statusCode: 409, code: 'OPERATOR_FALLBACK_LOOP' })
          // The other way round (second review 10b, n°7): its lines and its number are never the fallback another trunk keeps.
          const mine = [...(parsed.config.operator?.lines ?? []).map(e164Of), ...(parsed.config.defaultNumber ? [e164Of(parsed.config.defaultNumber)] : [])]
          const looping = others.find(t => t.config.operator?.fallback?.number && mine.includes(e164Of(t.config.operator.fallback.number)))
          if (looping)
            throw Object.assign(new Error(`${looping.config.operator!.fallback!.number} is the fallback trunk ${looping.id} keeps at the operator: it cannot be a line or the number of a trunk`), {
              statusCode: 409,
              code: 'OPERATOR_FALLBACK_LOOP'
            })
          // One fallback a line (review 10b, n°5): another trunk that keeps another one on a line of this one is refused.
          const shared = atOperator && others.find(t => t.config.operator?.fallback && askKey(t.config.operator.fallback) !== askKey(atOperator) && t.config.operator.lines.some(l => parsed.config.operator!.lines.includes(l)))
          if (shared)
            throw Object.assign(new Error(`operator.lines: trunk ${shared.id} keeps another fallback on ${shared.config.operator!.lines.filter(l => parsed.config.operator!.lines.includes(l)).join(', ')}: one fallback a line`), { statusCode: 409, code: 'OPERATOR_LINE_SHARED' })
          const record = trunkRecord(user.tenantId, id, parsed, current, options.secretsKey)
          // One default trunk: the one marked now, the others no longer.
          const unmark = (t: TrunkRecord): TrunkRecord => {
            const { default: _was, ...config } = t.config
            return { ...t, config }
          }
          const unmarked = record.config.default ? records.filter(t => t.id !== id && t.config.default).map(unmark) : []
          const updated = (t: TrunkRecord) => (t.id === id ? record : (unmarked.find(u => u.id === t.id) ?? t))
          const next = current ? records.map(updated) : [...records.map(updated), record]
          // The marks moved together, or not at all.
          await changeTrunks(user.tenantId, apply, next, dids, () => store.upsertTrunks([...unmarked, record]))
          return { record, created: !current, before: current }
        })
        // The state read before the change is no longer theirs: the screen reads it again at once.
        trunkStatus.delete(user.tenantId)
        // Its lines at the operator (step 10b), read, and its fallback set there, now: the screen says how it went
        // (GET /admin/operator). A failure leaves the trunk saved; the next round tries again. The lines it no longer
        // names lose the fallback it kept there (second review 10b, n°8), as owed until done (n°1).
        // What is owed still of those (third review 10b, n°11): 202 with it, as the deletions say it.
        const dropped = before?.config.operator?.fallback ? before.config.operator.lines.filter(l => !record.config.operator?.lines.includes(l)) : []
        const pending =
          operatorSync && (record.config.operator || before?.config.operator)
            ? await within(operatorSync.applyTrunk(user.tenantId, id, dropped), OPERATOR_APPLY_MS, 'operator').catch(async (err: unknown) => {
                req.log.warn({ err }, 'operator: the trunk not handed to the operator')
                return (await operatorSync.removals(user.tenantId)).filter(r => dropped.includes(r.line))
              })
            : []
        if (pending.length) return reply.code(202).send({ ...publicTrunk(record), pending })
        return reply.code(created ? 201 : 200).send(publicTrunk(record))
      })
      /** Removes the forwards of `lines` at the operator, and says what is owed still (all of them, past OPERATOR_APPLY_MS). */
      const removing = async (tenantId: string, lines: readonly string[], trunkId: string, log: FastifyRequest['log']): Promise<OperatorRemoval[]> =>
        within(operatorSync!.removeForwards(tenantId, lines, trunkId), OPERATOR_APPLY_MS, 'operator').catch(async (err: unknown) => {
          log.warn({ err }, 'operator: the forwards of the trunk not removed at the operator yet')
          return (await operatorSync!.removals(tenantId)).filter(r => lines.includes(r.line))
        })
      v1.delete<{ Params: { id: string } }>('/admin/trunks/:id', async (req, reply) => {
        const user = await administrator(req)
        const apply = trunksOf(registry.forTenant(user.tenantId))
        const gone = await inTurn(user.tenantId, async () => {
          const records = await store.listTrunks(user.tenantId)
          const current = records.find(t => t.id === req.params.id)
          if (!current) throw notFound('trunk')
          // The default trunk gives its number to everyone without a direct number: never changed without a word.
          if (records.length > 1 && defaultTrunk(records)?.id === req.params.id)
            throw Object.assign(new Error('This is the default trunk: make another one the default first'), { statusCode: 409, code: 'TRUNK_DEFAULT' })
          // Its direct numbers go with it.
          const dids = (await store.listDids(user.tenantId)).filter(d => d.trunkId !== req.params.id).map(publicDid)
          await changeTrunks(user.tenantId, apply, records.filter(t => t.id !== req.params.id), dids, () => store.deleteTrunk(user.tenantId, req.params.id))
          return current
        })
        trunkStatus.delete(user.tenantId)
        // The forwards it kept at the operator go with it (review 10b, n°13), where no other trunk keeps one: owed
        // until done, whatever became of it (second review n°1). Not done yet: 202, and what is owed.
        if (operatorSync && gone.config.operator) {
          const pending = gone.config.operator.fallback
            ? await removing(user.tenantId, gone.config.operator.lines, gone.id, req.log)
            : await within(operatorSync.applyTrunk(user.tenantId, gone.id), OPERATOR_APPLY_MS, 'operator').then(
                () => [],
                (err: unknown) => (req.log.warn({ err }, 'operator: the lines of the trunk not read at the operator'), [])
              )
          if (pending.length) return reply.code(202).send({ pending })
        }
        return reply.code(204).send()
      })
      // The fallback a trunk keeps at the operator removed there, on an administrator's word (review 10b, n°13): the
      // trunk no longer asks one, and the forwards of its lines go (those no other trunk keeps one on), read back,
      // whether the trunk asked one still or not (second review n°8: one left there). 200 once the operator has it;
      // 202 with what is owed still, done at the next rounds (n°1).
      v1.delete<{ Params: { id: string } }>('/admin/trunks/:id/operator/fallback', async (req, reply) => {
        const user = await administrator(req)
        const apply = trunksOf(registry.forTenant(user.tenantId))
        if (!operatorSync?.serves(user.tenantId)) throw Object.assign(new Error('No operator is configured for this organisation'), { statusCode: 409, code: 'OPERATOR_NONE' })
        const record = await inTurn(user.tenantId, async () => {
          const records = await store.listTrunks(user.tenantId)
          const current = records.find(t => t.id === req.params.id)
          if (!current) throw notFound('trunk')
          if (!current.config.operator) throw Object.assign(new Error('This trunk has no line at the operator'), { statusCode: 409, code: 'OPERATOR_NO_LINES' })
          if (!current.config.operator.fallback) return current
          const { fallback: _gone, ...operator } = current.config.operator
          const record: TrunkRecord = { ...current, config: { ...current.config, operator } }
          const dids = (await store.listDids(user.tenantId)).map(publicDid)
          await changeTrunks(user.tenantId, apply, records.map(t => (t.id === record.id ? record : t)), dids, () => store.upsertTrunks([record]))
          return record
        })
        const pending = await removing(user.tenantId, record.config.operator!.lines, record.id, req.log)
        return reply.code(pending.length ? 202 : 200).send({ trunk: publicTrunk(record), pending })
      })
      // The operator of the trunks (step 10b, ADR 0021), administrators only: whether there is one, each trunk's lines
      // there (their fallback as last read, whether it is as asked, when it was set or put back, how it failed), and
      // the records of calls of the last 7 days by what became of them (FR-D4: reconciled). `sync`: a round now (one
      // at a time, OPERATOR_SYNCS_PER_MINUTE a minute per tenant: each is requests to the operator).
      const operatorRate = (reply: FastifyReply) => reply.code(429).send({ statusCode: 429, code: 'OPERATOR_RATE', error: 'Too Many Requests', message: 'The operator was read a moment ago: wait a minute' })
      v1.get('/admin/operator', async req => {
        const user = await administrator(req)
        const status = operatorSync?.serves(user.tenantId) ? await operatorSync.status(user.tenantId) : undefined
        return status ? { configured: true, ...status } : { configured: false }
      })
      v1.post('/admin/operator/sync', async (req, reply) => {
        const user = await administrator(req)
        if (!operatorSync?.serves(user.tenantId)) throw Object.assign(new Error('No operator is configured for this organisation'), { statusCode: 409, code: 'OPERATOR_NONE' })
        // Counted in the store (every Gateway), and run by the Gateway that leads (review 10b, n°8).
        if (!(await store.takeOperatorQuota(user.tenantId, 'sync', 60_000, OPERATOR_SYNCS_PER_MINUTE))) return operatorRate(reply)
        // A round that failed, or did not end in time, is said (second review 10b, n°6): 502 or 504 OPERATOR_ROUND.
        const failed = await operatorSync.roundNow(user.tenantId, OPERATOR_ROUND_MS).then(
          () => undefined,
          (err: unknown) => {
            req.log.warn({ err }, 'operator: round not done')
            return err
          }
        )
        if (failed)
          return reply.code(failed instanceof OperatorRoundError && failed.timeout ? 504 : 502).send({
            statusCode: failed instanceof OperatorRoundError && failed.timeout ? 504 : 502,
            code: 'OPERATOR_ROUND',
            error: failed instanceof OperatorRoundError && failed.timeout ? 'Gateway Timeout' : 'Bad Gateway',
            message: failed instanceof OperatorRoundError && failed.timeout ? 'The operator was not read in time' : 'The operator could not be read'
          })
        return { configured: true, ...(await operatorSync.status(user.tenantId)) }
      })
      // A removal at the operator let go (third review 10b, n°4: a line the operator no longer has, keys without the
      // right to write it): nothing more is written there, what is there stays. 204, or 404 when none is owed.
      v1.delete<{ Params: { line: string } }>('/admin/operator/removals/:line', async (req, reply) => {
        const user = await administrator(req)
        if (!operatorSync?.serves(user.tenantId)) throw Object.assign(new Error('No operator is configured for this organisation'), { statusCode: 409, code: 'OPERATOR_NONE' })
        if (!(await operatorSync.abandonRemoval(user.tenantId, req.params.line))) throw notFound('removal')
        return reply.code(204).send()
      })
      // What is set at the operator on lines now, read only (review 10b, n°13): the screen shows it before a first
      // fallback replaces it. The lines as a trunk names them, MAX_OPERATOR_LINES at most.
      v1.post<{ Body: { lines?: unknown } }>('/admin/operator/lines', async (req, reply) => {
        const user = await administrator(req)
        if (!operatorSync?.serves(user.tenantId)) throw Object.assign(new Error('No operator is configured for this organisation'), { statusCode: 409, code: 'OPERATOR_NONE' })
        const lines = parseOperatorLines((req.body as { lines?: unknown } | undefined)?.lines)
        if (!(await store.takeOperatorQuota(user.tenantId, 'read', 60_000, OPERATOR_READS_PER_MINUTE))) return operatorRate(reply)
        return { items: await within(operatorSync.readLines(user.tenantId, lines), OPERATOR_APPLY_MS, 'operator') }
      })
      v1.get('/admin/dids', async req => {
        const user = await administrator(req)
        trunksOf(registry.forTenant(user.tenantId))
        return { items: (await store.listDids(user.tenantId)).map(publicDid) }
      })
      v1.put<{ Params: { id: string } }>('/admin/dids/:id', async (req, reply) => {
        const user = await administrator(req)
        const provider = registry.forTenant(user.tenantId)
        const apply = trunksOf(provider)
        const { did, created } = await inTurn(user.tenantId, async () => {
          const records = await store.listTrunks(user.tenantId)
          const dids = (await store.listDids(user.tenantId)).map(publicDid)
          const current = dids.find(d => d.id === req.params.id)
          if (!current && dids.length >= MAX_DIDS) throw Object.assign(new Error(`At most ${MAX_DIDS} ranges of direct numbers`), { statusCode: 409, code: 'DID_LIMIT' })
          const did = parseDid(req.params.id, req.body, records, dids)
          // The fallback a trunk keeps at the operator (step 10b) is never a direct number of the platform.
          const looping = records.find(t => t.config.operator?.fallback?.number && inDids([did], t.config.operator.fallback.number))
          if (looping)
            throw Object.assign(new Error(`${looping.config.operator!.fallback!.number} is the fallback trunk ${looping.id} keeps at the operator: it cannot be a direct number of the platform`), { statusCode: 409, code: 'OPERATOR_FALLBACK_LOOP' })
          await checkTarget(user.tenantId, provider, 'target', did.target, 'DID_TARGET')
          await checkTarget(user.tenantId, provider, 'fallbackTarget', did.fallbackTarget, 'FALLBACK_TARGET')
          await changeTrunks(user.tenantId, apply, records, current ? dids.map(d => (d.id === did.id ? did : d)) : [...dids, did], () => store.upsertDid({ tenantId: user.tenantId, ...did }))
          return { did, created: !current }
        })
        return reply.code(created ? 201 : 200).send(did)
      })
      v1.delete<{ Params: { id: string } }>('/admin/dids/:id', async (req, reply) => {
        const user = await administrator(req)
        const apply = trunksOf(registry.forTenant(user.tenantId))
        await inTurn(user.tenantId, async () => {
          const dids = (await store.listDids(user.tenantId)).map(publicDid)
          if (!dids.some(d => d.id === req.params.id)) throw notFound('direct number')
          await changeTrunks(user.tenantId, apply, await store.listTrunks(user.tenantId), dids.filter(d => d.id !== req.params.id), () => store.deleteDid(user.tenantId, req.params.id))
        })
        return reply.code(204).send()
      })

      // The rules of the calls to the public network (capability `outboundPolicy`, ADR 0017): administrators only, one
      // change at a time per tenant, in the store's turn for them (whatever Gateway writes): the version checked, then
      // the provider handed the change, then the store keeps it; the provider failing, or the store, the provider is
      // handed back what the store keeps. A change refused never reaches the provider (review 7 ter, n°9). Emergency
      // calls are outside all of it.
      const outboundOf = (provider: TelephonyProvider) => {
        if (!provider.setOutboundPolicy) throw Object.assign(new Error('Outbound rules are not available on this platform'), { statusCode: 501 })
        return provider.setOutboundPolicy.bind(provider)
      }
      // `expected`: the version the change was made from; kept only if the store still holds it (checked as it writes).
      const changeOutbound = (tenantId: string, apply: ReturnType<typeof outboundOf>, next: Outbound, expected?: string) =>
        store.setOutbound({ tenantId, ...next }, expected, (rules, undo) =>
          apply(rules.policy, rules.profiles, rules.assignments).catch((err: unknown) => {
            if (undo) app.log.error({ err, tenantId }, 'outbound rules: the previous ones could not be handed back to the provider')
            throw err
          })
        )
      // What holds when an administrator says nothing (ADR 0017): shown with what they said.
      // `version`: what to send back with a change, so that it is refused if the setting changed since (OUTBOUND_STALE).
      const outboundView = (o: Outbound) => ({ ...o, version: outboundVersion(o), defaults: { fraud: FRAUD_DEFAULTS, caps: OUTBOUND_CAP_DEFAULTS } })
      v1.get('/admin/outbound', async req => {
        const user = await administrator(req)
        outboundOf(registry.forTenant(user.tenantId))
        return outboundView(await outboundFor(user.tenantId))
      })
      v1.put('/admin/outbound', async req => {
        const user = await administrator(req)
        const apply = outboundOf(registry.forTenant(user.tenantId))
        const next = parseOutbound(req.body)
        // The version read (the screens always send it): the setting is replaced only if it is still the one read. A
        // script that means to replace it whole, whatever it is, sends none.
        const version = (req.body as { version?: unknown }).version
        if (version !== undefined && typeof version !== 'string') throw Object.assign(new Error('version: the version of GET /admin/outbound'), { statusCode: 400, code: 'OUTBOUND_INVALID' })
        await inTurn(user.tenantId, async () => {
          // Checked first (nothing handed to the provider for nothing), then again by the store as it writes: the turn
          // of this process ends after turnMaxMs, and another Gateway may write too (review 7 bis, n°2).
          if (version !== undefined && outboundVersion(await outboundFor(user.tenantId)) !== version) throw staleOutbound()
          await changeOutbound(user.tenantId, apply, next, version)
        })
        return outboundView(next)
      })
      // One person's profile (`profileId`, or null: the default one).
      v1.put<{ Params: { userId: string } }>('/admin/outbound/users/:userId', async req => {
        const user = await administrator(req)
        const apply = outboundOf(registry.forTenant(user.tenantId))
        const userId = req.params.userId
        const body = req.body as { profileId?: unknown; version?: unknown } | undefined
        const profileId = body?.profileId
        if (profileId !== null && (typeof profileId !== 'string' || !PROFILE_ID.test(profileId))) throw Object.assign(new Error('profileId: one of the profiles, or null'), { statusCode: 400, code: 'OUTBOUND_INVALID' })
        // The version the screen shows (the app always sends it): refused if the setting changed since, this person's
        // profile included (review 7 ter, n°3). A script sends none.
        const version = body?.version
        if (version !== undefined && typeof version !== 'string') throw Object.assign(new Error('version: the version of GET /admin/outbound'), { statusCode: 400, code: 'OUTBOUND_INVALID' })
        return inTurn(user.tenantId, async () => {
          const current = await outboundFor(user.tenantId)
          if (version !== undefined && outboundVersion(current) !== version) throw staleOutbound()
          const assignments = current.assignments.filter(a => a.userId !== userId)
          const next = parseOutbound({ ...current, assignments: profileId ? [...assignments, { userId, profileId }] : assignments })
          await changeOutbound(user.tenantId, apply, next, outboundVersion(current))
          // The whole setting as it is now, with its version (review 7 bis, n°1): a screen shows all of it, never a
          // version of the server grafted onto what it read before.
          return { userId, profileId: profileId ?? null, ...outboundView(next) }
        })
      })
      // The people who hold an extension (step 7), by user id: whom a rights profile is given to, where a direct
      // number or a fallback may ring. What the mappings say (the directory synchronisation writes them), nothing more.
      v1.get('/admin/users', async req => {
        const user = await administrator(req)
        const mappings = await store.listMappings(user.tenantId)
        return { items: mappings.map(m => ({ userId: m.userId, extension: m.extension, ...(m.displayName ? { displayName: m.displayName } : {}), ...(m.department ? { department: m.department } : {}) })) }
      })
      // The alerts, the latest repeated first, a page at a time (`next`: the `before` of the next page), of one kind
      // or param if asked. Each one once while it repeats: `count` times, the last at `lastAt` (its fields those of the
      // last), the first at `at` (`first`: its value and number).
      v1.get<{ Querystring: { limit?: string; before?: string; kind?: string; param?: string; state?: string } }>('/admin/alerts', async req => {
        const user = await administrator(req)
        const q = req.query
        const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400, code: 'ALERTS_QUERY' })
        const cursor = q.before === undefined ? undefined : ALERT_CURSOR.exec(q.before)
        if (q.before !== undefined && !cursor) throw bad('before: the `next` of a previous page')
        if (q.kind !== undefined && !(ALERT_KINDS as readonly string[]).includes(q.kind)) throw bad(`kind: one of ${ALERT_KINDS.join(', ')}`)
        if (q.param !== undefined && !/^[A-Za-z-]{1,32}$/.test(q.param)) throw bad('param: a threshold, a cap or a class of numbers')
        if (q.state !== undefined && q.state !== 'open' && q.state !== 'acknowledged') throw bad('state: open or acknowledged')
        const asked = q.limit === undefined ? 50 : Number(q.limit)
        if (!Number.isInteger(asked)) throw bad('limit: a whole number')
        const limit = clampLimit(asked)
        const before = cursor ? { lastAt: new Date(Number(cursor[1])).toISOString(), id: cursor[2]! } : undefined
        const items = await store.listAlerts(user.tenantId, { limit, ...(before ? { before } : {}), ...(q.kind ? { kind: q.kind as (typeof ALERT_KINDS)[number] } : {}), ...(q.param ? { param: q.param } : {}), ...(q.state ? { state: q.state } : {}) })
        const last = items.at(-1)
        return {
          items: items.map(publicAlert),
          ...(last && items.length === limit ? { next: `${Date.parse(last.lastAt)}-${last.id}` } : {})
        }
      })
      // An administrator has seen it (step 7): kept with who and when; a repeat from then on opens a new alert.
      // `lastAt`: its last repeat as they saw it. Repeated since, it stays open (409 ALERT_CHANGED): what came after
      // is never acknowledged unseen.
      v1.post<{ Params: { id: string } }>('/admin/alerts/:id/acknowledge', async req => {
        const user = await administrator(req)
        const body = req.body as { lastAt?: unknown; count?: unknown } | undefined
        const seen = body?.lastAt
        if (typeof seen !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(seen) || Number.isNaN(Date.parse(seen)))
          throw Object.assign(new Error('lastAt: the lastAt of the alert as listed'), { statusCode: 400, code: 'ALERT_INVALID' })
        const count = body?.count
        if (!Number.isInteger(count) || (count as number) < 1) throw Object.assign(new Error('count: the count of the alert as listed'), { statusCode: 400, code: 'ALERT_INVALID' })
        const alert = await store.acknowledgeAlert(user.tenantId, req.params.id, user.id, new Date().toISOString(), new Date(seen).toISOString(), count as number)
        if (!alert) throw notFound('alert')
        if (!alert.acknowledgedAt) throw Object.assign(new Error('The alert repeated since it was listed: list it again'), { statusCode: 409, code: 'ALERT_CHANGED' })
        return publicAlert(alert)
      })

      // The webhook hub (step 10a, ADR 0020, FR-D5 and FR-D6): the tools the organisation's administrators subscribe
      // to its events, the domains they may point to, each delivery and its outcome. Administrators only. Without
      // SECRETS_KEY (the secrets are kept encrypted with it), none: 501.
      const hubOf = () => {
        if (!hub) throw Object.assign(new Error('Webhooks are not available on this platform (SECRETS_KEY is not set)'), { statusCode: 501 })
        return hub
      }
      const subscriptionOf = async (tenantId: string, id: string) => {
        const record = WEBHOOK_ID.test(id) ? await store.getWebhookSubscription(tenantId, id) : null
        if (!record) throw notFound('webhook subscription')
        return record
      }
      const webhookView = async (tenantId: string, records: WebhookSubscriptionRecord[]) => {
        const domains = await store.getWebhookDomains(tenantId)
        return records.map(r => publicSubscription(r, domains, hubOf().policy, hubOf().clock()))
      }
      // Tests and replays send a request to the subscriber: 10 a minute per subscription and 30 per organisation,
      // whatever Gateway or administrator asks (a subscription deleted and made again counts the same), each counted
      // once accepted, in the transaction that queues it (one refused costs none); none to a disabled one (it
      // receives nothing, as the screen says).
      const sendable = (record: WebhookSubscriptionRecord) => {
        if (!record.enabled) throw Object.assign(new Error('This subscription is disabled: enable it first'), { statusCode: 409, code: 'WEBHOOK_DISABLED' })
      }
      const quota = { perSubscription: options.webhookSendsPerMinute ?? WEBHOOK_SENDS_PER_MINUTE, perTenant: options.webhookTenantSendsPerMinute ?? WEBHOOK_TENANT_SENDS_PER_MINUTE, windowMs: 60_000 }
      const rate = () => Object.assign(new Error('Too many deliveries asked of this subscription or organisation, slow down'), { statusCode: 429, code: 'WEBHOOK_RATE' })
      const backlog = () => Object.assign(new Error('This subscription has too many deliveries waiting: let them go first'), { statusCode: 409, code: 'WEBHOOK_BACKLOG' })
      v1.get('/webhooks/domains', async req => {
        const user = await administrator(req)
        hubOf()
        return { domains: await store.getWebhookDomains(user.tenantId) }
      })
      v1.put('/webhooks/domains', async req => {
        const user = await administrator(req)
        hubOf()
        const domains = parseWebhookDomains(req.body)
        await store.setWebhookDomains(user.tenantId, domains)
        return { domains }
      })
      v1.get('/webhooks', async req => {
        const user = await administrator(req)
        hubOf()
        return { items: await webhookView(user.tenantId, await store.listWebhookSubscriptions(user.tenantId)) }
      })
      // The secret is shown here and only here (and when renewed): never read back.
      v1.post('/webhooks', async (req, reply) => {
        const user = await administrator(req)
        const h = hubOf()
        const parsed = parseSubscription(req.body, await store.getWebhookDomains(user.tenantId), h.policy)
        const secret = newWebhookSecret()
        const at = new Date().toISOString()
        const id = `wh_${randomBytes(8).toString('hex')}`
        const record: WebhookSubscriptionRecord = { tenantId: user.tenantId, id, ...parsed, enabled: parsed.enabled ?? true, secretEnc: encrypt(secret, options.secretsKey!, secretContext(user.tenantId, id)), failures: 0, createdAt: at, updatedAt: at, createdBy: user.id }
        if (!(await store.addWebhookSubscription(record, MAX_WEBHOOKS))) throw Object.assign(new Error(`At most ${MAX_WEBHOOKS} webhook subscriptions`), { statusCode: 409, code: 'WEBHOOK_LIMIT' })
        h.forget(user.tenantId)
        app.log.info({ tenantId: user.tenantId, subscription: record.id, by: user.id }, 'webhook subscription created')
        return reply.code(201).send({ ...(await webhookView(user.tenantId, [record]))[0], secret })
      })
      v1.get<{ Params: { id: string } }>('/webhooks/:id', async req => {
        const user = await administrator(req)
        hubOf()
        return (await webhookView(user.tenantId, [await subscriptionOf(user.tenantId, req.params.id)]))[0]
      })
      // Its address, events and description as given; `enabled` kept unless given. Disabled, what it was owed is not sent.
      v1.put<{ Params: { id: string } }>('/webhooks/:id', async req => {
        const user = await administrator(req)
        const h = hubOf()
        const current = await subscriptionOf(user.tenantId, req.params.id)
        const parsed = parseSubscription(req.body, await store.getWebhookDomains(user.tenantId), h.policy)
        const { description: _was, ...kept } = current
        const record: WebhookSubscriptionRecord = { ...kept, ...parsed, enabled: parsed.enabled ?? current.enabled, updatedAt: new Date().toISOString() }
        if (!(await store.updateWebhookSubscription(record))) throw notFound('webhook subscription')
        h.forget(user.tenantId)
        return (await webhookView(user.tenantId, [record]))[0]
      })
      v1.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) => {
        const user = await administrator(req)
        const h = hubOf()
        if (!WEBHOOK_ID.test(req.params.id) || !(await store.deleteWebhookSubscription(user.tenantId, req.params.id))) throw notFound('webhook subscription')
        h.forget(user.tenantId)
        app.log.info({ tenantId: user.tenantId, subscription: req.params.id, by: user.id }, 'webhook subscription deleted')
        return reply.code(204).send()
      })
      // A new secret, at once: the deliveries sent from now on are signed with it, and for a day with the one it
      // replaced as well (a second `v1`), the time for the subscriber to take the new one. Only that one: renewed
      // again within the day, the first one no longer signs. `?grace=0`: the one it replaced no longer signs at all (a
      // secret that leaked).
      v1.post<{ Params: { id: string }; Querystring: { grace?: string } }>('/webhooks/:id/secret', async req => {
        const user = await administrator(req)
        const h = hubOf()
        if (req.query.grace !== undefined && req.query.grace !== '0') throw Object.assign(new Error('grace: 0 (the secret replaced no longer signs), or nothing (a day)'), { statusCode: 400, code: 'WEBHOOK_QUERY' })
        const current = await subscriptionOf(user.tenantId, req.params.id)
        const secret = newWebhookSecret()
        const now = h.clock()
        const previousUntil = req.query.grace === '0' ? null : new Date(now + WEBHOOK_SECRET_GRACE_MS).toISOString()
        if (!(await store.renewWebhookSecret(user.tenantId, current.id, encrypt(secret, options.secretsKey!, secretContext(user.tenantId, current.id)), previousUntil, new Date(now).toISOString()))) throw notFound('webhook subscription')
        app.log.info({ tenantId: user.tenantId, subscription: current.id, by: user.id, grace: previousUntil !== null }, 'webhook secret renewed')
        return { secret, ...(previousUntil ? { previousSecretUntil: previousUntil } : {}) }
      })
      // Started afresh (its subscriber repaired): no pause, no failures, no backlog counted; what waits is sent.
      v1.post<{ Params: { id: string } }>('/webhooks/:id/resume', async req => {
        const user = await administrator(req)
        const h = hubOf()
        const current = await subscriptionOf(user.tenantId, req.params.id)
        if (!(await h.resume(user.tenantId, current.id))) throw notFound('webhook subscription')
        app.log.info({ tenantId: user.tenantId, subscription: current.id, by: user.id }, 'webhook subscription resumed')
        return (await webhookView(user.tenantId, [await subscriptionOf(user.tenantId, current.id)]))[0]
      })
      v1.post<{ Params: { id: string } }>('/webhooks/:id/test', async (req, reply) => {
        const user = await administrator(req)
        const h = hubOf()
        sendable(await subscriptionOf(user.tenantId, req.params.id))
        const delivery = await h.test(user.tenantId, req.params.id, quota)
        if (!delivery) throw notFound('webhook subscription')
        if (delivery === 'full') throw backlog()
        if (delivery === 'rate') throw rate()
        return reply.code(202).send(publicDelivery(delivery))
      })
      // The log of a subscription, the latest first, a page at a time (`next`: the `before` of the next page).
      v1.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string; status?: string } }>('/webhooks/:id/deliveries', async req => {
        const user = await administrator(req)
        hubOf()
        await subscriptionOf(user.tenantId, req.params.id)
        const q = req.query
        const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400, code: 'WEBHOOK_QUERY' })
        const cursor = q.before === undefined ? undefined : DELIVERY_CURSOR.exec(q.before)
        if (q.before !== undefined && !cursor) throw bad('before: the `next` of a previous page')
        if (q.status !== undefined && !['pending', 'delivered', 'failed'].includes(q.status)) throw bad('status: pending, delivered or failed')
        const asked = q.limit === undefined ? 50 : Number(q.limit)
        if (!Number.isInteger(asked)) throw bad('limit: a whole number')
        const limit = clampLimit(asked)
        const items = await store.listWebhookDeliveries(user.tenantId, req.params.id, {
          limit,
          ...(cursor ? { before: { createdAt: new Date(Number(cursor[1])).toISOString(), id: cursor[2]! } } : {}),
          ...(q.status ? { status: q.status as WebhookDeliveryStatus } : {})
        })
        const last = items.at(-1)
        return { items: items.map(publicDelivery), ...(last && items.length === limit ? { next: `${Date.parse(last.createdAt)}-${last.id}` } : {}) }
      })
      // Sent again, its attempts from zero: the same event (the same id, which the subscriber may have seen already).
      v1.post<{ Params: { id: string; deliveryId: string } }>('/webhooks/:id/deliveries/:deliveryId/replay', async (req, reply) => {
        const user = await administrator(req)
        const h = hubOf()
        sendable(await subscriptionOf(user.tenantId, req.params.id))
        const replayed = DELIVERY_ID.test(req.params.deliveryId) ? await h.replay(user.tenantId, req.params.id, req.params.deliveryId, quota) : null
        if (!replayed) throw notFound('delivery')
        if (replayed === 'pending') throw Object.assign(new Error('This delivery is still pending: it is sent again by itself'), { statusCode: 409, code: 'WEBHOOK_PENDING' })
        if (replayed === 'full') throw backlog()
        if (replayed === 'rate') throw rate()
        return reply.code(202).send(publicDelivery(replayed))
      })

      // Right to erasure of one's own call history: with it, the log of what the subscribers were sent about them
      // (what is still to be sent is sent all the same, the organisation's tools are owed it, then kept without its
      // body) and what was told of their presence. The webhooks' first: a failure between the two leaves the history,
      // which the person sees and erases again, never a log they cannot see.
      v1.delete('/me/history', async (req, reply) => {
        const user = await whoIs(req)
        forgetPresence(user.tenantId, user.id)
        await store.eraseWebhookSubject(user.tenantId, user.id)
        // The operator's records of their direct numbers lose their numbers, and those not reconciled yet never enter
        // anybody's history (review 10b, n°1; a record read later neither, whoever holds the number then: n°3). When
        // their calls were is kept only with an operator, for those a record read later may be of (third review n°3).
        const kept = operatorSync?.keptOfErasure(user.tenantId)
        const deleted = await store.deleteHistory(user.tenantId, user.id, await erasedNumbersOf(store, user.tenantId, user.id), kept)
        return reply.send({ deleted })
      })

      const action = (name: string, run: (p: TelephonyProvider, id: string, body: { digits?: string; destination?: string }) => Promise<void>) =>
        v1.post<{ Params: { id: string }; Body: { digits?: string; destination?: string } | undefined }>(`/calls/:id/${name}`, async (req, reply) => {
          const { user, provider } = await who(req)
          // A call that is not the caller's looks exactly like a call that does not exist.
          if (!callOwners.get(req.params.id)?.has(ownerKey(user.tenantId, user.id))) throw Object.assign(new Error('Call not found'), { statusCode: 404 })
          await run(provider, req.params.id, req.body ?? {})
          return reply.code(204).send()
        })
      action('answer', (p, id) => p.answer(id))
      action('reject', (p, id) => p.hangup(id))
      action('hangup', (p, id) => p.hangup(id))
      action('hold', (p, id) => p.hold(id))
      action('resume', (p, id) => p.resume(id))
      action('transfer', (p, id, b) => p.transfer(id, b.destination ?? ''))
      action('dtmf', (p, id, b) => p.sendDTMF(id, b.digits ?? ''))


      // Phone access to a Meet room (dial-in PIN, dial-out). The owner is the first user who claims the room.
      // What LiveKit says when it refuses or does not answer stays in the log: the person is told the service is
      // unavailable (502, CONFERENCE_UNAVAILABLE), never LiveKit's words nor its status.
      const viaLiveKit = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
          return await run()
        } catch (err) {
          if (!(err instanceof LiveKitError)) throw err
          app.log.error({ err: { message: err.message, status: err.status, code: err.twirpCode } }, 'LiveKit request failed')
          throw Object.assign(new Error('The meeting rooms are unavailable'), { statusCode: 502, code: 'CONFERENCE_UNAVAILABLE' })
        }
      }
      const bridgeFor = async (req: FastifyRequest) => {
        const identity = await auth.authenticate(req)
        const user = await resolve(identity)
        const bridge = options.conference?.bridge(user.tenantId)
        if (!bridge) throw Object.assign(new Error('Conference bridge is not configured'), { statusCode: 501 })
        return { user, bridge, email: identity.email }
      }
      const meetRoomFor = async (email: string | undefined, by: { slug: string } | { id: string }): Promise<MeetRoom | null> => {
        if (!email) throw bad('Your account has no email: Meet cannot identify you')
        try {
          return await options.conference!.meet!.findRoom(email, by)
        } catch (err) {
          app.log.error({ err }, 'Meet request failed')
          throw Object.assign(new Error('Meet is unavailable'), { statusCode: 502 })
        }
      }
      const meetDialIn = (room: MeetRoom) => ({
        numbers: room.telephony?.enabled && room.telephony.phoneNumber ? [{ country: room.telephony.defaultCountry ?? '', e164: room.telephony.phoneNumber }] : [],
        meetingCode: room.slug,
        ...(room.telephony?.pinCode ? { pin: room.telephony.pinCode } : {})
      })
      // `closing`: only to close it. Without Meet, a room the Gateway did not name (claimed by its name before the
      // Gateway named them, maybe one of Meet's) looks like a missing one, except to be closed (second review n°6).
      // `reading`: the room of a call (step 8b) is read by everyone its room called at their extension, not only by its
      // owner (review 8b, n°2): whoever is in a conference sees who else is. Also whoever its call reached otherwise (a
      // member of a group, a forward's target, a direct number: second review 8b, n°4), told of that call by the SIP
      // server's events (callOwners, by the Call-ID LiveKit SIP gives each participant): rung by it, or answering it.
      const owned = async (req: FastifyRequest, meetingId: string, { closing = false, reading = false } = {}) => {
        if (!MEETING_ID.test(meetingId)) throw bad('invalid meeting id')
        const ctx = await bridgeFor(req)
        const record = await store.getConference(meetingId)
        // Another tenant's room looks exactly like a missing one.
        if (!record || record.tenantId !== ctx.user.tenantId) throw Object.assign(new Error('Meeting not found'), { statusCode: 404 })
        // The room of a call become a conference (step 8b) is the Gateway's, with or without Meet: never Meet's.
        const callRoom = CALL_ROOM.test(record.meetingId)
        if (!options.conference?.meet && !closing && !GATEWAY_ROOM.test(record.meetingId) && !callRoom) throw Object.assign(new Error('Meeting not found: without Meet, the Gateway names the rooms (POST /conferences with create)'), { statusCode: 404 })
        // The claim is not enough: Meet must still grant this user access to the room (membership can be revoked).
        // Checked first, so someone without access cannot tell that the room exists.
        let room: MeetRoom | null = null
        if (options.conference?.meet && !callRoom) {
          room = await meetRoomFor(ctx.email, { id: record.meetingId })
          if (!room) throw Object.assign(new Error('Room not found, or not accessible to you'), { statusCode: 404 })
        }
        let calls: ParticipantCall[] | undefined
        if (record.ownerUserId !== ctx.user.id) {
          let member = false
          if (reading && callRoom) {
            const me = ownerKey(ctx.user.tenantId, ctx.user.id)
            calls = await viaLiveKit(() => ctx.bridge.participantCalls(record.meetingId))
            member = calls.some(p => (!!ctx.user.extension && p.number === ctx.user.extension) || (!!p.callId && !!callOwners.get(p.callId)?.has(me)))
          }
          if (!member) throw Object.assign(new Error('Only the owner of the meeting can do this'), { statusCode: 403 })
        }
        return { ...ctx, record, room, calls }
      }
      /**
       * Whether a participant of a call's room is someone of the tenant other than its owner (second review 8b, n°4):
       * the SIP server told one of them of its call (rung by it, a member of a group or a forward's target among them),
       * or it was called at an extension of the tenant (the owner's own call, or a call whose events the Gateway lost
       * when it started again). Else from outside: a number of the public network (its events are the owner's, who
       * placed it), or a web participant.
       */
      const insider = async (record: { tenantId: string; ownerUserId: string }, p: ParticipantCall) => {
        const theirs = ownerKey(record.tenantId, record.ownerUserId)
        if ([...(p.callId ? (callOwners.get(p.callId) ?? []) : [])].some(k => k !== theirs && k.startsWith(`${record.tenantId}\u0000`))) return true
        return !!p.number && !!(await store.getMappingByExtension(record.tenantId, p.number))
      }
      /**
       * The room's rule with the PIN shown, made again if LiveKit lost it. A PIN shorter than PIN_DIGITS (a room opened
       * before the Gateway drew them from crypto: 6 digits of Math.random) is drawn again, its rule with it, the old one
       * removed (second review n°6). A room without a PIN (just opened, or its 6-digit one swept at start) gets one too.
       * One draw at a time per room in this process (the reads of a room at once wait for it), and of two Gateways the
       * first to write its PIN wins: the other deletes the rule it made and shows the winner's (third review n°5).
       * ensureDialIn then leaves the room the one rule of the PIN shown.
       */
      const drawing = new Map<string, Promise<string | undefined>>()
      const keepDialIn = async (bridge: LiveKitConferenceBridge, record: { meetingId: string; tenantId: string; pin?: string }) => {
        if (record.pin && record.pin.length >= PIN_DIGITS) return viaLiveKit(() => bridge.ensureDialIn(record.meetingId, record.pin!))
        let draw = drawing.get(record.meetingId)
        if (!draw) {
          const from = record.pin ?? null
          draw = (async () => {
            const dialIn = await viaLiveKit(() => bridge.createDialIn({ id: record.meetingId, tenantId: record.tenantId }))
            if (await store.replaceConferencePin(record.meetingId, from, dialIn.pin ?? null)) {
              await viaLiveKit(() => bridge.ensureDialIn(record.meetingId, dialIn.pin!))
              return dialIn.pin
            }
            await viaLiveKit(() => bridge.dropDialIn(record.meetingId, dialIn.pin!))
            const now = (await store.getConference(record.meetingId))?.pin
            if (now) await viaLiveKit(() => bridge.ensureDialIn(record.meetingId, now))
            return now
          })().finally(() => drawing.delete(record.meetingId))
          drawing.set(record.meetingId, draw)
        }
        const pin = await draw
        if (pin) record.pin = pin
        else delete record.pin
      }
      const publicDialIn = (bridge: LiveKitConferenceBridge, record: { meetingId: string; pin?: string }) => ({
        numbers: bridge.dialInNumbers,
        meetingCode: record.meetingId,
        ...(record.pin ? { pin: record.pin } : {})
      })

      // Opens the phone panel of a room. With Meet configured the room comes from Meet (existing room by slug, or a
      // new one with `create`), and Meet decides who may see it. Without Meet, `create` has the Gateway name a new room
      // (`twake-` and 16 random hexadecimal characters, never a name someone else chose: a LiveKit shared with Meet has
      // Meet's rooms, which nobody may take over from here); `meetingId` reopens one of the person's own rooms only;
      // anything else is 400. A new room is CONFERENCE_LIMIT (429) past the rooms a person may open (second review n°4).
      // That limit is per process (each Gateway has its own, forgotten when it restarts); the rooms open at once are
      // bounded in the database, per person and per tenant (third review n°6): 429 CONFERENCE_LIMIT as well.
      const newRooms = options.conferenceLimiter ?? new RateLimiter(20, 3_600_000)
      const tooManyRooms = { statusCode: 429, code: 'CONFERENCE_LIMIT', error: 'Too Many Requests', message: 'Too many rooms opened: wait a while' }
      const roomsPerPerson = options.conferenceCaps?.perPerson ?? 50
      const roomsPerTenant = options.conferenceCaps?.perTenant ?? 1000
      const mayOpen = async (tenantId: string, userId: string) =>
        newRooms.allow(ownerKey(tenantId, userId)) && (await store.countConferences(tenantId, userId)) < roomsPerPerson && (await store.countConferences(tenantId)) < roomsPerTenant
      v1.post<{ Body: { meetingId?: string; slug?: string; create?: boolean } }>('/conferences', async (req, reply) => {
        const { user, bridge, email } = await bridgeFor(req)
        const meet = options.conference?.meet
        let meetingId = req.body?.meetingId ?? ''
        let room: MeetRoom | null = null
        if (meet) {
          if (!email) throw bad('Your account has no email: Meet cannot identify you')
          if (req.body?.create) {
            if (!(await mayOpen(user.tenantId, user.id))) return reply.code(429).send(tooManyRooms)
            try {
              room = await meet.createRoom(email)
            } catch (err) {
              app.log.error({ err }, 'Meet request failed')
              throw Object.assign(new Error('Meet is unavailable'), { statusCode: 502 })
            }
          } else {
            if (!MEETING_ID.test(req.body?.slug ?? '')) throw bad('invalid room')
            room = await meetRoomFor(email, { slug: req.body.slug! })
            if (!room) throw Object.assign(new Error('Room not found, or not accessible to you'), { statusCode: 404 })
          }
          meetingId = room.id
        } else if (req.body?.meetingId !== undefined) {
          if (!MEETING_ID.test(meetingId)) throw bad('invalid meeting id')
          const mine = await store.getConference(meetingId)
          // Another tenant's room, or a name the Gateway never gave, looks exactly like a missing one.
          if (!mine || mine.tenantId !== user.tenantId || !GATEWAY_ROOM.test(meetingId)) throw Object.assign(new Error('Meeting not found: without Meet, the Gateway names the rooms (POST /conferences with create)'), { statusCode: 404 })
        } else if (req.body?.create === true) {
          if (!(await mayOpen(user.tenantId, user.id))) return reply.code(429).send(tooManyRooms)
          meetingId = `twake-${randomBytes(8).toString('hex')}`
        } else throw bad('Which room: meetingId to reopen one of yours, or create for a new one')

        const record = await store.claimConference({ tenantId: user.tenantId, meetingId, ownerUserId: user.id, createdAt: new Date().toISOString() })
        if (record.tenantId !== user.tenantId || record.ownerUserId !== user.id) throw Object.assign(new Error('Meeting already managed by someone else'), { statusCode: 409 })
        if (room) return reply.code(201).send({ meetingId, slug: room.slug, ...(room.url ? { url: room.url } : {}), dialIn: meetDialIn(room) })
        await keepDialIn(bridge, record)
        return reply.code(201).send({ meetingId, dialIn: publicDialIn(bridge, record) })
      })

      const roomReads = options.conferenceReadLimiter ?? new RateLimiter(60, 60_000)
      v1.get<{ Params: { id: string } }>('/conferences/:id', async (req, reply) => {
        const { bridge, record, room, user, calls } = await owned(req, req.params.id, { reading: true })
        if (!roomReads.allow(ownerKey(user.tenantId, user.id))) return reply.code(429).send({ statusCode: 429, code: 'CONFERENCE_READ_LIMIT', error: 'Too Many Requests', message: 'Too many reads of your rooms: wait a minute' })
        if (room) {
          // The PIN and number are Meet's, read back each time so a rotation shows up here.
          return { meetingId: record.meetingId, slug: room.slug, ...(room.url ? { url: room.url } : {}), dialIn: meetDialIn(room), participants: await viaLiveKit(() => bridge.listParticipants(record.meetingId)) }
        }
        // A call's room (step 8b): nobody dials into it, no PIN. The number of someone from outside (the public network)
        // is its owner's to see whole, who called it; masked for the others in it (second review 8b, n°6).
        if (CALL_ROOM.test(record.meetingId)) {
          // X-Twake-Call: the Call-ID of the reader's own call in it (a header, not in the URL proxies log), whose
          // participant is marked (`you`): their panel tells who came after them. It decides nothing here, and says
          // nothing to whoever does not have that Call-ID already. One value, of 256 characters at most, else none.
          const header = req.headers['x-twake-call']
          const you = typeof header === 'string' && header.length <= 256 ? header : undefined
          const participants = await viaLiveKit(() => bridge.listParticipants(record.meetingId, you ? { you } : {}))
          if (!calls) return { meetingId: record.meetingId, participants }
          // Shown whole only when proved of the tenant by the read of the calls: one come in since is masked too (third
          // review 8b, n°2). Its id carries no number (an identity drawn at random, conference-livekit).
          const inside = new Set<string>()
          for (const p of calls) if (await insider(record, p)) inside.add(p.id)
          return {
            meetingId: record.meetingId,
            participants: participants.map(p => (!inside.has(p.id) && p.number ? { ...p, number: maskNumber(p.number), ...(p.displayName ? { displayName: maskNumber(p.number) } : {}) } : p))
          }
        }
        // The PIN shown lets in: the room's rule is made again if LiveKit lost it.
        await keepDialIn(bridge, record)
        return { meetingId: record.meetingId, dialIn: publicDialIn(bridge, record), participants: await viaLiveKit(() => bridge.listParticipants(record.meetingId)) }
      })

      v1.delete<{ Params: { id: string } }>('/conferences/:id', async (req, reply) => {
        const { bridge, record } = await owned(req, req.params.id, { closing: true })
        // A call's room (step 8b) ends for everyone in it: closing it is "Terminer pour tous". Meet owns its dial-in
        // rules: only a Gateway-managed rule is removed here.
        if (CALL_ROOM.test(record.meetingId)) await viaLiveKit(() => bridge.deleteRoom(record.meetingId))
        else if (!options.conference?.meet) await viaLiveKit(() => bridge.removeDialIn(record.meetingId))
        await store.deleteConference(record.meetingId)
        return reply.code(204).send()
      })

      // The room calls a number at the owner's name (step 8, ADR 0018): their extension, which the SIP server treats as
      // a call from their phone (rights, caps, the direct number presented), once the SIP server granted that very call
      // (grantRoomCall: LiveKit's word alone makes no call anyone's). Answered once the call is (201), or with the SIP
      // status of the failure (409, DIAL_FAILED: `sipStatus`, `sipReason`; 480 when nobody answered); LiveKit refusing
      // or not answering is 502 (CONFERENCE_UNAVAILABLE). DIAL_OUT_LIMIT (429) past the calls a person's rooms may place.
      // The call that took the grant must be the Gateway's own, and LiveKit's trunk must still go to the SIP server
      // (review 8b, n°3): otherwise 502, CALL_DIVERTED, the call ended and the administrators told (callDiverted).
      const dialOuts = options.dialOutLimiter ?? new RateLimiter(10, 60_000)
      const tooManyDialOuts = { statusCode: 429, code: 'DIAL_OUT_LIMIT', error: 'Too Many Requests', message: 'Too many calls placed by your rooms: wait a minute' }
      const divertedReply = { statusCode: 502, code: 'CALL_DIVERTED', error: 'Bad Gateway', message: "A room's call did not go where it was sent: the administrators are told" }
      /**
       * For the administrators (alert `meet`, `param` call-diverted or trunk-changed): kept and logged, as the SIP
       * server's. Its repeats for the same extension count in one alert (the store's alertKey, ALERT_DEDUP_MS).
       */
      const roomAlert = async (tenantId: string, param: 'call-diverted' | 'trunk-changed', extension: string, number?: string) => {
        app.log.error({ tenantId, alert: { kind: 'meet', param, ...(pseudonym ? { ext: pseudonym(tenantId, extension) } : {}) } }, `telephony alert: meet ${param}`)
        await store.addAlert({ tenantId, at: new Date().toISOString(), alert: { kind: 'meet', param, extension, ...(number ? { number } : {}) } }).catch(err => app.log.error({ err, tenantId }, 'could not record the alert'))
      }
      /**
       * Whether LiveKit's outbound trunk still sends the rooms' calls to the SIP server (review 8b, n°3): someone with a
       * key of LiveKit could point it at a server of theirs, which would receive the grant with the call. Written back
       * then, and this call is not placed (the administrators are told).
       */
      const trunkIntact = async (bridge: LiveKitConferenceBridge, tenantId: string, extension: string) => {
        if (await viaLiveKit(() => bridge.outboundIntact())) return true
        await roomAlert(tenantId, 'trunk-changed', extension)
        return false
      }
      /**
       * Settles the grant of a room's call once LiveKit answered, whatever it answered (review 8b, n°3; second review,
       * n°1): withdrawn first if no call took it (only then: nothing can take it after), then the call that took it read
       * from the SIP server, which keeps its From tag, the id LiveKit SIP gives its call (`placed.sipCallId`). Diverted
       * (true: that call ended at the SIP server, the administrators told) when another call took it (replayed from
       * someone else's room), or when LiveKit placed a call that took none. When LiveKit's call failed (`placed`
       * undefined), the call that took the grant is ended wherever it is, and is a diversion only if it was answered
       * (third review 8b, n°1): whoever replayed the grant, then refused the Gateway's call (486). One still ringing is
       * ended quietly: LiveKit's own, given up at its ringing delay (it cancels and says so at once, the 487s still on
       * their way), or a replayed one nobody answered yet; the failure is a failure. A provider that cannot say (no
       * `taken`) is taken at its word. Read twice (third review 8b, n°4): a grant that still cannot be read is told,
       * whatever LiveKit said; an SIP server that cannot end the call nor say what it was leaves a failure a failure
       * (logged), and after a success the diversion is told all the same.
       */
      const settle = async (provider: TelephonyProvider, tenantId: string, grant: RoomCallGrantToken, placed: DialedParticipant | undefined, extension: string, number: string) => {
        const withdraw = () => grant.revoke().catch((err: unknown) => app.log.warn({ err }, 'the grant of a room call not withdrawn'))
        if (!grant.taken) {
          // Nothing to read: withdrawn when the call failed, as it was before.
          if (!placed) await withdraw()
          return false
        }
        await withdraw()
        const read = grant.taken.bind(grant)
        let taken: { tag: string; callId: string } | undefined
        try {
          taken = await read().catch(() => read())
        } catch (err) {
          app.log.error({ err, tenantId }, 'the call that took the grant of a room call could not be read: told')
          await roomAlert(tenantId, 'call-diverted', extension, number)
          return true
        }
        if (!taken) {
          if (!placed) return false
          await roomAlert(tenantId, 'call-diverted', extension, number)
          return true
        }
        if (placed?.sipCallId && taken.tag === placed.sipCallId) return false
        const { callId } = taken
        const endRoomCall = provider.endRoomCall?.bind(provider)
        const ended = endRoomCall
          ? await endRoomCall(callId)
              .catch(() => endRoomCall(callId))
              .catch((err: unknown) => {
                app.log.error({ err, tenantId }, 'the call that took the grant of a room call not ended at the SIP server, nor said')
                return 'unknown' as const
              })
          : ('unknown' as const)
        if (!placed) return ended === 'answered' ? (await roomAlert(tenantId, 'call-diverted', extension, number), true) : false
        await roomAlert(tenantId, 'call-diverted', extension, number)
        return true
      }
      /** What is shown of a participant a room called: never the id of the call at LiveKit. */
      const shown = ({ sipCallId: _, ...participant }: DialedParticipant) => participant
      v1.post<{ Params: { id: string }; Body: { number?: string } }>('/conferences/:id/participants', async (req, reply) => {
        const { bridge, record, user } = await owned(req, req.params.id)
        if (!user.extension) throw Object.assign(new Error('You hold no extension: a room calls at the name of whoever asks'), { statusCode: 403, code: 'NO_EXTENSION' })
        const number = (req.body?.number ?? '').trim()
        if (!/^\+?[0-9*#]{2,20}$/.test(number)) throw bad('Invalid phone number')
        const provider = registry.serves(user.tenantId) ? registry.forTenant(user.tenantId) : undefined
        if (!provider?.grantRoomCall) throw Object.assign(new Error('The SIP server cannot let a room call'), { statusCode: 501 })
        if (!dialOuts.allow(ownerKey(user.tenantId, user.id))) return reply.code(429).send(tooManyDialOuts)
        if (!(await trunkIntact(bridge, user.tenantId, user.extension))) return reply.code(502).send(divertedReply)
        // A conference's room (step 8b) is named to the phone it calls: whoever answers sees who is in it (review 8b, n°2).
        const grant = await provider.grantRoomCall({ extension: user.extension, number, ...(CALL_ROOM.test(record.meetingId) ? { room: record.meetingId } : {}) })
        let participant: DialedParticipant
        try {
          participant = await viaLiveKit(() => bridge.dialParticipant(record.meetingId, number, { from: user.extension, grant: grant.token }))
        } catch (err) {
          // Failed, or LiveKit did not say: the grant is settled all the same (second review 8b, n°1).
          if (await settle(provider, user.tenantId, grant, undefined, user.extension, number)) return reply.code(502).send(divertedReply)
          const failed = err as Error & { code?: string; sipStatus?: number; sipReason?: string }
          if (failed.code !== 'DIAL_FAILED') throw err
          return reply.code(409).send({ statusCode: 409, code: 'DIAL_FAILED', error: 'Conflict', message: failed.message, sipStatus: failed.sipStatus, sipReason: failed.sipReason })
        }
        if (await settle(provider, user.tenantId, grant, participant, user.extension, number)) {
          await viaLiveKit(() => bridge.disconnectParticipant(participant.id)).catch((err: unknown) => app.log.warn({ err }, 'the participant of a diverted call not removed'))
          return reply.code(502).send(divertedReply)
        }
        return reply.code(201).send(shown(participant))
      })

      const participantAction = (method: 'delete' | 'post', path: string, run: (b: LiveKitConferenceBridge, pid: string) => Promise<void>) =>
        v1[method]<{ Params: { id: string; pid: string } }>(`/conferences/:id/participants/:pid${path}`, async (req, reply) => {
          const { bridge, record } = await owned(req, req.params.id)
          // The participant id embeds its room: refuse ids of another room so an owner cannot reach foreign rooms.
          if (splitParticipantId(req.params.pid).room !== record.meetingId) throw bad('participant does not belong to this meeting')
          await viaLiveKit(() => run(bridge, req.params.pid))
          return reply.code(204).send()
        })
      participantAction('delete', '', (b, pid) => b.disconnectParticipant(pid))
      participantAction('post', '/mute', (b, pid) => b.muteParticipant(pid))

      // « Ajouter un participant » (step 8b, ADR 0019): the person's call `id`, answered, between two extensions,
      // becomes a conference in a room of its own (CALL_ROOM: no PIN, nobody dials into it). The room calls the person
      // first (`join`, the token their window drew: only that window answers, at once), then the other party in the
      // place of the call (Replaces, the dialog as OpenSIPS holds it, never as a browser says it: their phone answers at
      // once and ends the call, and the person's window with it). Each call through the SIP server's grant, at the
      // person's name (route[meet_source]), to those two extensions' phones and nowhere else. The third participant is
      // then called as any other (POST /conferences/:id/participants). A call with the public network or a room is
      // CONFERENCE_EXTERNAL (409: nothing can take its place, the platform has no B2BUA); one not answered (or over),
      // CALL_NOT_ANSWERED (409). A room's call that fails is DIAL_FAILED (409), and nothing of the conference stays: the
      // room ends, the person's window takes the call back. The rooms of the person's calls LiveKit ended go first.
      const closeEndedCallRooms = async (bridge: LiveKitConferenceBridge, tenantId: string, userId: string) => {
        // A room just made may not be in LiveKit yet (its first call rings): a minute's grace.
        const mine = (await store.listConferences(tenantId, userId)).filter(r => CALL_ROOM.test(r.meetingId) && Date.now() - Date.parse(r.createdAt) > 60_000)
        if (!mine.length) return
        const open = await viaLiveKit(() => bridge.openRooms(mine.map(r => r.meetingId)))
        for (const r of mine) if (!open.has(r.meetingId)) await store.deleteConference(r.meetingId)
      }
      // One conference at a time per call (review 8b, n°6): both parties asking at once would have two rooms take the
      // same dialog. In this process (a Gateway behind another one asked at the same instant is not seen).
      const making = new Set<string>()
      v1.post<{ Params: { id: string }; Body: { join?: unknown } | undefined }>('/calls/:id/conference', async (req, reply) => {
        const { user, bridge } = await bridgeFor(req)
        // A call that is not the person's looks exactly like a call that does not exist.
        if (!callOwners.get(req.params.id)?.has(ownerKey(user.tenantId, user.id))) throw Object.assign(new Error('Call not found'), { statusCode: 404 })
        const join = req.body?.join
        if (typeof join !== 'string' || !/^[0-9a-f]{32}$/.test(join)) throw bad('join: the 32 hexadecimal characters the window drew')
        const me = user.extension
        if (!me) throw Object.assign(new Error('You hold no extension: a room calls at the name of whoever asks'), { statusCode: 403, code: 'NO_EXTENSION' })
        const provider = registry.serves(user.tenantId) ? registry.forTenant(user.tenantId) : undefined
        if (!provider?.grantRoomCall || !provider.callBetweenExtensions) throw Object.assign(new Error('The SIP server cannot make a conference of a call'), { statusCode: 501 })
        const lock = `${user.tenantId}\n${req.params.id}`
        if (making.has(lock)) return reply.code(409).send({ statusCode: 409, code: 'CONFERENCE_IN_PROGRESS', error: 'Conflict', message: 'A conference is already being made of this call' })
        making.add(lock)
        try {
          return await makeConference(req.params.id, join, user, me, provider, bridge, reply)
        } finally {
          making.delete(lock)
        }
      })
      const makeConference = async (callId: string, join: string, user: User, me: string, provider: TelephonyProvider, bridge: LiveKitConferenceBridge, reply: FastifyReply) => {
        const parties = await provider.callBetweenExtensions!(callId)
        if (parties === 'external') return reply.code(409).send({ statusCode: 409, code: 'CONFERENCE_EXTERNAL', error: 'Conflict', message: 'A call with the public network or a room cannot become a conference yet' })
        if (!parties || (parties.caller !== me && parties.callee !== me)) return reply.code(409).send({ statusCode: 409, code: 'CALL_NOT_ANSWERED', error: 'Conflict', message: 'The call is not in progress' })
        const placed = parties.caller === me
        const other = placed ? parties.callee : parties.caller
        // The dialog as the other party's phone has it (RFC 3891): its own tag (To), then the person's (From). A dialog
        // a Replaces header cannot name as it is (a phone's Call-ID of other characters) is said before anything begins
        // (review 8b, n°15).
        const replaces = `${parties.callId};to-tag=${placed ? parties.calleeTag : parties.callerTag};from-tag=${placed ? parties.callerTag : parties.calleeTag}`
        if (!REPLACES.test(replaces)) return reply.code(409).send({ statusCode: 409, code: 'CONFERENCE_UNSUPPORTED', error: 'Conflict', message: 'This call cannot be taken over by a room' })
        await closeEndedCallRooms(bridge, user.tenantId, user.id)
        // Two calls of a room (review 8b, n°16), counted before a room is: refused, nothing of either is used.
        if (!dialOuts.allow(ownerKey(user.tenantId, user.id), 2)) return reply.code(429).send(tooManyDialOuts)
        if (!(await mayOpen(user.tenantId, user.id))) return reply.code(429).send(tooManyRooms)
        const meetingId = `twake-call-${randomBytes(8).toString('hex')}`
        await store.claimConference({ tenantId: user.tenantId, meetingId, ownerUserId: user.id, createdAt: new Date().toISOString() })
        const divertedCall = () => Object.assign(new Error('A call of the room was diverted'), { code: 'CALL_DIVERTED' })
        // LiveKit's trunk read again before each grant (second review 8b, n°1): changed between the two calls, the
        // second is not placed.
        const place = async (number: string, conference: { join: string } | { replaces: string }) => {
          if (!(await trunkIntact(bridge, user.tenantId, me))) throw divertedCall()
          const grant = await provider.grantRoomCall!({ extension: me, number, room: meetingId, ...conference })
          let participant: DialedParticipant
          try {
            participant = await viaLiveKit(() => bridge.dialParticipant(meetingId, number, { from: me, grant: grant.token }))
          } catch (err) {
            if (await settle(provider, user.tenantId, grant, undefined, me, number)) throw divertedCall()
            throw err
          }
          if (await settle(provider, user.tenantId, grant, participant, me, number)) throw divertedCall()
          return participant
        }
        try {
          const own = await place(me, { join })
          // The person left the room before the other party comes in (hung up while it began, review 8b, n°8): nobody
          // else's call is taken over.
          if (!(await viaLiveKit(() => bridge.listParticipants(meetingId))).some(p => p.id === own.id))
            throw Object.assign(new Error('You left the room before the conference began'), { code: 'CONFERENCE_ABANDONED' })
          const theirs = await place(other, { replaces })
          watchOwner(bridge, { tenantId: user.tenantId, meetingId, ownerUserId: user.id })
          return reply.code(201).send({ meetingId, participants: [shown(own), shown(theirs)] })
        } catch (err) {
          // Ending the room also ends a call of it still ringing: LiveKit SIP stops dialing once its participant is gone
          // from the room (CANCEL; review 8b, n°13, read in LiveKit SIP v1.17.0).
          await viaLiveKit(() => bridge.deleteRoom(meetingId)).catch((e: unknown) => app.log.warn({ err: e }, 'the room of a conference that did not begin was not ended'))
          await store.deleteConference(meetingId)
          const failed = err as Error & { code?: string; sipStatus?: number; sipReason?: string }
          if (failed.code === 'CALL_DIVERTED') return reply.code(502).send(divertedReply)
          if (failed.code === 'CONFERENCE_ABANDONED') return reply.code(409).send({ statusCode: 409, code: 'CONFERENCE_ABANDONED', error: 'Conflict', message: failed.message })
          if (failed.code !== 'DIAL_FAILED') throw err
          return reply.code(409).send({ statusCode: 409, code: 'DIAL_FAILED', error: 'Conflict', message: failed.message, sipStatus: failed.sipStatus, sipReason: failed.sipReason })
        }
      }

      /**
       * Ends the room its owner is no longer in while someone from outside is (review 8b, n°7; insider, second review
       * 8b, n°4): that call goes at the owner's name and on their caps, with nobody left to end it. Read from LiveKit
       * each time, LiveKit's webhook included (third review 8b, n°6): a webhook played again, or another call of the room
       * to the owner's extension that ends, ends nothing while the owner is still in it. Whether the room ended.
       */
      const endIfOwnerGone = async (bridge: LiveKitConferenceBridge, record: { tenantId: string; meetingId: string; ownerUserId: string }) => {
        const owner = await store.getMappingByUser(record.tenantId, record.ownerUserId)
        if (!owner?.extension) return false
        const now = await viaLiveKit(() => bridge.participantCalls(record.meetingId))
        if (now.some(p => p.number === owner.extension)) return false
        let outsider = false
        for (const p of now) {
          if (p.number === owner.extension) continue
          if (!(await insider(record, p))) {
            outsider = true
            break
          }
        }
        if (!outsider) return false
        app.log.info({ tenantId: record.tenantId }, 'the owner of a conference left it with someone from outside in it: the room ends')
        await viaLiveKit(() => bridge.deleteRoom(record.meetingId))
        await store.deleteConference(record.meetingId)
        return true
      }
      /**
       * Looks every conferenceOwnerCheckMs whether the owner of the room is still in it (second review 8b, n°3): the
       * room ends as above without LiveKit's webhook (a LiveKit that sends none, or none here). Stops once the room or
       * its record is gone. In this process only: a Gateway started again relies on the webhook for the rooms before.
       */
      const ownerCheckMs = options.conferenceOwnerCheckMs ?? 15_000
      const watchOwner = (bridge: LiveKitConferenceBridge, record: { tenantId: string; meetingId: string; ownerUserId: string }) => {
        let busy = false
        const timer = setInterval(() => {
          if (busy) return
          busy = true
          void (async () => {
            if (closing || !(await store.getConference(record.meetingId))) return clearInterval(timer)
            if (!(await viaLiveKit(() => bridge.openRooms([record.meetingId]))).has(record.meetingId)) return clearInterval(timer)
            if (await endIfOwnerGone(bridge, record)) clearInterval(timer)
          })()
            .catch((err: unknown) => app.log.warn({ err }, "the owner of a conference's room not looked for"))
            .finally(() => (busy = false))
        }, ownerCheckMs)
        timer.unref()
      }

      // LiveKit webhooks: authenticated by the signature, not by a Twake identity.
      v1.post('/webhooks/livekit', async (req, reply) => {
        const cfg = options.conference
        if (!cfg) return reply.code(501).send()
        const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? ''
        if (!verifyWebhook(cfg.webhookKey, cfg.webhookSecret, req.headers.authorization, raw)) return reply.code(401).send()
        const body = req.body as { event?: string; room?: { name?: string } }
        const record = body.room?.name ? await store.getConference(body.room.name) : null
        // The room of a call (step 8b) lives as long as LiveKit has it: everyone gone, its record goes too.
        if (record && body.event === 'room_finished' && CALL_ROOM.test(record.meetingId)) await store.deleteConference(record.meetingId)
        const bridge = record && cfg.bridge(record.tenantId)
        // Its owner gone while someone with no extension of the tenant is still in it (review 8b, n°7): that call goes at
        // the owner's name and on their caps, with nobody left to end it. The room ends.
        if (record && bridge && body.event === 'participant_left' && CALL_ROOM.test(record.meetingId)) {
          const owner = await store.getMappingByUser(record.tenantId, record.ownerUserId)
          if (owner?.extension && (body as { participant?: { attributes?: Record<string, string> } }).participant?.attributes?.['twake.number'] === owner.extension) await endIfOwnerGone(bridge, record)
        }
        const event = record && bridge ? bridge.fromWebhook(body) : undefined
        if (record && event) bus.publish(record.tenantId, record.ownerUserId, event)
        return reply.code(204).send()
      })

      // Browsers cannot send headers on a WebSocket: they trade their credentials for a single-use ticket.
      v1.post('/ws-ticket', async req => ({ ticket: tickets.issue(await auth.authenticate(req)), expiresInSec: 30 }))

      v1.get<{ Querystring: { ticket?: string } }>('/ws', { websocket: true }, async (socket, req) => {
        const ticketed = req.query.ticket ? tickets.consume(req.query.ticket) : null
        const identity = ticketed ?? (await auth.authenticate(req).catch(() => null))
        if (!identity) return socket.close(1008, 'Unauthenticated')
        const user = await resolve(identity)
        const send = (event: TelephonyEvent) => socket.send(JSON.stringify(event))
        const unsubscribe = bus.subscribe(user.tenantId, user.id, send)
        const unsubscribeTenant = bus.subscribeTenant(user.tenantId, send)
        socket.on('close', () => {
          unsubscribe()
          unsubscribeTenant()
        })
        // The session is accepted: the client may read the state now (and reset its backoff), every change from
        // here on reaches it. Not an event; a socket closed before it is a failed attempt.
        socket.send(JSON.stringify({ type: 'stream.ready' }))
      })

      if (process.env.AUTH_MODE === 'dev') {
        // Dev only: simulate an incoming call to exercise the whole chain.
        v1.post<{ Body: { from: string } }>('/dev/incoming-call', async req => {
          const user = await whoIs(req)
          const call = { id: crypto.randomUUID(), direction: 'inbound' as const, state: 'ringing' as const, remoteNumber: req.body.from }
          bus.publish(user.tenantId, user.id, { type: 'call.ringing', timestamp: new Date().toISOString(), payload: { call } })
          return call
        })
      }
    },
    { prefix: '/api/v1' }
  )

  return app
}
