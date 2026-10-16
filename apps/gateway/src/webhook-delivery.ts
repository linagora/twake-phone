import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { Resolver } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

// How the Gateway reaches a subscriber (step 10a, ADR 0020): the signature it puts on each delivery, which addresses it
// may reach (an administrator of an organisation must never have the Gateway call an address of the platform's own
// network), and the request itself: bounded in time (the connection sooner than the answer), without redirects, the
// body of the answer never read.

/**
 * The header a subscriber checks: `t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, keyed with the subscription's
 * secret (the whole `whsec_…` string). For a day after a new secret, a second `v1` signs with the one before: the
 * subscriber accepts the delivery when one of them matches the secret it has.
 */
export const SIGNATURE_HEADER = 'x-twakephone-signature'

/** A new secret for a subscription: shown once, kept encrypted (SECRETS_KEY). */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`

const hmac = (secret: string, timestamp: number, body: string) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

/**
 * The signature of `body` (the exact bytes sent) at `timestamp` (seconds since the epoch), as the header carries it:
 * one `v1` per secret given (the current one first, then the one it replaced while that one is still accepted).
 */
export const signWebhook = (secrets: string | readonly string[], timestamp: number, body: string) =>
  [`t=${timestamp}`, ...(typeof secrets === 'string' ? [secrets] : secrets).map(secret => `v1=${hmac(secret, timestamp, body)}`)].join(',')

/**
 * What a subscriber does with the header (tests and the documentation's example): one of its `v1` is the body's
 * signature with this secret, made less than `toleranceSec` ago (a delivery replayed later by someone who caught it
 * is refused). False for a missing or malformed header.
 */
export const verifyWebhookSignature = (secret: string, header: string | undefined, body: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) => {
  if (typeof header !== 'string') return false
  const parts = header.split(',').map(p => p.trim().split('='))
  const t = Number(parts.find(p => p[0] === 't')?.[1])
  if (!Number.isInteger(t) || Math.abs(nowSec - t) > toleranceSec) return false
  const expected = Buffer.from(hmac(secret, t, body), 'hex')
  return parts.some(p => p[0] === 'v1' && p.length === 2 && /^[0-9a-f]{64}$/.test(p[1]!) && timingSafeEqual(Buffer.from(p[1]!, 'hex'), expected))
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

/** The ports a subscriber listens on unless the operator lists others (WEBHOOK_PORTS): https's, and http's in http. */
export const WEBHOOK_PORTS: readonly number[] = [443, 80]
/** The port of each scheme, the only one allowed in it without WEBHOOK_PORTS. */
const SCHEME_PORT: Record<string, number> = { 'https:': 443, 'http:': 80 }

export interface DestinationPolicy {
  /** `http:` as well as `https:` (WEBHOOK_ALLOW_HTTP=1: development and tests only). */
  allowHttp?: boolean
  /**
   * The ports an address may name, whatever its scheme (WEBHOOK_PORTS): the Gateway is no scanner of the ports of
   * whatever address an administrator chooses. Without it, its scheme's own only: 443 in https, 80 in http. Port 0
   * never.
   */
  ports?: readonly number[]
}

/**
 * WEBHOOK_PORTS: ports from 1 to 65535, comma-separated (`443,8443`); undefined when unset (each scheme its own
 * port).
 */
export const parsePorts = (value: string | undefined, name = 'WEBHOOK_PORTS'): number[] | undefined => {
  const entries = (value ?? '').split(',').map(x => x.trim()).filter(Boolean)
  if (!entries.length) return undefined
  return entries.map(e => {
    const port = Number(e)
    if (!/^\d{1,5}$/.test(e) || port < 1 || port > 65_535) throw new Error(`${name}: ${e} is no port (1 to 65535)`)
    return port
  })
}

/** The port an address names, its scheme's when it names none. */
const portOf = (url: URL) => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80)

/**
 * The address of a subscription, as kept: an absolute https URL (http only when the operator allows it), on one of
 * the ports allowed, without credentials nor fragment, whose host the organisation allows. A 400 with a code the app
 * puts into words.
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
  const port = portOf(url)
  const ports = policy.ports ?? [SCHEME_PORT[url.protocol]!]
  if (port === 0 || !ports.includes(port)) throw refused('WEBHOOK_URL_PORT', `url: port ${port} is not allowed in ${url.protocol.slice(0, -1)} (${ports.join(', ')})`)
  if (!hostAllowed(hostOf(url), domains)) throw refused('WEBHOOK_DOMAIN', `url: ${hostOf(url)} is not among the domains the organisation allows`)
  return url.toString()
}

/** Whether a kept address may still be delivered to: its scheme and port still allowed, its host still among the domains. */
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
  // ::/8: the unspecified address, this host (::1), the deprecated IPv4-compatible addresses (::a.b.c.d, ::/96) and
  // everything reserved around them. IPv4-mapped ones (::ffff:0:0/96, inside it) are read for their IPv4 part first.
  ['::', 8],
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
  ['ff00::', 8],
  // The 6bone, returned long ago (RFC 3701): never a subscriber.
  ['3ffe::', 16]
]
// One list per family: a BlockList checks an IPv4 address against its IPv6 rules too, as ::ffff:a.b.c.d, which ::/8
// holds.
const special = { ipv4: new BlockList(), ipv6: new BlockList() }
for (const [net, prefix] of SPECIAL_V4) special.ipv4.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of SPECIAL_V6) special.ipv6.addSubnet(net, prefix, 'ipv6')

/** What addresses a delivery may reach are checked against: a BlockList, or the networks an operator opened. */
export interface AddressSet {
  check(address: string, type: 'ipv4' | 'ipv6'): boolean
}

/**
 * Addresses refused even inside a network the operator opened, unless an entry names them (lies within one of
 * these): this host (loopback, the unspecified address), link-local (where clouds answer the metadata of the
 * machine, its credentials included), and the metadata services of the clouds elsewhere.
 */
const GUARDED: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  // Alibaba Cloud's metadata (inside 100.64.0.0/10), Azure's WireServer (a public address, inside Azure only).
  ['100.100.100.200', 32, 'ipv4'],
  ['168.63.129.16', 32, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  // AWS's metadata in IPv6 (inside fc00::/7).
  ['fd00:ec2::254', 128, 'ipv6']
]
const guarded = { ipv4: new BlockList(), ipv6: new BlockList() }
const guardedRanges = GUARDED.map(([net, prefix, type]) => {
  const one = new BlockList()
  one.addSubnet(net, prefix, type)
  guarded[type].addSubnet(net, prefix, type)
  return { one, prefix, type }
})

/** Shortest prefix of a network opened (WEBHOOK_PRIVATE_NETWORKS): wider, a typing error would open far too much. */
export const MIN_OPEN_PREFIX = { ipv4: 8, ipv6: 16 } as const

interface Network {
  net: string
  prefix: number
  type: 'ipv4' | 'ipv6'
}

/**
 * One network as written: an IPv4 or IPv6 address (no zone, `%eth0`), alone (one host) or with a prefix of 1 to 3
 * digits within its family's length. Anything else, `10.0.0.0/` (an empty prefix), `10.0.0.0/8/30`, `/0x8`, is an
 * error that says the entry.
 */
const parseNetwork = (entry: string, name: string): Network => {
  const bad = () => new Error(`${name}: ${entry} is no network (10.20.0.0/16, fd00:1::/64, or one address)`)
  const parts = entry.split('/')
  if (parts.length > 2) throw bad()
  const [net, bits] = parts as [string, string | undefined]
  const family = isIP(net)
  if (!family || net.includes('%')) throw bad()
  const type = family === 6 ? 'ipv6' : 'ipv4'
  const max = family === 6 ? 128 : 32
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) throw bad()
  const prefix = bits === undefined ? max : Number(bits)
  if (prefix > max) throw bad()
  return { net, prefix, type }
}

/** The entries of a list written `10.20.0.0/16,fd00:1::/64`, each read strictly (parseNetwork). */
const networksOf = (value: string | undefined, name: string) =>
  (value ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .map(entry => parseNetwork(entry, name))

/**
 * Networks written `10.20.0.0/16,fd00:1::/64` (an address alone is one host), that the operator closes to every
 * delivery whatever the rest (WEBHOOK_DENY_NETWORKS: the platform's own public addresses), or that tests open.
 * `name`: the variable, for the error.
 */
export const parseNetworks = (value: string | undefined, name = 'WEBHOOK_DENY_NETWORKS', into = new BlockList()): BlockList => {
  for (const n of networksOf(value, name)) into.addSubnet(n.net, n.prefix, n.type)
  return into
}

/**
 * The networks the operator opens to the deliveries of one organisation (WEBHOOK_PRIVATE_NETWORKS), despite the rule
 * that keeps the special ranges out: none wider than MIN_OPEN_PREFIX (a /0 or a /4 is a typing error, never a
 * network), and never this host, link-local nor a cloud's metadata (GUARDED) unless an entry lies within them (names
 * them: `127.0.0.1/32` for a receiver on a development machine). `entries`: as written, for the log.
 */
export class OpenNetworks implements AddressSet {
  private readonly list = new BlockList()
  /** The entries within a guarded range: they open what they name of it. */
  private readonly named = new BlockList()
  readonly entries: string[] = []

  constructor(value: string, name = 'WEBHOOK_PRIVATE_NETWORKS') {
    const networks = networksOf(value, name)
    if (!networks.length) throw new Error(`${name}: an organisation without networks (acme=10.20.0.0/16)`)
    for (const n of networks) {
      if (n.prefix < MIN_OPEN_PREFIX[n.type])
        throw new Error(`${name}: ${n.net}/${n.prefix} opens too much (/${MIN_OPEN_PREFIX[n.type]} at the widest in ${n.type === 'ipv6' ? 'IPv6' : 'IPv4'})`)
      this.list.addSubnet(n.net, n.prefix, n.type)
      if (guardedRanges.some(g => g.type === n.type && n.prefix >= g.prefix && g.one.check(n.net, n.type))) this.named.addSubnet(n.net, n.prefix, n.type)
      this.entries.push(`${n.net}/${n.prefix}`)
    }
  }

  check(address: string, type: 'ipv4' | 'ipv6') {
    if (guarded[type].check(address, type)) return this.named.check(address, type)
    return this.list.check(address, type)
  }
}

/**
 * WEBHOOK_PRIVATE_NETWORKS: the networks the operator opens to the deliveries of one organisation each, never to the
 * others' (an administrator of another one would reach them with a domain of their own that resolves there):
 * `acme=10.20.0.0/16,fd00:1::/64;beta=192.0.2.10`. The organisation is written as the token names it (any character),
 * `;`, `=` and `%` percent-encoded (`%3B`, `%3D`, `%25`: `urn%3Aacme` is fine as `urn:acme`). A list without an
 * organisation (`10.20.0.0/16`) is that of `defaultTenant` (a platform of one organisation).
 */
export const parseTenantNetworks = (value: string | undefined, defaultTenant: string, name = 'WEBHOOK_PRIVATE_NETWORKS'): Map<string, OpenNetworks> => {
  const lists = new Map<string, string[]>()
  for (const part of (value ?? '').split(';').map(x => x.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    let tenant = defaultTenant
    if (eq >= 0) {
      const written = part.slice(0, eq).trim()
      try {
        tenant = decodeURIComponent(written)
      } catch {
        throw new Error(`${name}: ${written} is no organisation (write % as %25)`)
      }
      if (!tenant) throw new Error(`${name}: ${part} names no organisation (acme=10.20.0.0/16;beta=192.0.2.10)`)
    }
    lists.set(tenant, [...(lists.get(tenant) ?? []), eq < 0 ? part : part.slice(eq + 1)])
  }
  return new Map([...lists].map(([tenant, parts]) => [tenant, new OpenNetworks(parts.join(','), name)]))
}

/**
 * The addresses no delivery reaches whatever the operator opened: WEBHOOK_DENY_NETWORKS, and the addresses of this
 * host's own interfaces (`interfaces`: os.networkInterfaces()), public ones included: with the host's network (the
 * pilot kit's OpenSIPS and Gateway), its public address is the platform itself. Not the loopback (`internal`), refused
 * unless the operator opens it, which only a development machine does (a receiver of its own).
 */
export const denyNetworks = (value: string | undefined, interfaces: Record<string, { address: string; internal?: boolean }[] | undefined> = {}): BlockList => {
  const list = parseNetworks(value, 'WEBHOOK_DENY_NETWORKS')
  for (const addresses of Object.values(interfaces))
    for (const a of addresses ?? []) {
      if (a.internal) continue
      const address = a.address.split('%')[0]!
      const family = isIP(address)
      if (family) list.addAddress(address, family === 6 ? 'ipv6' : 'ipv4')
    }
  return list
}

const MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i

/**
 * Whether a delivery may reach `address`: a public address, or one of the networks the operator opened (`open`);
 * never one it closed (`deny`), even inside what it opened, nor a guarded one (this host, link-local, the clouds'
 * metadata) that `open` does not name.
 */
export const addressAllowed = (address: string, open?: AddressSet, deny?: AddressSet): boolean => {
  const family = isIP(address)
  if (!family) return false
  const mapped = family === 6 ? MAPPED.exec(address)?.[1] : undefined
  if (mapped) return addressAllowed(mapped, open, deny)
  const type = family === 6 ? 'ipv6' : 'ipv4'
  if (deny?.check(address, type)) return false
  // ::ffff:0:0/96 written another way (hexadecimal): refused, its IPv4 part is not read here.
  if (family === 6 && /^::ffff:/i.test(address)) return !!open?.check(address, 'ipv6')
  if (open?.check(address, type)) return true
  if (guarded[type].check(address, type)) return false
  return !special[type].check(address, type)
}

export type Resolve = (host: string) => Promise<LookupAddress[]>
/**
 * The DNS, asked by c-ares (A and AAAA records), not by getaddrinfo: a slow server of an allowed domain holds none of
 * the four threads of libuv that the file system, crypto and the database's name resolution share. 2 s, one try: within
 * the 3 s of the connection (a slow DNS is told `dns`, not `timeout`). The hosts file is not read (a subscriber is a
 * public name).
 */
const resolver = new Resolver({ timeout: 2_000, tries: 1 })
const systemResolve: Resolve = async host => {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
  if (v4.status === 'rejected' && v6.status === 'rejected') throw v4.reason
  return [...(v4.status === 'fulfilled' ? v4.value.map(address => ({ address, family: 4 })) : []), ...(v6.status === 'fulfilled' ? v6.value.map(address => ({ address, family: 6 })) : [])]
}

export class DeliveryError extends Error {
  constructor(
    /**
     * Why: the server's log keeps it; the log of deliveries an administrator reads says `unreachable` for dns,
     * connection, tls and timeout alike (deliveryFailure), no oracle of what listens where.
     */
    readonly reason: 'destination-refused' | 'dns' | 'connection' | 'tls' | 'timeout' | 'redirect',
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
const guardedLookup = (resolve: Resolve, open: AddressSet | undefined, deny: AddressSet | undefined, resolved: () => void = () => undefined): LookupFunction =>
  (hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname).finally(resolved).then(
      addresses => {
        if (!addresses.length) return callback(new DeliveryError('dns', 'the host has no address'), '', 4)
        if (addresses.some(a => !addressAllowed(a.address, open, deny))) return callback(new DeliveryError('destination-refused', 'the host resolves to an address deliveries may not reach'), '', 4)
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0]!.address, addresses[0]!.family)
      },
      () => callback(new DeliveryError('dns', 'the host could not be resolved'), '', 4)
    )
  }

export interface PostOptions {
  /** The status of the answer within this time, the name resolved and the connection made included (default 5 s). */
  timeoutMs?: number
  /** The name resolved and the connection made within this time (default 3 s): a host that drops the packets costs that much. */
  connectTimeoutMs?: number
  /** Networks the operator opened to the organisation of this delivery (WEBHOOK_PRIVATE_NETWORKS). */
  open?: AddressSet
  /** Addresses never reached (WEBHOOK_DENY_NETWORKS, this host's own). */
  deny?: AddressSet
  /** The resolver (tests give one that answers what they want). */
  resolve?: Resolve
  /** Certificates trusted besides the system's (tests: a local https subscriber). */
  ca?: string | Buffer
}

/**
 * POSTs `body` to `url` and says the status of the answer as soon as it comes (the body of the answer is not read: a
 * 2xx is a delivery, however long or slow what follows), or throws a DeliveryError: an address that may not be
 * reached (resolved here, a literal one checked as it is), no connection or no answer in time, a redirect (never
 * followed). The caller checked the scheme and the domain.
 */
export const postWebhook = (url: string, body: string, headers: Record<string, string>, opts: PostOptions = {}): Promise<{ status: number }> => {
  const target = new URL(url)
  const host = hostOf(target)
  const timeoutMs = opts.timeoutMs ?? 5_000
  const connectTimeoutMs = Math.min(opts.connectTimeoutMs ?? 3_000, timeoutMs)
  if (isIP(host) && !addressAllowed(host, opts.open, opts.deny)) return Promise.reject(new DeliveryError('destination-refused', 'the address may not be reached by deliveries'))
  return new Promise((resolve, reject) => {
    let settled = false
    // A time out before the name was resolved is the DNS's (a literal address has none to resolve).
    let resolved = !!isIP(host)
    const late = (what: string) => new DeliveryError(resolved ? 'timeout' : 'dns', resolved ? what : 'the host could not be resolved in time')
    const done = (err: Error | null, status?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(connectTimer)
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
        lookup: guardedLookup(opts.resolve ?? systemResolve, opts.open, opts.deny, () => (resolved = true)),
        ...(opts.ca ? { ca: opts.ca } : {})
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        // What the subscriber says after its status is neither kept nor waited for.
        res.on('error', () => undefined)
        res.destroy()
        if (status >= 300 && status < 400) return done(new DeliveryError('redirect', `redirect not followed (${status})`))
        done(null, status)
      }
    )
    const timer = setTimeout(() => {
      req.destroy()
      done(late(`no answer within ${timeoutMs} ms`))
    }, timeoutMs)
    const connectTimer = setTimeout(() => {
      req.destroy()
      done(late(`no connection within ${connectTimeoutMs} ms`))
    }, connectTimeoutMs)
    req.on('socket', socket => {
      if (!socket.connecting) clearTimeout(connectTimer)
      else socket.once('connect', () => clearTimeout(connectTimer))
    })
    req.on('error', (err: Error & { code?: string }) => {
      if (err instanceof DeliveryError) return done(err)
      const tls = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(`${err.code ?? ''} ${err.message}`)
      done(new DeliveryError(tls ? 'tls' : 'connection', tls ? 'TLS: the certificate could not be verified' : 'the connection could not be made'))
    })
    req.end(body)
  })
}
