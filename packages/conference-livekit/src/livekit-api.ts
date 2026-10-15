import { createHmac, createHash, timingSafeEqual } from 'node:crypto'

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url')

/** HS256 JWT as LiveKit expects it (no dependency needed for this). */
export const signToken = (apiKey: string, apiSecret: string, grants: Record<string, unknown>, ttlSec = 60, now = Date.now()): string => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const exp = Math.floor(now / 1000) + ttlSec
  const payload = b64url(JSON.stringify({ iss: apiKey, sub: apiKey, nbf: Math.floor(now / 1000) - 5, exp, ...grants }))
  const sig = createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

/** Verifies the Authorization of a LiveKit webhook: a JWT whose `sha256` claim is the body's hash (base64). */
export const verifyWebhook = (apiKey: string, apiSecret: string, authorization: string | undefined, rawBody: string, now = Date.now()): boolean => {
  if (!authorization) return false
  const parts = authorization.replace(/^Bearer /i, '').split('.')
  if (parts.length !== 3) return false
  const [h, p, s] = parts as [string, string, string]
  const expected = createHmac('sha256', apiSecret).update(`${h}.${p}`).digest()
  const given = Buffer.from(s, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  try {
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as { iss?: string; exp?: number; sha256?: string }
    if (claims.iss !== apiKey || (claims.exp && claims.exp * 1000 < now)) return false
    return claims.sha256 === createHash('sha256').update(rawBody).digest('base64')
  } catch {
    return false
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export class LiveKitError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Minimal Twirp (JSON) client for LiveKit's RoomService and SIP services. */
export class LiveKitApi {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly fetchFn: Fetch = (u, i) => fetch(u, i)
  ) {}

  /** Room-scoped calls need the room name in the grant: LiveKit refuses a wildcard. */
  private grants(body: unknown): Record<string, unknown> {
    const b = (body ?? {}) as { room?: string; room_name?: string }
    const room = b.room ?? b.room_name
    return { video: { roomCreate: true, roomList: true, roomAdmin: true, roomJoin: true, ...(room ? { room } : {}) }, sip: { admin: true, call: true } }
  }

  async call<T = Record<string, unknown>>(service: 'livekit.RoomService' | 'livekit.SIP', method: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.url.replace(/\/$/, '')}/twirp/${service}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken(this.apiKey, this.apiSecret, this.grants(body))}` },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    if (!res.ok) {
      let msg = text
      try {
        msg = (JSON.parse(text) as { msg?: string }).msg ?? text
      } catch {
        // not JSON: the body itself is the message
      }
      throw new LiveKitError(`LiveKit ${method} failed (${res.status}): ${msg}`, res.status)
    }
    return (text ? JSON.parse(text) : {}) as T
  }
}
