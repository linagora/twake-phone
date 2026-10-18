import { createHmac } from 'node:crypto'
import type { RoutedEvent, VoicemailBox, VoicemailOwner, VoicemailProvider, VoicemailSync, VoicemailSyncOptions } from '@twake/telephony-provider-sdk'
import type { ProviderStatus, Voicemail } from '@twake/telephony-types'

// Everything about Wazo Platform lives here (step 11a, ADR 0022): the Gateway only sees a VoicemailProvider. Wazo's own
// words (users, voicemails, folders, contexts) stay inside this package.
//
// One Wazo context (`internal`, labelled TwakePhone by default) holds the mailboxes of a tenant: one per extension,
// numbered as it, for one Wazo user that stands for the person who holds the extension (its `userfield` says who, as
// a keyed print: HMAC with a key the Gateway derives from SECRETS_KEY). A mailbox follows its holder: when they take
// another extension, it moves there with its messages. One whose holder no longer holds any is set aside (renumbered
// out of the extensions, PARKED: no call reaches it) and removed with its messages only after a grace period
// (`graceMs`), unless its holder comes back meanwhile; a person never hears someone else's messages. Each mailbox has
// its bounds (`maxMessages`, `maxMessageSec`). wazo-calld reads and changes the messages, wazo-websocketd tells a new
// one (the event wazo-calld makes of Asterisk's MWI, for the mailbox's user).

/** The fetch this package uses (Node's own by default); the tests give theirs. `body`: the answer's, as a stream. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string>; body: AsyncIterable<Uint8Array> | null }>

/** What this package needs of a WebSocket (Node's own by default; the tests give theirs). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface WazoLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface WazoConfig {
  /** wazo-auth's API (`http://127.0.0.1:9497/0.1`). */
  authUrl: string
  /** wazo-confd's API (`http://127.0.0.1:9486/1.1`). */
  confdUrl: string
  /** wazo-calld's API (`http://127.0.0.1:9500/1.0`). */
  calldUrl: string
  /** wazo-websocketd (`ws://127.0.0.1:9502/`). */
  websocketdUrl: string
  /** The Gateway's account in Wazo (its tenant is the one whose mailboxes these are). */
  username: string
  password: string
  /**
   * The key of the prints of the holders (`userfield`): HMAC-SHA256 of their id, so that Wazo's database alone does not
   * give back who holds a mailbox (a plain hash of a directory id is reversed by trying the directory's ids).
   */
  holderSecret: Uint8Array
  /** How long a mailbox whose holder holds no extension any more is kept aside, with its messages. Default: 7 days. */
  graceMs?: number
  /** The most messages a mailbox keeps (Asterisk's maxmsg: the caller is then told it is full). Default: 50. */
  maxMessages?: number
  /** The longest a message may be, in seconds (maxsecs), and the silence that ends it (maxsilence). Defaults: 180, 10. */
  maxMessageSec?: number
  maxSilenceSec?: number
  /**
   * The longest a call to a mailbox lasts, in seconds (VOICEMAIL_MAX_CALL_SEC of OpenSIPS and Asterisk; 300 by
   * default): no message is longer, whatever `maxMessageSec` was when it was left. At least `maxMessageSec`.
   */
  maxCallSec?: number
  /**
   * The largest recording handed out, in bytes. Default: what `maxCallSec` of Asterisk's WAV (the stack's format: 8 kHz,
   * 16 bits, one channel) takes, and a half: a message left under a higher `maxMessageSec` of before is still read.
   */
  maxRecordingBytes?: number
  /** The clock (the tests give theirs). */
  now?: () => number
  /** The label of the context of the mailboxes. Default: TwakePhone. */
  contextLabel?: string
  /** How long a token of wazo-auth lasts, in seconds; renewed at four fifths of it. Default: 3600. */
  tokenTtlSec?: number
  /** How long a request to Wazo may take, in milliseconds. Default: 10 s. */
  requestTimeoutMs?: number
  /** Waits before trying wazo-websocketd again, in milliseconds, the last one repeated. Default: 1, 2, 5, 10, 30 s. */
  reconnectMs?: number[]
  fetch?: Fetch
  webSocket?: (url: string) => WebSocketLike
  logger?: WazoLogger
  /** The provider's id (the Gateway names the tenant with it). Default: wazo. */
  id?: string
}

/** Wazo's answer to a request it did not do (its status, and its own words, cut short). */
export class WazoError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/**
 * A synchronisation or a purge stopped before its next change: the Gateway may no longer write the mailboxes
 * (VoicemailSyncOptions' mayWrite, third review 11a, n°2).
 */
export class WazoStopped extends Error {
  constructor() {
    super('the mailboxes are no longer this Gateway\'s to write: stopped before the next change')
  }
}

/** A mailbox number as Wazo's Asterisk takes it, and as OpenSIPS reads it (provider-opensips' MAILBOX). */
const NUMBER = /^[0-9]{1,40}$/
/** A message id as wazo-calld makes them (`1792289524-00000004`): nothing else reaches a URL. */
export const MESSAGE_ID = /^[0-9A-Za-z_-]{1,64}$/
/** The prefix of the `userfield` of the users this package made: the others are not its own. */
const HOLDER = 'twakephone:'
/**
 * Who a user stands for, as its `userfield` keeps it: a print of the person's id keyed with `secret`, which Wazo never
 * has (without the key, trying the ids of the directory gives nothing back).
 */
export const holderKey = (secret: Uint8Array, userId: string) => `${HOLDER}${createHmac('sha256', secret).update(userId).digest('hex').slice(0, 40)}`
/**
 * The number of a mailbox set aside: 0000, when (seconds since 1970, ten digits), its id (ten digits). No extension
 * starts with 0 (EXTENSION_FORMAT), so no call ever reaches it; the Gateway never hands it to the SIP server.
 */
const PARKED = /^0000([0-9]{10})([0-9]{10})$/
const parkedNumber = (at: number, id: number) => `0000${String(Math.floor(at / 1000)).padStart(10, '0')}${String(id).padStart(10, '0')}`
const PAGE = 500
const DAY_MS = 86_400_000
/** How long the mailbox an event was read with stands for `owns` of that event (the same mailbox, read once). */
const EVENT_READ_MS = 2_000

interface WazoContext {
  id: number
  name: string
  label?: string
  type?: string
}
interface WazoUser {
  uuid: string
  userfield?: string | null
  voicemail?: { id: number } | null
}
interface WazoMailbox {
  id: number
  number: string
  context: string
  name?: string
  max_messages?: number | null
  options?: [string, string][]
  users?: { uuid: string }[]
}
interface WazoMessage {
  id: string
  caller_id_name?: string | null
  caller_id_num?: string | null
  timestamp?: number
  duration?: number
  folder?: WazoFolder
}
interface WazoFolder {
  id: number
  type: string
  name?: string
  messages?: WazoMessage[]
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * Whom a mailbox is for: the first of its users that stands for someone (its `userfield` one of ours), '' when none
 * does. The one rule, for the synchronisation, the routes and the events alike (third review 11a, n°14).
 */
const holderIn = (vm: WazoMailbox, userOf: (uuid: string) => WazoUser | undefined) => (vm.users ?? []).map(u => userOf(u.uuid)?.userfield).find(f => f?.startsWith(HOLDER)) ?? ''

/** A message as the Gateway shows it: who left it (an extension or a number, never Asterisk's "unknown"), when, how long. */
export const voicemailOf = (m: WazoMessage, folder: Pick<WazoFolder, 'type'> | undefined): Voicemail => {
  const from = str(m.caller_id_num, 32)
  const name = str(m.caller_id_name, 128)
  return {
    id: m.id,
    ...(/^\+?[0-9]{1,32}$/.test(from) ? { from } : {}),
    ...(name && name !== from && !/^(unknown|anonymous)$/i.test(name) ? { fromName: name } : {}),
    receivedAt: new Date((typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : 0) * 1000).toISOString(),
    durationSec: typeof m.duration === 'number' && m.duration > 0 ? Math.round(m.duration) : 0,
    // Not listened to: in the inbox, or marked urgent.
    unread: folder?.type === 'new' || folder?.type === 'urgent'
  }
}

/** A single-consumer queue, as an AsyncIterable (the Gateway reads the events one at a time). */
class Queue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiter: ((r: IteratorResult<T>) => void) | undefined
  private closed = false
  constructor(private readonly max = 10_000) {}
  push(item: T) {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: item, done: false })
      return
    }
    if (this.items.length < this.max) this.items.push(item)
  }
  close() {
    this.closed = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = undefined
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => (this.waiter = resolve))
      }
    }
  }
}

/** The events of wazo-calld this package hears, by what they become. */
const EVENTS = {
  user_voicemail_message_created: 'voicemail.created',
  user_voicemail_message_updated: 'voicemail.updated',
  user_voicemail_message_deleted: 'voicemail.deleted'
} as const

/** A body not read: let go (Node's fetch keeps the connection until it is). */
const drop = (body: AsyncIterable<Uint8Array> | null) => {
  const cancel = (body as { cancel?: () => Promise<void> } | null)?.cancel
  if (typeof cancel === 'function') void cancel.call(body).catch(() => undefined)
}

/** The chunks of a body of Node's fetch, as they come (its reader), and a way to let it go unread (`cancel`). */
const chunksOf = (stream: ReadableStream<Uint8Array>) => ({
  cancel: () => stream.cancel(),
  async *[Symbol.asyncIterator]() {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    } finally {
      // Stopped before its end (a recording past its bound, an error): the connection goes with it.
      await reader.cancel().catch(() => undefined)
    }
  }
})

/** Node's fetch, as this provider uses it. */
const nativeFetch: Fetch = async (url, init) => {
  const res = await globalThis.fetch(url, init)
  return { status: res.status, headers: res.headers, json: () => res.json(), text: () => res.text(), body: res.body ? chunksOf(res.body) : null }
}

/**
 * The mailboxes of a tenant on Wazo Platform (step 11a, ADR 0022): made, moved and set aside as the extensions pass from
 * one person to another (syncMailboxes), their messages read, marked as read and deleted (wazo-calld), and a message
 * left, read or deleted anywhere told as it happens (wazo-websocketd).
 */
export class WazoVoicemail implements VoicemailProvider {
  readonly id: string
  private readonly fetch: Fetch
  private readonly log: WazoLogger
  private readonly now: () => number
  private readonly graceMs: number
  private readonly maxMessages: number
  /** The longest a message lasts, in seconds (maxsecs of each mailbox). */
  readonly maxMessageSec: number
  private readonly maxSilenceSec: number
  private readonly maxRecordingBytes: number
  private token: { value: string; renewAt: number } | undefined
  private tokenPending: Promise<string> | undefined
  private renewTimer: ReturnType<typeof setTimeout> | undefined
  private context: WazoContext | undefined
  /**
   * The mailbox of each extension and whom it is for (the `userfield` of its user), and the other way round, from the
   * last sync or looked up.
   */
  private readonly byExtension = new Map<string, { id: number; holder: string }>()
  private readonly byVoicemail = new Map<number, string>()
  private readonly queue = new Queue<RoutedEvent>()
  private subscribed = false
  private closed = false
  private ws: WebSocketLike | undefined
  private wsOpen = false
  private wsAttempt = 0
  private wsTimer: ReturnType<typeof setTimeout> | undefined
  private restOk: boolean | undefined
  private reason: string | undefined
  /** What the last synchronisation held back, as said in the log (said again only when it changes). */
  private heldNote: string | undefined
  /** The last read of each mailbox an event was of (mailboxById), for the `owns` of that event. */
  private readonly readForEvent = new Map<number, { at: number; box: { vm: WazoMailbox; holder: string } | undefined }>()
  /** The events of each mailbox, told one after the other in the order wazo-websocketd sent them (third review, n°8). */
  private readonly eventChains = new Map<number, Promise<void>>()

  constructor(private readonly config: WazoConfig) {
    this.id = config.id ?? 'wazo'
    this.fetch = config.fetch ?? nativeFetch
    this.log = config.logger ?? console
    this.now = config.now ?? Date.now
    if (!(config.holderSecret instanceof Uint8Array) || config.holderSecret.length < 16) throw new Error('Wazo provider: holderSecret takes 16 bytes or more')
    const positive = (value: number | undefined, fallback: number, name: string) => {
      const n = value ?? fallback
      if (!Number.isInteger(n) || n <= 0) throw new Error(`Wazo provider: ${name} is a whole number above 0`)
      return n
    }
    this.maxMessages = positive(config.maxMessages, 50, 'maxMessages')
    this.maxMessageSec = positive(config.maxMessageSec, 180, 'maxMessageSec')
    this.maxSilenceSec = positive(config.maxSilenceSec, 10, 'maxSilenceSec')
    const maxCallSec = positive(config.maxCallSec, Math.max(300, this.maxMessageSec), 'maxCallSec')
    // A message the call to the mailbox would cut first (second review 11a, n°11): refused, not cut without a word.
    if (this.maxMessageSec > maxCallSec) throw new Error(`Wazo provider: maxMessageSec (${this.maxMessageSec} s) is longer than a call to a mailbox lasts (maxCallSec, ${maxCallSec} s)`)
    // Asterisk's WAV (format = wav in the stack): 8 kHz, 16 bits, one channel, 16 000 bytes a second; and its header.
    this.maxRecordingBytes = positive(config.maxRecordingBytes, Math.ceil(maxCallSec * 16_000 * 1.5) + 65_536, 'maxRecordingBytes')
    this.graceMs = config.graceMs ?? 7 * DAY_MS
    if (!Number.isFinite(this.graceMs) || this.graceMs < 0) throw new Error('Wazo provider: graceMs is 0 or more')
  }

  getStatus(): ProviderStatus {
    if (this.restOk !== true) return 'DISCONNECTED'
    return this.subscribed && !this.wsOpen ? 'DEGRADED' : 'CONNECTED'
  }

  getStatusReason() {
    if (this.restOk !== true) return this.reason ?? 'voicemail server not reached yet'
    if (this.subscribed && !this.wsOpen) return 'voicemail events not heard (wazo-websocketd)'
    return undefined
  }

  /** Who a user of ours stands for (its `userfield`). */
  private key(userId: string) {
    return holderKey(this.config.holderSecret, userId)
  }

  // ---- wazo-auth ------------------------------------------------------------------------------------------------

  private async tokenValue(): Promise<string> {
    if (this.token && this.now() < this.token.renewAt) return this.token.value
    this.tokenPending ??= this.newToken().finally(() => (this.tokenPending = undefined))
    return this.tokenPending
  }

  private async newToken(): Promise<string> {
    const ttl = this.config.tokenTtlSec ?? 3600
    const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')
    const res = await this.send(`${this.config.authUrl}/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ expiration: ttl }) })
    if (res.status !== 200) throw this.failed(res.status, 'wazo-auth refused the Gateway account')
    const body = (await res.json()) as { data?: { token?: string } }
    const value = body.data?.token
    if (!value) throw this.failed(502, 'wazo-auth gave no token')
    this.token = { value, renewAt: this.now() + ttl * 800 }
    // A WebSocket open since the last token keeps hearing with the new one.
    if (this.ws && this.wsOpen) this.ws.send(JSON.stringify({ op: 'token', data: { token: value } }))
    this.renewLater(ttl * 800)
    return value
  }

  /**
   * While the events are heard, the token is renewed at four fifths of its life even when no request needs it:
   * wazo-websocketd closes a WebSocket whose token expired. A renewal that fails is tried again 30 s later.
   */
  private renewLater(ms: number) {
    clearTimeout(this.renewTimer)
    this.renewTimer = undefined
    if (!this.subscribed || this.closed) return
    this.renewTimer = setTimeout(() => {
      this.token = undefined
      this.tokenValue().catch((err: unknown) => {
        this.log.warn(`Wazo: token not renewed: ${err instanceof Error ? err.message : String(err)}`)
        this.renewLater(30_000)
      })
    }, Math.max(0, ms))
    this.renewTimer.unref?.()
  }

  private failed(status: number, message: string) {
    this.restOk = false
    this.reason = message
    return new WazoError(status, message)
  }

  /**
   * A request, within `requestTimeoutMs` until its answer is read; `bodyMs`: the answer's head only within it, its body
   * (a recording, read as it is sent on) within `bodyMs` more.
   */
  private async send(url: string, init: Parameters<Fetch>[1], bodyMs?: number) {
    const abort = new AbortController()
    let timer = setTimeout(() => abort.abort(new DOMException('timed out', 'TimeoutError')), this.config.requestTimeoutMs ?? 10_000)
    timer.unref?.()
    try {
      const res = await this.fetch(url, { ...init, signal: abort.signal })
      if (bodyMs !== undefined) {
        clearTimeout(timer)
        timer = setTimeout(() => abort.abort(new DOMException('timed out', 'TimeoutError')), bodyMs)
        timer.unref?.()
      }
      return res
    } catch (err) {
      clearTimeout(timer)
      throw this.failed(503, `voicemail server not reached (${err instanceof Error ? err.name : 'error'})`)
    }
  }

  /** A request to a Wazo API with the Gateway's token, once more with a new one if it expired meanwhile (401). */
  private async request(url: string, method = 'GET', body?: unknown, accept = 'application/json', bodyMs?: number) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokenValue()
      const res = await this.send(url, { method, headers: { 'x-auth-token': token, accept, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, bodyMs)
      if (res.status === 401 && attempt === 0) {
        drop(res.body)
        this.token = undefined
        continue
      }
      if (res.status >= 500 || res.status === 401 || res.status === 403) {
        drop(res.body)
        throw this.failed(res.status, `voicemail server answered ${res.status}`)
      }
      this.restOk = true
      this.reason = undefined
      return res
    }
  }

  private async json<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await this.request(url, method, body)
    if (res.status >= 300) throw new WazoError(res.status, `${method} ${new URL(url).pathname.replace(/\/[0-9a-f-]{36}/g, '/…')}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  private async list<T>(path: string): Promise<T[]> {
    const items: T[] = []
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.json<{ items?: T[]; total?: number }>(`${this.config.confdUrl}${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&offset=${offset}`)
      items.push(...(page.items ?? []))
      if ((page.items?.length ?? 0) < PAGE) return items
    }
  }

  // ---- wazo-confd: the mailboxes ----------------------------------------------------------------------------------

  /**
   * The context of the mailboxes, made the first time. Two Gateways that start together may each make one (second
   * review 11a, n°1): the oldest of that label is the one, read again after making it, and the one made here goes if
   * it is not.
   */
  private async contextOf(beforeWrite?: () => void): Promise<WazoContext> {
    if (this.context) return this.context
    const label = this.config.contextLabel ?? 'TwakePhone'
    const ours = async () => (await this.list<WazoContext>('/contexts')).filter(c => c.label === label && (c.type ?? 'internal') === 'internal').sort((a, b) => a.id - b.id)[0]
    let found = await ours()
    if (!found) {
      beforeWrite?.()
      const made = await this.json<WazoContext>(`${this.config.confdUrl}/contexts`, 'POST', { label, type: 'internal' })
      found = await ours()
      if (!found) throw new WazoError(502, 'the context of the mailboxes is not found after it was made')
      if (made?.id !== undefined && made.id !== found.id) {
        await this.json(`${this.config.confdUrl}/contexts/${made.id}`, 'DELETE').catch((err: unknown) => this.log.warn(`Wazo: a second context of the mailboxes not removed: ${err instanceof Error ? err.message : String(err)}`))
      } else this.log.info(`Wazo: context of the mailboxes made (${label})`)
    }
    this.context = found
    return found
  }

  /** The bounds of every mailbox, as wazo-confd takes them: Asterisk's maxmsg, maxsecs and maxsilence. */
  private bounds() {
    return {
      max_messages: this.maxMessages,
      options: [
        ['maxsecs', String(this.maxMessageSec)],
        ['maxsilence', String(this.maxSilenceSec)]
      ] as [string, string][]
    }
  }

  private bounded(vm: WazoMailbox) {
    const options = new Map(vm.options ?? [])
    return vm.max_messages === this.maxMessages && options.get('maxsecs') === String(this.maxMessageSec) && options.get('maxsilence') === String(this.maxSilenceSec)
  }

  private remember(extension: string, voicemailId: number, holder: string) {
    const before = this.byExtension.get(extension)
    if (before && before.id !== voicemailId) this.byVoicemail.delete(before.id)
    // Moved since: its extension of before is no longer its.
    const was = this.byVoicemail.get(voicemailId)
    if (was !== undefined && was !== extension && this.byExtension.get(was)?.id === voicemailId) this.byExtension.delete(was)
    this.byExtension.set(extension, { id: voicemailId, holder })
    this.byVoicemail.set(voicemailId, extension)
  }

  private forget(voicemailId: number) {
    const extension = this.byVoicemail.get(voicemailId)
    this.byVoicemail.delete(voicemailId)
    if (extension !== undefined && this.byExtension.get(extension)?.id === voicemailId) this.byExtension.delete(extension)
  }

  /**
   * A mailbox given another number (Wazo moves its messages with it), name and the bounds. Until the next remember,
   * it is nobody's here.
   */
  private async renumber(vm: WazoMailbox, number: string, name: string, context: string) {
    const bounds = this.bounds()
    await this.json(`${this.config.confdUrl}/voicemails/${vm.id}`, 'PUT', { name, number, context, ask_password: false, ...bounds })
    this.forget(vm.id)
    Object.assign(vm, { number, name }, bounds)
  }

  /** A mailbox, its user first let go (Wazo refuses to delete one a user has), then that user. */
  private async removeMailbox(vm: WazoMailbox, users: WazoUser[]) {
    for (const u of vm.users ?? []) {
      await this.json(`${this.config.confdUrl}/users/${u.uuid}/voicemails`, 'DELETE')
      const user = users.find(x => x.uuid === u.uuid)
      if (user?.userfield?.startsWith(HOLDER)) await this.json(`${this.config.confdUrl}/users/${u.uuid}`, 'DELETE')
    }
    await this.json(`${this.config.confdUrl}/voicemails/${vm.id}`, 'DELETE')
    this.forget(vm.id)
  }

  /**
   * Who holds each extension now. A mailbox already at its holder's extension stays (its bounds set again if they
   * changed); every other one is set aside (parked: renumbered out of the extensions, with its messages), then a holder
   * without a mailbox at their extension gets back theirs from aside (moved there, messages and all: a new extension
   * keeps the messages), else a new one. A mailbox aside longer than the grace period, its holder still gone, is
   * removed with its messages.
   *
   * Before any change, `beforeChanges` hears the mailboxes already at their holder's extension (the SIP server keeps
   * only those meanwhile: second review 11a, n°3). One mailbox Wazo refuses to change (a 4xx) is said and left out,
   * the others done (n°8). Too many at once (more than two, and more than half of the mailboxes at an extension: a
   * directory that came back short, a wrong tenant) is held back until `release` names exactly that (n°9; third review,
   * n°6): the mailboxes of the people gone stay where they are, reached as before; those past their grace period stay
   * aside. Said once, not at each synchronisation. `mayWrite` is asked before each change (third review, n°2).
   *
   * A mailbox only ever shows its holder's messages (third review 11a, n°4): one made that has messages already (left
   * in the spool under its number), or one moved that came with messages it did not have, is let go of its holder and
   * set aside, nobody's (removed after the grace period); its holder gets a new one.
   */
  async syncMailboxes(holders: { extension: string; userId: string; displayName?: string }[], options: VoicemailSyncOptions = {}): Promise<VoicemailSync> {
    const guard = () => {
      if (options.mayWrite && !options.mayWrite()) throw new WazoStopped()
    }
    const context = await this.contextOf(guard)
    const now = this.now()
    const wanted = new Map<string, { key: string; name: string }>()
    for (const h of holders) if (NUMBER.test(h.extension) && !PARKED.test(h.extension)) wanted.set(h.extension, { key: this.key(h.userId), name: str(h.displayName, 80) || h.extension })
    const keys = new Set([...wanted.values()].map(w => w.key))
    let users = await this.list<WazoUser>('/users?recurse=false')
    const mailboxes = (await this.list<WazoMailbox>('/voicemails?recurse=false')).filter(v => v.context === context.name)
    const holderOf = (vm: WazoMailbox) => holderIn(vm, uuid => users.find(x => x.uuid === uuid))
    const boxes: VoicemailBox[] = []
    const counts = { made: 0, moved: 0, parked: 0, removed: 0, isolated: 0 }
    let failed = 0
    /** One change of one mailbox: a refusal of Wazo (4xx) is said and counted, Wazo down stops the synchronisation. */
    const attempt = async (what: string, change: () => Promise<void>) => {
      guard()
      try {
        await change()
        return true
      } catch (err) {
        if (!(err instanceof WazoError) || err.status < 400 || err.status >= 500 || err.status === 401 || err.status === 403) throw err
        failed++
        this.log.warn(`Wazo: ${what} not done, tried again at the next synchronisation: ${err.message}`)
        return false
      }
    }
    /** A mailbox let go of its users and set aside, nobody's: its messages are nobody's here (third review 11a, n°4). */
    const isolate = async (vm: WazoMailbox) => {
      for (const u of vm.users ?? []) {
        guard()
        await this.json(`${this.config.confdUrl}/users/${u.uuid}/voicemails`, 'DELETE')
        users = users.map(x => (x.uuid === u.uuid ? { ...x, voicemail: null } : x))
      }
      vm.users = []
      guard()
      await this.renumber(vm, parkedNumber(now, vm.id), 'TwakePhone', context.name)
      counts.isolated++
    }
    // At their holder's extension: they stay.
    const kept = new Map<number, { vm: WazoMailbox; want: { key: string; name: string } }>()
    for (const vm of mailboxes) {
      const want = wanted.get(vm.number)
      if (!want || holderOf(vm) !== want.key) continue
      kept.set(vm.id, { vm, want })
      wanted.delete(vm.number)
    }
    // The others at an extension go aside, their extension free for its holder now; but not those of people gone
    // (their holder holds no extension, nobody holds theirs) when too many go at once, unless an administrator said
    // that very mass is meant.
    const active = mailboxes.filter(vm => !PARKED.test(vm.number))
    const release = options.release
    const sameOf = release !== undefined && release.of === active.length
    const toPark = active.filter(vm => !kept.has(vm.id))
    const gone = toPark.filter(vm => !wanted.has(vm.number) && !keys.has(holderOf(vm)))
    const tooManyGone = gone.length > 2 && gone.length * 2 > active.length
    const parkReleased = tooManyGone && sameOf && release?.park === gone.length
    const holdPark = tooManyGone && !parkReleased
    const stay = new Set(holdPark ? gone.map(vm => vm.id) : [])
    const reachable = [...kept.values()].map(k => k.vm).concat(active.filter(vm => stay.has(vm.id)))
    for (const vm of reachable) this.remember(vm.number, vm.id, holderOf(vm))
    await options.beforeChanges?.(reachable.map(vm => ({ extension: vm.number, mailbox: `${vm.number}@${context.name}` })))
    for (const { vm, want } of kept.values()) {
      if (!this.bounded(vm) || vm.name !== want.name) await attempt(`the bounds of mailbox ${vm.id}`, () => this.renumber(vm, vm.number, want.name, context.name))
      this.remember(vm.number, vm.id, want.key)
      boxes.push({ extension: vm.number, mailbox: `${vm.number}@${context.name}` })
    }
    for (const vm of active) if (stay.has(vm.id)) boxes.push({ extension: vm.number, mailbox: `${vm.number}@${context.name}` })
    for (const vm of toPark) {
      if (stay.has(vm.id)) continue
      if (await attempt(`setting mailbox ${vm.id} aside`, () => this.renumber(vm, parkedNumber(now, vm.id), vm.name || 'TwakePhone', context.name))) counts.parked++
    }
    const aside = mailboxes.filter(vm => !kept.has(vm.id) && !stay.has(vm.id))
    // The holders without a mailbox at their extension: theirs from aside, else a new one, for a user that stands for
    // them (theirs, if they had one without a mailbox). One whose extension is still taken (its mailbox not set aside)
    // gets none this time.
    for (const [extension, want] of wanted) {
      const theirs = aside.find(vm => holderOf(vm) === want.key)
      if (theirs) {
        let had = new Set<string>()
        const moved = await attempt(`moving mailbox ${theirs.id}`, async () => {
          had = await this.messageIdsOf(theirs.id)
          await this.renumber(theirs, extension, want.name, context.name)
        })
        if (!moved) continue
        aside.splice(aside.indexOf(theirs), 1)
        const has = await this.messageIdsOf(theirs.id)
        const lost = [...had].filter(id => !has.has(id)).length
        if (lost) {
          failed++
          this.log.error(`Wazo: ${lost} message(s) of mailbox ${theirs.id} did not move with it to ${extension} (left in the spool under its number of before, nobody's)`)
        }
        if (![...has].some(id => !had.has(id))) {
          this.remember(extension, theirs.id, want.key)
          boxes.push({ extension, mailbox: `${extension}@${context.name}` })
          counts.moved++
          continue
        }
        // It came with messages it did not have (the spool under the extension had some): nobody's.
        failed++
        this.log.error(`Wazo: mailbox ${theirs.id} moved to ${extension} shows messages it did not have (left in the spool under that number): set aside, nobody's, and a new one made`)
        if (!(await attempt(`setting mailbox ${theirs.id} aside, nobody's`, () => isolate(theirs)))) continue
      }
      const made = await attempt(`the mailbox of ${extension}`, async () => {
        const user = users.find(u => u.userfield === want.key && !u.voicemail) ?? (await this.json<WazoUser>(`${this.config.confdUrl}/users`, 'POST', { firstname: want.name.slice(0, 128), userfield: want.key }))
        if (!users.some(u => u.uuid === user.uuid)) users = [...users, { ...user, voicemail: null }]
        // Made where the spool still has messages (third review 11a, n°4): those are nobody's here. The mailbox is set
        // aside before anyone has it (nobody's), and made again, once.
        let vm: WazoMailbox | undefined
        for (let round = 0; !vm; round++) {
          guard()
          const fresh = await this.json<WazoMailbox>(`${this.config.confdUrl}/voicemails`, 'POST', { name: want.name, number: extension, context: context.name, ask_password: false, ...this.bounds() })
          if (!(await this.messageIdsOf(fresh.id)).size) {
            vm = fresh
            break
          }
          this.log.error(`Wazo: the mailbox made at ${extension} shows messages already (left in the spool under that number): set aside, nobody's`)
          guard()
          await this.renumber(fresh, parkedNumber(now, fresh.id), 'TwakePhone', context.name)
          counts.isolated++
          if (round > 0) throw new WazoError(409, `the spool under ${extension} keeps messages of before`)
        }
        guard()
        await this.json(`${this.config.confdUrl}/users/${user.uuid}/voicemails/${vm.id}`, 'PUT')
        users = [...users.filter(u => u.uuid !== user.uuid), { ...user, voicemail: { id: vm.id } }]
        this.remember(extension, vm.id, want.key)
      })
      if (!made) continue
      boxes.push({ extension, mailbox: `${extension}@${context.name}` })
      counts.made++
    }
    // Aside past the grace period: removed, unless too many at once (more than two, and more than half of the mailboxes
    // reached now), unless an administrator said that very mass is meant.
    const expired = aside.filter(vm => Number(PARKED.exec(vm.number)?.[1] ?? Infinity) * 1000 + this.graceMs <= now)
    const tooManyExpired = expired.length > 2 && expired.length * 2 > boxes.length
    const removeReleased = tooManyExpired && sameOf && release?.remove === expired.length
    const holdRemove = tooManyExpired && !removeReleased
    if (!holdRemove) {
      for (const vm of expired) {
        if (!(await attempt(`removing mailbox ${vm.id}`, () => this.removeMailbox(vm, users)))) continue
        counts.removed++
        // Its users of ours went with it; the others (made in Wazo by hand) lost it only.
        users = users.flatMap(u => ((vm.users ?? []).some(x => x.uuid === u.uuid) ? (u.userfield?.startsWith(HOLDER) ? [] : [{ ...u, voicemail: null }]) : [u]))
      }
    }
    // A user of ours left without a mailbox (one whose making stopped half-way, one whose mailbox was set aside nobody's):
    // removed.
    for (const u of users) {
      if (!u.userfield?.startsWith(HOLDER) || u.voicemail) continue
      await attempt(`removing a user without a mailbox`, () => this.json(`${this.config.confdUrl}/users/${u.uuid}`, 'DELETE'))
    }
    const heldBack = holdPark || holdRemove ? { ...(holdPark ? { park: gone.length } : {}), ...(holdRemove ? { remove: expired.length } : {}), of: active.length } : undefined
    const note = heldBack ? JSON.stringify(heldBack) : undefined
    if (note && note !== this.heldNote)
      this.log.warn(
        `Wazo: too many mailboxes at once, held back until an administrator says it is meant:${holdPark ? ` ${gone.length} of ${active.length} of people who hold no extension left where they are` : ''}${holdRemove ? ` ${expired.length} set aside past their grace period kept` : ''}`
      )
    this.heldNote = note
    if (release && !parkReleased && !removeReleased) this.log.warn(`Wazo: the release of ${JSON.stringify(release)} not applied: this synchronisation did not find that (${note ?? 'nothing held back'})`)
    if (counts.made || counts.moved || counts.parked || counts.removed || counts.isolated)
      this.log.info(`Wazo: ${counts.made} mailbox(es) made, ${counts.moved} moved to their holder's extension, ${counts.parked} set aside, ${counts.removed} removed (set aside longer than the grace period), ${counts.isolated} set aside nobody's (messages that were not theirs), ${aside.length - counts.removed} aside`)
    return { boxes: boxes.sort((a, b) => a.extension.localeCompare(b.extension)), failed, ...(heldBack ? { heldBack } : {}), ...(parkReleased || removeReleased ? { released: true } : {}) }
  }

  /** The ids of the messages of a mailbox, as wazo-calld lists them (none when it has no spool yet). */
  private async messageIdsOf(voicemailId: number) {
    return new Set((await this.rawMessagesOf(voicemailId)).map(({ m }) => m.id))
  }

  /** The mailbox of an extension in Wazo now, and whom it is for (another Gateway may have made or moved it since). */
  private async lookUp(extension: string) {
    if (PARKED.test(extension)) return undefined
    const context = await this.contextOf()
    const vm = (await this.list<WazoMailbox>(`/voicemails?recurse=false&search=${encodeURIComponent(extension)}`)).find(v => v.number === extension && v.context === context.name)
    if (!vm) {
      const known = this.byExtension.get(extension)
      if (known) this.forget(known.id)
      return undefined
    }
    const holder = await this.holderOfBox(vm)
    this.remember(extension, vm.id, holder)
    return { id: vm.id, holder }
  }

  /** Whom a mailbox is for, its users read from wazo-confd one by one (holderIn: the first of ours). */
  private async holderOfBox(vm: WazoMailbox) {
    const read = new Map<string, WazoUser>()
    for (const u of vm.users ?? []) {
      const user = await this.json<WazoUser>(`${this.config.confdUrl}/users/${u.uuid}`)
      if (user) read.set(u.uuid, user)
      if (user?.userfield?.startsWith(HOLDER)) break
    }
    return holderIn(vm, uuid => read.get(uuid))
  }

  /**
   * The mailbox of the owner's extension if it is the owner's: as the last sync (or look-up) left it, which this
   * Gateway's syncs keep true; looked up in Wazo again only when none is known for the extension or the one known is
   * someone else's. Never one set aside.
   */
  private async voicemailIdOf(owner: VoicemailOwner): Promise<number | undefined> {
    if (!NUMBER.test(owner.extension) || PARKED.test(owner.extension)) return undefined
    const holder = this.key(owner.userId)
    let box = this.byExtension.get(owner.extension)
    if (box?.holder !== holder) box = await this.lookUp(owner.extension)
    return box?.holder === holder ? box.id : undefined
  }

  /**
   * A mailbox of the context as Wazo has it now, by its id, and whom it is for; undefined when it has none such.
   * `reuseMs`: one read that long ago stands (the event's own read, for its `owns`: third review 11a, n°8).
   */
  private async mailboxById(voicemailId: number, reuseMs = 0): Promise<{ vm: WazoMailbox; holder: string } | undefined> {
    const recent = this.readForEvent.get(voicemailId)
    if (recent && this.now() - recent.at <= reuseMs) return recent.box
    const box = await this.readMailbox(voicemailId)
    this.readForEvent.set(voicemailId, { at: this.now(), box })
    if (this.readForEvent.size > 1_000) this.readForEvent.delete(this.readForEvent.keys().next().value!)
    return box
  }

  private async readMailbox(voicemailId: number) {
    const context = await this.contextOf()
    const res = await this.request(`${this.config.confdUrl}/voicemails/${voicemailId}`)
    if (res.status === 404) {
      drop(res.body)
      this.forget(voicemailId)
      return undefined
    }
    if (res.status >= 300) {
      drop(res.body)
      throw new WazoError(res.status, `voicemail ${voicemailId}: ${res.status}`)
    }
    const vm = (await res.json()) as WazoMailbox
    if (vm.context !== context.name || !NUMBER.test(vm.number ?? '')) return undefined
    return { vm, holder: await this.holderOfBox(vm) }
  }

  /**
   * Whether the mailbox of the owner's extension is theirs. With `owner.mailbox` (an event's), whether that very
   * mailbox is, as Wazo has it now (second review 11a, n°2): at the extension, for them, not aside. Another Gateway may
   * have moved it since this one last looked.
   */
  async owns(owner: VoicemailOwner) {
    if (owner.mailbox === undefined) return (await this.voicemailIdOf(owner)) !== undefined
    const id = /^[0-9]{1,15}$/.test(owner.mailbox) ? Number(owner.mailbox) : NaN
    if (!Number.isSafeInteger(id) || !NUMBER.test(owner.extension) || PARKED.test(owner.extension)) return false
    const now = await this.mailboxById(id, EVENT_READ_MS)
    if (!now) return false
    this.remember(now.vm.number, id, now.holder)
    // Set aside, its number is out of the extensions: never the owner's extension.
    return now.vm.number === owner.extension && now.holder === this.key(owner.userId)
  }

  // ---- wazo-calld: the messages ----------------------------------------------------------------------------------

  private async folders(voicemailId: number): Promise<WazoFolder[] | undefined> {
    const res = await this.request(`${this.config.calldUrl}/voicemails/${voicemailId}`)
    if (res.status === 404) {
      drop(res.body)
      this.forget(voicemailId)
      return undefined
    }
    if (res.status >= 300) {
      drop(res.body)
      throw new WazoError(res.status, `voicemail ${voicemailId}: ${res.status}`)
    }
    return ((await res.json()) as { folders?: WazoFolder[] }).folders ?? []
  }

  private async messagesOf(voicemailId: number) {
    return (await this.rawMessagesOf(voicemailId)).map(({ m, f }) => voicemailOf(m, f))
  }

  private async rawMessagesOf(voicemailId: number) {
    return ((await this.folders(voicemailId)) ?? []).flatMap(f => (f.messages ?? []).filter(m => typeof m.id === 'string' && MESSAGE_ID.test(m.id)).map(m => ({ m, f })))
  }

  async listMessages(owner: VoicemailOwner): Promise<Voicemail[]> {
    const id = await this.voicemailIdOf(owner)
    if (id === undefined) return []
    return (await this.messagesOf(id)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id))
  }

  /**
   * The recording of a message, as wazo-calld sends it on: never read whole here, and cut (an error, the answer then
   * broken off) past `maxRecordingBytes`; one that says it is larger is refused before.
   */
  async getRecording(owner: VoicemailOwner, messageId: string) {
    if (!MESSAGE_ID.test(messageId)) return undefined
    const id = await this.voicemailIdOf(owner)
    if (id === undefined) return undefined
    const res = await this.request(`${this.config.calldUrl}/voicemails/${id}/messages/${messageId}/recording`, 'GET', undefined, 'audio/wav', 300_000)
    if (res.status === 404 || res.status === 400) {
      drop(res.body)
      return undefined
    }
    if (res.status >= 300) {
      drop(res.body)
      throw new WazoError(res.status, `recording: ${res.status}`)
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
    const length = res.headers.get('content-length')
    const size = length !== null && /^[0-9]{1,15}$/.test(length.trim()) ? Number(length) : undefined
    const max = this.maxRecordingBytes
    const source = res.body
    if (!source || (size !== undefined && size > max)) {
      drop(source)
      throw new WazoError(502, source ? `recording larger than ${max} bytes` : 'recording without a body')
    }
    async function* capped() {
      let total = 0
      // Leaving the loop (an error, or the reader gone) lets the answer of wazo-calld go.
      for await (const chunk of source!) {
        total += chunk.byteLength
        if (total > max) throw new WazoError(502, `recording larger than ${max} bytes`)
        yield chunk
      }
    }
    return { contentType: /^audio\/[a-z0-9.+-]+$/i.test(type) ? type : 'audio/wav', ...(size !== undefined ? { size } : {}), body: capped() }
  }

  async markRead(owner: VoicemailOwner, messageId: string) {
    if (!MESSAGE_ID.test(messageId)) return false
    const id = await this.voicemailIdOf(owner)
    if (id === undefined) return false
    const folders = await this.folders(id)
    const from = folders?.find(f => (f.messages ?? []).some(m => m.id === messageId))
    if (!folders || !from) return false
    const old = folders.find(f => f.type === 'old')
    if (!old) throw new WazoError(502, 'the mailbox has no folder of messages listened to')
    if (from.id === old.id) return true
    const res = await this.request(`${this.config.calldUrl}/voicemails/${id}/messages/${messageId}`, 'PUT', { folder_id: old.id })
    drop(res.body)
    if (res.status === 404) return false
    if (res.status >= 300) throw new WazoError(res.status, `message not moved: ${res.status}`)
    return true
  }

  private async deleteFrom(voicemailId: number, messageId: string) {
    const res = await this.request(`${this.config.calldUrl}/voicemails/${voicemailId}/messages/${messageId}`, 'DELETE')
    drop(res.body)
    if (res.status === 404) return false
    if (res.status >= 300) throw new WazoError(res.status, `message not deleted: ${res.status}`)
    return true
  }

  async deleteMessage(owner: VoicemailOwner, messageId: string) {
    if (!MESSAGE_ID.test(messageId)) return false
    const id = await this.voicemailIdOf(owner)
    if (id === undefined) return false
    return this.deleteFrom(id, messageId)
  }

  /**
   * Every message of the person (step 10's erasure): of each mailbox of the context whose user stands for them, the
   * one at their extension and those set aside alike. Not someone else's mailbox now at an extension they held.
   */
  async eraseMessages(owner: Pick<VoicemailOwner, 'userId'>): Promise<number> {
    const context = await this.contextOf()
    const key = this.key(owner.userId)
    const users = await this.list<WazoUser>('/users?recurse=false')
    const ours = new Set(users.filter(u => u.userfield === key).map(u => u.uuid))
    const mailboxes = (await this.list<WazoMailbox>('/voicemails?recurse=false')).filter(v => v.context === context.name && (v.users ?? []).some(u => ours.has(u.uuid)))
    let erased = 0
    for (const vm of mailboxes) for (const m of await this.messagesOf(vm.id)) if (await this.deleteFrom(vm.id, m.id)) erased++
    return erased
  }

  /**
   * The messages left before `before`, in every mailbox of the context (those aside too): the retention period. One
   * without a date (Wazo gave none) is not taken for one of 1970: it stays, and it is said (second review 11a, n°22).
   */
  async purgeMessages(before: Date, options: { mayWrite?(): boolean } = {}): Promise<number> {
    const context = await this.contextOf()
    const limit = before.getTime() / 1000
    const mailboxes = (await this.list<WazoMailbox>('/voicemails?recurse=false')).filter(v => v.context === context.name)
    let purged = 0
    let undated = 0
    for (const vm of mailboxes)
      for (const { m } of await this.rawMessagesOf(vm.id)) {
        if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp) || m.timestamp <= 0) {
          undated++
          continue
        }
        if (m.timestamp >= limit) continue
        if (options.mayWrite && !options.mayWrite()) throw new WazoStopped()
        if (await this.deleteFrom(vm.id, m.id)) purged++
      }
    if (purged) this.log.info(`Wazo: ${purged} message(s) older than the retention period deleted`)
    if (undated) this.log.warn(`Wazo: ${undated} message(s) without a date left out of the retention period (delete them in Wazo if they are old)`)
    return purged
  }

  // ---- wazo-websocketd: the events -------------------------------------------------------------------------------

  subscribe(): AsyncIterable<RoutedEvent> {
    if (this.subscribed) throw new Error('Wazo provider: subscribe() takes one consumer')
    this.subscribed = true
    if (this.token) this.renewLater(this.token.renewAt - this.now())
    void this.connect()
    return this.queue
  }

  private async connect() {
    if (this.closed) return
    let token: string
    try {
      token = await this.tokenValue()
    } catch (err) {
      this.log.warn(`Wazo: events not heard yet: ${err instanceof Error ? err.message : String(err)}`)
      return this.reconnectLater()
    }
    if (this.closed) return
    const url = new URL(this.config.websocketdUrl)
    url.searchParams.set('token', token)
    url.searchParams.set('version', '2')
    let ws: WebSocketLike
    try {
      ws = (this.config.webSocket ?? (u => new WebSocket(u) as unknown as WebSocketLike))(url.toString())
    } catch (err) {
      this.log.warn(`Wazo: wazo-websocketd not reached: ${err instanceof Error ? err.message : String(err)}`)
      return this.reconnectLater()
    }
    this.ws = ws
    ws.onmessage = ev => this.onMessage(ws, ev.data)
    ws.onerror = () => undefined
    ws.onclose = ev => {
      if (this.ws !== ws) return
      const was = this.wsOpen
      this.ws = undefined
      this.wsOpen = false
      if (this.closed) return
      if (was) this.log.warn(`Wazo: voicemail events lost (wazo-websocketd closed${ev.code ? `, ${ev.code}` : ''}), reconnecting`)
      // A token refused (4002 and the like): the next one is new.
      if (ev.code && ev.code >= 4000) this.token = undefined
      this.reconnectLater()
    }
  }

  private reconnectLater() {
    if (this.closed) return
    const waits = this.config.reconnectMs ?? [1000, 2000, 5000, 10_000, 30_000]
    const wait = waits[Math.min(this.wsAttempt++, waits.length - 1)] ?? 30_000
    clearTimeout(this.wsTimer)
    this.wsTimer = setTimeout(() => void this.connect(), wait)
    this.wsTimer.unref?.()
  }

  private onMessage(ws: WebSocketLike, data: unknown) {
    let msg: { op?: string; code?: number; data?: { name?: string; data?: Record<string, unknown> } }
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')) as typeof msg
    } catch {
      return
    }
    if (msg.op === 'init') {
      for (const event_name of Object.keys(EVENTS)) ws.send(JSON.stringify({ op: 'subscribe', data: { event_name } }))
      ws.send(JSON.stringify({ op: 'start' }))
      return
    }
    if (msg.op === 'start') {
      if (msg.code !== undefined && msg.code !== 0) return
      if (!this.wsOpen) this.log.info('Wazo: voicemail events heard (wazo-websocketd)')
      this.wsOpen = true
      this.wsAttempt = 0
      return
    }
    if (msg.op !== 'event' || !msg.data?.name || !(msg.data.name in EVENTS)) return
    const type = EVENTS[msg.data.name as keyof typeof EVENTS]
    const payload = msg.data.data ?? {}
    // One mailbox's events one after the other, as they came (a `created` never told after its `deleted`); those of
    // different mailboxes side by side.
    const key = Number(payload.voicemail_id)
    const chain = (this.eventChains.get(key) ?? Promise.resolve()).then(() => this.tellEvent(type, payload))
    this.eventChains.set(key, chain)
    void chain.finally(() => {
      if (this.eventChains.get(key) === chain) this.eventChains.delete(key)
    })
  }

  /** An event told, its mailbox read again once more a moment later when Wazo did not answer, then given up (said). */
  private async tellEvent(type: (typeof EVENTS)[keyof typeof EVENTS], data: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.onEvent(type, data)
      } catch (err) {
        if (attempt > 0 || this.closed) {
          this.log.warn(`Wazo: voicemail event not told: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
        await new Promise(resolve => setTimeout(resolve, this.config.reconnectMs?.[0] ?? 1_000).unref?.())
      }
    }
  }

  private async onEvent(type: (typeof EVENTS)[keyof typeof EVENTS], data: Record<string, unknown>) {
    const voicemailId = Number(data.voicemail_id)
    const message = (data.message ?? {}) as WazoMessage
    const messageId = typeof data.message_id === 'string' ? data.message_id : message.id
    if (!Number.isInteger(voicemailId) || typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return
    // Where the mailbox is now, read from Wazo at each event (second review 11a, n°2): another Gateway may have moved it
    // since this one last looked. One aside, or of another context: nobody's. The Gateway asks `owns` with it.
    const now = await this.mailboxById(voicemailId)
    if (!now || PARKED.test(now.vm.number) || !now.holder) return
    this.remember(now.vm.number, voicemailId, now.holder)
    const extension = now.vm.number
    const mailbox = String(voicemailId)
    const timestamp = new Date(this.now()).toISOString()
    if (type === 'voicemail.deleted') this.queue.push({ extension, mailbox, event: { type, timestamp, payload: { id: messageId } } })
    else this.queue.push({ extension, mailbox, event: { type, timestamp, payload: { voicemail: voicemailOf({ ...message, id: messageId }, message.folder) } } })
  }

  async close() {
    this.closed = true
    clearTimeout(this.wsTimer)
    clearTimeout(this.renewTimer)
    const ws = this.ws
    this.ws = undefined
    this.wsOpen = false
    ws?.close(1000, 'closing')
    this.queue.close()
  }
}
