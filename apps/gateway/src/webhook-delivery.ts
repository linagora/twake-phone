import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

// How the Gateway reaches a subscriber (step 10a, ADR 0020): the signature it puts on each delivery, which addresses it
// may reach (an administrator of an organisation must never have the Gateway call an address of the platform's own
// network), and the request itself, bounded in time and size, without redirects.

/** The header a subscriber checks: `t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed with the subscription's secret. */
export const SIGNATURE_HEADER = 'x-twakephone-signature'

/** A new secret for a subscription: shown once, kept encrypted (SECRETS_KEY). */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`

/** The signature of `body` (the exact bytes sent) at `timestamp` (seconds since the epoch), as the header carries it. */
export const signWebhook = (secret: string, timestamp: number, body: string) => `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

/**
 * What a subscriber does with the header (tests and the documentation's example): the signature is the body's, with
 * this secret, made less than `toleranceSec` ago (a delivery replayed later by someone who caught it is refused).
 */
export const verifyWebhookSignature = (secret: string, header: string | undefined, body: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) => {
  const parts = Object.fromEntries((header ?? '').split(',').map(p => p.trim().split('=', 2) as [string, string]))
  const t = Number(parts.t)
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false
  const expected = Buffer.from(signWebhook(secret, t, body).split('v1=')[1]!, 'hex')
  const given = Buffer.from(parts.v1, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// ---------------------------------------------------------------------------------------------------------------
// Where a subscription may point

/** Longest address of a subscriber. */
export const WEBHOOK_URL_MAX = 2048
/** Domains an organisation allows at most. */
export const MAX_WEBHOOK_DOMAINS = 50
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
/** A host name (lower case, a dot at least: no bare intranet name), or `*.` before one for its subdomains. */
const DOMAIN = new RegExp(`^(?=.{1,253}$)(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`)
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

const refused = (code: string, message: string) => Object.assign(new Error(message), { statusCode: 400, code })

/**
 * The domains an administrator allows (PUT /webhooks/domains): host names, `*.example.org` for the subdomains of
 * example.org (not example.org itself), or an IPv4 address (an address of the platform's network is still refused at
 * delivery unless the operator opens it). Lower case, each once, in the order given.
 */
export const parseWebhookDomains = (body: unknown): string[] => {
  const list = (body as { domains?: unknown } | null)?.domains
  if (!Array.isArray(list)) throw refused('WEBHOOK_DOMAINS', 'domains: a list of host names')
  if (list.length > MAX_WEBHOOK_DOMAINS) throw refused('WEBHOOK_DOMAINS', `domains: ${MAX_WEBHOOK_DOMAINS} at most`)
  const out: string[] = []
  for (const value of list) {
    const d = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : ''
    if (!DOMAIN.test(d) && !IPV4.test(d)) throw refused('WEBHOOK_DOMAINS', `domains: ${String(value).slice(0, 80)} is no host name (example.org, or *.example.org for its subdomains)`)
    if (!out.includes(d)) out.push(d)
  }
  return out
}

/** The host of a URL as compared to the allowed domains: lower case, without the brackets of an IPv6 address nor a final dot. */
const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

/** Whether `host` is one of `domains` (exactly, or a subdomain of a `*.` entry). */
export const hostAllowed = (host: string, domains: readonly string[]) => domains.some(d => (d.startsWith('*.') ? host.endsWith(d.slice(1)) && host.length > d.length - 1 : host === d))

export interface DestinationPolicy {
  /** `http:` as well as `https:` (WEBHOOK_ALLOW_HTTP=1: development and tests only). */
  allowHttp?: boolean
}

/**
 * The address of a subscription, as kept: an absolute https URL (http only when the operator allows it), without
 * credentials nor fragment, whose host the organisation allows. A 400 with a code the app puts into words.
 */
export const parseWebhookUrl = (value: unknown, domains: readonly string[], policy: DestinationPolicy = {}): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > WEBHOOK_URL_MAX) throw refused('WEBHOOK_URL', `url: an https address of ${WEBHOOK_URL_MAX} characters at most`)
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw refused('WEBHOOK_URL', 'url: not an address')
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) throw refused('WEBHOOK_URL_SCHEME', 'url: https only')
  if (url.username || url.password) throw refused('WEBHOOK_URL', 'url: no user name nor password in the address (the signature authenticates the platform)')
  if (url.hash) throw refused('WEBHOOK_URL', 'url: no fragment (#)')
  if (!hostAllowed(hostOf(url), domains)) throw refused('WEBHOOK_DOMAIN', `url: ${hostOf(url)} is not among the domains the organisation allows`)
  return url.toString()
}

/** Whether a kept address may still be delivered to: its scheme still allowed, its host still among the domains. */
export const destinationAllowed = (value: string, domains: readonly string[], policy: DestinationPolicy = {}) => {
  try {
    parseWebhookUrl(value, domains, policy)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Which addresses may be reached

/**
 * The addresses no delivery reaches unless the operator opens them (WEBHOOK_PRIVATE_NETWORKS): this host, the
 * private networks, link-local (cloud metadata), shared, documentation, benchmarking, multicast and reserved ranges, in
 * IPv4 and IPv6 (RFC 6890 and the IANA special-purpose registries).
 */
const SPECIAL_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]
const SPECIAL_V6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  // IPv4-mapped and translated addresses: their IPv4 part is checked instead (mapped), or refused (NAT64, which
  // reaches any IPv4 address through a translator).
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
]
const special = new BlockList()
for (const [net, prefix] of SPECIAL_V4) special.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of SPECIAL_V6) special.addSubnet(net, prefix, 'ipv6')

/** The networks the operator opens to deliveries despite the rule above (`10.20.0.0/16,fd00:1::/64`): a CRM of its own network. */
export const parseNetworks = (value: string | undefined): BlockList => {
  const list = new BlockList()
  for (const entry of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [net, bits] = entry.split('/')
    const family = isIP(net ?? '')
    const prefix = bits === undefined ? (family === 6 ? 128 : 32) : Number(bits)
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) throw new Error(`WEBHOOK_PRIVATE_NETWORKS: ${entry} is no network (10.20.0.0/16, fd00:1::/64)`)
    list.addSubnet(net!, prefix, family === 6 ? 'ipv6' : 'ipv4')
  }
  return list
}

const MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i

/** Whether a delivery may reach `address`: a public address, or one of the networks the operator opened (`open`). */
export const addressAllowed = (address: string, open?: BlockList): boolean => {
  const family = isIP(address)
  if (!family) return false
  const mapped = family === 6 ? MAPPED.exec(address)?.[1] : undefined
  if (mapped) return addressAllowed(mapped, open)
  // ::ffff:0:0/96 written another way (hexadecimal): refused, its IPv4 part is not read here.
  if (family === 6 && /^::ffff:/i.test(address)) return !!open?.check(address, 'ipv6')
  const type = family === 6 ? 'ipv6' : 'ipv4'
  if (open?.check(address, type)) return true
  return !special.check(address, type)
}

export type Resolve = (host: string) => Promise<LookupAddress[]>
const systemResolve: Resolve = host =>
  new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))))

export class DeliveryError extends Error {
  constructor(
    /** What is kept in the log of deliveries and shown to the administrator: a category, never an address. */
    readonly reason: 'destination-refused' | 'dns' | 'connection' | 'tls' | 'timeout' | 'too-large' | 'redirect',
    message: string
  ) {
    super(message)
  }
}

/**
 * A `lookup` for the request that resolves the host itself and refuses it when any of its addresses may not be
 * reached: the connection goes to an address checked here, never to one a second resolution would give (a name whose
 * records change between a check and the connection).
 */
const guardedLookup = (resolve: Resolve, open: BlockList | undefined): LookupFunction =>
  (hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname).then(
      addresses => {
        if (!addresses.length) return callback(new DeliveryError('dns', 'the host has no address'), '', 4)
        if (addresses.some(a => !addressAllowed(a.address, open))) return callback(new DeliveryError('destination-refused', 'the host resolves to an address deliveries may not reach'), '', 4)
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0]!.address, addresses[0]!.family)
      },
      () => callback(new DeliveryError('dns', 'the host could not be resolved'), '', 4)
    )
  }

export interface PostOptions {
  /** Answer within this time, headers and body (default 10 s). */
  timeoutMs?: number
  /** Most of a response read before the connection is cut (default 64 KiB): what it says is not kept, only its status. */
  maxResponseBytes?: number
  /** Networks the operator opened (WEBHOOK_PRIVATE_NETWORKS). */
  open?: BlockList
  /** The resolver (tests give one that answers what they want). */
  resolve?: Resolve
}

/**
 * POSTs `body` to `url` and says the status of the answer, or throws a DeliveryError: an address that may not be
 * reached (resolved here, a literal one checked as it is), no answer in time, a redirect (never followed), an answer
 * longer than allowed. The caller checked the scheme and the domain.
 */
export const postWebhook = (url: string, body: string, headers: Record<string, string>, opts: PostOptions = {}): Promise<{ status: number }> => {
  const target = new URL(url)
  const host = hostOf(target)
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxBytes = opts.maxResponseBytes ?? 65_536
  if (isIP(host) && !addressAllowed(host, opts.open)) return Promise.reject(new DeliveryError('destination-refused', 'the address may not be reached by deliveries'))
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, status?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve({ status: status! })
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        agent: false,
        lookup: guardedLookup(opts.resolve ?? systemResolve, opts.open)
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.destroy()
          return done(new DeliveryError('redirect', `redirect not followed (${status})`))
        }
        let read = 0
        res.on('data', (chunk: Buffer) => {
          read += chunk.length
          if (read > maxBytes) {
            res.destroy()
            done(new DeliveryError('too-large', `answer longer than ${maxBytes} bytes`))
          }
        })
        res.on('end', () => done(null, status))
        res.on('error', () => done(new DeliveryError('connection', 'the connection dropped during the answer')))
      }
    )
    const timer = setTimeout(() => {
      req.destroy()
      done(new DeliveryError('timeout', `no answer within ${timeoutMs} ms`))
    }, timeoutMs)
    req.on('error', (err: Error & { code?: string }) => {
      if (err instanceof DeliveryError) return done(err)
      const tls = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(`${err.code ?? ''} ${err.message}`)
      done(new DeliveryError(tls ? 'tls' : 'connection', tls ? 'TLS: the certificate could not be verified' : 'the connection could not be made'))
    })
    req.end(body)
  })
}
