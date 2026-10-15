import type { Agent } from 'node:https'
import webpush from 'web-push'
import { decrypt, encrypt } from './crypto.js'
import type { PushSubscriptionRecord, Store } from './store/types.js'

// Web Push (step 5, ADR 0015): a browser whose person agreed to it is told of a call for them while no window of the
// app is open (RFC 8030), by its push service, with a message encrypted for that browser alone (aes128gcm, RFC 8291)
// and signed with the Gateway's VAPID keys (RFC 8292). The `web-push` library does the encryption and the signing.

/** The push services of the browsers the app supports: Chromium (FCM), Firefox (Mozilla), Edge (WNS), Safari (Apple). */
export const DEFAULT_PUSH_SERVICES = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '*.notify.windows.com', '*.push.apple.com']
/** Subscriptions kept per person (their browsers): the oldest goes beyond. */
export const PUSH_SUBSCRIPTIONS_MAX = 10
/** How long a push service may take to take a message. */
const SEND_TIMEOUT_MS = 5_000
/** How long a missed call waits at the push service for a browser that is off. */
export const MISSED_TTL_SEC = 12 * 3600
const ENDPOINT_MAX = 1024

/** What a notification shows, and the call it is about. Nothing else travels: no secret, no address. */
export type PushMessage =
  | { type: 'call'; callId: string; number: string; name?: string; group?: { number: string; name?: string }; until: number }
  | { type: 'missed'; callId: string; number: string; name?: string; group?: { number: string; name?: string } }

export interface PushLogger {
  warn: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

export interface WebPushOptions {
  store: Store
  /** SECRETS_KEY: encrypts the VAPID private key the Gateway makes for itself. */
  key?: Buffer
  /** VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (base64url): given, they are used as they are and never stored. */
  vapid?: { publicKey: string; privateKey: string }
  /** VAPID_SUBJECT: how the push services reach whoever runs this Gateway (`mailto:` or `https:`). */
  subject: string
  /** Push service hosts allowed (`*.` for any subdomain); the browsers' own by default. Always over HTTPS. */
  services?: string[]
  /** Test seam: which endpoints are accepted, instead of `services`. */
  allowEndpoint?: (url: URL) => boolean
  /** Test seam: the HTTPS agent to the push services (a test service with its own certificate). */
  agent?: Agent
  /** PUSH_PROXY: an HTTP proxy to reach the push services. */
  proxy?: string
  timeoutMs?: number
  logger?: PushLogger
}

const bad = (code: string, message: string) => Object.assign(new Error(message), { statusCode: 400, code })
const base64url = (value: unknown, bytes: number, first?: number) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null
  const raw = Buffer.from(value, 'base64url')
  if (raw.length !== bytes || (first !== undefined && raw[0] !== first)) return null
  return raw.toString('base64url')
}

/** Whether `host` is one of `patterns` ("*.example.test": any subdomain of it, not itself). */
export const hostAllowed = (host: string, patterns: readonly string[]) =>
  patterns.some(p => (p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p))

/** The services of PUSH_SERVICES (comma-separated host names, `*.` allowed), or the default ones. */
export const parsePushServices = (value: string | undefined) => {
  const list = (value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  for (const h of list) if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) throw new Error(`PUSH_SERVICES: ${h} is not a host name`)
  return list.length ? list : DEFAULT_PUSH_SERVICES
}

/** The VAPID subject, checked as the push services want it: `mailto:` or `https:`. */
export const parseVapidSubject = (value: string) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL')
  }
  if (url.protocol !== 'mailto:' && url.protocol !== 'https:') throw new Error('VAPID_SUBJECT must be a mailto: or https: URL')
  return value
}

/** Subscriptions, keys and sending. */
export class WebPush {
  private keys?: Promise<{ publicKey: string; privateKey: string } | null>
  private readonly allow: (url: URL) => boolean

  constructor(private readonly opts: WebPushOptions) {
    this.opts = { ...opts }
    const services = opts.services ?? DEFAULT_PUSH_SERVICES
    this.allow = opts.allowEndpoint ?? (url => url.protocol === 'https:' && (url.port === '' || url.port === '443') && !url.username && !url.password && hostAllowed(url.hostname, services))
  }

  /** Where it says what went wrong, when it was given nowhere (the Gateway's log). */
  useLogger(logger: PushLogger) {
    this.opts.logger ??= logger
  }

  /**
   * The VAPID keys: those given, else those kept in the store, else a pair made now and kept (encrypted). None
   * without either the given keys or SECRETS_KEY: no push then. Tried again after a failure (the database may be late).
   */
  vapidKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
    this.keys ??= this.loadKeys().catch(err => {
      this.keys = undefined
      throw err
    })
    return this.keys
  }

  private async loadKeys() {
    const { vapid, key, store } = this.opts
    if (vapid) return vapid
    if (!key) return null
    const kept = (await store.getVapidKeys()) ?? (await store.initVapidKeys((({ publicKey, privateKey }) => ({ publicKey, privateKeyEnc: encrypt(privateKey, key) }))(webpush.generateVAPIDKeys())))
    return { publicKey: kept.publicKey, privateKey: decrypt(kept.privateKeyEnc, key) }
  }

  /** The public key the browsers subscribe with (base64url), or null when there is no push. */
  async publicKey() {
    return (await this.vapidKeys())?.publicKey ?? null
  }

  /** Validates what a browser's PushSubscription gives (its toJSON()): an allowed push service and well-formed keys. */
  parseSubscription(body: unknown) {
    const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
    if (typeof b.endpoint !== 'string' || b.endpoint.length > ENDPOINT_MAX) throw bad('PUSH_SUBSCRIPTION', 'invalid endpoint')
    let url: URL
    try {
      url = new URL(b.endpoint)
    } catch {
      throw bad('PUSH_SUBSCRIPTION', 'invalid endpoint')
    }
    if (!this.allow(url)) throw bad('PUSH_SERVICE', 'this push service is not allowed')
    // An uncompressed P-256 point, and a 16-byte secret.
    const p256dh = base64url(b.keys?.p256dh, 65, 0x04)
    const auth = base64url(b.keys?.auth, 16)
    if (!p256dh || !auth) throw bad('PUSH_SUBSCRIPTION', 'invalid keys')
    return { endpoint: b.endpoint, p256dh, auth }
  }

  /** Keeps a browser's subscription for this person (theirs from now on); beyond PUSH_SUBSCRIPTIONS_MAX, the oldest go. */
  async subscribe(tenantId: string, userId: string, sub: { endpoint: string; p256dh: string; auth: string }) {
    await this.opts.store.savePushSubscription({ tenantId, userId, ...sub, createdAt: new Date().toISOString() })
    const all = await this.opts.store.listPushSubscriptions(tenantId, userId)
    for (const old of all.slice(0, Math.max(0, all.length - PUSH_SUBSCRIPTIONS_MAX))) await this.opts.store.deletePushSubscription(tenantId, userId, old.endpoint)
  }

  /**
   * Sends `message` to every browser of this person, `ttlSec` at most at their push service, urgent. Resolves once
   * each push service answered (or did not within the timeout): the people whose subscriptions it said are gone (404,
   * 410), whose rows are removed.
   */
  async notify(tenantId: string, userId: string, message: PushMessage, ttlSec: number): Promise<{ sent: number; gone: { tenantId: string; userId: string }[] }> {
    const keys = await this.vapidKeys()
    if (!keys) return { sent: 0, gone: [] }
    const subs = await this.opts.store.listPushSubscriptions(tenantId, userId)
    const payload = JSON.stringify(message)
    const gone: { tenantId: string; userId: string }[] = []
    let sent = 0
    await Promise.all(
      subs.map(async sub => {
        try {
          await this.send(sub, payload, keys, ttlSec)
          sent++
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          const service = new URL(sub.endpoint).hostname
          if (status === 404 || status === 410) {
            const owner = await this.opts.store.deletePushEndpoint(sub.endpoint)
            if (owner) gone.push(owner)
            this.opts.logger?.warn({ tenantId, userId, service, status }, 'push subscription gone, removed')
          } else {
            this.opts.logger?.error({ tenantId, userId, service, status, err: (err as Error).message }, 'push not sent')
          }
        }
      })
    )
    return { sent, gone }
  }

  private send(sub: PushSubscriptionRecord, payload: string, keys: { publicKey: string; privateKey: string }, ttlSec: number) {
    return webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
      vapidDetails: { subject: this.opts.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: Math.max(0, Math.round(ttlSec)),
      urgency: 'high',
      // A message not yet delivered is replaced by the next one about calls (a missed call replaces its ringing).
      topic: 'call',
      contentEncoding: 'aes128gcm',
      timeout: this.opts.timeoutMs ?? SEND_TIMEOUT_MS,
      ...(this.opts.agent ? { agent: this.opts.agent } : {}),
      ...(this.opts.proxy ? { proxy: this.opts.proxy } : {})
    })
  }
}

