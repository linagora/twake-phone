import { createHmac, hkdfSync } from 'node:crypto'
import Fastify, { type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { splitParticipantId, verifyWebhook, type LiveKitConferenceBridge, type MeetApi, type MeetRoom } from '@twake/conference-livekit'
import type { MediaProvider, TelephonyProvider } from '@twake/telephony-provider-sdk'
import { EXTENSION_FORMAT, FRAUD_DEFAULTS, OUTBOUND_CAP_DEFAULTS, isReservedNumber, type CallDirection, type DidRange, type Endpoint, type ForwardingRules, type Presence, type PresenceStatus, type RingGroup, type TelephonyEvent, type User } from '@twake/telephony-types'
import { adminPolicyFromEnv, isAdmin, type AdminPolicy } from './admin.js'
import { authenticatorFromEnv, TicketStore, type Authenticator, type Identity } from './auth.js'
import { MAX_CONTACT_ID, MAX_FAVORITES, MAX_QUERY, MAX_SEARCH, RateLimiter, type ContactDirectory } from './contacts.js'
import { StoreDirectory, seedUserMap, type UserDirectory } from './directory.js'
import type { DirectorySync } from './directory-sync.js'
import { EventBus } from './events.js'
import { historyEntryFor } from './history.js'
import { ENDED_TTL_SEC, MISSED_TTL_SEC, type PushMessage, type WebPush } from './push.js'
import type { ProviderRegistry } from './registry.js'
import { securityHeadersFor, type SecurityOptions } from './security.js'
import { MAX_DIDS, MAX_TRUNKS, TRUNK_ID, defaultTrunk, parseDid, parseTrunk, providerTrunks, publicDid, publicTrunk, trunkRecord } from './trunks.js'
import { EMPTY_OUTBOUND, PROFILE_ID, outboundVersion, parseOutbound, staleOutbound, type Outbound } from './outbound.js'
import { MemoryStore } from './store/memory.js'
import { ALERT_RETENTION_DAYS, clampLimit, isMissed, type HistoryEntry, type HistoryQuery, type Store, type StoredAlert, type TrunkRecord, type UserPresenceRecord } from './store/types.js'

/** What the SIP server raises for the administrators (TelephonyAlert). */
const ALERT_KINDS = ['fraud-warning', 'fraud-critical', 'limit', 'rights', 'emergency'] as const
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
  /** Phone access to Meet rooms. Absent when no LiveKit is configured: the endpoints answer 501. */
  conference?: {
    bridge: (tenantId: string) => LiveKitConferenceBridge | undefined
    /** When present, Meet owns rooms, PINs and dial-in; the Gateway acts as a Meet application for the user. */
    meet?: MeetApi
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
  missed: isMissed(e)
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
  const trunkStatus = new Map<string, { at: number; answer: Promise<{ available: boolean; items: unknown[] }> }>()
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
      serializers: {
        // Tickets and dev tokens travel in the query string of the WebSocket: never log them.
        req: req => ({ method: req.method, url: req.url?.split('?')[0] })
      }
    }
  })
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
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-cozy-instance']
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
      return
    }
    trackOwner(tenantId, userId, event)
    // Recorded before it is told: the app reloads its history when it hears that a call ended. A database that
    // hangs holds the tenant's events for a few seconds at most, not for good.
    const entry = historyEntryFor(tenantId, userId, event)
    if (entry) await within(store.addHistory(entry), historyWriteMs, 'history write').catch(err => app.log.error({ err, callId: entry.callId }, 'could not record call history'))
    bus.publish(tenantId, userId, event)
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
  // The alerts past their retention go every hour (and once at start), whoever they belong to (step 6b).
  const purgeAlerts = () =>
    store.purgeAlerts(new Date(Date.now() - ALERT_RETENTION_DAYS * 86_400_000).toISOString()).then(
      n => {
        if (n) app.log.info({ purged: n }, 'alerts past their retention removed')
      },
      err => app.log.error({ err }, 'alerts not purged')
    )
  const alertPurge = setInterval(() => void purgeAlerts(), options.alertPurgeIntervalMs ?? 3_600_000)
  alertPurge.unref()
  app.addHook('onReady', async () => {
    void purgeAlerts()
  })
  app.addHook('onClose', async () => {
    closing = true
    clearInterval(alertPurge)
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
      // A number rings an extension someone holds, or a ring group of the tenant: nothing else; so does a fallback.
      const checkTarget = async (tenantId: string, provider: TelephonyProvider, field: string, target: string | undefined, code: string) => {
        if (!target || (await store.getMappingByExtension(tenantId, target))) return
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
        const tenantId = user.tenantId
        const kept = trunkStatus.get(tenantId)
        if (kept && Date.now() - kept.at < trunkStatusMs) return kept.answer
        // One read for every screen open within the window (the reads under way included); a failure is logged
        // when it starts and when it ends, not at every read of every open screen.
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
      })
      v1.put<{ Params: { id: string } }>('/admin/trunks/:id', async (req, reply) => {
        const user = await administrator(req)
        const apply = trunksOf(registry.forTenant(user.tenantId))
        const id = req.params.id
        if (!TRUNK_ID.test(id)) throw Object.assign(new Error('id: lower case letters, digits and dashes, 32 at most'), { statusCode: 400, code: 'TRUNK_INVALID' })
        const { record, created } = await inTurn(user.tenantId, async () => {
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
          return { record, created: !current }
        })
        // The state read before the change is no longer theirs: the screen reads it again at once.
        trunkStatus.delete(user.tenantId)
        return reply.code(created ? 201 : 200).send(publicTrunk(record))
      })
      v1.delete<{ Params: { id: string } }>('/admin/trunks/:id', async (req, reply) => {
        const user = await administrator(req)
        const apply = trunksOf(registry.forTenant(user.tenantId))
        await inTurn(user.tenantId, async () => {
          const records = await store.listTrunks(user.tenantId)
          if (!records.some(t => t.id === req.params.id)) throw notFound('trunk')
          // The default trunk gives its number to everyone without a direct number: never changed without a word.
          if (records.length > 1 && defaultTrunk(records)?.id === req.params.id)
            throw Object.assign(new Error('This is the default trunk: make another one the default first'), { statusCode: 409, code: 'TRUNK_DEFAULT' })
          // Its direct numbers go with it.
          const dids = (await store.listDids(user.tenantId)).filter(d => d.trunkId !== req.params.id).map(publicDid)
          await changeTrunks(user.tenantId, apply, records.filter(t => t.id !== req.params.id), dids, () => store.deleteTrunk(user.tenantId, req.params.id))
        })
        trunkStatus.delete(user.tenantId)
        return reply.code(204).send()
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

      // Right to erasure of one's own call history.
      v1.delete('/me/history', async (req, reply) => {
        const user = await whoIs(req)
        return reply.send({ deleted: await store.deleteHistory(user.tenantId, user.id) })
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
      const owned = async (req: FastifyRequest, meetingId: string) => {
        if (!MEETING_ID.test(meetingId)) throw bad('invalid meeting id')
        const ctx = await bridgeFor(req)
        const record = await store.getConference(meetingId)
        // Another tenant's room looks exactly like a missing one.
        if (!record || record.tenantId !== ctx.user.tenantId) throw Object.assign(new Error('Meeting not found'), { statusCode: 404 })
        // The claim is not enough: Meet must still grant this user access to the room (membership can be revoked).
        // Checked first, so someone without access cannot tell that the room exists.
        let room: MeetRoom | null = null
        if (options.conference?.meet) {
          room = await meetRoomFor(ctx.email, { id: record.meetingId })
          if (!room) throw Object.assign(new Error('Room not found, or not accessible to you'), { statusCode: 404 })
        }
        if (record.ownerUserId !== ctx.user.id) throw Object.assign(new Error('Only the owner of the meeting can do this'), { statusCode: 403 })
        return { ...ctx, record, room }
      }
      const publicDialIn = (bridge: LiveKitConferenceBridge, record: { meetingId: string; pin?: string }) => ({
        numbers: bridge.dialInNumbers,
        meetingCode: record.meetingId,
        ...(record.pin ? { pin: record.pin } : {})
      })

      // Opens the phone panel of a room. With Meet configured the room comes from Meet (existing room by slug, or a
      // new one with `create`), and Meet decides who may see it. Without Meet, any LiveKit room name can be adopted.
      v1.post<{ Body: { meetingId?: string; slug?: string; create?: boolean } }>('/conferences', async (req, reply) => {
        const { user, bridge, email } = await bridgeFor(req)
        const meet = options.conference?.meet
        let meetingId = req.body?.meetingId ?? ''
        let room: MeetRoom | null = null
        if (meet) {
          if (!email) throw bad('Your account has no email: Meet cannot identify you')
          if (req.body?.create) {
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
        } else if (!MEETING_ID.test(meetingId)) throw bad('invalid meeting id')

        const record = await store.claimConference({ tenantId: user.tenantId, meetingId, ownerUserId: user.id, createdAt: new Date().toISOString() })
        if (record.tenantId !== user.tenantId || record.ownerUserId !== user.id) throw Object.assign(new Error('Meeting already managed by someone else'), { statusCode: 409 })
        if (room) return reply.code(201).send({ meetingId, slug: room.slug, ...(room.url ? { url: room.url } : {}), dialIn: meetDialIn(room) })
        if (!record.pin) {
          const dialIn = await bridge.createDialIn({ id: meetingId, tenantId: user.tenantId })
          await store.setConferencePin(meetingId, dialIn.pin ?? null)
          record.pin = dialIn.pin
        }
        return reply.code(201).send({ meetingId, dialIn: publicDialIn(bridge, record) })
      })

      v1.get<{ Params: { id: string } }>('/conferences/:id', async req => {
        const { bridge, record, room } = await owned(req, req.params.id)
        if (room) {
          // The PIN and number are Meet's, read back each time so a rotation shows up here.
          return { meetingId: record.meetingId, slug: room.slug, ...(room.url ? { url: room.url } : {}), dialIn: meetDialIn(room), participants: await bridge.listParticipants(record.meetingId) }
        }
        return { meetingId: record.meetingId, dialIn: publicDialIn(bridge, record), participants: await bridge.listParticipants(record.meetingId) }
      })

      v1.delete<{ Params: { id: string } }>('/conferences/:id', async (req, reply) => {
        const { bridge, record } = await owned(req, req.params.id)
        // Meet owns its dial-in rules: only a Gateway-managed rule is removed here.
        if (!options.conference?.meet) await bridge.removeDialIn(record.meetingId)
        await store.deleteConference(record.meetingId)
        return reply.code(204).send()
      })

      v1.post<{ Params: { id: string }; Body: { number?: string } }>('/conferences/:id/participants', async (req, reply) => {
        const { bridge, record } = await owned(req, req.params.id)
        const participant = await bridge.dialParticipant(record.meetingId, (req.body?.number ?? '').trim())
        return reply.code(202).send(participant)
      })

      const participantAction = (method: 'delete' | 'post', path: string, run: (b: LiveKitConferenceBridge, pid: string) => Promise<void>) =>
        v1[method]<{ Params: { id: string; pid: string } }>(`/conferences/:id/participants/:pid${path}`, async (req, reply) => {
          const { bridge, record } = await owned(req, req.params.id)
          // The participant id embeds its room: refuse ids of another room so an owner cannot reach foreign rooms.
          if (splitParticipantId(req.params.pid).room !== record.meetingId) throw bad('participant does not belong to this meeting')
          await run(bridge, req.params.pid)
          return reply.code(204).send()
        })
      participantAction('delete', '', (b, pid) => b.disconnectParticipant(pid))
      participantAction('post', '/mute', (b, pid) => b.muteParticipant(pid))

      // LiveKit webhooks: authenticated by the signature, not by a Twake identity.
      v1.post('/webhooks/livekit', async (req, reply) => {
        const cfg = options.conference
        if (!cfg) return reply.code(501).send()
        const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? ''
        if (!verifyWebhook(cfg.webhookKey, cfg.webhookSecret, req.headers.authorization, raw)) return reply.code(401).send()
        const body = req.body as { room?: { name?: string } }
        const record = body.room?.name ? await store.getConference(body.room.name) : null
        const bridge = record && cfg.bridge(record.tenantId)
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
