import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { FastifyRequest } from 'fastify'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

/** Who is calling, as established by an Authenticator. Telephony identity (extension) is resolved separately. */
export interface Identity {
  userId: string
  tenantId: string
  displayName?: string
  /** Used to act on the user's behalf in other Twake services (e.g. Meet's external API). */
  email?: string
  /** Roles the identity provider asserts (a claim of the token); what they allow is decided by the Gateway. */
  roles?: string[]
}

/** The roles claim as providers write it: an array, or one space- or comma-separated string. */
export const rolesOf = (claim: unknown): string[] => {
  const raw = Array.isArray(claim) ? claim : typeof claim === 'string' ? claim.split(/[\s,]+/) : []
  return raw.filter((r): r is string => typeof r === 'string' && r.length > 0)
}

export interface Authenticator {
  authenticate(req: FastifyRequest): Promise<Identity>
}

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode })

const bearer = (req: FastifyRequest): string | undefined => req.headers.authorization?.replace(/^Bearer\s+/i, '') || undefined

/**
 * Development only: trusts a header, a query parameter or a "dev:<user>" token. Never enable outside a dev box.
 */
export class DevAuthenticator implements Authenticator {
  constructor(private readonly tenantId = 'dev') {}

  async authenticate(req: FastifyRequest): Promise<Identity> {
    const query = req.query as Record<string, string | undefined>
    const raw = bearer(req) ?? query.token
    const tokenUser = raw?.startsWith('dev:') ? raw.slice(4) : undefined
    const id = req.headers['x-dev-user'] ?? query.user ?? tokenUser
    const tenant = req.headers['x-dev-tenant'] ?? this.tenantId
    if (typeof id !== 'string' || !id || typeof tenant !== 'string') throw fail(401, 'Unauthenticated')
    const roles = rolesOf(req.headers['x-dev-roles'])
    return { userId: id, tenantId: tenant, email: `${id}@${process.env.DEV_EMAIL_DOMAIN ?? 'twake.local'}`, ...(roles.length ? { roles } : {}) }
  }
}

/**
 * fetch() silently drops a `Host` header, so it cannot reach an instance through the stack's internal address
 * (which routes by Host). node:http can. Returns a Response so callers do not care which one answered.
 */
export const hostAwareFetch = (input: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> =>
  new Promise((resolve, reject) => {
    const url = new URL(input)
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', headers: init.headers, signal: init.signal }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode ?? 502 })))
    })
    req.on('error', reject)
    req.end()
  })

export interface CozyAuthOptions {
  /** Instances the Gateway agrees to ask: guards against being used to reach arbitrary hosts (SSRF). */
  instancePattern: RegExp
  /** Tenant of users whose instance has no organisation. */
  defaultTenant: string
  /** Reach the stack here instead of the public URL (e.g. http://cozyt:8080); the Host header carries the instance. */
  internalUrl?: string
  /** How long a verified token is trusted without asking the stack again. */
  cacheMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Authenticates with the Twake session itself: the caller presents the Cozy app token it already has plus the
 * URL of its instance, and the Gateway asks that instance who the token belongs to. The stack is the authority:
 * a token it does not recognise is refused, so there is no key to share and no second login.
 */
export class CozyAuthenticator implements Authenticator {
  private readonly cache = new Map<string, { identity: Identity; until: number }>()

  constructor(private readonly opts: CozyAuthOptions) {}

  async authenticate(req: FastifyRequest): Promise<Identity> {
    const token = bearer(req)
    const instance = req.headers['x-cozy-instance']
    // Distinct messages: they say which condition failed without revealing anything about the token.
    if (!token) throw fail(401, 'Unauthenticated: no bearer token')
    if (typeof instance !== 'string') throw fail(401, 'Unauthenticated: no X-Cozy-Instance header')
    let url: URL
    try {
      url = new URL(instance)
    } catch {
      throw fail(401, 'Unauthenticated: X-Cozy-Instance is not a URL')
    }
    if (!this.opts.instancePattern.test(url.origin)) throw fail(401, `Unauthenticated: instance ${url.origin} is not allowed`)

    const now = (this.opts.now ?? Date.now)()
    const cacheKey = createHash('sha256').update(`${url.origin}\u0000${token}`).digest('hex')
    const hit = this.cache.get(cacheKey)
    if (hit && hit.until > now) return hit.identity

    const base = this.opts.internalUrl ?? url.origin
    let res: Response
    try {
      res = await (this.opts.fetchImpl ?? (this.opts.internalUrl ? hostAwareFetch : fetch))(`${base}/settings/instance`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.api+json', ...(this.opts.internalUrl ? { host: url.host } : {}) },
        signal: AbortSignal.timeout(4000)
      })
    } catch {
      throw fail(503, 'Identity provider unreachable')
    }
    // cozy-stack answers 400 "Invalid JWT token" (with `www-authenticate: invalid_token`) for a token it does not know.
    if ([400, 401, 403].includes(res.status)) {
      // The shape of the token (never its content) tells a malformed value from a rejected valid one.
      const shape = `length ${token.length}, ${token.split('.').length} segment(s), starts with ${/^[A-Za-z0-9_-]{3}/.test(token) ? 'a base64url prefix' : 'a non-token character'}`
      throw fail(401, `Unauthenticated: ${url.host} rejected the token (${res.status}; ${shape})`)
    }
    if (!res.ok) throw fail(503, 'Identity provider error')

    const attrs = ((await res.json()) as { data?: { attributes?: Record<string, string> } }).data?.attributes ?? {}
    const userId = attrs.oidc_id || url.hostname.split('.')[0]
    if (!userId) throw fail(401, 'Unauthenticated')
    const identity: Identity = { userId, tenantId: attrs.org_id || this.opts.defaultTenant, ...(attrs.public_name ? { displayName: attrs.public_name } : {}), ...(attrs.email ? { email: attrs.email } : {}) }
    this.cache.set(cacheKey, { identity, until: now + (this.opts.cacheMs ?? 60_000) })
    if (this.cache.size > 5000) this.cache.clear()
    return identity
  }
}

export interface JwtAuthOptions {
  jwksUrl?: string
  /** Alternative to jwksUrl, mostly for tests. */
  keys?: JWTVerifyGetKey
  issuer: string
  audience: string
  userClaim?: string
  tenantClaim?: string
  /** Claim carrying the user's roles (e.g. "roles", or "groups" on LemonLDAP::NG). Absent: no role is read. */
  rolesClaim?: string
  defaultTenant: string
}

/** Authenticates an OIDC access/ID token signed by the Twake SSO (LemonLDAP-NG), checked against its JWKS. */
export class JwtAuthenticator implements Authenticator {
  private readonly keys: JWTVerifyGetKey

  constructor(private readonly opts: JwtAuthOptions) {
    if (!opts.keys && !opts.jwksUrl) throw new Error('JwtAuthenticator needs jwksUrl or keys')
    this.keys = opts.keys ?? createRemoteJWKSet(new URL(opts.jwksUrl!))
  }

  async authenticate(req: FastifyRequest): Promise<Identity> {
    const token = bearer(req)
    if (!token) throw fail(401, 'Unauthenticated')
    try {
      const { payload } = await jwtVerify(token, this.keys, { issuer: this.opts.issuer, audience: this.opts.audience, algorithms: ['RS256', 'ES256'] })
      const userId = payload[this.opts.userClaim ?? 'preferred_username'] ?? payload.sub
      if (typeof userId !== 'string' || !userId) throw new Error('no user claim')
      const tenant = this.opts.tenantClaim ? payload[this.opts.tenantClaim] : undefined
      const roles = this.opts.rolesClaim ? rolesOf(payload[this.opts.rolesClaim]) : []
      return {
        userId,
        tenantId: typeof tenant === 'string' && tenant ? tenant : this.opts.defaultTenant,
        ...(typeof payload.name === 'string' ? { displayName: payload.name } : {}),
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        ...(roles.length ? { roles } : {})
      }
    } catch {
      throw fail(401, 'Unauthenticated')
    }
  }
}

/**
 * Single-use, short-lived tickets for the WebSocket: browsers cannot set headers on a WebSocket, and a
 * long-lived token in a URL ends up in logs and history. The client asks for a ticket over an authenticated
 * request, then opens the socket with it.
 */
export class TicketStore {
  private readonly tickets = new Map<string, { identity: Identity; until: number }>()

  constructor(private readonly ttlMs = 30_000, private readonly now: () => number = Date.now) {}

  issue(identity: Identity): string {
    const ticket = randomBytes(24).toString('base64url')
    this.tickets.set(ticket, { identity, until: this.now() + this.ttlMs })
    for (const [t, v] of this.tickets) if (v.until < this.now()) this.tickets.delete(t)
    return ticket
  }

  /** Returns the identity once; the ticket is burnt either way. */
  consume(ticket: string): Identity | null {
    const hit = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    return hit && hit.until >= this.now() ? hit.identity : null
  }
}

export type AuthMode = 'dev' | 'cozy' | 'jwt'

/** Builds the authenticator selected by the environment. Refuses to guess: unknown modes fail at startup. */
export const authenticatorFromEnv = (env: NodeJS.ProcessEnv): Authenticator => {
  const mode = (env.AUTH_MODE ?? 'cozy') as AuthMode
  const defaultTenant = env.DEFAULT_TENANT ?? 'default'
  if (mode === 'dev') return new DevAuthenticator(env.DEFAULT_TENANT ?? 'dev')
  if (mode === 'cozy') {
    if (!env.COZY_INSTANCE_PATTERN) throw new Error('COZY_INSTANCE_PATTERN is required in cozy auth mode (regex of allowed instance origins)')
    return new CozyAuthenticator({ instancePattern: new RegExp(env.COZY_INSTANCE_PATTERN), defaultTenant, ...(env.COZY_INTERNAL_URL ? { internalUrl: env.COZY_INTERNAL_URL } : {}) })
  }
  if (mode === 'jwt') {
    if (!env.JWT_JWKS_URL || !env.JWT_ISSUER || !env.JWT_AUDIENCE) throw new Error('JWT_JWKS_URL, JWT_ISSUER and JWT_AUDIENCE are required in jwt auth mode')
    return new JwtAuthenticator({
      jwksUrl: env.JWT_JWKS_URL,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      defaultTenant,
      ...(env.JWT_USER_CLAIM ? { userClaim: env.JWT_USER_CLAIM } : {}),
      ...(env.JWT_TENANT_CLAIM ? { tenantClaim: env.JWT_TENANT_CLAIM } : {}),
      ...(env.JWT_ROLES_CLAIM ? { rolesClaim: env.JWT_ROLES_CLAIM } : {})
    })
  }
  throw new Error(`Unknown AUTH_MODE: ${mode}`)
}
