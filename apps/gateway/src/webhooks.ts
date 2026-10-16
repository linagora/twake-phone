import { randomBytes } from 'node:crypto'
import type { BlockList } from 'node:net'
import { WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_TYPES_LATER, type WebhookEvent, type WebhookEventType } from '@twake/telephony-types'
import { decrypt } from './crypto.js'
import { DeliveryError, SIGNATURE_HEADER, destinationAllowed, parseWebhookUrl, postWebhook, signWebhook, type DestinationPolicy, type PostOptions } from './webhook-delivery.js'
import { randomEventId, type PublishedWebhookEvent } from './webhook-events.js'
import { WEBHOOK_RETENTION_DAYS, WEBHOOK_STATE_ROLE, type ClaimedDelivery, type Store, type WebhookDeliveryRecord, type WebhookHealth, type WebhookSubscriptionRecord } from './store/types.js'

/** Attempts of a delivery: the first and 8 retries (the plan), then it is failed. */
export const WEBHOOK_MAX_ATTEMPTS = 9
/** The wait before the first retry; each one after waits twice as long (30 s, 1 min, 2 min… 64 min: about 2 h in all). */
export const WEBHOOK_RETRY_BASE_MS = 30_000
/** Pending deliveries a subscription has at most: past them, an event is recorded failed (`backlog`), not sent. */
export const WEBHOOK_MAX_PENDING = 1_000
/** How long the secret a new one replaced still signs (a second `v1`). */
export const WEBHOOK_SECRET_GRACE_MS = 86_400_000
/** Attempts failed in a row after which a subscription is paused (its deliveries wait), then every failure after. */
export const WEBHOOK_BREAKER_FAILURES = 5
/** A subscription failing that long in a row is disabled, and the administrators alerted. */
export const WEBHOOK_DISABLE_AFTER_MS = 86_400_000
/** Tests and replays a subscription is asked at most per minute, whatever Gateway or administrator asks. */
export const WEBHOOK_SENDS_PER_MINUTE = 10
/** Tests and replays the subscriptions of one organisation are asked at most per minute, all together. */
export const WEBHOOK_TENANT_SENDS_PER_MINUTE = 30
/** A request's bound: a subscriber slower than that fails (and is paused by the breaker), never holding a place for long. */
export const WEBHOOK_TIMEOUT_MS = 5_000
/** A reading of the database's clock that took longer than that is not kept (WebhookHub.readClock). */
export const WEBHOOK_CLOCK_ROUND_TRIP_MS = 250

/** How long after `attempts` failed attempts the next one is due (0 to 10 % more, so that retries spread out). */
export const retryDelayMs = (attempts: number, baseMs = WEBHOOK_RETRY_BASE_MS, jitter = Math.random()) => Math.round(baseMs * 2 ** Math.max(0, attempts - 1) * (1 + 0.1 * jitter))

/** How long a subscription failing `failures` times in a row is paused: 30 s after 5, twice as long each time, 1 h at most. */
export const pauseMs = (failures: number, baseMs = 30_000, maxMs = 3_600_000) => Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures - WEBHOOK_BREAKER_FAILURES, 20)))

/**
 * Why an attempt failed, as kept in the log and put into words by the app: an answer that is not 2xx (`http`, its
 * status kept), no answer (`unreachable`: the name, the connection, TLS or the time; which one is in the server's
 * log only, no oracle of what listens where), an address the platform keeps out (`destination-refused`), a redirect,
 * or a refusal before any request (`domain-not-allowed`: the organisation no longer allows its host, or its scheme or
 * port is no longer allowed; `secret-unreadable`: SECRETS_KEY changed). The store records three more: `disabled` (its
 * subscription was disabled while it waited), `backlog` (queued past WEBHOOK_MAX_PENDING) and `abandoned` (its last
 * attempt never came back).
 */
export type WebhookFailure = 'http' | 'unreachable' | 'destination-refused' | 'redirect' | 'domain-not-allowed' | 'secret-unreadable'

/** What the log of deliveries says of a DeliveryError. */
export const deliveryFailure = (reason: DeliveryError['reason']): WebhookFailure => (reason === 'destination-refused' || reason === 'redirect' ? reason : 'unreachable')

/** What a subscription's secret is bound to (the AAD of its encryption): copied to another row, it does not decrypt. */
export const secretContext = (tenantId: string, subscriptionId: string) => `webhook|${tenantId}|${subscriptionId}`

/** The person an event is about, erased with their history (DELETE /me/history). */
const subjectOf = (event: PublishedWebhookEvent) => ('call' in event ? event.call.user : 'presence' in event ? event.presence.user : undefined)

/** How long what a tenant's subscriptions take is kept before it is read again (WebhookHub.wants). */
const WANTED_MS = 5_000
/** Subscriptions an organisation has at most. */
export const MAX_WEBHOOKS = 20
export const WEBHOOK_ID = /^wh_[0-9a-f]{16}$/
export const DELIVERY_ID = /^dlv_[0-9a-f]{32}$/
/** The cursor of a page of deliveries (`next`, `before`): the creation (ms) and id of the last one of the page. */
export const DELIVERY_CURSOR = /^([0-9]{1,15})-(dlv_[0-9a-f]{32})$/
const DESCRIPTION_MAX = 200
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * A subscription as an administrator writes it (POST /webhooks, PUT /webhooks/:id): an address among the allowed
 * domains, the events it takes (at least one, of those TwakePhone emits: each once, in the model's order), a
 * description of one line, and whether it is enabled (absent: as it was, enabled for a new one).
 */
export const parseSubscription = (body: unknown, domains: readonly string[], policy: DestinationPolicy): { url: string; events: WebhookEventType[]; description?: string; enabled?: boolean } => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('a subscription: url and events'), { statusCode: 400, code: 'WEBHOOK_INVALID' })
  const b = body as { url?: unknown; events?: unknown; description?: unknown; enabled?: unknown }
  const url = parseWebhookUrl(b.url, domains, policy)
  if (!Array.isArray(b.events) || !b.events.length) throw Object.assign(new Error('events: at least one of ' + WEBHOOK_EVENT_TYPES.join(', ')), { statusCode: 400, code: 'WEBHOOK_EVENTS' })
  for (const e of b.events) {
    if ((WEBHOOK_EVENT_TYPES_LATER as readonly unknown[]).includes(e)) throw Object.assign(new Error(`events: ${String(e)} is not emitted yet`), { statusCode: 400, code: 'WEBHOOK_EVENTS' })
    if (!(WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(e)) throw Object.assign(new Error(`events: ${String(e).slice(0, 40)} is none of ${WEBHOOK_EVENT_TYPES.join(', ')}`), { statusCode: 400, code: 'WEBHOOK_EVENTS' })
  }
  const events = WEBHOOK_EVENT_TYPES.filter(t => (b.events as unknown[]).includes(t))
  let description: string | undefined
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== 'string' || b.description.trim().length > DESCRIPTION_MAX || CONTROL.test(b.description)) throw Object.assign(new Error(`description: one line of ${DESCRIPTION_MAX} characters at most`), { statusCode: 400, code: 'WEBHOOK_DESCRIPTION' })
    description = b.description.trim() || undefined
  }
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw Object.assign(new Error('enabled: true or false'), { statusCode: 400, code: 'WEBHOOK_INVALID' })
  return { url, events, ...(description ? { description } : {}), ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}) }
}

/**
 * A subscription as the API shows it: never its secret. `deliverable`: its address is still among the allowed
 * domains. `disabledReason` 'failing': the platform disabled it (a day of failures). `failures`: attempts failed in a
 * row, `pausedUntil` while its deliveries wait for the breaker. `backlog`: events recorded failed since it was last
 * enabled or resumed (too many waiting), the latest at `backlogAt`. `previousSecretUntil`: the secret a new one
 * replaced still signs until then.
 */
export const publicSubscription = (w: WebhookSubscriptionRecord, domains: readonly string[], policy: DestinationPolicy, now = Date.now()) => ({
  id: w.id,
  url: w.url,
  events: w.events,
  ...(w.description ? { description: w.description } : {}),
  enabled: w.enabled,
  ...(w.disabledReason ? { disabledReason: w.disabledReason } : {}),
  deliverable: destinationAllowed(w.url, domains, policy),
  ...(w.failures ? { failures: w.failures } : {}),
  ...(w.pausedUntil && Date.parse(w.pausedUntil) > now ? { pausedUntil: w.pausedUntil } : {}),
  ...(w.backlog ? { backlog: w.backlog, ...(w.backlogAt ? { backlogAt: w.backlogAt } : {}) } : {}),
  ...(w.secretPrevUntil && Date.parse(w.secretPrevUntil) > now ? { previousSecretUntil: w.secretPrevUntil } : {}),
  createdAt: w.createdAt,
  updatedAt: w.updatedAt
})

/** A delivery as the log shows it: what, when, how it went; not the body (the subscriber has it). */
export const publicDelivery = (d: WebhookDeliveryRecord) => ({
  id: d.id,
  eventId: d.eventId,
  eventType: d.eventType,
  status: d.status,
  attempts: d.attempts,
  createdAt: d.createdAt,
  ...(d.status === 'pending' && d.nextAttemptAt ? { nextAttemptAt: d.nextAttemptAt } : {}),
  ...(d.lastAttemptAt ? { lastAttemptAt: d.lastAttemptAt } : {}),
  ...(d.lastStatus !== undefined ? { lastStatus: d.lastStatus } : {}),
  ...(d.lastError ? { lastError: d.lastError } : {}),
  ...(d.deliveredAt ? { deliveredAt: d.deliveredAt } : {})
})

type Logger = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }

export interface WebhookHubOptions {
  store: Store
  /** SECRETS_KEY: the subscriptions' secrets are kept encrypted with it. */
  key: Buffer
  policy?: DestinationPolicy
  /**
   * Networks the operator opens to the deliveries of each organisation (WEBHOOK_PRIVATE_NETWORKS, parseTenantNetworks),
   * never to the others'. A BlockList alone opens its networks to every one (tests).
   */
  open?: BlockList | ReadonlyMap<string, BlockList>
  /** Addresses no delivery reaches (WEBHOOK_DENY_NETWORKS, this host's own). */
  deny?: BlockList
  /** How deliveries are sent (tests give their own); postWebhook by default. */
  post?: (url: string, body: string, headers: Record<string, string>, opts: PostOptions) => Promise<{ status: number }>
  /** The resolver of postWebhook (tests). */
  resolve?: PostOptions['resolve']
  /** Certificates postWebhook trusts besides the system's (tests). */
  ca?: PostOptions['ca']
  /** How often the queue is looked at when nothing nudged it (default 1 s). */
  pollMs?: number
  /** How long after a delivery ended the queue is looked at again (default 25 ms): those ended meanwhile are claimed together. */
  batchMs?: number
  /** Deliveries sent at the same time by this Gateway (default 16). */
  concurrency?: number
  /** Deliveries of one subscription in flight at most, whatever the Gateways (default 2). */
  perSubscription?: number
  /**
   * Deliveries of one tenant in flight at most, whatever the Gateways (default a quarter of `concurrency`, 4): two
   * tenants whose subscribers answer slowly hold half of one Gateway at most, never all of it.
   */
  perTenant?: number
  /** Pending deliveries a subscription has at most (default WEBHOOK_MAX_PENDING). */
  maxPending?: number
  /** How long a delivery taken is held before another Gateway may take it again (default 60 s, beyond a request's bound). */
  leaseMs?: number
  /**
   * A request's bound (default 5 s: a subscriber slower than that fails, and its breaker pauses it), and that of its
   * connection (default 3 s).
   */
  timeoutMs?: number
  connectTimeoutMs?: number
  /** The first retry's wait (default 30 s; the tests shorten it). */
  retryBaseMs?: number
  maxAttempts?: number
  /** The first pause of a failing subscription (default 30 s), its longest (1 h), and when it is disabled (a day). */
  pauseBaseMs?: number
  pauseMaxMs?: number
  disableAfterMs?: number
  /** How long the lease of WEBHOOK_STATE_ROLE is taken for (default 15 s, renewed every third of it). */
  stateLeaseMs?: number
  /**
   * Whether this Gateway hears what it would tell (the event streams of its providers are up): one that does not
   * gives the lease to one that does (Store.takeWebhookLease), and tells again what it knows once it hears again.
   */
  healthy?: () => boolean
  /** How often the deliveries past their retention are removed (default every hour). */
  purgeEveryMs?: number
  /** How often the deliveries whose last attempt never came back are failed (default every minute). */
  sweepEveryMs?: number
  /** Events being queued at the same time (default 16), and waiting to be (default 1 000: past them, dropped and logged). */
  publishConcurrency?: number
  publishQueue?: number
  /** How long after an alert of a subscription's backlog another one is raised for it (default an hour). */
  backlogAlertMs?: number
  now?: () => number
  logger?: Logger
}

/**
 * The webhook hub of a Gateway (step 10a, ADR 0020): it queues the organisation's events for the subscriptions that
 * take them, and sends what is due, signed, at least once. The queue is in the database, dated on its clock: any
 * Gateway sends any delivery, none takes one another holds, and one that stopped while sending leaves it due again at
 * the end of its lease. No tenant, no subscription takes more than its share of what is sent at once: one whose
 * subscriber never answers, or answers slowly, is paused, then disabled, and never delays the others.
 */
export class WebhookHub {
  private readonly store: Store
  private readonly now: () => number
  private readonly pollMs: number
  private readonly batchMs: number
  private readonly concurrency: number
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly stateLeaseMs: number
  /** Who this Gateway is for the lease of WEBHOOK_STATE_ROLE. */
  readonly holder = `gw_${randomBytes(8).toString('hex')}`
  private logger: Logger
  private timer: ReturnType<typeof setTimeout> | undefined
  /** When the queue is looked at next (this clock), while a look is scheduled. */
  private dueAt = Infinity
  private purgeTimer: ReturnType<typeof setInterval> | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private leaseTimer: ReturnType<typeof setInterval> | undefined
  /** Stopped: a renewal still on its way takes no lease back. */
  private closed = false
  /** Not looking at the queue (before start(), after stop()). */
  private stopped = true
  private running = false
  private again = false
  private inflight = new Set<Promise<void>>()
  /** The renewal under way: one at a time, awaited by stop(). */
  private renewal: Promise<void> | undefined
  /** What onLead's listeners tell under way, awaited by stop() too; another round asked meanwhile. */
  private telling: Promise<void> | undefined
  private tellPending = false
  /** The database's clock minus this one's (ms): the signatures' `t` only (the queue is dated by the database). */
  private skew = 0
  private skewRead = false
  private leads = false
  private heard = true
  private readonly leadListeners: (() => void | Promise<void>)[] = []
  /** The events being queued, and those waiting to be (publish, publishChange): bounded. */
  private publishing = 0
  private readonly publishWaiting: (() => void)[] = []
  private dropped = 0
  private readonly backlogAlerted = new Map<string, number>()

  constructor(private readonly options: WebhookHubOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? 1_000
    this.batchMs = options.batchMs ?? 25
    this.concurrency = options.concurrency ?? 16
    this.leaseMs = options.leaseMs ?? 60_000
    this.maxAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS
    this.retryBaseMs = options.retryBaseMs ?? WEBHOOK_RETRY_BASE_MS
    this.stateLeaseMs = options.stateLeaseMs ?? 15_000
    this.logger = options.logger ?? console
  }

  get policy(): DestinationPolicy {
    return this.options.policy ?? {}
  }

  /** Deliveries of one tenant in flight at most, whatever the Gateways. */
  get perTenant() {
    return this.options.perTenant ?? Math.max(1, Math.floor(this.concurrency / 4))
  }

  useLogger(logger: Logger) {
    this.logger = logger
  }

  /** The time on the database's clock, as this Gateway reckons it (the signatures' `t`, the events' occurred_at). */
  clock() {
    return this.now() + this.skew
  }

  private iso(ms = this.clock()) {
    return new Date(ms).toISOString()
  }

  /**
   * Whether this Gateway tells the changes of state (presences, trunks) of every tenant now: it holds the lease of
   * WEBHOOK_STATE_ROLE. The others hear the same changes and leave them to it.
   */
  get leading() {
    return this.leads
  }

  /**
   * `listener` runs each time this Gateway takes the lease, and when it hears its events again while it holds it
   * (the app tells then what changed meanwhile). Awaited: one renewal at a time.
   */
  onLead(listener: () => void | Promise<void>) {
    this.leadListeners.push(listener)
  }

  /**
   * The database's clock read again, on the store's connection of its own: a reading whose round trip took longer
   * than WEBHOOK_CLOCK_ROUND_TRIP_MS is not kept (a wait for the connection would skew it), unless none was yet.
   */
  private async readClock() {
    const before = this.now()
    const db = Date.parse(await this.store.clock())
    const after = this.now()
    if (after - before > WEBHOOK_CLOCK_ROUND_TRIP_MS && this.skewRead) return
    this.skew = db - (before + after) / 2
    this.skewRead = true
  }

  /** Takes or renews the lease of WEBHOOK_STATE_ROLE (and reads the database's clock again): one renewal at a time. */
  renewLease(): Promise<void> {
    this.renewal ??= this.renew().finally(() => (this.renewal = undefined))
    return this.renewal
  }

  private async renew() {
    if (this.closed) return
    try {
      await this.readClock()
      if (this.closed) return
      const healthy = this.options.healthy?.() ?? true
      const held = await this.store.takeWebhookLease(WEBHOOK_STATE_ROLE, this.holder, this.stateLeaseMs, healthy)
      // Stopped meanwhile: the lease it renewed is given back (stop() waits for this renewal).
      if (this.closed) return
      const gained = held && !this.leads
      const heardAgain = held && !gained && healthy && !this.heard
      this.leads = held
      this.heard = healthy
      if (gained) this.logger.info({ holder: this.holder, healthy }, 'webhook changes of state told by this Gateway')
      if (heardAgain) this.logger.info({ holder: this.holder }, 'webhook changes of state heard again: what is known is told')
      // Told apart from the renewal (which goes on every third of the lease meanwhile, however long this takes).
      if (gained || heardAgain) this.tellAgain()
    } catch (err) {
      this.leads = false
      this.logger.error({ err }, 'webhook lease not renewed')
    }
  }

  /** Runs the listeners of onLead, one round at a time (another asked meanwhile runs after it). */
  private tellAgain() {
    if (this.telling) {
      this.tellPending = true
      return
    }
    this.telling = (async () => {
      do {
        this.tellPending = false
        for (const listener of this.leadListeners) {
          if (this.closed || !this.leads) return
          await Promise.resolve()
            .then(listener)
            .catch((err: unknown) => this.logger.error({ err }, 'webhook changes of state not told again'))
        }
      } while (this.tellPending)
    })().finally(() => (this.telling = undefined))
  }

  /**
   * The events some enabled subscription of the tenant takes, read again after WANTED_MS (a subscription another
   * Gateway made is heard within that time), or at once after a change made here: an event nobody takes (a presence,
   * most of the time) costs no write.
   */
  private readonly wanted = new Map<string, { at: number; types: Promise<Set<string>> }>()
  private wantedTypes(tenantId: string) {
    const kept = this.wanted.get(tenantId)
    if (kept && this.now() - kept.at < WANTED_MS) return kept.types
    const types = this.store.listWebhookSubscriptions(tenantId).then(list => new Set(list.filter(s => s.enabled).flatMap(s => s.events as string[])))
    this.wanted.set(tenantId, { at: this.now(), types })
    types.catch(() => this.wanted.delete(tenantId))
    return types
  }

  /** Whether some enabled subscription of the tenant takes one of `types`. */
  async wants(tenantId: string, ...types: WebhookEventType[]) {
    const wanted = await this.wantedTypes(tenantId)
    return types.some(t => wanted.has(t))
  }

  /** The subscriptions of the tenant changed: what they take is read again at the next event. */
  forget(tenantId: string) {
    this.wanted.delete(tenantId)
  }

  /**
   * Runs `task` once one of publishConcurrency places is free, or drops it (`dropped`, logged once every so many)
   * when publishQueue wait already: a database that slows down never piles up the events of every stream.
   */
  private async bounded<T>(task: () => Promise<T>, dropped: T): Promise<T> {
    if (this.publishing >= (this.options.publishConcurrency ?? 16)) {
      if (this.publishWaiting.length >= (this.options.publishQueue ?? 1_000)) {
        if (this.dropped++ % 100 === 0) this.logger.warn({ dropped: this.dropped }, 'webhook events dropped: too many waiting to be queued')
        return dropped
      }
      await new Promise<void>(resolve => this.publishWaiting.push(resolve))
    } else this.publishing++
    try {
      return await task()
    } finally {
      const next = this.publishWaiting.shift()
      if (next) next()
      else this.publishing--
    }
  }

  /** The events or deliveries recorded failed (`backlog`): the administrators are alerted, once an hour per subscription. */
  private backlogged(tenantId: string, subscriptionIds: string[]) {
    const now = this.now()
    const every = this.options.backlogAlertMs ?? 3_600_000
    for (const id of subscriptionIds) {
      const last = this.backlogAlerted.get(id)
      if (last !== undefined && now - last < every) continue
      this.backlogAlerted.set(id, now)
      this.logger.warn({ tenantId, subscription: id }, 'webhook events not queued: the subscription has too many waiting')
      void this.store
        .addAlert({ tenantId, at: this.iso(), alert: { kind: 'webhook', param: 'backlog', scope: 'tenant', value: this.options.maxPending ?? WEBHOOK_MAX_PENDING } })
        .catch((err: unknown) => this.logger.error({ err, tenantId }, 'webhook backlog alert not recorded'))
    }
  }

  private queueOptions(tenantId: string, subjectUser?: string) {
    return { maxPending: this.options.maxPending ?? WEBHOOK_MAX_PENDING, onBacklog: (ids: string[]) => this.backlogged(tenantId, ids), ...(subjectUser ? { subjectUser } : {}) }
  }

  /**
   * Queues an event for the subscriptions of the tenant that take it; sent soon. How many deliveries were queued (0
   * when it was dropped: too many waiting).
   */
  publish(tenantId: string, event: PublishedWebhookEvent): Promise<number> {
    return this.bounded(async () => {
      if (!(await this.wants(tenantId, event.type))) return 0
      const n = await this.store.enqueueWebhookEvent(tenantId, event.id, event.type, JSON.stringify(event), undefined, this.queueOptions(tenantId, subjectOf(event)))
      if (n) this.nudge()
      return n
    }, 0)
  }

  /**
   * Tells that `subject` is now `state`, once, whatever the Gateways that hear it (Store.setWebhookState): only the
   * one that holds the lease writes it, dated on the database's clock and later than anything told before (a change
   * never goes back in time), with the event `make` gives for what it was before (null: none) at that date, in the
   * same transaction. How many deliveries were queued (none when the store already had this state, or another Gateway
   * took the lease meanwhile); null when the store was not asked: not the leader, no subscription takes `types`, or
   * too many events waiting (dropped).
   */
  publishChange(tenantId: string, subject: string, state: string, types: WebhookEventType[], make: (previous: string | undefined, at: string) => PublishedWebhookEvent | null): Promise<number | null> {
    if (!this.leads) return Promise.resolve(null)
    return this.bounded(async () => {
      if (!this.leads || !(await this.wants(tenantId, ...types))) return null
      const out = await this.store.setWebhookState(
        { tenantId, subject, state, holder: this.holder },
        (previous, at) => {
          const event = make(previous, at)
          if (!event || !types.includes(event.type)) return null
          const subjectUser = subjectOf(event)
          return { id: event.id, type: event.type, body: JSON.stringify(event), ...(subjectUser ? { subjectUser } : {}) }
        },
        this.queueOptions(tenantId)
      )
      if (out?.queued) this.nudge()
      return out?.queued ?? 0
    }, null)
  }

  /**
   * Queues a `webhook.test` for one subscription (whatever events it takes), and lifts its pause (an administrator
   * who repaired the subscriber checks it now, not in an hour): the delivery, `full` when it has WEBHOOK_MAX_PENDING
   * waiting already, or null if it has none of that id.
   */
  async test(tenantId: string, subscriptionId: string) {
    const event: WebhookEvent = { id: randomEventId(), type: 'webhook.test', occurred_at: this.iso(), tenant: tenantId, subscription: subscriptionId }
    const delivery = await this.store.enqueueWebhookDelivery(tenantId, subscriptionId, event.id, event.type, JSON.stringify(event), undefined, this.options.maxPending ?? WEBHOOK_MAX_PENDING)
    if (delivery && delivery !== 'full') await this.unpause(tenantId, subscriptionId)
    return delivery
  }

  /**
   * Sends a delivery again (Store.replayWebhookDelivery), lifting its subscription's pause as a test does: the
   * delivery, `pending` (it still is), `full`, or null.
   */
  async replay(tenantId: string, subscriptionId: string, id: string) {
    const replayed = await this.store.replayWebhookDelivery(tenantId, subscriptionId, id, undefined, this.options.maxPending ?? WEBHOOK_MAX_PENDING)
    if (replayed && typeof replayed !== 'string') await this.unpause(tenantId, subscriptionId)
    return replayed
  }

  /**
   * Starts a subscription afresh without closing what it waits to send (Store.resumeWebhookSubscription): no pause,
   * no failures counted. False when the tenant has none of that id.
   */
  async resume(tenantId: string, subscriptionId: string) {
    if (!(await this.store.resumeWebhookSubscription(tenantId, subscriptionId))) return false
    this.backlogAlerted.delete(subscriptionId)
    this.nudge()
    return true
  }

  private async unpause(tenantId: string, subscriptionId: string) {
    await this.store.pauseWebhookSubscription(tenantId, subscriptionId, null)
    this.nudge()
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.closed = false
    // The clock read and the lease taken before the first claim.
    void this.renewLease().finally(() => this.schedule(0))
    this.leaseTimer = setInterval(() => void this.renewLease(), Math.max(50, Math.floor(this.stateLeaseMs / 3)))
    this.leaseTimer.unref()
    const purge = () =>
      void this.store.purgeWebhookDeliveries(this.iso(this.clock() - WEBHOOK_RETENTION_DAYS * 86_400_000)).then(
        n => n && this.logger.info({ purged: n }, 'webhook deliveries past their retention removed'),
        (err: unknown) => this.logger.error({ err }, 'webhook deliveries not purged')
      )
    purge()
    this.purgeTimer = setInterval(purge, this.options.purgeEveryMs ?? 3_600_000)
    this.purgeTimer.unref()
    const sweep = () =>
      void this.sweep().catch((err: unknown) => this.logger.error({ err }, 'webhook deliveries abandoned not failed'))
    sweep()
    this.sweepTimer = setInterval(sweep, this.options.sweepEveryMs ?? 60_000)
    this.sweepTimer.unref()
  }

  /** Fails the deliveries whose last attempt never came back (Store.sweepWebhookDeliveries): how many. */
  async sweep() {
    const n = await this.store.sweepWebhookDeliveries(this.maxAttempts)
    if (n) this.logger.warn({ abandoned: n }, 'webhook deliveries failed: their last attempt never came back')
    return n
  }

  /**
   * Stops taking deliveries, and waits for those under way (their outcome recorded). The lease is given back (another
   * Gateway tells the changes from its next renewal, not 15 s later), once the renewal under way, if any, ended.
   */
  async stop() {
    this.stopped = true
    this.closed = true
    clearTimeout(this.timer)
    this.dueAt = Infinity
    clearInterval(this.purgeTimer)
    clearInterval(this.sweepTimer)
    clearInterval(this.leaseTimer)
    await this.renewal
    const led = this.leads
    this.leads = false
    await this.telling
    if (led) await this.store.takeWebhookLease(WEBHOOK_STATE_ROLE, this.holder, 0).catch(() => undefined)
    while (this.inflight.size || this.running) await Promise.allSettled([...this.inflight, new Promise(r => setTimeout(r, 10))])
  }

  /**
   * Something was queued (`ms` 0), or a delivery ended (batchMs): the queue is looked at then rather than at the
   * next poll, those ended meanwhile claimed together.
   */
  nudge(ms = 0) {
    if (this.stopped) return
    if (this.running) this.again = true
    else if (this.now() + ms < this.dueAt) this.schedule(ms)
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    this.dueAt = Infinity
    if (this.stopped) return
    this.dueAt = this.now() + ms
    this.timer = setTimeout(() => {
      this.dueAt = Infinity
      void this.tick()
    }, ms)
    this.timer.unref()
  }

  /** Takes what is due, as many as there is room for, and sends them; looks again at the next poll (or soon if nudged). */
  private async tick() {
    if (this.running || this.stopped) return
    this.running = true
    this.again = false
    try {
      const room = this.concurrency - this.inflight.size
      if (room > 0) {
        const claimed = await this.store.claimWebhookDeliveries(room, {
          perSubscription: this.options.perSubscription ?? 2,
          perTenant: this.perTenant,
          maxAttempts: this.maxAttempts,
          leaseMs: this.leaseMs
        })
        const domains = new Map<string, Promise<string[]>>()
        const domainsOf = (tenantId: string) => {
          let d = domains.get(tenantId)
          if (!d) domains.set(tenantId, (d = this.store.getWebhookDomains(tenantId)))
          return d
        }
        for (const d of claimed) {
          const p: Promise<void> = this.attempt(d, domainsOf)
            .catch((err: unknown) => this.logger.error({ err, delivery: d.id }, 'webhook delivery not recorded'))
            .finally(() => {
              this.inflight.delete(p)
              this.nudge(this.batchMs)
            })
          this.inflight.add(p)
        }
        if (claimed.length === room) this.again = true
      }
    } catch (err) {
      this.logger.error({ err }, 'webhook deliveries not read')
    } finally {
      this.running = false
      this.schedule(this.again ? this.batchMs : this.pollMs)
    }
  }

  /** The networks the operator opened to the deliveries of `tenantId`. */
  private openTo(tenantId: string): BlockList | undefined {
    const open = this.options.open
    if (!open) return undefined
    return 'check' in open ? open : open.get(tenantId)
  }

  private async attempt(d: ClaimedDelivery, domainsOf: (tenantId: string) => Promise<string[]>) {
    const failed = async (error: WebhookFailure, status?: number, retry = true) => {
      const again = retry && d.attempts < this.maxAttempts
      if (!again) this.logger.warn({ tenantId: d.tenantId, subscription: d.subscriptionId, delivery: d.id, attempts: d.attempts, error, ...(status !== undefined ? { status } : {}) }, 'webhook delivery failed for good')
      const health = await this.store.completeWebhookDelivery(d.id, d.claim, { delivered: false, ...(status !== undefined ? { status } : {}), error, ...(again ? { retryInMs: retryDelayMs(d.attempts, this.retryBaseMs) } : {}) })
      await this.breaker(d, health)
    }
    // Checked again at each attempt: the organisation may have removed the domain since the subscription was made.
    if (!destinationAllowed(d.url, await domainsOf(d.tenantId), this.policy)) return failed('domain-not-allowed', undefined, false)
    const secrets: string[] = []
    try {
      secrets.push(decrypt(d.secretEnc, this.options.key, secretContext(d.tenantId, d.subscriptionId)))
    } catch {
      return failed('secret-unreadable', undefined, false)
    }
    // The secret it replaced, for a day: unreadable, it is left out (the current one signs).
    if (d.secretPrevEnc) {
      try {
        secrets.push(decrypt(d.secretPrevEnc, this.options.key, secretContext(d.tenantId, d.subscriptionId)))
      } catch {
        // left out
      }
    }
    const timestamp = Math.floor(this.clock() / 1000)
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'TwakePhone-Webhooks/1.0',
      [SIGNATURE_HEADER]: signWebhook(secrets, timestamp, d.body),
      'x-twakephone-event': d.eventType,
      'x-twakephone-event-id': d.eventId,
      'x-twakephone-delivery': d.id,
      'idempotency-key': d.eventId
    }
    let status: number
    try {
      const post = this.options.post ?? postWebhook
      const open = this.openTo(d.tenantId)
      ;({ status } = await post(d.url, d.body, headers, {
        timeoutMs: this.options.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
        ...(this.options.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
        ...(open ? { open } : {}),
        ...(this.options.deny ? { deny: this.options.deny } : {}),
        ...(this.options.resolve ? { resolve: this.options.resolve } : {}),
        ...(this.options.ca ? { ca: this.options.ca } : {})
      }))
    } catch (err) {
      // An address the platform's network keeps out, or a redirect, is no passing failure: the administrator changes
      // the address. Anything else not classified is a connection that failed (retried, never left to its lease).
      // What failed exactly is in this log, not in that of the deliveries (no oracle of what listens where).
      const reason = err instanceof DeliveryError ? err.reason : 'connection'
      this.logger.warn({ ...(err instanceof DeliveryError ? { reason } : { err }), tenantId: d.tenantId, subscription: d.subscriptionId, delivery: d.id }, 'webhook delivery attempt failed')
      return failed(deliveryFailure(reason), undefined, reason !== 'destination-refused' && reason !== 'redirect')
    }
    if (status >= 200 && status < 300) await this.store.completeWebhookDelivery(d.id, d.claim, { delivered: true, status })
    else await failed('http', status)
  }

  /**
   * After a failure: a subscription failing WEBHOOK_BREAKER_FAILURES times in a row is paused (30 s, twice as long
   * each failure after, 1 h at most), and disabled once it has failed for disableAfterMs (a day), the administrators
   * alerted once. Reckoned on the database's clock (the time of the outcome).
   */
  private async breaker(d: ClaimedDelivery, health: WebhookHealth | null) {
    if (!health || health.failures < WEBHOOK_BREAKER_FAILURES) return
    const now = Date.parse(health.at)
    const since = health.failingSince ? Date.parse(health.failingSince) : now
    if (now - since >= (this.options.disableAfterMs ?? WEBHOOK_DISABLE_AFTER_MS)) {
      if (!(await this.store.disableFailingWebhookSubscription(d.tenantId, d.subscriptionId, health.at))) return
      this.forget(d.tenantId)
      this.logger.warn({ tenantId: d.tenantId, subscription: d.subscriptionId, failures: health.failures, since: health.failingSince }, 'webhook subscription disabled: its deliveries failed for a day')
      await this.store.addAlert({ tenantId: d.tenantId, at: health.at, alert: { kind: 'webhook', param: 'disabled', scope: 'tenant', value: health.failures } })
      return
    }
    await this.store.pauseWebhookSubscription(d.tenantId, d.subscriptionId, this.iso(now + pauseMs(health.failures, this.options.pauseBaseMs, this.options.pauseMaxMs)))
  }
}
