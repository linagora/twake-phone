// The bot of TwakePhone in Twake Chat (step 11b, ADR 0023): a Matrix account of the organisation, on its homeserver,
// whose access token comes from the environment only (MATRIX_BOT_TOKEN). It knows the client-server API it needs:
// who it is, whether an account exists, a room made with one person (at an address of its own), who is in it, a
// message sent and found again, a message withdrawn (redaction), a room left. Its errors say what failed in a few
// words and the Matrix error code: never a body, never what was sent. Each request may be stopped (`signal`).

/** A Matrix user id (`@localpart:server`), as the spec allows it for new accounts (lowercase localpart). */
export const MATRIX_USER_ID = /^@[a-z0-9._=\-/+]{1,255}:[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/
/** The code of the error of a directory that gives a person two Matrix ids (two entries, two values): no notice rather than one to the wrong account. */
export const MATRIX_ID_AMBIGUOUS = 'MATRIX_ID_AMBIGUOUS'
/** A room id (`!opaque:server`) or an event id (`$opaque`), as a homeserver gives them: kept and sent back as they are. */
const ROOM_ID = /^![\x21-\x7e]{1,255}$/
const EVENT_ID = /^\$[\x21-\x7e]{1,255}$/
/** The localpart of a room alias the bot makes (`twakephone-<print>`). */
const ALIAS_LOCALPART = /^[a-z0-9._=-]{1,128}$/

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

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response
    const timeout = AbortSignal.timeout(this.timeoutMs)
    try {
      res = await this.fetch(`${this.base}/_matrix/client/v3${path}`, {
        method,
        headers: { authorization: `Bearer ${this.config.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error'
      })
    } catch {
      throw new MatrixError(signal?.aborted ? 'stopped' : timeout.aborted ? `no answer within ${this.timeoutMs / 1000} s` : 'homeserver not reached')
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
      throw new MatrixError(signal?.aborted ? 'stopped' : `unreadable answer (${res.status})`, res.status)
    }
    if (res.status >= 300) {
      const e = parsed as { errcode?: unknown; retry_after_ms?: unknown }
      const errcode = typeof e.errcode === 'string' && /^[A-Z0-9_.]{1,64}$/.test(e.errcode) ? e.errcode : undefined
      const retry = typeof e.retry_after_ms === 'number' && Number.isFinite(e.retry_after_ms) ? Math.max(0, Math.min(e.retry_after_ms, 3_600_000)) : undefined
      throw new MatrixError(`${method} ${path.split('/')[1]!.split('?')[0]}: ${res.status}${errcode ? ` ${errcode}` : ''}`, res.status, errcode, retry)
    }
    return parsed as T
  }

  /** Who the bot is (asked once, again after a failure): its user id and the server it is on. */
  whoami(signal?: AbortSignal): Promise<{ userId: string; serverName: string }> {
    this.me ??= this.request<{ user_id?: unknown }>('GET', '/account/whoami', undefined, signal).then(
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
   * Whether the homeserver has an account of that id (its profile): false when it says it has none (404), undefined
   * when it does not say (a homeserver that shows profiles only to those who share a room with them: 403).
   */
  async exists(userId: string, signal?: AbortSignal): Promise<boolean | undefined> {
    if (!MATRIX_USER_ID.test(userId)) throw new MatrixError('not a Matrix user id')
    try {
      await this.request('GET', `/profile/${encodeURIComponent(userId)}`, undefined, signal)
      return true
    } catch (err) {
      if (err instanceof MatrixError && err.status === 404) return false
      if (err instanceof MatrixError && err.status === 403) return undefined
      throw err
    }
  }

  /**
   * A room of the bot with `userId` only (invited): private, not encrypted, nobody else may be invited to it (only the
   * bot may invite), its history visible from the invitation. Its id. The bot, its creator, holds it: the preset gives
   * it full power, and from room version 12 a creator stands above the power levels, which then must not name it.
   * With `alias` (its localpart), the room takes that address: a second creation at it is refused (M_ROOM_IN_USE), so
   * that a request whose answer was lost, asked again, never makes two rooms.
   */
  async createDirectRoom(userId: string, name: string, topic: string, alias?: string, signal?: AbortSignal): Promise<string> {
    if (!MATRIX_USER_ID.test(userId)) throw new MatrixError('not a Matrix user id')
    if (alias !== undefined && !ALIAS_LOCALPART.test(alias)) throw new MatrixError('not an alias')
    const r = await this.request<{ room_id?: unknown }>(
      'POST',
      '/createRoom',
      {
        preset: 'private_chat',
        is_direct: true,
        invite: [userId],
        name,
        topic,
        ...(alias !== undefined ? { room_alias_name: alias } : {}),
        initial_state: [{ type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'invited' } }],
        power_level_content_override: { users_default: 0, invite: 100, kick: 100, ban: 100, redact: 100, state_default: 100, events_default: 0 }
      },
      signal
    )
    if (typeof r.room_id !== 'string' || !ROOM_ID.test(r.room_id)) throw new MatrixError('createRoom: no room id')
    return r.room_id
  }

  /** The room an alias of the bot's server (its localpart) leads to, undefined when there is none. */
  async resolveAlias(alias: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!ALIAS_LOCALPART.test(alias)) throw new MatrixError('not an alias')
    const { serverName } = await this.whoami(signal)
    try {
      const r = await this.request<{ room_id?: unknown }>('GET', `/directory/room/${encodeURIComponent(`#${alias}:${serverName}`)}`, undefined, signal)
      if (typeof r.room_id !== 'string' || !ROOM_ID.test(r.room_id)) throw new MatrixError('directory: no room id')
      return r.room_id
    } catch (err) {
      if (err instanceof MatrixError && err.status === 404) return undefined
      throw err
    }
  }

  /** Removes an alias the bot made (its localpart); nothing when there is none. */
  async deleteAlias(alias: string, signal?: AbortSignal): Promise<void> {
    if (!ALIAS_LOCALPART.test(alias)) throw new MatrixError('not an alias')
    const { serverName } = await this.whoami(signal)
    await this.request('DELETE', `/directory/room/${encodeURIComponent(`#${alias}:${serverName}`)}`, undefined, signal).catch((err: unknown) => {
      if (!(err instanceof MatrixError && err.status === 404)) throw err
    })
  }

  /** The bot leaves a room (it no longer reads it nor writes in it); nothing when it is no longer in it. */
  async leave(roomId: string, signal?: AbortSignal): Promise<void> {
    if (!ROOM_ID.test(roomId)) throw new MatrixError('not a room id')
    await this.request('POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {}, signal).catch((err: unknown) => {
      if (!(err instanceof MatrixError && (err.status === 403 || err.status === 404))) throw err
    })
  }

  /** The members of a room as its state says (whatever their membership). */
  async members(roomId: string, signal?: AbortSignal): Promise<MatrixMember[]> {
    if (!ROOM_ID.test(roomId)) throw new MatrixError('not a room id')
    const r = await this.request<{ chunk?: unknown }>('GET', `/rooms/${encodeURIComponent(roomId)}/members`, undefined, signal)
    if (!Array.isArray(r.chunk)) throw new MatrixError('members: no chunk')
    return r.chunk.flatMap((e: { type?: unknown; state_key?: unknown; content?: { membership?: unknown } }) =>
      e?.type === 'm.room.member' && typeof e.state_key === 'string' && typeof e.content?.membership === 'string' ? [{ userId: e.state_key, membership: e.content.membership }] : []
    )
  }

  /**
   * The bot's own message of a room whose field `field` is `key` (among its last 50 there), or undefined: a message
   * sent before whose answer was lost is found again, whatever token or transaction sent it.
   */
  async findSent(roomId: string, field: string, key: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!ROOM_ID.test(roomId)) throw new MatrixError('not a room id')
    const { userId } = await this.whoami(signal)
    const filter = JSON.stringify({ types: ['m.room.message'], senders: [userId] })
    const r = await this.request<{ chunk?: unknown }>('GET', `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50&filter=${encodeURIComponent(filter)}`, undefined, signal)
    if (!Array.isArray(r.chunk)) throw new MatrixError('messages: no chunk')
    const found = (r.chunk as { sender?: unknown; event_id?: unknown; content?: Record<string, unknown> }[]).find(e => e?.sender === userId && e.content?.[field] === key && typeof e.event_id === 'string' && EVENT_ID.test(e.event_id))
    return found?.event_id as string | undefined
  }

  /**
   * Sends a message (`m.room.message`) to a room, once for a `txnId` (the homeserver answers a repeat with the same
   * event: a retry after a lost answer sends nothing more). Its event id.
   */
  async send(roomId: string, txnId: string, content: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!ROOM_ID.test(roomId)) throw new MatrixError('not a room id')
    const r = await this.request<{ event_id?: unknown }>('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`, content, signal)
    if (typeof r.event_id !== 'string' || !EVENT_ID.test(r.event_id)) throw new MatrixError('send: no event id')
    return r.event_id
  }

  /** Withdraws a message of the bot (a redaction: its content removed for everyone in the room). */
  async redact(roomId: string, eventId: string, txnId: string, reason: string, signal?: AbortSignal): Promise<void> {
    if (!ROOM_ID.test(roomId) || !EVENT_ID.test(eventId)) throw new MatrixError('not a room or event id')
    await this.request('PUT', `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`, { reason }, signal)
  }
}
