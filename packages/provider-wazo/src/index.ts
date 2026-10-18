import { createHash } from 'node:crypto'
import type { RoutedEvent, VoicemailBox, VoicemailOwner, VoicemailProvider } from '@twake/telephony-provider-sdk'
import type { ProviderStatus, Voicemail } from '@twake/telephony-types'

// Everything about Wazo Platform lives here (step 11a, ADR 0022): the Gateway only sees a VoicemailProvider. Wazo's own
// words (users, voicemails, folders, contexts) stay inside this package.
//
// One Wazo context (`internal`, labelled TwakePhone by default) holds the mailboxes of a tenant: one per extension,
// numbered as it, for one Wazo user that stands for the person who holds the extension (its `userfield` says who,
// hashed). When an extension passes to someone else, the old mailbox goes with its messages and a new one is made: a
// person never hears someone else's messages. wazo-calld reads and changes the messages, wazo-websocketd tells a new
// one (the event wazo-calld makes of Asterisk's MWI, for the mailbox's user).

/** The fetch this package uses (Node's own by default); the tests give theirs. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>

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

/** A mailbox number as Wazo's Asterisk takes it, and as OpenSIPS reads it (provider-opensips' MAILBOX). */
const NUMBER = /^[0-9]{1,40}$/
/** A message id as wazo-calld makes them (`1792289524-00000004`): nothing else reaches a URL. */
export const MESSAGE_ID = /^[0-9A-Za-z_-]{1,64}$/
/** The prefix of the `userfield` of the users this package made: the others are not its own. */
const HOLDER = 'twakephone:'
/** Who a user stands for, as its `userfield` keeps it: hashed, nothing of the person's id is in Wazo. */
export const holderKey = (userId: string) => `${HOLDER}${createHash('sha256').update(userId).digest('hex').slice(0, 40)}`
const PAGE = 500

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

/**
 * The mailboxes of a tenant on Wazo Platform (step 11a, ADR 0022): made and removed as the extensions pass from one
 * person to another (syncMailboxes), their messages read, marked as read and deleted (wazo-calld), and a message left,
 * read or deleted anywhere told as it happens (wazo-websocketd).
 */
export class WazoVoicemail implements VoicemailProvider {
  readonly id: string
  private readonly fetch: Fetch
  private readonly log: WazoLogger
  private token: { value: string; renewAt: number } | undefined
  private tokenPending: Promise<string> | undefined
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

  constructor(private readonly config: WazoConfig) {
    this.id = config.id ?? 'wazo'
    this.fetch = config.fetch ?? globalThis.fetch
    this.log = config.logger ?? console
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

  // ---- wazo-auth ------------------------------------------------------------------------------------------------

  private async tokenValue(): Promise<string> {
    if (this.token && Date.now() < this.token.renewAt) return this.token.value
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
    this.token = { value, renewAt: Date.now() + ttl * 800 }
    // A WebSocket open since the last token keeps hearing with the new one.
    if (this.ws && this.wsOpen) this.ws.send(JSON.stringify({ op: 'token', data: { token: value } }))
    return value
  }

  private failed(status: number, message: string) {
    this.restOk = false
    this.reason = message
    return new WazoError(status, message)
  }

  private async send(url: string, init: Parameters<Fetch>[1]) {
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs ?? 10_000)
    try {
      return await this.fetch(url, { ...init, signal })
    } catch (err) {
      throw this.failed(503, `voicemail server not reached (${err instanceof Error ? err.name : 'error'})`)
    }
  }

  /** A request to a Wazo API with the Gateway's token, once more with a new one if it expired meanwhile (401). */
  private async request(url: string, method = 'GET', body?: unknown, accept = 'application/json') {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokenValue()
      const res = await this.send(url, { method, headers: { 'x-auth-token': token, accept, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      if (res.status === 401 && attempt === 0) {
        this.token = undefined
        continue
      }
      if (res.status >= 500 || res.status === 401 || res.status === 403) throw this.failed(res.status, `voicemail server answered ${res.status}`)
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

  /** The context of the mailboxes, made the first time. */
  private async contextOf(): Promise<WazoContext> {
    if (this.context) return this.context
    const label = this.config.contextLabel ?? 'TwakePhone'
    const found = (await this.list<WazoContext>('/contexts')).find(c => c.label === label && (c.type ?? 'internal') === 'internal')
    this.context = found ?? (await this.json<WazoContext>(`${this.config.confdUrl}/contexts`, 'POST', { label, type: 'internal' }))
    if (!found) this.log.info(`Wazo: context of the mailboxes made (${label})`)
    return this.context
  }

  private remember(extension: string, voicemailId: number, holder: string) {
    const before = this.byExtension.get(extension)
    if (before && before.id !== voicemailId) this.byVoicemail.delete(before.id)
    this.byExtension.set(extension, { id: voicemailId, holder })
    this.byVoicemail.set(voicemailId, extension)
  }

  private forget(voicemailId: number) {
    const extension = this.byVoicemail.get(voicemailId)
    this.byVoicemail.delete(voicemailId)
    if (extension !== undefined && this.byExtension.get(extension)?.id === voicemailId) this.byExtension.delete(extension)
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

  async syncMailboxes(holders: { extension: string; userId: string; displayName?: string }[]): Promise<VoicemailBox[]> {
    const context = await this.contextOf()
    const wanted = new Map<string, { userId: string; name: string }>()
    for (const h of holders) if (NUMBER.test(h.extension)) wanted.set(h.extension, { userId: h.userId, name: str(h.displayName, 80) || h.extension })
    let users = await this.list<WazoUser>('/users?recurse=false')
    const mailboxes = (await this.list<WazoMailbox>('/voicemails?recurse=false')).filter(v => v.context === context.name)
    const boxes: VoicemailBox[] = []
    let made = 0
    let removed = 0
    // The mailboxes of nobody now, or of someone else than the holder: they go, with their messages.
    for (const vm of mailboxes) {
      const want = wanted.get(vm.number)
      const holder = want ? holderKey(want.userId) : undefined
      const kept = want && (vm.users ?? []).some(u => users.find(x => x.uuid === u.uuid)?.userfield === holder)
      if (kept) {
        this.remember(vm.number, vm.id, holder!)
        boxes.push({ extension: vm.number, mailbox: `${vm.number}@${context.name}` })
        wanted.delete(vm.number)
        continue
      }
      await this.removeMailbox(vm, users)
      removed++
      // Its users of ours went with it; the others (made in Wazo by hand) lost it only.
      users = users.flatMap(u => ((vm.users ?? []).some(x => x.uuid === u.uuid) ? (u.userfield?.startsWith(HOLDER) ? [] : [{ ...u, voicemail: null }]) : [u]))
    }
    // The holders without one: a user that stands for them (theirs, if they had one without a mailbox), its mailbox.
    for (const [extension, want] of wanted) {
      const key = holderKey(want.userId)
      let user = users.find(u => u.userfield === key && !u.voicemail)
      user ??= await this.json<WazoUser>(`${this.config.confdUrl}/users`, 'POST', { firstname: want.name.slice(0, 128), userfield: key })
      const vm = await this.json<WazoMailbox>(`${this.config.confdUrl}/voicemails`, 'POST', { name: want.name, number: extension, context: context.name, ask_password: false })
      await this.json(`${this.config.confdUrl}/users/${user.uuid}/voicemails/${vm.id}`, 'PUT')
      users.push({ ...user, voicemail: { id: vm.id } })
      this.remember(extension, vm.id, key)
      boxes.push({ extension, mailbox: `${extension}@${context.name}` })
      made++
    }
    // A user of ours left without a mailbox (one whose making stopped half-way): removed.
    for (const u of users) {
      if (!u.userfield?.startsWith(HOLDER) || u.voicemail) continue
      await this.json(`${this.config.confdUrl}/users/${u.uuid}`, 'DELETE')
    }
    if (made || removed) this.log.info(`Wazo: ${made} mailbox(es) made, ${removed} removed (their holder changed or left)`)
    return boxes.sort((a, b) => a.extension.localeCompare(b.extension))
  }

  /** The mailbox of an extension in Wazo now, and whom it is for (another Gateway may have made it since). */
  private async lookUp(extension: string) {
    const context = await this.contextOf()
    const vm = (await this.list<WazoMailbox>(`/voicemails?recurse=false&search=${encodeURIComponent(extension)}`)).find(v => v.number === extension && v.context === context.name)
    if (!vm) {
      const known = this.byExtension.get(extension)
      if (known) this.forget(known.id)
      return undefined
    }
    const uuid = vm.users?.[0]?.uuid
    const user = uuid ? await this.json<WazoUser>(`${this.config.confdUrl}/users/${uuid}`) : undefined
    const holder = user?.userfield?.startsWith(HOLDER) ? user.userfield : ''
    this.remember(extension, vm.id, holder)
    return { id: vm.id, holder }
  }

  /**
   * The mailbox of the owner's extension if it is the owner's: from the last sync, else (none known, or known for
   * someone else) looked up again.
   */
  private async voicemailIdOf(owner: VoicemailOwner): Promise<number | undefined> {
    if (!NUMBER.test(owner.extension)) return undefined
    const holder = holderKey(owner.userId)
    let box = this.byExtension.get(owner.extension)
    if (box?.holder !== holder) box = await this.lookUp(owner.extension)
    return box?.holder === holder ? box.id : undefined
  }

  async owns(owner: VoicemailOwner) {
    return (await this.voicemailIdOf(owner)) !== undefined
  }

  // ---- wazo-calld: the messages ----------------------------------------------------------------------------------

  private async folders(voicemailId: number): Promise<WazoFolder[] | undefined> {
    const res = await this.request(`${this.config.calldUrl}/voicemails/${voicemailId}`)
    if (res.status === 404) {
      this.forget(voicemailId)
      return undefined
    }
    if (res.status >= 300) throw new WazoError(res.status, `voicemail ${voicemailId}: ${res.status}`)
    return ((await res.json()) as { folders?: WazoFolder[] }).folders ?? []
  }

  async listMessages(owner: VoicemailOwner): Promise<Voicemail[]> {
    const id = await this.voicemailIdOf(owner)
    if (id === undefined) return []
    const folders = (await this.folders(id)) ?? []
    return folders
      .flatMap(f => (f.messages ?? []).filter(m => typeof m.id === 'string' && MESSAGE_ID.test(m.id)).map(m => voicemailOf(m, f)))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id))
  }

  async getRecording(owner: VoicemailOwner, messageId: string) {
    if (!MESSAGE_ID.test(messageId)) return undefined
    const id = await this.voicemailIdOf(owner)
    if (id === undefined) return undefined
    const res = await this.request(`${this.config.calldUrl}/voicemails/${id}/messages/${messageId}/recording`, 'GET', undefined, 'audio/wav')
    if (res.status === 404 || res.status === 400) return undefined
    if (res.status >= 300) throw new WazoError(res.status, `recording: ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    return { contentType: /^audio\/[a-z0-9.+-]+$/i.test(type.split(';')[0]!.trim()) ? type.split(';')[0]!.trim() : 'audio/wav', body: new Uint8Array(await res.arrayBuffer()) }
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
    if (res.status === 404) return false
    if (res.status >= 300) throw new WazoError(res.status, `message not moved: ${res.status}`)
    return true
  }

  async deleteMessage(owner: VoicemailOwner, messageId: string) {
    if (!MESSAGE_ID.test(messageId)) return false
    const id = await this.voicemailIdOf(owner)
    if (id === undefined) return false
    const res = await this.request(`${this.config.calldUrl}/voicemails/${id}/messages/${messageId}`, 'DELETE')
    if (res.status === 404) return false
    if (res.status >= 300) throw new WazoError(res.status, `message not deleted: ${res.status}`)
    return true
  }

  // ---- wazo-websocketd: the events -------------------------------------------------------------------------------

  subscribe(): AsyncIterable<RoutedEvent> {
    if (this.subscribed) throw new Error('Wazo provider: subscribe() takes one consumer')
    this.subscribed = true
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
    void this.onEvent(EVENTS[msg.data.name as keyof typeof EVENTS], msg.data.data ?? {}).catch((err: unknown) => this.log.warn(`Wazo: voicemail event not told: ${err instanceof Error ? err.message : String(err)}`))
  }

  private async onEvent(type: (typeof EVENTS)[keyof typeof EVENTS], data: Record<string, unknown>) {
    const voicemailId = Number(data.voicemail_id)
    const message = (data.message ?? {}) as WazoMessage
    const messageId = typeof data.message_id === 'string' ? data.message_id : message.id
    if (!Number.isInteger(voicemailId) || typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return
    let extension = this.byVoicemail.get(voicemailId)
    if (extension === undefined) {
      // Made by another Gateway since: the mailboxes of the context, looked up once.
      const context = await this.contextOf()
      const vm = (await this.list<WazoMailbox>('/voicemails?recurse=false')).find(v => v.id === voicemailId && v.context === context.name)
      if (!vm || !(await this.lookUp(vm.number))) return
      extension = vm.number
    }
    const timestamp = new Date().toISOString()
    if (type === 'voicemail.deleted') this.queue.push({ extension, event: { type, timestamp, payload: { id: messageId } } })
    else this.queue.push({ extension, event: { type, timestamp, payload: { voicemail: voicemailOf({ ...message, id: messageId }, message.folder) } } })
  }

  async close() {
    this.closed = true
    clearTimeout(this.wsTimer)
    const ws = this.ws
    this.ws = undefined
    this.wsOpen = false
    ws?.close(1000, 'closing')
    this.queue.close()
  }
}
