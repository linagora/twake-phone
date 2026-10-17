import { createHash } from 'node:crypto'
import { OperatorError, type OperatorErrorCode } from '@twake/telephony-provider-sdk'

/**
 * The OVHcloud API's entry points (the documentation's names). Any other value of `endpoint` is taken as the URL of
 * the API itself, up to its version (`https://…/1.0`): the fake server of the tests.
 */
export const OVH_ENDPOINTS: Readonly<Record<string, string>> = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
  'ovh-us': 'https://api.us.ovhcloud.com/1.0'
}

/** A request's bound: an API that does not answer in that time is `unreachable`. */
export const OVH_TIMEOUT_MS = 10_000
/** How long the gap between this clock and OVH's is kept before it is read again (`/auth/time`). */
export const OVH_TIME_TTL_MS = 3_600_000

export interface OvhCredentials {
  /** The application key and its secret (an application created for the platform), and the consumer key (its rights). */
  applicationKey: string
  applicationSecret: string
  consumerKey: string
}

export interface OvhClientOptions extends OvhCredentials {
  /** `ovh-eu` by default (OVH_ENDPOINTS), or the URL of the API. */
  endpoint?: string
  timeoutMs?: number
  /** Test seams. */
  fetch?: typeof fetch
  now?: () => number
}

/**
 * The signature of a request, as OVHcloud documents it: `$1$` and the SHA-1, in hexadecimal, of the application
 * secret, the consumer key, the method, the whole URL (query string included), the body (empty without one) and the
 * timestamp (OVH's clock, in seconds), joined with `+`.
 */
export const ovhSignature = (applicationSecret: string, consumerKey: string, method: string, url: string, body: string, timestamp: number) =>
  `$1$${createHash('sha1').update(`${applicationSecret}+${consumerKey}+${method}+${url}+${body}+${timestamp}`).digest('hex')}`

/** What OVH answers when it refuses a request: its words (`message`), and on some calls a code (`errorCode`). */
interface OvhRefusal {
  message?: unknown
  errorCode?: unknown
}

/** The keys refused, whatever the status OVH answers it with (400 for a signature, 403 for an unknown key). */
const KEYS_REFUSED = new Set(['INVALID_KEY', 'INVALID_CREDENTIAL', 'INVALID_SIGNATURE'])

const codeFor = (status: number, errorCode: string): OperatorErrorCode =>
  KEYS_REFUSED.has(errorCode) || status === 401
    ? 'unauthorized'
    : status === 403
      ? 'forbidden'
      : status === 404
        ? 'not-found'
        : status === 429
          ? 'rate'
          : status >= 500
            ? 'unreachable'
            : 'refused'

/** OVH's words, on one line and bounded: they go into the log only (they may name a line, never a key). */
const wordsOf = (refusal: OvhRefusal | undefined) => (typeof refusal?.message === 'string' ? refusal.message.replace(/\s+/g, ' ').slice(0, 200) : '')

/**
 * A client of the OVHcloud API (`/1.0`): every request signed with the application's secret and the consumer key,
 * dated by OVH's clock (the gap read on `/auth/time`, read again after an hour, or once more when OVH says a request
 * is out of time). Never logs nor throws a key: an error says the method, the path and OVH's words.
 */
export class OvhClient {
  readonly base: string
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  /** OVH's clock minus this one's, in seconds, and when it was read (ms, this clock). */
  private gap: { sec: number; at: number } | undefined
  private gapRead: Promise<number> | undefined

  constructor(private readonly options: OvhClientOptions) {
    const endpoint = options.endpoint ?? 'ovh-eu'
    this.base = (OVH_ENDPOINTS[endpoint] ?? endpoint).replace(/\/+$/, '')
    if (!/^https?:\/\/[^/]+\/.+/.test(this.base)) throw new Error('OVH endpoint: ovh-eu, ovh-ca, ovh-us or the URL of the API (https://…/1.0)')
    for (const k of ['applicationKey', 'applicationSecret', 'consumerKey'] as const) if (!options[k]) throw new Error(`OVH ${k} is required`)
    this.fetchFn = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? OVH_TIMEOUT_MS
  }

  /** OVH's clock now, in seconds (`/auth/time`, unsigned). */
  async time(): Promise<number> {
    const res = await this.send('GET', `${this.base}/auth/time`, {}, undefined, '/auth/time')
    const text = await res.text()
    const sec = Number(text)
    if (!res.ok || !Number.isInteger(sec)) throw new OperatorError('unreachable', `OVH GET /auth/time: answered ${res.status}`)
    return sec
  }

  private gapNow(force = false): Promise<number> {
    const kept = this.gap
    if (!force && kept && this.now() - kept.at < OVH_TIME_TTL_MS) return Promise.resolve(kept.sec)
    this.gapRead ??= (async () => {
      const before = this.now()
      const sec = await this.time()
      const after = this.now()
      const gap = sec - Math.floor((before + after) / 2 / 1000)
      this.gap = { sec: gap, at: after }
      return gap
    })().finally(() => (this.gapRead = undefined))
    return this.gapRead
  }

  private async send(method: string, url: string, headers: Record<string, string>, body: string | undefined, path: string) {
    try {
      return await this.fetchFn(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (err) {
      const why = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'no answer in time' : 'not reached'
      throw new OperatorError('unreachable', `OVH ${method} ${path}: ${why}`)
    }
  }

  /**
   * A signed request to `path` (from the version on: `/telephony/…`), with its query and JSON body: the JSON OVH
   * answers (undefined for an empty answer). Throws an OperatorError.
   */
  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const query = options.query && Object.keys(options.query).length ? `?${new URLSearchParams(options.query).toString()}` : ''
    const url = `${this.base}${path}${query}`
    const body = options.body === undefined ? '' : JSON.stringify(options.body)
    for (let attempt = 0; ; attempt++) {
      const timestamp = Math.floor(this.now() / 1000) + (await this.gapNow(attempt > 0))
      const headers: Record<string, string> = {
        'X-Ovh-Application': this.options.applicationKey,
        'X-Ovh-Consumer': this.options.consumerKey,
        'X-Ovh-Timestamp': String(timestamp),
        'X-Ovh-Signature': ovhSignature(this.options.applicationSecret, this.options.consumerKey, method, url, body, timestamp),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }
      const res = await this.send(method, url, headers, body || undefined, path)
      const text = await res.text().catch(() => '')
      let json: unknown
      try {
        json = text ? JSON.parse(text) : undefined
      } catch {
        json = undefined
      }
      if (res.ok) return json as T
      const refusal = json && typeof json === 'object' ? (json as OvhRefusal) : undefined
      const words = wordsOf(refusal)
      const errorCode = typeof refusal?.errorCode === 'string' ? refusal.errorCode.slice(0, 64) : ''
      // Out of time: this clock drifted from OVH's since the gap was read. Read again once, then the request again.
      if (attempt === 0 && (res.status === 400 || res.status === 401) && /time/i.test(`${words} ${errorCode}`)) continue
      throw new OperatorError(codeFor(res.status, errorCode), `OVH ${method} ${path}: ${res.status}${errorCode ? ` ${errorCode}` : ''}${words ? ` ${words}` : ''}`)
    }
  }
}
