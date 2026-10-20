import { createHmac } from 'node:crypto'
import type { CallFlowRoute, RoutedEvent, VoicemailBox, VoicemailOwner, VoicemailProvider, VoicemailSubscribeOptions, VoicemailSync, VoicemailSyncOptions } from '@twake/telephony-provider-sdk'
import type { CallFlow, ProviderStatus, Voicemail } from '@twake/telephony-types'

export { WazoSupervision, SupervisionError, CALL_ID, SUPERVISION_CALLER, type WazoSupervisionConfig } from './supervision.js'
export { AmiError, amiAction, type AmiConfig } from './ami.js'

// Everything about Wazo Platform lives here (step 11a, ADR 0022): the Gateway only sees a VoicemailProvider. Wazo's own
// words (users, voicemails, folders, contexts) stay inside this package.
//
// One Wazo context (`internal`, labelled TwakePhone by default) holds the mailboxes of a tenant: one per person who
// holds an extension, for one Wazo user that stands for them (its `userfield` says who, as a keyed print: HMAC with a
// key the Gateway derives from SECRETS_KEY). A mailbox is its holder's, not an extension's: its
// number comes from their print (mailboxNumber), never an extension's, and never changes, so that Wazo never moves a
// mailbox's directory in its spool (what wazo-sysconfd does with a target already there is not this package's to
// trust). The SIP server sends the calls of each extension to the mailbox of its holder (`voicemail_boxes`), and says
// where each one is reached (VoicemailSyncOptions' `reached`): nothing of it is written in Wazo, whose wazo-confd
// reloads Asterisk at each change of a user. A person who takes another extension keeps theirs, messages and all; one
// who holds none any more has theirs set aside (no call reaches it; its name says since when), kept with its messages
// until the retention period deletes them (purgeMessages), and removed once past a grace period (`graceMs`) and
// without a message left (or with them, when no retention period deletes them), unless they come back meanwhile. The
// users this package makes carry no name, nothing but the print of whom they stand for. A person never hears someone
// else's messages. Each mailbox has its bounds (`maxMessages`, `maxMessageSec`). wazo-calld reads
// and changes the messages, wazo-websocketd tells a new one (the event wazo-calld makes of Asterisk's MWI, for the
// mailbox's user).

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
  /**
   * How long a mailbox whose holder holds no extension any more is kept aside at least, with its messages; it goes only
   * once past it and without a message left (the retention period deletes them: purgeMessages). Default: 7 days.
   */
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
  /** The label of the context of the mailboxes and of the lines. Default: TwakePhone. */
  contextLabel?: string
  /**
   * The key of the passwords of the lines (step 11c-1, ADR 0027): the password of the line of an extension is the first
   * 32 hexadecimal digits of the HMAC-SHA256 of the extension under it, which the SIP server computes the same (its
   * WAZO_LINE_KEY). Without it, no line is made (`syncLines` does nothing).
   */
  lineKey?: string
  /**
   * The context of the dialplan the members of a sequential group or a queue are called in (step 11c-2, ADR 0028): Wazo
   * calls `Local/<extension>@<context>`, whose dialplan rings the line of the extension. Default: twake-members (the
   * stack's own, docker/wazo/asterisk/extensions.conf).
   */
  membersContext?: string
  /** How long a token of wazo-auth lasts, in seconds; renewed at four fifths of it. Default: 3600. */
  tokenTtlSec?: number
  /** How long a request to Wazo may take, in milliseconds. Default: 10 s. */
  requestTimeoutMs?: number
  /**
   * How long a write to Wazo may take, its token and its retry after a 401 included, in milliseconds:
   * below the margin of the Gateway's lease of the mailboxes (15 s). Default: 10 s.
   */
  writeTimeoutMs?: number
  /** Waits before trying wazo-websocketd again, in milliseconds, the last one repeated. Default: 1, 2, 5, 10, 30 s. */
  reconnectMs?: number[]
  fetch?: Fetch
  webSocket?: (url: string) => WebSocketLike
  logger?: WazoLogger
  /** The provider's id (the Gateway names the tenant with it). Default: wazo. */
  id?: string
}

/** The number of a flow: digits, as OpenSIPS reads them. */
const FLOW_NUMBER = /^[0-9]{1,40}$/
const membersOf = (f: CallFlow) => [...new Set((f.members ?? []).filter(m => /^[0-9]{1,40}$/.test(m)))]
/**
 * Seconds Asterisk's queue waits between two members (the group's `retry_delay`: it also holds between the last member and
 * the next round, and for members that fail at once, so that a group of unreachable members does not spin).
 */
const RETRY_SEC = 1
/**
 * Seconds each member rings, and a caller waits at most: a sequential group is done after one round of its members, each
 * ringing `ring` seconds and the queue waiting `RETRY_SEC` between two (measured against Asterisk 22: with a timeout of 5 s
 * and a retry of 2 s, the second member is called 7 s after the first).
 */
const timesOf = (f: CallFlow) => {
  const ring = f.ringSec ?? 15
  return { ring, wait: f.kind === 'queue' ? (f.waitSec ?? 120) : (ring + RETRY_SEC) * Math.max(1, membersOf(f).length) }
}

/** The extensions that have a line: digits, as the SIP server's REGISTER names them (`wazo_lines`). */
const LINE_EXTENSION = /^[0-9]{1,40}$/

/** A SIP endpoint of wazo-confd, with the line it belongs to. */
interface WazoLineEndpoint {
  uuid: string
  name?: string
  label?: string
  line?: { id?: number } | null
}

/** A line of wazo-confd, with what it is associated with. */
interface WazoLineRow {
  id: number
  context?: string
  endpoint_sip?: unknown
  users?: unknown[]
  extensions?: unknown[]
}

/** A group of wazo-confd, as a sequential group or a queue of TwakePhone (step 11c-2): its name is what Asterisk calls the queue. */
interface WazoGroup {
  uuid: string
  name: string
  label: string
  ring_strategy?: string
  timeout?: number | null
  user_timeout?: number | null
  members?: { extensions?: { exten: string; context: string }[] }
}

/** The label of the group of the flow at `number`: how a group of ours is told from another, and from its number. */
const GROUP_LABEL = /^TwakePhone ([0-9]{1,40})$/
/** What reaches Asterisk's dialplan as a word: a queue's name and a sound's. */
const QUEUE_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const SOUND = /^[A-Za-z0-9_/-]{1,64}$/
/** The sound a menu plays without a greeting of its own (docker/wazo/asterisk/sounds). */
const DEFAULT_GREETING = 'twake-menu'

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
 * (VoicemailSyncOptions' mayWrite).
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
 * The number of the mailbox of a holder: 0001, then 20 digits of their print (`holderKey`).
 * Theirs whatever extension they hold, it never changes: Wazo never moves its directory in the spool. No extension
 * starts with 0 (EXTENSION_FORMAT): none is ever a mailbox's number.
 */
export const mailboxNumber = (key: string) => `0001${(BigInt(`0x${key.slice(HOLDER.length)}`) % 10n ** 20n).toString().padStart(20, '0')}`
const HOLDER_BOX = /^0001[0-9]{20}$/
/** The name of the mailboxes and users this package makes: nothing of the person. */
const NAME = 'TwakePhone'
/** The name of a mailbox set aside, and since when (seconds). */
const ASIDE = /^TwakePhone aside ([0-9]{1,12})$/
const asideName = (sec: number) => `TwakePhone aside ${sec}`
/** The extensions of a person, the shortest first (the one their events are told at). */
const shortest = (a: string, b: string) => a.length - b.length || a.localeCompare(b)
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
  firstname?: string | null
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
 * does. The one rule, for the synchronisation, the routes and the events alike.
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
 * The mailboxes of a tenant on Wazo Platform (step 11a, ADR 0022): one per person who holds an extension, made and set
 * aside as people come and go (syncMailboxes), their messages read, marked as read and deleted (wazo-calld), and a
 * message left, read or deleted anywhere told as it happens (wazo-websocketd).
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
  /** The mailbox of each holder (by their print), and the other way round, from the last sync or looked up. */
  private readonly byHolder = new Map<string, number>()
  private readonly holderById = new Map<number, string>()
  /** The holders whose mailbox Wazo refused to make, how many times in a row, and until when it waits. */
  private readonly refusedAt = new Map<string, { n: number; until: number }>()
  private readonly writeMs: number
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
  /** What the last synchronisation returned (where each mailbox is reached, when `reached` is not given), and who held what. */
  private lastBoxes: VoicemailBox[] = []
  private lastPeople = new Map<string, string[]>()
  /** Who holds which extension now (VoicemailSubscribeOptions' holders), and the print of each person met. */
  private holdersNow: (() => Promise<{ extension: string; userId: string }[]>) | undefined
  /** Told when the events are heard again (VoicemailSubscribeOptions's onHeard). */
  private onHeard: (() => void) | undefined
  private readonly keys = new Map<string, string>()
  /** The events of each mailbox, told one after the other in the order wazo-websocketd sent them. */
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
    // A message the call to the mailbox would cut first: refused, not cut without a word.
    if (this.maxMessageSec > maxCallSec) throw new Error(`Wazo provider: maxMessageSec (${this.maxMessageSec} s) is longer than a call to a mailbox lasts (maxCallSec, ${maxCallSec} s)`)
    // Asterisk's WAV (format = wav in the stack): 8 kHz, 16 bits, one channel, 16 000 bytes a second; and its header.
    this.maxRecordingBytes = positive(config.maxRecordingBytes, Math.ceil(maxCallSec * 16_000 * 1.5) + 65_536, 'maxRecordingBytes')
    this.writeMs = positive(config.writeTimeoutMs, 10_000, 'writeTimeoutMs')
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
   * A request, within `requestTimeoutMs` until its answer is read, its body included (and before `deadline`, when
   * given: a write's); `bodyMs`: the answer's head only within it, its body (a recording, read as it is sent on) within
   * `bodyMs` more.
   */
  private async send(url: string, init: Parameters<Fetch>[1], bodyMs?: number, deadline?: number) {
    const ms = deadline === undefined ? (this.config.requestTimeoutMs ?? 10_000) : Math.min(this.config.requestTimeoutMs ?? 10_000, deadline - Date.now())
    if (ms <= 0) throw this.failed(503, 'voicemail server not reached in time (TimeoutError)')
    const abort = new AbortController()
    let timer = setTimeout(() => abort.abort(new DOMException('timed out', 'TimeoutError')), ms)
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

  /** The token, before `deadline` when given (a write's). */
  private async tokenBefore(deadline: number | undefined) {
    if (deadline === undefined) return this.tokenValue()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.tokenValue(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(this.failed(503, 'voicemail server not reached in time (TimeoutError)')), Math.max(0, deadline - Date.now()))
          timer.unref?.()
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A request to a Wazo API with the Gateway's token, once more with a new one if it expired meanwhile (401). A write
   * (any method but GET) is bounded whole, its token and its retry included, by `writeTimeoutMs`, and `guard` is asked
   * again once the token is in hand, before each try: a Gateway that lost the lease while
   * wazo-auth answered sends nothing.
   */
  private async request(url: string, method = 'GET', body?: unknown, accept = 'application/json', bodyMs?: number, guard?: () => void) {
    const deadline = method === 'GET' ? undefined : Date.now() + this.writeMs
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokenBefore(deadline)
      guard?.()
      const res = await this.send(url, { method, headers: { 'x-auth-token': token, accept, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, bodyMs, deadline)
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

  private async json<T>(url: string, method = 'GET', body?: unknown, guard?: () => void): Promise<T> {
    const res = await this.request(url, method, body, 'application/json', undefined, guard)
    let text: string | undefined
    let value: unknown
    try {
      if (res.status >= 300) text = (await res.text()).slice(0, 200)
      else if (res.status !== 204) value = await res.json()
    } catch (err) {
      // Its body not read in time (the request's bound covers it), or not JSON.
      throw this.failed(503, `voicemail server's answer not read (${err instanceof Error ? err.name : 'error'})`)
    }
    if (text !== undefined) throw new WazoError(res.status, `${method} ${new URL(url).pathname.replace(/\/[0-9a-f-]{36}/g, '/…')}: ${res.status} ${text}`)
    return value as T
  }

  /** A light request to wazo-confd: the status says what came of it. */
  async probe() {
    await this.json(`${this.config.confdUrl}/contexts?limit=1&offset=0`)
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
   * The context of the mailboxes, made the first time. Two Gateways that start together may each make one:
   * the oldest of that label is the one, read again after making it, and the one made here goes if
   * it is not.
   */
  private async contextOf(guard?: () => void): Promise<WazoContext> {
    if (this.context) return this.context
    const label = this.config.contextLabel ?? 'TwakePhone'
    const ours = async () => (await this.list<WazoContext>('/contexts')).filter(c => c.label === label && (c.type ?? 'internal') === 'internal').sort((a, b) => a.id - b.id)[0]
    let found = await ours()
    if (!found) {
      guard?.()
      const made = await this.json<WazoContext>(`${this.config.confdUrl}/contexts`, 'POST', { label, type: 'internal' }, guard)
      found = await ours()
      if (!found) throw new WazoError(502, 'the context of the mailboxes is not found after it was made')
      if (made?.id !== undefined && made.id !== found.id) {
        await this.json(`${this.config.confdUrl}/contexts/${made.id}`, 'DELETE', undefined, guard).catch((err: unknown) => this.log.warn(`Wazo: a second context of the mailboxes not removed: ${err instanceof Error ? err.message : String(err)}`))
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

  private remember(key: string, voicemailId: number) {
    const before = this.byHolder.get(key)
    if (before !== undefined && before !== voicemailId) this.holderById.delete(before)
    this.byHolder.set(key, voicemailId)
    this.holderById.set(voicemailId, key)
  }

  private forget(voicemailId: number) {
    const key = this.holderById.get(voicemailId)
    this.holderById.delete(voicemailId)
    if (key !== undefined && this.byHolder.get(key) === voicemailId) this.byHolder.delete(key)
  }

  /** A mailbox given its name (NAME, or since when it is aside) and the bounds again, its number as it is (Wazo moves nothing). */
  private async update(vm: WazoMailbox, name: string, context: string, guard: () => void) {
    const bounds = this.bounds()
    await this.json(`${this.config.confdUrl}/voicemails/${vm.id}`, 'PUT', { name, number: vm.number, context, ask_password: false, ...bounds }, guard)
    Object.assign(vm, { name }, bounds)
  }

  /** A mailbox, its user first let go (Wazo refuses to delete one a user has), then that user. */
  private async removeMailbox(vm: WazoMailbox, users: WazoUser[], guard: () => void) {
    for (const u of vm.users ?? []) {
      await this.json(`${this.config.confdUrl}/users/${u.uuid}/voicemails`, 'DELETE', undefined, guard)
      const user = users.find(x => x.uuid === u.uuid)
      if (user?.userfield?.startsWith(HOLDER)) await this.json(`${this.config.confdUrl}/users/${u.uuid}`, 'DELETE', undefined, guard)
    }
    await this.json(`${this.config.confdUrl}/voicemails/${vm.id}`, 'DELETE', undefined, guard)
    this.forget(vm.id)
  }

  /**
   * Who holds each extension now. Each person has their mailbox at their own number (mailboxNumber): kept (its bounds
   * set again if they changed), or made, and reached at every extension they hold. One whose holder holds no extension
   * any more is set aside (no call reaches it, its name says since when), with its messages; it is theirs again,
   * messages and all, if they come back. One aside longer than the grace period and without a message left (the
   * retention period deleted them: purgeMessages), or with them when `removeAsideWithMessages`, is removed. No mailbox
   * ever changes number: Wazo never moves a directory of its spool. Where a mailbox is reached is never written in
   * Wazo: a change of extension changes nothing there (wazo-confd would reload Asterisk for it).
   *
   * Before any change, `beforeChanges` hears the mailboxes already their holder's (the SIP server keeps only those
   * meanwhile). One mailbox Wazo refuses to change (a 4xx) is said and left out, the others done; one it refused to
   * make is tried again after a wait that grows at each refusal, from a minute to an hour. Too many gone at once (more
   * than two, and more than half of the mailboxes in use, counted on the mailboxes and never on where they are reached:
   * a directory that came back short, a wrong tenant, an id attribute switched) is held back until `release` names
   * exactly that: the mailboxes of the people gone stay as they are, reached at the extensions nobody holds (as
   * `reached` says), and nobody new is given one meanwhile; those past their grace period stay aside. Said once, not at
   * each synchronisation. A release only sets aside: the mailbox is its holder's again, messages and all, if they come
   * back. `mayWrite` is asked before each change, and again before each request once Wazo's token is in hand.
   */
  async syncMailboxes(holders: { extension: string; userId: string; displayName?: string }[], options: VoicemailSyncOptions = {}): Promise<VoicemailSync> {
    const guard = () => {
      if (options.mayWrite && !options.mayWrite()) throw new WazoStopped()
    }
    const write = <T>(path: string, method: string, body?: unknown) => this.json<T>(`${this.config.confdUrl}${path}`, method, body, guard)
    const context = await this.contextOf(guard)
    const now = this.now()
    // Each person, by their print: the extensions they hold, the shortest first.
    const people = new Map<string, string[]>()
    for (const h of holders) {
      if (!NUMBER.test(h.extension) || h.extension.startsWith('0')) continue
      const key = this.key(h.userId)
      const extensions = people.get(key) ?? []
      if (!extensions.includes(h.extension)) extensions.push(h.extension)
      people.set(key, extensions)
    }
    for (const extensions of people.values()) extensions.sort(shortest)
    const held = new Set([...people.values()].flat())
    let users = await this.list<WazoUser>('/users?recurse=false')
    const mailboxes = (await this.list<WazoMailbox>('/voicemails?recurse=false')).filter(v => v.context === context.name)
    const userOf = (uuid: string) => users.find(x => x.uuid === uuid)
    const holderOf = (vm: WazoMailbox) => holderIn(vm, userOf)
    const address = (vm: WazoMailbox) => `${vm.number}@${context.name}`
    // Where each mailbox is reached now: as the SIP server has it, or as the last synchronisation left it.
    const reachedAt = new Map<string, string[]>()
    for (const b of options.reached ?? this.lastBoxes) reachedAt.set(b.mailbox, [...(reachedAt.get(b.mailbox) ?? []), b.extension])
    const reachedOf = (vm: WazoMailbox) => reachedAt.get(address(vm)) ?? []
    const asideSince = (vm: WazoMailbox) => Number(ASIDE.exec(vm.name ?? '')?.[1] ?? NaN)
    const ours = mailboxes.filter(vm => HOLDER_BOX.test(vm.number))
    const byNumber = new Map(ours.map(vm => [vm.number, vm]))
    const numbers = new Set([...people.keys()].map(mailboxNumber))
    const boxes: VoicemailBox[] = []
    const counts = { made: 0, aside: 0, removed: 0, erased: 0 }
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
    // Theirs already, at their number: reached at the extensions they hold, whatever Wazo is told next.
    const ready = new Map<string, WazoMailbox>()
    for (const key of people.keys()) {
      const vm = byNumber.get(mailboxNumber(key))
      if (vm && holderOf(vm) === key) ready.set(key, vm)
    }
    // Those of people who hold no extension now go aside, unless too many go at once, unless an administrator said
    // that very mass is meant. Counted on the mailboxes in use (a holder, not aside), never on where they are reached:
    // a mass whose rows went (their extensions given to new ids: an id attribute switched, ids renamed) is a mass all
    // the same. Held back, those still reached at an extension nobody holds stay reached there.
    const gone = ours.filter(vm => holderOf(vm) !== '' && !people.has(holderOf(vm)))
    const inUse = (vm: WazoMailbox) => holderOf(vm) !== '' && !ASIDE.test(vm.name ?? '')
    const leaving = gone.filter(inUse)
    const active = ours.filter(inUse)
    const stillAt = new Map(leaving.map(vm => [vm, reachedOf(vm).filter(e => !held.has(e))] as const))
    const release = options.release
    const sameOf = release !== undefined && release.of === active.length
    const tooManyGone = leaving.length > 2 && leaving.length * 2 > active.length
    const parkReleased = tooManyGone && sameOf && release?.park === leaving.length
    const holdPark = tooManyGone && !parkReleased
    const stay = holdPark ? stillAt : new Map<WazoMailbox, string[]>()
    const stayBoxes = [...stay].flatMap(([vm, at]) => at.map(extension => ({ extension, mailbox: address(vm) })))
    const reachable = [...ready].flatMap(([key, vm]) => people.get(key)!.map(extension => ({ extension, mailbox: address(vm) }))).concat(stayBoxes)
    for (const [key, vm] of ready) this.remember(key, vm.id)
    await options.beforeChanges?.(reachable)
    let waiting = 0
    for (const [key, extensions] of people) {
      const number = mailboxNumber(key)
      let vm = ready.get(key)
      // A mass held back: nobody new given a mailbox meanwhile. The same people under new ids (an id attribute
      // switched) would otherwise have theirs by the next round, the mass then less than half of the mailboxes in use,
      // and set aside without anyone saying it is meant.
      if (!vm && holdPark) {
        waiting++
        continue
      }
      if (!vm) {
        const there = byNumber.get(number)
        if (there && holderOf(there) !== '') {
          // Someone else's at their number (a mailbox made by hand there): never shown to them.
          failed++
          this.log.error(`Wazo: the mailbox at the number of the holder of ${extensions[0]} (${there.id}) is someone else's: none for them`)
          continue
        }
        const refused = this.refusedAt.get(key)
        if (refused && now < refused.until) {
          failed++
          continue
        }
        let user: WazoUser | undefined
        let box: WazoMailbox | undefined = there
        const made = await attempt(`the mailbox of ${extensions[0]}`, async () => {
          user = users.find(u => u.userfield === key && !u.voicemail) ?? (await write<WazoUser>('/users', 'POST', { firstname: NAME, userfield: key }))
          if (!users.some(u => u.uuid === user!.uuid)) users = [...users, { ...user, voicemail: null }]
          box ??= await write<WazoMailbox>('/voicemails', 'POST', { name: NAME, number, context: context.name, ask_password: false, ...this.bounds() })
          await write(`/users/${user.uuid}/voicemails/${box.id}`, 'PUT')
          users = users.map(u => (u.uuid === user!.uuid ? { ...u, voicemail: { id: box!.id } } : u))
          box.users = [{ uuid: user.uuid }]
        })
        if (!made || !box) {
          // Refused: again after a minute, then two, four... an hour at most.
          const n = (refused?.n ?? 0) + 1
          this.refusedAt.set(key, { n, until: now + Math.min(60_000 * 2 ** (n - 1), 3_600_000) })
          continue
        }
        this.refusedAt.delete(key)
        vm = box
        counts.made++
      }
      // Its bounds, and its name back from aside for one who came back.
      if (!this.bounded(vm) || vm.name !== NAME) await attempt(`the bounds of mailbox ${vm.id}`, () => this.update(vm, NAME, context.name, guard))
      this.remember(key, vm.id)
      for (const extension of extensions) boxes.push({ extension, mailbox: address(vm) })
    }
    boxes.push(...stayBoxes)
    // The people gone: their mailbox set aside, with its messages (since when, in its name, for the grace period).
    const asideNow = new Set<WazoMailbox>()
    for (const vm of gone) {
      if (stay.has(vm)) continue
      this.forget(vm.id)
      if (ASIDE.test(vm.name ?? '')) continue
      if (!(await attempt(`setting mailbox ${vm.id} aside`, () => this.update(vm, asideName(Math.floor(now / 1000)), context.name, guard)))) continue
      asideNow.add(vm)
      counts.aside++
    }
    // Aside past the grace period, or half made for nobody who holds an extension, and without a message left (the
    // messages stay their retention period, whatever the grace period), or with them when no retention period deletes
    // them: removed, unless too many at once (more than two, and more than half of the mailboxes reached now), unless
    // an administrator said that very mass is meant.
    const pastGrace = gone.filter(vm => !stay.has(vm) && asideSince(vm) * 1000 + this.graceMs <= now).concat(ours.filter(vm => holderOf(vm) === '' && !numbers.has(vm.number)))
    const expired: { vm: WazoMailbox; messages: Set<string> }[] = []
    for (const vm of pastGrace) {
      const messages = await this.messageIdsOf(vm.id)
      // With its messages, never in the round that set it aside (a grace period of 0): a person between two extensions
      // a moment keeps them.
      if (!messages.size || (options.removeAsideWithMessages && !asideNow.has(vm))) expired.push({ vm, messages })
    }
    const tooManyExpired = expired.length > 2 && expired.length * 2 > boxes.length
    const removeReleased = tooManyExpired && sameOf && release?.remove === expired.length
    const holdRemove = tooManyExpired && !removeReleased
    if (!holdRemove) {
      for (const { vm, messages } of expired) {
        const removed = await attempt(`removing mailbox ${vm.id}`, async () => {
          // Its messages first, through wazo-calld: none is left in the spool whatever wazo-sysconfd does next.
          for (const id of messages) if (await this.deleteFrom(vm.id, id, guard)) counts.erased++
          await this.removeMailbox(vm, users, guard)
        })
        if (!removed) continue
        counts.removed++
        // Its users of ours went with it; the others (made in Wazo by hand) lost it only.
        users = users.flatMap(u => ((vm.users ?? []).some(x => x.uuid === u.uuid) ? (u.userfield?.startsWith(HOLDER) ? [] : [{ ...u, voicemail: null }]) : [u]))
      }
    }
    // A user of ours without a mailbox, for nobody who holds an extension (one whose making stopped half-way): removed.
    for (const u of users) {
      if (!u.userfield?.startsWith(HOLDER) || u.voicemail || people.has(u.userfield)) continue
      await attempt(`removing a user without a mailbox`, () => write(`/users/${u.uuid}`, 'DELETE'))
    }
    const heldBack =
      holdPark || holdRemove
        ? { ...(holdPark ? { park: leaving.length } : {}), ...(holdRemove ? { remove: expired.length } : {}), of: active.length, ...(holdPark && waiting ? { waiting } : {}), ...(holdPark && !boxes.length ? { noneReached: true } : {}) }
        : undefined
    const note = heldBack ? JSON.stringify(heldBack) : undefined
    if (note && note !== this.heldNote)
      this.log.warn(
        `Wazo: too many mailboxes at once, held back until an administrator says it is meant:${holdPark ? ` ${leaving.length} of ${active.length} of people who hold no extension now (${waiting} new holder(s) without a mailbox meanwhile)` : ''}${holdRemove ? ` ${expired.length} set aside past their grace period kept` : ''}`
      )
    this.heldNote = note
    if (release && !parkReleased && !removeReleased) this.log.warn(`Wazo: the release of ${JSON.stringify(release)} not applied: this synchronisation did not find that (${note ?? 'nothing held back'})`)
    if (counts.made || counts.aside || counts.removed)
      this.log.info(`Wazo: ${counts.made} mailbox(es) made, ${counts.aside} set aside (their holder holds no extension), ${counts.removed} removed (aside past the grace period${counts.erased ? `, ${counts.erased} message(s) with them: no retention period` : ', no message left'})`)
    boxes.sort((a, b) => a.extension.localeCompare(b.extension))
    this.lastBoxes = boxes
    this.lastPeople = people
    return { boxes, failed, ...(heldBack ? { heldBack } : {}), ...(parkReleased || removeReleased ? { released: true } : {}) }
  }

  /** The ids of the messages of a mailbox, as wazo-calld lists them (none when it has no spool yet). */
  private async messageIdsOf(voicemailId: number) {
    return new Set((await this.rawMessagesOf(voicemailId)).map(({ m }) => m.id))
  }

  /** Whom a mailbox is for, its users read from wazo-confd one by one (holderIn: the first of ours). */
  private async holderOfBox(vm: WazoMailbox) {
    const read = new Map<string, WazoUser>()
    for (const u of vm.users ?? []) {
      const user = await this.json<WazoUser>(`${this.config.confdUrl}/users/${u.uuid}`)
      if (user) read.set(u.uuid, user)
      if (user?.userfield?.startsWith(HOLDER)) break
    }
    return { holder: holderIn(vm, uuid => read.get(uuid)) }
  }

  /**
   * The owner's mailbox: the one at their number whose user stands for them, as the last sync (or look-up) found it;
   * looked up in Wazo when none is known. Whatever extension they hold (`owner.extension` only has to be one).
   */
  private async voicemailIdOf(owner: VoicemailOwner): Promise<number | undefined> {
    if (!NUMBER.test(owner.extension)) return undefined
    const key = this.key(owner.userId)
    const known = this.byHolder.get(key)
    if (known !== undefined) return known
    const context = await this.contextOf()
    const number = mailboxNumber(key)
    const vm = (await this.list<WazoMailbox>(`/voicemails?recurse=false&search=${number}`)).find(v => v.number === number && v.context === context.name)
    if (!vm || (await this.holderOfBox(vm)).holder !== key) return undefined
    this.remember(key, vm.id)
    return vm.id
  }

  /**
   * A mailbox of the context as Wazo has it now, by its id, and whom it is for; undefined when it has none such.
   * `reuseMs` above 0: one read that long ago stands (the event's own read, for its `owns`).
   */
  private async mailboxById(voicemailId: number, reuseMs = 0): Promise<{ vm: WazoMailbox; holder: string } | undefined> {
    const recent = this.readForEvent.get(voicemailId)
    if (recent && reuseMs > 0 && this.now() - recent.at <= reuseMs) return recent.box
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
    return { vm, holder: (await this.holderOfBox(vm)).holder }
  }

  /**
   * Whether the owner has a mailbox. With `owner.mailbox` (an event's), whether that very mailbox is theirs, as Wazo has
   * it now: at their number, its user standing for them.
   */
  // ---- wazo-confd: the lines (step 11c-1, ADR 0027) ---------------------------------------------------------------

  /** Whether lines are made (a `lineKey` was given). */
  get linesOn() {
    return !!this.config.lineKey
  }

  /** The password of the line of `extension`: what the SIP server answers Wazo's challenge with. */
  linePassword(extension: string) {
    if (!this.config.lineKey) throw new Error('Wazo provider: lineKey is not set')
    return createHmac('sha256', this.config.lineKey).update(extension).digest('hex').slice(0, 32)
  }

  /**
   * One line at Wazo for each of these extensions (digits): an endpoint named after it, in the context of the
   * mailboxes, with its password (linePassword) and one contact at most. Nothing of the person is in Wazo. Those of an
   * extension nobody holds any more go, once `beforeRemoval` has heard which (the SIP server stops registering them
   * there first). Returns the extensions that have their line now (`ready`), and how many Wazo refused (said in the log,
   * done again at the next round). Never more than a line at a time: each is a reload of Asterisk's PJSIP, which
   * wazo-sysconfd melts. `mayWrite` is asked before each request.
   */
  async syncLines(extensions: string[], options: { mayWrite?(): boolean; beforeRemoval?(extensions: string[]): Promise<void> } = {}): Promise<{ ready: string[]; failed: number }> {
    if (!this.config.lineKey) return { ready: [], failed: 0 }
    const guard = () => {
      if (options.mayWrite && !options.mayWrite()) throw new WazoStopped()
    }
    const label = this.config.contextLabel ?? 'TwakePhone'
    const wanted = [...new Set(extensions.filter(e => LINE_EXTENSION.test(e)))].sort()
    const context = await this.contextOf(guard)
    const have = new Map<string, WazoLineEndpoint>()
    for (const e of await this.list<WazoLineEndpoint>('/endpoints/sip')) if (e.label === label && LINE_EXTENSION.test(e.name ?? '')) have.set(e.name!, e)
    // A line whose creation was answered by an error after it was made (wazo-sysconfd failing after wazo-confd committed)
    // has no endpoint: used again, never made twice (the context holds nothing but ours).
    const orphans = (await this.list<WazoLineRow>('/lines')).filter(l => l.context === context.name && !l.endpoint_sip && !(l.users?.length) && !(l.extensions?.length))
    const ready: string[] = []
    let failed = 0
    const refused = (what: string, extension: string, err: unknown) => {
      if (err instanceof WazoStopped || (err instanceof WazoError && err.status >= 500)) throw err
      failed++
      this.log.warn(`Wazo: the line of ${extension} not ${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const confd = this.config.confdUrl
    const gone = [...have.keys()].filter(e => !wanted.includes(e))
    if (gone.length) await options.beforeRemoval?.(gone)
    for (const extension of gone) {
      const endpoint = have.get(extension)!
      try {
        if (endpoint.line?.id !== undefined) {
          await this.json(`${confd}/lines/${endpoint.line.id}/endpoints/sip/${endpoint.uuid}`, 'DELETE', undefined, guard)
          await this.json(`${confd}/lines/${endpoint.line.id}`, 'DELETE', undefined, guard)
        }
        await this.json(`${confd}/endpoints/sip/${endpoint.uuid}`, 'DELETE', undefined, guard)
      } catch (err) {
        refused('removed', extension, err)
      }
    }
    for (const extension of wanted) {
      try {
        let endpoint = have.get(extension)
        if (!endpoint) {
          endpoint = await this.json<WazoLineEndpoint>(
            `${confd}/endpoints/sip`,
            'POST',
            {
              name: extension,
              label,
              auth_section_options: [
                ['username', extension],
                ['password', this.linePassword(extension)]
              ],
              aor_section_options: [
                ['max_contacts', '1'],
                ['remove_existing', 'yes']
              ]
            },
            guard
          )
        }
        if (endpoint.line?.id === undefined) {
          const spare = orphans.shift()
          const line = spare ?? (await this.json<{ id: number }>(`${confd}/lines`, 'POST', { context: context.name }, guard))
          await this.json(`${confd}/lines/${line.id}/endpoints/sip/${endpoint.uuid}`, 'PUT', undefined, guard)
        }
        ready.push(extension)
      } catch (err) {
        refused('made', extension, err)
      }
    }
    // The lines left over by an error, nothing at Wazo any more: removed.
    for (const line of orphans) await this.json(`${confd}/lines/${line.id}`, 'DELETE', undefined, guard).catch((err: unknown) => this.log.warn(`Wazo: a line without an endpoint not removed: ${err instanceof Error ? err.message : String(err)}`))
    return { ready, failed }
  }

  // ---- wazo-confd: the call flows (step 11c-2, ADR 0028) ----------------------------------------------------------

  /** Whether flows are run: they ring the members through their lines, so when lines are made. */
  get flowsOn() {
    return this.linesOn
  }

  /**
   * The sequential groups and queues of the tenant are groups of wazo-confd, labelled `TwakePhone <number>`: a strategy
   * (`linear`: one member after the other; `least_recent`: the one idle longest), the seconds each member rings, the
   * seconds at most a caller waits, and the extensions of the members, called in the context of the dialplan of this
   * server (`membersContext`). A voice menu is not a resource of Wazo's: its digits and sound are the route OpenSIPS
   * hands Asterisk's dialplan. Nothing of the people is in Wazo but the extensions. A group of ours that the tenant no
   * longer has, or whose strategy is not its flow's kind (it is made again: a strategy edited to `linear` fails in
   * Asterisk), goes once `beforeRemoval` has heard its number (the SIP server stops sending calls there first). Returns
   * how the SIP server reaches each flow that exists now, and how many Wazo refused (said in the log, done again at the
   * next round). One request at a time, each a reload of Asterisk's queues that wazo-sysconfd melts; `mayWrite` is asked
   * before each.
   */
  async syncFlows(flows: CallFlow[], options: { mayWrite?(): boolean; beforeRemoval?(numbers: string[]): Promise<void> } = {}): Promise<{ routes: CallFlowRoute[]; failed: number }> {
    if (!this.config.lineKey) return { routes: [], failed: 0 }
    const guard = () => {
      if (options.mayWrite && !options.mayWrite()) throw new WazoStopped()
    }
    const confd = this.config.confdUrl
    const context = this.config.membersContext ?? 'twake-members'
    const wanted = new Map(flows.filter(f => FLOW_NUMBER.test(f.number)).map(f => [f.number, f]))
    const have = new Map<string, WazoGroup>()
    for (const g of await this.list<WazoGroup>('/groups')) {
      const n = GROUP_LABEL.exec(g.label ?? '')?.[1]
      if (n) have.set(n, g)
    }
    let failed = 0
    const refused = (what: string, number: string, err: unknown) => {
      if (err instanceof WazoStopped || (err instanceof WazoError && err.status >= 500)) throw err
      failed++
      this.log.warn(`Wazo: the flow ${number} not ${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const groupFlows = [...wanted.values()].filter(f => f.kind !== 'menu')
    const strategyOf = (f: CallFlow) => (f.kind === 'queue' ? 'least_recent' : 'linear')
    const gone = [...have.keys()].filter(n => !groupFlows.some(f => f.number === n))
    // A group made again (its flow changed kind) leaves the SIP server first as well.
    const remade = groupFlows.filter(f => have.get(f.number)?.ring_strategy && have.get(f.number)!.ring_strategy !== strategyOf(f)).map(f => f.number)
    // The menus that lead to a group that goes or is made again leave the SIP server first too: their route names the group.
    const leaving = new Set([...gone, ...remade])
    const menus = [...wanted.values()].filter(f => f.kind === 'menu' && Object.values(f.choices ?? {}).some(t => leaving.has(t))).map(f => f.number)
    if (leaving.size) await options.beforeRemoval?.([...leaving, ...menus])
    for (const number of gone) {
      try {
        await this.json(`${confd}/groups/${have.get(number)!.uuid}`, 'DELETE', undefined, guard)
      } catch (err) {
        refused('removed', number, err)
      }
    }
    /** The group of each queue or sequential flow that is made now. */
    const made = new Map<string, WazoGroup>()
    for (const f of groupFlows) {
      try {
        const members = membersOf(f)
        if (!members.length) throw new WazoError(400, 'no member')
        const { ring, wait } = timesOf(f)
        const fields = { label: `TwakePhone ${f.number}`, timeout: wait, user_timeout: ring, retry_delay: RETRY_SEC, ring_in_use: false }
        let group = have.get(f.number)
        if (!group) {
          group = await this.json<WazoGroup>(`${confd}/groups`, 'POST', { ...fields, ring_strategy: f.kind === 'queue' ? 'least_recent' : 'linear' }, guard)
        } else if (group.timeout !== wait || group.user_timeout !== ring) {
          await this.json(`${confd}/groups/${group.uuid}`, 'PUT', fields, guard)
          group = { ...group, timeout: wait, user_timeout: ring }
        }
        // The kind never changes a group (a strategy edited to `linear` fails in Asterisk): a group of the other kind goes and comes back.
        const strategy = strategyOf(f)
        if (group.ring_strategy && group.ring_strategy !== strategy) {
          await this.json(`${confd}/groups/${group.uuid}`, 'DELETE', undefined, guard)
          group = await this.json<WazoGroup>(`${confd}/groups`, 'POST', { ...fields, ring_strategy: strategy }, guard)
        }
        const current = (group.members?.extensions ?? []).map(e => `${e.exten}@${e.context}`)
        const asked = members.map(m => `${m}@${context}`)
        if (current.length !== asked.length || current.some((c, i) => c !== asked[i])) {
          await this.json(`${confd}/groups/${group.uuid}/members/extensions`, 'PUT', { extensions: members.map(exten => ({ exten, context })) }, guard)
        }
        if (!QUEUE_NAME.test(group.name ?? '')) throw new WazoError(422, 'Wazo gave the group a name Asterisk\'s dialplan would not read')
        made.set(f.number, group)
      } catch (err) {
        refused('made', f.number, err)
        // A change Wazo refused leaves the group it had, which goes on running: its route stays (the next round tries again).
        const kept = have.get(f.number)
        if (kept && (!kept.ring_strategy || kept.ring_strategy === strategyOf(f)) && QUEUE_NAME.test(kept.name ?? '')) made.set(f.number, kept)
      }
    }
    const routes: CallFlowRoute[] = []
    for (const f of wanted.values()) {
      if (f.kind === 'menu') continue
      const group = made.get(f.number)
      if (!group) continue
      routes.push({ number: f.number, route: `${f.kind === 'queue' ? 'queue' : 'seq'}|${group.name}|${timesOf(f).wait}` })
    }
    // A menu: its digits lead to an extension, or to a group that is made (a digit leading to one that is not is left out until it is).
    for (const f of wanted.values()) {
      if (f.kind !== 'menu') continue
      const choices: string[] = []
      for (const [digit, target] of Object.entries(f.choices ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!/^[0-9]$/.test(digit)) continue
        const flow = wanted.get(target)
        if (!flow) {
          if (LINE_EXTENSION.test(target)) choices.push(`${digit}=e:${target}`)
        } else if (flow.kind !== 'menu') {
          const route = routes.find(r => r.number === target)
          if (route) choices.push(`${digit}=q:${route.route.split('|')[1]}:${route.route.split('|')[2]}`)
        }
      }
      if (!choices.length) continue
      const greeting = f.greeting && SOUND.test(f.greeting) ? f.greeting : DEFAULT_GREETING
      routes.push({ number: f.number, route: `menu|${choices.join('~')}|${greeting}` })
    }
    return { routes, failed }
  }

  /** A mailbox of the SIP server (`number@context`) is a person's when it is at their number, which is theirs only. */
  mailboxIsOf(mailbox: string, userId: string) {
    return mailbox.split('@')[0] === mailboxNumber(this.key(userId))
  }

  async owns(owner: VoicemailOwner) {
    if (owner.mailbox === undefined) return (await this.voicemailIdOf(owner)) !== undefined
    const id = /^[0-9]{1,15}$/.test(owner.mailbox) ? Number(owner.mailbox) : NaN
    if (!Number.isSafeInteger(id) || !NUMBER.test(owner.extension)) return false
    const now = await this.mailboxById(id, EVENT_READ_MS)
    const key = this.key(owner.userId)
    if (!now || now.vm.number !== mailboxNumber(key) || now.holder !== key) return false
    this.remember(key, id)
    return true
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

  private async deleteFrom(voicemailId: number, messageId: string, guard?: () => void) {
    const res = await this.request(`${this.config.calldUrl}/voicemails/${voicemailId}/messages/${messageId}`, 'DELETE', undefined, 'application/json', undefined, guard)
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
   * Every message of the person (step 10's erasure): of their mailbox, at their number, reached or set aside (or half
   * made there, linked to nobody), and of any mailbox of the context their user has. Never someone else's: one whose
   * user stands for another is left. Reads only what is the person's (the mailboxes at their number, the users of
   * their print), and writes nothing but the deletions of the messages, each asked `mayWrite` first: no mailbox is
   * ever made or changed for an erasure.
   */
  async eraseMessages(owner: Pick<VoicemailOwner, 'userId'>, options: { mayWrite?(): boolean } = {}): Promise<number> {
    const guard = () => {
      if (options.mayWrite && !options.mayWrite()) throw new WazoStopped()
    }
    const context = await this.contextOf()
    const key = this.key(owner.userId)
    const number = mailboxNumber(key)
    const found = new Map<number, WazoMailbox>()
    for (const vm of await this.list<WazoMailbox>(`/voicemails?recurse=false&search=${number}`)) if (vm.context === context.name && vm.number === number) found.set(vm.id, vm)
    for (const u of await this.list<WazoUser>(`/users?recurse=false&search=${encodeURIComponent(key)}`)) {
      if (u.userfield !== key || !u.voicemail || found.has(u.voicemail.id)) continue
      const box = await this.readMailbox(u.voicemail.id)
      if (box) found.set(box.vm.id, box.vm)
    }
    let erased = 0
    for (const vm of found.values()) {
      const { holder } = await this.holderOfBox(vm)
      if (holder !== '' && holder !== key) {
        this.log.warn(`Wazo: mailbox ${vm.id} left out of an erasure: its user stands for someone else`)
        continue
      }
      for (const { m } of await this.rawMessagesOf(vm.id)) {
        guard()
        if (await this.deleteFrom(vm.id, m.id, guard)) erased++
      }
    }
    return erased
  }

  /**
   * The messages left before `before`, in every mailbox of the context (those aside too): the retention period. One
   * without a date (Wazo gave none) is not taken for one of 1970: it stays, and it is said.
   */
  async purgeMessages(before: Date, options: { mayWrite?(): boolean } = {}): Promise<number> {
    const guard = () => {
      if (options.mayWrite && !options.mayWrite()) throw new WazoStopped()
    }
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
        if (await this.deleteFrom(vm.id, m.id, guard)) purged++
      }
    if (purged) this.log.info(`Wazo: ${purged} message(s) older than the retention period deleted`)
    if (undated) this.log.warn(`Wazo: ${undated} message(s) without a date left out of the retention period (delete them in Wazo if they are old)`)
    return purged
  }

  // ---- wazo-websocketd: the events -------------------------------------------------------------------------------

  subscribe(options: VoicemailSubscribeOptions = {}): AsyncIterable<RoutedEvent> {
    if (this.subscribed) throw new Error('Wazo provider: subscribe() takes one consumer')
    this.subscribed = true
    this.holdersNow = options.holders ? () => options.holders!() : undefined
    this.onHeard = options.onHeard
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
    // A connection refused before it opened: Node's WebSocket tells an error and no close (or one much later).
    ws.onerror = () => {
      if (this.ws !== ws || this.wsOpen) return
      this.ws = undefined
      try {
        ws.close()
      } catch {
        // Never opened.
      }
      this.reconnectLater()
    }
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
      const was = this.wsOpen
      if (!was) this.log.info('Wazo: voicemail events heard (wazo-websocketd)')
      this.wsOpen = true
      this.wsAttempt = 0
      // Heard from now on, maybe not during the gap: the Gateway reads the mailboxes again.
      if (!was) {
        try {
          this.onHeard?.()
        } catch {
          // The Gateway's own business.
        }
      }
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
    // The mailbox as Wazo has it now, read at each event: a holder's, at their number, told at an extension they hold
    // now (the shortest). One of someone who holds none (set aside), of nobody, or of another context: nobody's. The
    // Gateway asks `owns` with it.
    const now = await this.mailboxById(voicemailId)
    if (!now || !HOLDER_BOX.test(now.vm.number) || !now.holder) return
    const extension = await this.extensionOf(now.holder)
    if (!extension) return
    this.remember(now.holder, voicemailId)
    const mailbox = String(voicemailId)
    const timestamp = new Date(this.now()).toISOString()
    if (type === 'voicemail.deleted') this.queue.push({ extension, mailbox, event: { type, timestamp, payload: { id: messageId } } })
    else this.queue.push({ extension, mailbox, event: { type, timestamp, payload: { voicemail: voicemailOf({ ...message, id: messageId }, message.folder) } } })
  }

  /** An extension the person of this print holds now (the shortest), as the Gateway says, or the last synchronisation. */
  private async extensionOf(holder: string) {
    if (!this.holdersNow) return this.lastPeople.get(holder)?.[0]
    if (this.keys.size > 100_000) this.keys.clear()
    const keyOf = (userId: string) => {
      let key = this.keys.get(userId)
      if (key === undefined) this.keys.set(userId, (key = this.key(userId)))
      return key
    }
    return (await this.holdersNow())
      .filter(h => NUMBER.test(h.extension) && !h.extension.startsWith('0') && keyOf(h.userId) === holder)
      .map(h => h.extension)
      .sort(shortest)[0]
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
