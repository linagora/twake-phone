import type { BlockList } from 'node:net'
import { WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_TYPES_LATER, type WebhookEvent, type WebhookEventType } from '@twake/telephony-types'
import { decrypt } from './crypto.js'
import { DeliveryError, SIGNATURE_HEADER, destinationAllowed, parseWebhookUrl, postWebhook, signWebhook, type DestinationPolicy, type PostOptions } from './webhook-delivery.js'
import { randomEventId } from './webhook-events.js'
import { WEBHOOK_RETENTION_DAYS, type ClaimedDelivery, type Store, type WebhookDeliveryRecord, type WebhookSubscriptionRecord } from './store/types.js'

/** Attempts of a delivery: the first and 8 retries (the plan), then it is failed. */
export const WEBHOOK_MAX_ATTEMPTS = 9
/** The wait before the first retry; each one after waits twice as long (30 s, 1 min, 2 min… 64 min: about 2 h in all). */
export const WEBHOOK_RETRY_BASE_MS = 30_000

/** How long after `attempts` failed attempts the next one is due (0 to 10 % more, so that retries spread out). */
export const retryDelayMs = (attempts: number, baseMs = WEBHOOK_RETRY_BASE_MS, jitter = Math.random()) => Math.round(baseMs * 2 ** Math.max(0, attempts - 1) * (1 + 0.1 * jitter))

/**
 * Why an attempt failed, as kept in the log and put into words by the app: an answer that is not 2xx (`http`, its
 * status kept), a DeliveryError's reason, or a refusal before any request (`domain-not-allowed`: the organisation no
 * longer allows its host, or the scheme is no longer allowed; `secret-unreadable`: SECRETS_KEY changed).
 */
export type WebhookFailure = 'http' | DeliveryError['reason'] | 'domain-not-allowed' | 'secret-unreadable' | 'disabled'

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

/** A subscription as the API shows it: never its secret. `deliverable`: its address is still among the allowed domains. */
export const publicSubscription = (w: WebhookSubscriptionRecord, domains: readonly string[], policy: DestinationPolicy) => ({
  id: w.id,
  url: w.url,
  events: w.events,
  ...(w.description ? { description: w.description } : {}),
  enabled: w.enabled,
  deliverable: destinationAllowed(w.url, domains, policy),
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
  /** How deliveries are sent (tests give their own); postWebhook by default. */
  post?: (url: string, body: string, headers: Record<string, string>, opts: PostOptions) => Promise<{ status: number }>
  /** The resolver of postWebhook (tests). */
  resolve?: PostOptions['resolve']
  /** How often the queue is looked at when nothing nudged it (default 1 s). */
  pollMs?: number
  /** Deliveries sent at the same time by this Gateway (default 16). */
  concurrency?: number
  /** How long a delivery taken is held before another Gateway may take it again (default 60 s, beyond a request's bound). */
  leaseMs?: number
  /** A request's bound (default 10 s). */
  timeoutMs?: number
  /** The first retry's wait (default 30 s; the tests shorten it). */
  retryBaseMs?: number
  maxAttempts?: number
  /** How often the deliveries past their retention are removed (default every hour). */
  purgeEveryMs?: number
  now?: () => number
  logger?: Logger
}

/**
 * The webhook hub of a Gateway (step 10a, ADR 0020): it queues the organisation's events for the subscriptions that
 * take them, and sends what is due, signed, at least once. The queue is in the database: any Gateway sends any
 * delivery, none takes one another holds, and one that stopped while sending leaves it due again at the end of its
 * lease.
 */
export class WebhookHub {
  private readonly store: Store
  private readonly now: () => number
  private readonly pollMs: number
  private readonly concurrency: number
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private logger: Logger
  private timer: ReturnType<typeof setTimeout> | undefined
  private purgeTimer: ReturnType<typeof setInterval> | undefined
  private running = false
  private stopped = true
  private again = false
  private inflight = new Set<Promise<void>>()

  constructor(private readonly options: WebhookHubOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? 1_000
    this.concurrency = options.concurrency ?? 16
    this.leaseMs = options.leaseMs ?? 60_000
    this.maxAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS
    this.retryBaseMs = options.retryBaseMs ?? WEBHOOK_RETRY_BASE_MS
    this.logger = options.logger ?? console
  }

  get policy(): DestinationPolicy {
    return this.options.policy ?? {}
  }

  useLogger(logger: Logger) {
    this.logger = logger
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString()
  }

  /**
   * The events some enabled subscription of the tenant takes, read again after WANTED_MS (a subscription another
   * Gateway made is heard within that time), or at once after a change made here: an event nobody takes (a presence,
   * most of the time) costs no write.
   */
  private readonly wanted = new Map<string, { at: number; types: Promise<Set<string>> }>()
  private wants(tenantId: string, type: string) {
    const kept = this.wanted.get(tenantId)
    if (kept && this.now() - kept.at < WANTED_MS) return kept.types.then(t => t.has(type))
    const types = this.store.listWebhookSubscriptions(tenantId).then(list => new Set(list.filter(s => s.enabled).flatMap(s => s.events as string[])))
    this.wanted.set(tenantId, { at: this.now(), types })
    types.catch(() => this.wanted.delete(tenantId))
    return types.then(t => t.has(type))
  }

  /** The subscriptions of the tenant changed: what they take is read again at the next event. */
  forget(tenantId: string) {
    this.wanted.delete(tenantId)
  }

  /** Queues an event for the subscriptions of the tenant that take it; sent soon. How many deliveries were queued. */
  async publish(tenantId: string, event: Exclude<WebhookEvent, { type: 'webhook.test' }>): Promise<number> {
    if (!(await this.wants(tenantId, event.type))) return 0
    const n = await this.store.enqueueWebhookEvent(tenantId, event.id, event.type, JSON.stringify(event), this.iso())
    if (n) this.nudge()
    return n
  }

  /**
   * Queues an event that says a state changed (a presence) only if it did as far as the subscribers know
   * (Store.setWebhookState): heard by every Gateway, it is told once. Nothing written when nobody takes it.
   */
  async publishChange(tenantId: string, subject: string, state: string, event: Exclude<WebhookEvent, { type: 'webhook.test' }>): Promise<number> {
    if (!(await this.wants(tenantId, event.type))) return 0
    if ((await this.store.setWebhookState(tenantId, subject, state, event.occurred_at)) === null) return 0
    return this.publish(tenantId, event)
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
    this.schedule(0)
    const purge = () =>
      void this.store.purgeWebhookDeliveries(this.iso(this.now() - WEBHOOK_RETENTION_DAYS * 86_400_000)).then(
        n => n && this.logger.info({ purged: n }, 'webhook deliveries past their retention removed'),
        (err: unknown) => this.logger.error({ err }, 'webhook deliveries not purged')
      )
    purge()
    this.purgeTimer = setInterval(purge, this.options.purgeEveryMs ?? 3_600_000)
    this.purgeTimer.unref()
  }

  /** Stops taking deliveries, and waits for those under way (their outcome recorded). */
  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearInterval(this.purgeTimer)
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
        const now = this.now()
        const claimed = await this.store.claimWebhookDeliveries(this.iso(now), this.iso(now + this.leaseMs), room)
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
    const failed = (error: WebhookFailure, status?: number, retry = true) => {
      const retryAt = retry && d.attempts < this.maxAttempts ? this.iso(this.now() + retryDelayMs(d.attempts, this.retryBaseMs)) : undefined
      if (!retryAt) this.logger.warn({ tenantId: d.tenantId, subscription: d.subscriptionId, delivery: d.id, attempts: d.attempts, error, ...(status !== undefined ? { status } : {}) }, 'webhook delivery failed for good')
      return this.store.completeWebhookDelivery(d.id, d.claim, { delivered: false, at: this.iso(), ...(status !== undefined ? { status } : {}), error, ...(retryAt ? { retryAt } : {}) })
    }
    // Checked again at each attempt: the organisation may have removed the domain since the subscription was made.
    if (!destinationAllowed(d.url, await domainsOf(d.tenantId), this.policy)) return void (await failed('domain-not-allowed', undefined, false))
    let secret: string
    try {
      secret = decrypt(d.secretEnc, this.options.key)
    } catch {
      return void (await failed('secret-unreadable', undefined, false))
    }
    const timestamp = Math.floor(this.now() / 1000)
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'TwakePhone-Webhooks/1.0',
      [SIGNATURE_HEADER]: signWebhook(secret, timestamp, d.body),
      'x-twakephone-event': d.eventType,
      'x-twakephone-event-id': d.eventId,
      'x-twakephone-delivery': d.id,
      'idempotency-key': d.eventId
    }
    try {
      const post = this.options.post ?? postWebhook
      const { status } = await post(d.url, d.body, headers, { timeoutMs: this.options.timeoutMs ?? 10_000, ...(this.options.open ? { open: this.options.open } : {}), ...(this.options.resolve ? { resolve: this.options.resolve } : {}) })
      if (status >= 200 && status < 300) await this.store.completeWebhookDelivery(d.id, d.claim, { delivered: true, at: this.iso(), status })
      else await failed('http', status)
    } catch (err) {
      if (!(err instanceof DeliveryError)) throw err
      // An address the platform's network keeps out is no passing failure: the administrator changes the address.
      await failed(err.reason, undefined, err.reason !== 'destination-refused')
    }
  }
}
