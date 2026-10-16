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

/** How long after `attempts` failed attempts the next one is due (0 to 10 % more, so that retries spread out). */
export const retryDelayMs = (attempts: number, baseMs = WEBHOOK_RETRY_BASE_MS, jitter = Math.random()) => Math.round(baseMs * 2 ** Math.max(0, attempts - 1) * (1 + 0.1 * jitter))

/** How long a subscription failing `failures` times in a row is paused: 30 s after 5, twice as long each time, 1 h at most. */
export const pauseMs = (failures: number, baseMs = 30_000, maxMs = 3_600_000) => Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures - WEBHOOK_BREAKER_FAILURES, 20)))

/**
 * Why an attempt failed, as kept in the log and put into words by the app: an answer that is not 2xx (`http`, its
 * status kept), a DeliveryError's reason, or a refusal before any request (`domain-not-allowed`: the organisation no
 * longer allows its host, or the scheme is no longer allowed; `secret-unreadable`: SECRETS_KEY changed). The store
 * records three more: `disabled` (its subscription was disabled while it waited), `backlog` (queued past
 * WEBHOOK_MAX_PENDING) and `abandoned` (its last attempt never came back).
 */
export type WebhookFailure = 'http' | DeliveryError['reason'] | 'domain-not-allowed' | 'secret-unreadable'

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
 * row, `pausedUntil` while its deliveries wait for the breaker. `previousSecretUntil`: the secret a new one replaced
 * still signs until then.
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
  /** Networks the operator opens to deliveries (WEBHOOK_PRIVATE_NETWORKS). */
  open?: BlockList
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
  /** Deliveries sent at the same time by this Gateway (default 16). */
  concurrency?: number
  /** Deliveries of one subscription in flight at most, whatever the Gateways (default 2). */
  perSubscription?: number
  /** Deliveries of one tenant in flight at most, whatever the Gateways (default 8). */
  perTenant?: number
  /** Pending deliveries a subscription has at most (default WEBHOOK_MAX_PENDING). */
  maxPending?: number
  /** How long a delivery taken is held before another Gateway may take it again (default 60 s, beyond a request's bound). */
  leaseMs?: number
  /** A request's bound (default 10 s), and that of its connection (default 3 s). */
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
  /** How often the deliveries past their retention are removed (default every hour). */
  purgeEveryMs?: number
  now?: () => number
  logger?: Logger
}

/**
 * The webhook hub of a Gateway (step 10a, ADR 0020): it queues the organisation's events for the subscriptions that
 * take them, and sends what is due, signed, at least once. The queue is in the database: any Gateway sends any
 * delivery, none takes one another holds, and one that stopped while sending leaves it due again at the end of its
 * lease. No tenant, no subscription takes more than its share of what is sent at once: one whose subscriber never
 * answers is paused, then disabled, and never delays the others. The queue is dated on the database's clock.
 */
export class WebhookHub {
  private readonly store: Store
  private readonly now: () => number
  private readonly pollMs: number
  private readonly concurrency: number
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly stateLeaseMs: number
  /** Who this Gateway is for the lease of WEBHOOK_STATE_ROLE. */
  readonly holder = `gw_${randomBytes(8).toString('hex')}`
  private logger: Logger
  private timer: ReturnType<typeof setTimeout> | undefined
  private purgeTimer: ReturnType<typeof setInterval> | undefined
  private leaseTimer: ReturnType<typeof setInterval> | undefined
  /** Stopped after it ran: a renewal still on its way takes no lease back. */
  private closed = false
  private running = false
  private stopped = true
  private again = false
  private inflight = new Set<Promise<void>>()
  /** The database's clock minus this one's (ms), read when the hub starts and with each renewal of the lease. */
  private skew = 0
  private lastStateAt = 0
  private leads = false
  private readonly leadListeners: (() => void)[] = []

  constructor(private readonly options: WebhookHubOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? 1_000
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

  useLogger(logger: Logger) {
    this.logger = logger
  }

  /** The time on the database's clock, as this Gateway reckons it. */
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

  /** `listener` runs each time this Gateway takes the lease (the app tells then what changed while it did not hold it). */
  onLead(listener: () => void) {
    this.leadListeners.push(listener)
  }

  private async readClock() {
    const before = this.now()
    const db = Date.parse(await this.store.clock())
    const after = this.now()
    this.skew = db - (before + after) / 2
  }

  /** Takes or renews the lease of WEBHOOK_STATE_ROLE (and reads the database's clock again). */
  async renewLease() {
    if (this.closed) return
    try {
      await this.readClock()
      const held = await this.store.takeWebhookLease(WEBHOOK_STATE_ROLE, this.holder, this.stateLeaseMs)
      const gained = held && !this.leads
      this.leads = held
      if (gained) {
        this.logger.info({ holder: this.holder }, 'webhook changes of state told by this Gateway')
        for (const listener of this.leadListeners) listener()
      }
    } catch (err) {
      this.leads = false
      this.logger.error({ err }, 'webhook lease not renewed')
    }
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

  private queueOptions(event: PublishedWebhookEvent) {
    const subjectUser = subjectOf(event)
    return { maxPending: this.options.maxPending ?? WEBHOOK_MAX_PENDING, ...(subjectUser ? { subjectUser } : {}) }
  }

  /** Queues an event for the subscriptions of the tenant that take it; sent soon. How many deliveries were queued. */
  async publish(tenantId: string, event: PublishedWebhookEvent): Promise<number> {
    if (!(await this.wants(tenantId, event.type))) return 0
    const n = await this.store.enqueueWebhookEvent(tenantId, event.id, event.type, JSON.stringify(event), this.iso(), this.queueOptions(event))
    if (n) this.nudge()
    return n
  }

  /**
   * Tells that `subject` is now `state`, once, whatever the Gateways that hear it (Store.setWebhookState): only the
   * one that holds the lease writes it, dated on the database's clock and later than anything it told before (a
   * change never goes back in time), with the event `make` gives for what it was before (null: none), in the same
   * transaction. How many deliveries were queued (none when the store already had this state, or another Gateway
   * took the lease meanwhile); null when the store was not asked: not the leader, or no subscription takes `types`.
   */
  async publishChange(tenantId: string, subject: string, state: string, types: WebhookEventType[], make: (previous: string | undefined, at: string) => PublishedWebhookEvent | null): Promise<number | null> {
    if (!this.leads || !(await this.wants(tenantId, ...types))) return null
    const t = Math.max(Math.floor(this.clock()), this.lastStateAt + 1)
    this.lastStateAt = t
    const at = this.iso(t)
    const out = await this.store.setWebhookState({ tenantId, subject, state, at, holder: this.holder }, previous => {
      const event = make(previous, at)
      if (!event || !types.includes(event.type)) return null
      const subjectUser = subjectOf(event)
      return { id: event.id, type: event.type, body: JSON.stringify(event), ...(subjectUser ? { subjectUser } : {}) }
    }, { maxPending: this.options.maxPending ?? WEBHOOK_MAX_PENDING })
    if (out?.queued) this.nudge()
    return out?.queued ?? 0
  }

  /** Queues a `webhook.test` for one subscription (whatever events it takes): the delivery, or null if it has none. */
  async test(tenantId: string, subscriptionId: string) {
    const event: WebhookEvent = { id: randomEventId(), type: 'webhook.test', occurred_at: this.iso(), tenant: tenantId, subscription: subscriptionId }
    const delivery = await this.store.enqueueWebhookDelivery(tenantId, subscriptionId, event.id, event.type, JSON.stringify(event), this.iso())
    if (delivery) this.nudge()
    return delivery
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.closed = false
    // The clock read and the lease taken before the first claim: the queue is dated on the database's clock.
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
  }

  /** Stops taking deliveries, and waits for those under way (their outcome recorded). The lease lapses by itself. */
  async stop() {
    this.stopped = true
    this.closed = true
    const led = this.leads
    this.leads = false
    clearTimeout(this.timer)
    clearInterval(this.purgeTimer)
    clearInterval(this.leaseTimer)
    // Its lease given back (ending now): another Gateway tells the changes from its next renewal, not 15 s later.
    if (led) await this.store.takeWebhookLease(WEBHOOK_STATE_ROLE, this.holder, 0).catch(() => undefined)
    while (this.inflight.size || this.running) await Promise.allSettled([...this.inflight, new Promise(r => setTimeout(r, 10))])
  }

  /** Something was queued: the queue is looked at now rather than at the next poll. */
  nudge() {
    if (this.stopped) return
    if (this.running) this.again = true
    else this.schedule(0)
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tick(), ms)
    this.timer.unref()
  }

  /** Takes what is due, as many as there is room for, and sends them; looks again at the next poll (or at once if nudged). */
  private async tick() {
    if (this.running || this.stopped) return
    this.running = true
    this.again = false
    try {
      const room = this.concurrency - this.inflight.size
      if (room > 0) {
        const now = this.clock()
        const claimed = await this.store.claimWebhookDeliveries(this.iso(now), this.iso(now + this.leaseMs), room, {
          perSubscription: this.options.perSubscription ?? 2,
          perTenant: this.options.perTenant ?? 8,
          maxAttempts: this.maxAttempts
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
              this.nudge()
            })
          this.inflight.add(p)
        }
        if (claimed.length === room) this.again = true
      }
    } catch (err) {
      this.logger.error({ err }, 'webhook deliveries not read')
    } finally {
      this.running = false
      this.schedule(this.again ? 0 : this.pollMs)
    }
  }

  private async attempt(d: ClaimedDelivery, domainsOf: (tenantId: string) => Promise<string[]>) {
    const failed = async (error: WebhookFailure, status?: number, retry = true) => {
      const retryAt = retry && d.attempts < this.maxAttempts ? this.iso(this.clock() + retryDelayMs(d.attempts, this.retryBaseMs)) : undefined
      if (!retryAt) this.logger.warn({ tenantId: d.tenantId, subscription: d.subscriptionId, delivery: d.id, attempts: d.attempts, error, ...(status !== undefined ? { status } : {}) }, 'webhook delivery failed for good')
      const health = await this.store.completeWebhookDelivery(d.id, d.claim, { delivered: false, at: this.iso(), ...(status !== undefined ? { status } : {}), error, ...(retryAt ? { retryAt } : {}) })
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
      ;({ status } = await post(d.url, d.body, headers, {
        timeoutMs: this.options.timeoutMs ?? 10_000,
        ...(this.options.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
        ...(this.options.open ? { open: this.options.open } : {}),
        ...(this.options.deny ? { deny: this.options.deny } : {}),
        ...(this.options.resolve ? { resolve: this.options.resolve } : {}),
        ...(this.options.ca ? { ca: this.options.ca } : {})
      }))
    } catch (err) {
      // An address the platform's network keeps out, or a redirect, is no passing failure: the administrator changes
      // the address. Anything else not classified is a connection that failed (retried, never left to its lease).
      if (!(err instanceof DeliveryError)) {
        this.logger.warn({ err, delivery: d.id }, 'webhook delivery failed unexpectedly')
        return failed('connection')
      }
      return failed(err.reason, undefined, err.reason !== 'destination-refused' && err.reason !== 'redirect')
    }
    if (status >= 200 && status < 300) await this.store.completeWebhookDelivery(d.id, d.claim, { delivered: true, at: this.iso(), status })
    else await failed('http', status)
  }

  /**
   * After a failure: a subscription failing WEBHOOK_BREAKER_FAILURES times in a row is paused (30 s, twice as long
   * each failure after, 1 h at most), and disabled once it has failed for disableAfterMs (a day), the administrators
   * alerted once.
   */
  private async breaker(d: ClaimedDelivery, health: WebhookHealth | null) {
    if (!health || health.failures < WEBHOOK_BREAKER_FAILURES) return
    const now = this.clock()
    const since = health.failingSince ? Date.parse(health.failingSince) : now
    if (now - since >= (this.options.disableAfterMs ?? WEBHOOK_DISABLE_AFTER_MS)) {
      if (!(await this.store.disableFailingWebhookSubscription(d.tenantId, d.subscriptionId, this.iso(now)))) return
      this.forget(d.tenantId)
      this.logger.warn({ tenantId: d.tenantId, subscription: d.subscriptionId, failures: health.failures, since: health.failingSince }, 'webhook subscription disabled: its deliveries failed for a day')
      await this.store.addAlert({ tenantId: d.tenantId, at: this.iso(now), alert: { kind: 'webhook', param: 'disabled', scope: 'tenant', value: health.failures } })
      return
    }
    await this.store.pauseWebhookSubscription(d.tenantId, d.subscriptionId, this.iso(now + pauseMs(health.failures, this.options.pauseBaseMs, this.options.pauseMaxMs)))
  }
}
