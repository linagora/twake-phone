// The bot of TwakePhone in Twake Chat (step 11b, ADR 0023): a Matrix account of the organisation, on its homeserver,
// whose access token comes from the environment only (MATRIX_BOT_TOKEN). It knows the client-server API it needs:
// who it is, a room made with one person, who is in it, a message sent, a message withdrawn (redaction). Its errors say
// what failed in a few words and the Matrix error code: never a body, never what was sent.

/** A Matrix user id (`@localpart:server`), as the spec allows it for new accounts (lowercase localpart). */
export const MATRIX_USER_ID = /^@[a-z0-9._=\-/+]{1,255}:[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/
/** A room id (`!opaque:server`) or an event id (`$opaque`), as a homeserver gives them: kept and sent back as they are. */
const ROOM_ID = /^![\x21-\x7e]{1,255}$/
const EVENT_ID = /^\$[\x21-\x7e]{1,255}$/

export class MatrixError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The Matrix error code (`M_FORBIDDEN`, `M_LIMIT_EXCEEDED`...), when it gave one. */
    readonly errcode?: string,
    /** How long the homeserver asked to wait (M_LIMIT_EXCEEDED), in ms. */
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'MatrixError'
  }
}

export interface MatrixBotConfig {
  /** The homeserver's client-server API (`https://matrix.example.org`). */
  homeserverUrl: string
  /** The bot's access token: sent in the Authorization header only, never logged, never kept anywhere else. */
  token: string
  /** How long each request may take: 10 s by default. */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/** A member of a room as its state says: invited, joined, gone (`leave`), banned, or asking (`knock`). */
export interface MatrixMember {
  userId: string
  membership: string
}

/** The answer of a homeserver read up to 256 kB: a room's members fit, anything larger is refused. */
const MAX_ANSWER = 256 * 1024

export class MatrixBot {
  private readonly base: string
  private readonly timeoutMs: number
  private readonly fetch: typeof globalThis.fetch
  private me: Promise<{ userId: string; serverName: string }> | undefined

  constructor(private readonly config: MatrixBotConfig) {
    const url = new URL(config.homeserverUrl)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Matrix: MATRIX_HOMESERVER_URL must be http: or https:')
    if (url.username || url.password || url.search || url.hash) throw new Error('Matrix: MATRIX_HOMESERVER_URL must carry no credentials, query nor fragment')
    if (!config.token || /\s/.test(config.token)) throw new Error('Matrix: MATRIX_BOT_TOKEN is not an access token')
    this.base = url.toString().replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.fetch = config.fetch ?? globalThis.fetch
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.fetch(`${this.base}/_matrix/client/v3${path}`, {
        method,
        headers: { authorization: `Bearer ${this.config.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error'
      })
    } catch (err) {
      throw new MatrixError(err instanceof Error && err.name === 'TimeoutError' ? `no answer within ${this.timeoutMs / 1000} s` : 'homeserver not reached')
    }
    let parsed: unknown
    try {
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      if (reader)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > MAX_ANSWER) {
            await reader.cancel().catch(() => undefined)
            throw new MatrixError('answer too large', res.status)
          }
          chunks.push(value)
        }
      const text = Buffer.concat(chunks).toString('utf8')
      parsed = text ? JSON.parse(text) : {}
    } catch (err) {
      if (err instanceof MatrixError) throw err
      throw new MatrixError(`unreadable answer (${res.status})`, res.status)
    }
    if (res.status >= 300) {
      const e = parsed as { errcode?: unknown; retry_after_ms?: unknown }
      const errcode = typeof e.errcode === 'string' && /^[A-Z0-9_.]{1,64}$/.test(e.errcode) ? e.errcode : undefined
      const retry = typeof e.retry_after_ms === 'number' && Number.isFinite(e.retry_after_ms) ? Math.max(0, Math.min(e.retry_after_ms, 3_600_000)) : undefined
      throw new MatrixError(`${method} ${path.split('/')[1]}: ${res.status}${errcode ? ` ${errcode}` : ''}`, res.status, errcode, retry)
    }
    return parsed as T
  }

  /** Who the bot is (asked once, again after a failure): its user id and the server it is on. */
  whoami(): Promise<{ userId: string; serverName: string }> {
    this.me ??= this.request<{ user_id?: unknown }>('GET', '/account/whoami').then(
      r => {
        const userId = typeof r.user_id === 'string' && MATRIX_USER_ID.test(r.user_id) ? r.user_id : undefined
        if (!userId) throw new MatrixError('whoami: no user id')
        return { userId, serverName: userId.slice(userId.indexOf(':') + 1) }
      },
      (err: unknown) => {
        this.me = undefined
        throw err
      }
    )
    return this.me
  }

  /** A light request to the homeserver: rejects when it does not answer or refuses the token. */
  async probe() {
    this.me = undefined
    await this.whoami()
  }

  /**
   * A room of the bot with `userId` only (invited): private, not encrypted, nobody else may be invited to it (only the
   * bot may invite), its history visible from the invitation. Its id. The bot, its creator, holds it: the preset gives
   * it full power, and from room version 12 a creator stands above the power levels, which then must not name it.
   */
  async createDirectRoom(userId: string, name: string, topic: string): Promise<string> {
    if (!MATRIX_USER_ID.test(userId)) throw new MatrixError('not a Matrix user id')
    const r = await this.request<{ room_id?: unknown }>('POST', '/createRoom', {
      preset: 'private_chat',
      is_direct: true,
      invite: [userId],
      name,
      topic,
      initial_state: [{ type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'invited' } }],
      power_level_content_override: { users_default: 0, invite: 100, kick: 100, ban: 100, redact: 100, state_default: 100, events_default: 0 }
    })
    if (typeof r.room_id !== 'string' || !ROOM_ID.test(r.room_id)) throw new MatrixError('createRoom: no room id')
    return r.room_id
  }

  /** The members of a room as its state says (whatever their membership). */
  async members(roomId: string): Promise<MatrixMember[]> {
    if (!ROOM_ID.test(roomId)) throw new MatrixError('not a room id')
    const r = await this.request<{ chunk?: unknown }>('GET', `/rooms/${encodeURIComponent(roomId)}/members`)
    if (!Array.isArray(r.chunk)) throw new MatrixError('members: no chunk')
    return r.chunk.flatMap((e: { type?: unknown; state_key?: unknown; content?: { membership?: unknown } }) =>
      e?.type === 'm.room.member' && typeof e.state_key === 'string' && typeof e.content?.membership === 'string' ? [{ userId: e.state_key, membership: e.content.membership }] : []
    )
  }

  /**
   * Sends a message (`m.room.message`) to a room, once for a `txnId` (the homeserver answers a repeat with the same
   * event: a retry after a lost answer sends nothing more). Its event id.
   */
  async send(roomId: string, txnId: string, content: Record<string, unknown>): Promise<string> {
    if (!ROOM_ID.test(roomId)) throw new MatrixError('not a room id')
    const r = await this.request<{ event_id?: unknown }>('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`, content)
    if (typeof r.event_id !== 'string' || !EVENT_ID.test(r.event_id)) throw new MatrixError('send: no event id')
    return r.event_id
  }

  /** Withdraws a message of the bot (a redaction: its content removed for everyone in the room). */
  async redact(roomId: string, eventId: string, txnId: string, reason: string): Promise<void> {
    if (!ROOM_ID.test(roomId) || !EVENT_ID.test(eventId)) throw new MatrixError('not a room or event id')
    await this.request('PUT', `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`, { reason })
  }
}
