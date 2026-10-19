import { describe, expect, it } from 'vitest'
import type { ProviderFactory, RoutedEvent, TelephonyProvider, TranscriptionProvider, VoicemailBox, VoicemailProvider, VoicemailSubscribeOptions } from '@twake/telephony-provider-sdk'
import type { TelephonyEvent, Voicemail } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { MATRIX_ID_AMBIGUOUS, MatrixBot, MatrixError } from './matrix.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import type { FencedLease, Store } from './store/types.js'
import { voicemailRole } from './voicemail-lease.js'
import {
  NOTICE_FIELD,
  TRANSCRIPT_TEXT_MAX,
  TranscriptWatcher,
  VoicemailTranscripts,
  callerName,
  matrixFromEnv,
  matrixIdFromTemplate,
  noticeContent,
  noticeKey,
  publicTranscript,
  transcriptionFromEnv,
  txnOf,
  type VoicemailTranscriptsOptions
} from './voicemail-transcripts.js'

// Step 11b (ADR 0023): the transcription of the messages, shown in the Messagerie vocale, and the bot's notice of each
// in Twake Chat, by the Gateway that writes the mailboxes.

const until = async (what: string, fn: () => boolean | Promise<boolean>, timeout = 3_000) => {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const gate = () => {
  let open!: () => void
  const closed = new Promise<void>(resolve => (open = resolve))
  return { closed, open }
}

const SERVER = 'chat.example.test'
const BOT = `@twakephone:${SERVER}`
const TOKEN = 'syt_not_a_real_token'

/**
 * A Matrix homeserver in memory, as Synapse answers the client-server API the bot uses: who it is, whose account
 * exists (a profile: Synapse's 404 `M_UNKNOWN` for no account, `M_NOT_FOUND` for an account with no name nor avatar),
 * a room made (the bot joined, the person invited) at an address of its own (refused when taken), the addresses, its
 * members, a room left, a message sent once per transaction id, the bot's last messages of a room (by pages, `from`
 * and `end`), a message withdrawn (redacted). `fail` makes the next requests fail with these statuses; `lose` does the
 * next request of that kind and loses its answer (500); `lag` hides the next addresses asked (404, as a replica late).
 */
const homeserver = () => {
  const rooms = new Map<string, { members: Map<string, string>; created: Record<string, unknown> }>()
  const aliases = new Map<string, string>()
  const events = new Map<string, { roomId: string; content: Record<string, unknown>; redacted: boolean }>()
  const txns = new Map<string, string>()
  const sentTxns: string[] = []
  const noAccount = new Set<string>()
  const noProfile = new Set<string>()
  const calls: string[] = []
  const state = { lag: 0 }
  const failures: number[] = []
  const losing: string[] = []
  let n = 0
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const handle = (method: string, parts: string[], url: URL, body: Record<string, unknown>): Response => {
    if (parts.join('/') === 'account/whoami') return answer(200, { user_id: BOT })
    if (parts[0] === 'profile') {
      if (noAccount.has(parts[1]!)) return answer(404, { errcode: 'M_UNKNOWN', error: 'No row found (profiles)' })
      return noProfile.has(parts[1]!) ? answer(404, { errcode: 'M_NOT_FOUND', error: 'Profile was not found' }) : answer(200, { displayname: 'x' })
    }
    if (parts[0] === 'directory') {
      const roomId = aliases.get(parts[2]!)
      if (method === 'DELETE') return aliases.delete(parts[2]!) ? answer(200, {}) : answer(404, { errcode: 'M_NOT_FOUND', error: 'no alias' })
      if (state.lag > 0) {
        state.lag--
        return answer(404, { errcode: 'M_NOT_FOUND', error: 'no alias' })
      }
      return roomId ? answer(200, { room_id: roomId }) : answer(404, { errcode: 'M_NOT_FOUND', error: 'no alias' })
    }
    if (parts[0] === 'createRoom') {
      const alias = typeof body.room_alias_name === 'string' ? `#${body.room_alias_name}:${SERVER}` : undefined
      if (alias && aliases.has(alias)) return answer(400, { errcode: 'M_ROOM_IN_USE', error: 'alias taken' })
      const roomId = `!room${++n}:${SERVER}`
      rooms.set(roomId, { members: new Map([[BOT, 'join'], ...(body.invite as string[]).map(u => [u, 'invite'] as [string, string])]), created: body })
      if (alias) aliases.set(alias, roomId)
      return answer(200, { room_id: roomId })
    }
    if (parts[0] === 'rooms') {
      const room = rooms.get(parts[1]!)
      if (!room || room.members.get(BOT) !== 'join') return answer(403, { errcode: 'M_FORBIDDEN', error: 'not in the room' })
      if (parts[2] === 'members') return answer(200, { chunk: [...room.members].map(([u, m]) => ({ type: 'm.room.member', state_key: u, content: { membership: m } })) })
      if (parts[2] === 'leave') {
        room.members.set(BOT, 'leave')
        return answer(200, {})
      }
      if (parts[2] === 'messages') {
        const filter = JSON.parse(url.searchParams.get('filter') ?? '{}') as { senders?: string[] }
        if (!filter.senders?.includes(BOT)) return answer(400, { errcode: 'M_INVALID_PARAM', error: 'filter expected' })
        const from = Number(url.searchParams.get('from') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 10)
        const chunk = [...events].filter(([, e]) => e.roomId === parts[1]).reverse().slice(from, from + limit).map(([id, e]) => ({ event_id: id, sender: BOT, type: 'm.room.message', content: e.redacted ? {} : e.content }))
        return answer(200, { chunk, end: String(from + chunk.length) })
      }
      if (parts[2] === 'send') {
        const k = `${parts[1]}|${parts[4]}`
        sentTxns.push(parts[4]!)
        let id = txns.get(k)
        if (!id) {
          id = `$event${++n}`
          txns.set(k, id)
          events.set(id, { roomId: parts[1]!, content: body, redacted: false })
        }
        return answer(200, { event_id: id })
      }
      if (parts[2] === 'redact') {
        const e = events.get(parts[3]!)
        if (!e || e.roomId !== parts[1]) return answer(404, { errcode: 'M_NOT_FOUND', error: 'no such event' })
        e.redacted = true
        return answer(200, { event_id: `$redaction${++n}` })
      }
    }
    return answer(404, { errcode: 'M_UNRECOGNIZED', error: 'unknown endpoint' })
  }
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init.method ?? 'GET'
    const headers = (init.headers ?? {}) as Record<string, string>
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
    if (headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' })
    const parts = url.pathname.replace(/^\/_matrix\/client\/v3\//, '').split('/').map(decodeURIComponent)
    const kind = `${method} ${parts[0] === 'rooms' ? parts[2] : parts[0] === 'profile' || parts[0] === 'directory' ? parts[0] : parts.join('/')}`
    calls.push(kind)
    const failure = failures.shift()
    if (failure) return answer(failure, failure === 429 ? { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 30 } : { errcode: 'M_UNKNOWN', error: 'an internal detail' })
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const res = handle(method, parts, url, body)
    const lost = losing.indexOf(kind)
    if (lost >= 0 && res.status < 300) {
      losing.splice(lost, 1)
      return answer(500, { errcode: 'M_UNKNOWN', error: 'the answer was lost' })
    }
    return res
  }) as typeof globalThis.fetch
  /** The messages of the bot still readable, with their room's invited or joined people. */
  const notices = () => [...events.values()].filter(e => !e.redacted).map(e => ({ ...e, people: [...rooms.get(e.roomId)!.members].filter(([, m]) => m !== 'leave').map(([u]) => u) }))
  return { fetch, rooms, aliases, events, calls, sentTxns, noAccount, noProfile, state, fail: (...statuses: number[]) => void failures.push(...statuses), lose: (kind: string) => void losing.push(kind), notices }
}

/**
 * A voicemail server in memory, as step 11a has it: a mailbox per holder (kept whatever extension reaches it, a set-aside
 * one listed by any), the extension that reaches each, the messages, their recordings, its events. A message `big…` has
 * a recording larger than 1 MB of unknown length, `huge…` one that says so. `down` makes it fail; `recordingGate` holds
 * each recording read back.
 */
const mailboxes = () => {
  const at = new Map<string, string>()
  const boxes = new Map<string, Voicemail[]>()
  let synced = 0
  let recordings = 0
  let push: ((e: RoutedEvent) => void) | undefined
  let heard: (() => void) | undefined
  const pending: RoutedEvent[] = []
  // `blind`: the spool out of the voicemail server's sight (unmounted), every mailbox read empty without failing
  // (`blindTo`: those of these holders only); `failing`: the mailboxes of these holders not read (an error).
  const state = { down: false, blind: false, blindTo: new Set<string>(), failing: new Set<string>(), lists: 0, recordingGate: undefined as Promise<void> | undefined }
  const up = () => {
    if (state.down) throw new Error('voicemail server down')
  }
  const vm: VoicemailProvider = {
    id: 'fake-voicemail',
    getStatus: () => 'CONNECTED',
    probe: async () => {},
    async syncMailboxes(list, options = {}) {
      await options.beforeChanges?.([])
      if (!options.mayWrite?.()) throw new Error('stopped')
      for (const h of list) {
        if (!boxes.has(h.userId)) boxes.set(h.userId, [])
        at.set(h.extension, h.userId)
      }
      synced++
      return { boxes: list.map(h => ({ extension: h.extension, mailbox: `${h.userId}@ctx` })), failed: 0 }
    },
    mailboxIsOf: (mailbox, userId) => mailbox === `${userId}@ctx`,
    owns: async o => at.get(o.extension) === o.userId,
    listMessages: async o => {
      up()
      state.lists++
      if (state.failing.has(o.userId)) throw new Error('mailbox not read')
      return state.blind || state.blindTo.has(o.userId) ? [] : [...(boxes.get(o.userId) ?? [])]
    },
    getRecording: async (o, id) => {
      up()
      recordings++
      await state.recordingGate
      if (state.blind || state.blindTo.has(o.userId) || !boxes.get(o.userId)?.some(m => m.id === id)) return undefined
      if (id.startsWith('big')) return { contentType: 'audio/wav', body: (async function* () { yield new Uint8Array(600_000); yield new Uint8Array(600_000) })() }
      if (id.startsWith('huge')) return { contentType: 'audio/wav', size: 2_000_000, body: (async function* () { yield new Uint8Array(1) })() }
      const bytes = new TextEncoder().encode(`RIFF-audio-of-${id}`)
      return { contentType: 'audio/wav', size: bytes.length, body: (async function* () { yield bytes })() }
    },
    markRead: async () => true,
    async deleteMessage(o, id) {
      const list = boxes.get(o.userId)
      if (!list?.some(m => m.id === id)) return false
      boxes.set(o.userId, list.filter(m => m.id !== id))
      return true
    },
    async eraseMessages(o, options = {}) {
      if (!options.mayWrite?.()) throw new Error('stopped')
      const n = boxes.get(o.userId)?.length ?? 0
      if (boxes.has(o.userId)) boxes.set(o.userId, [])
      return n
    },
    async purgeMessages(before, options = {}) {
      if (!options.mayWrite?.()) throw new Error('stopped')
      let n = 0
      for (const [holder, list] of boxes) {
        const kept = list.filter(m => Date.parse(m.receivedAt) >= before.getTime())
        n += list.length - kept.length
        boxes.set(holder, kept)
      }
      return n
    },
    subscribe(options?: VoicemailSubscribeOptions) {
      heard = options?.onHeard
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const e = pending.shift()
            if (e) return Promise.resolve({ value: e, done: false })
            return new Promise<IteratorResult<RoutedEvent>>(resolve => (push = value => resolve({ value, done: false })))
          }
        })
      }
    },
    close: async () => {}
  }
  const emit = (e: RoutedEvent) => {
    if (push) {
      const p = push
      push = undefined
      p(e)
    } else pending.push(e)
  }
  /** A caller leaves a message at `extension`: in the mailbox of its holder, then told (voicemail.created) unless `silently`. */
  const leave = (extension: string, v: Voicemail, silently = false) => {
    boxes.get(at.get(extension)!)!.unshift(v)
    if (!silently) emit({ extension, event: { type: 'voicemail.created', timestamp: v.receivedAt, payload: { voicemail: v } } })
  }
  /** A message deleted on the voicemail server, nothing told. */
  const remove = (holder: string, id: string) => void boxes.set(holder, (boxes.get(holder) ?? []).filter(m => m.id !== id))
  return { vm, at, boxes, state, emit, leave, remove, synced: () => synced, recordings: () => recordings, heard: () => heard?.() }
}
type Mailboxes = ReturnType<typeof mailboxes>

/** A SIP server that keeps the mailboxes it is given (as provider-opensips). */
const sipServer = () => {
  let rows: VoicemailBox[] = []
  const provider = {
    getStatus: () => 'CONNECTED',
    getCapabilities: async () => ({ presence: { realtime: true }, conference: { dialIn: false, dialOut: false } }),
    getPresence: async () => ({ status: 'available', source: 'telephony' }),
    setPresence: async () => {},
    getVoicemailAccess: async () => true,
    setVoicemailBoxes: async (boxes: VoicemailBox[]) => {
      rows = boxes
      return {}
    },
    withdrawVoicemailBoxes: async (extensions: string[]) => void (rows = rows.filter(r => !extensions.includes(r.extension))),
    voicemailMark: async () => 0,
    listVoicemailBoxes: async () => rows,
    subscribe: async function* () {},
    close: async () => {}
  }
  const factory: ProviderFactory<unknown> = { type: 'sip', create: () => provider as unknown as TelephonyProvider }
  return { factory }
}

const message = (id: string, over: Partial<Voicemail> = {}): Voicemail => ({ id, from: '0612345678', fromName: 'Alice Martin', receivedAt: new Date().toISOString(), durationSec: 12, unread: true, ...over })
const SAID = 'Bonjour Paul, ici Alice, rappelez-moi demain matin.'

const setup = async (
  o: {
    store?: MemoryStore
    boxes?: Mailboxes
    transcribe?: TranscriptionProvider['transcribe'] | false
    notices?: false
    maxSec?: number
    queueMax?: number
    matrixIdOf?: (tenantId: string, userId: string) => Promise<string | undefined>
    retentionDays?: number
    purgeMs?: number
    hub?: boolean
    logs?: string[]
    withText?: boolean
    declinedMs?: number
    reconcileMs?: number
    orphanMs?: number
  } = {}
) => {
  process.env.AUTH_MODE = 'dev'
  const store = o.store ?? new MemoryStore()
  await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101', displayName: 'Alice Martin' })
  await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '102', displayName: 'Jean Dupont' })
  await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '103', displayName: 'Bob Durand' })
  const boxes = o.boxes ?? mailboxes()
  const hs = homeserver()
  const bus = new EventBus()
  const heardAudio: string[] = []
  const transcribe = o.transcribe === false ? undefined : (o.transcribe ?? (async () => ({ text: SAID })))
  const provider: TranscriptionProvider | undefined = transcribe && {
    id: 'fake-transcription',
    transcribe: async (audio, options) => {
      heardAudio.push(new TextDecoder().decode(audio))
      return transcribe(audio, options)
    }
  }
  const registry = new ProviderRegistry([{ tenantId: 'A', type: 'sip', config: {} }], [sipServer().factory])
  const synced = boxes.synced()
  // The log read by the test: written (the tests run silent otherwise).
  const level = process.env.LOG_LEVEL
  if (o.logs && level === 'silent') process.env.LOG_LEVEL = 'info'
  const app = await buildApp(registry, {
    store,
    bus,
    directory: new StoreDirectory(store),
    tickets: new TicketStore(),
    admin: { adminRole: 'twakephone-admin', adminUsers: new Set(['A:root']) },
    voicemail: (t: string) => (t === 'A' ? boxes.vm : undefined),
    voicemailLeaseMs: 300,
    voicemailRetryMs: [20],
    ...(o.retentionDays !== undefined ? { voicemailRetentionDays: o.retentionDays } : {}),
    ...(o.purgeMs !== undefined ? { voicemailPurgeMs: o.purgeMs } : {}),
    ...(provider ? { transcription: { provider, maxSec: o.maxSec ?? 180, queueMax: o.queueMax ?? 100, maxBytes: 1_000_000, lang: 'fr' } } : {}),
    ...(o.notices === false
      ? {}
      : {
          notices: {
            bot: new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: hs.fetch }),
            userTemplate: `@{uid}:${SERVER}`,
            appUrl: 'https://phone.example.test',
            timeZone: 'Europe/Paris',
            ...(o.withText === false ? { withText: false } : {}),
            ...(o.matrixIdOf ? { matrixIdOf: o.matrixIdOf } : {})
          }
        }),
    transcriptRetryMs: [20, 20],
    noticeRetryMs: [20, 20],
    transcriptEveryMs: 20,
    transcriptWatchMs: 20,
    ...(o.declinedMs !== undefined ? { declinedMs: o.declinedMs } : {}),
    ...(o.reconcileMs !== undefined ? { transcriptReconcileMs: o.reconcileMs } : {}),
    ...(o.orphanMs !== undefined ? { transcriptOrphanMs: o.orphanMs } : {}),
    ...(o.hub ? { secretsKey: Buffer.alloc(32, 7), webhooks: { pollMs: 3_600_000, stateLeaseMs: 300, streamSettleMs: 0 }, trunkWatchMs: 0 } : {}),
    ...(o.logs ? { logStream: { write: (line: string) => void o.logs!.push(line) } } : {})
  })
  process.env.LOG_LEVEL = level
  await app.ready()
  registry.startAll()
  await until('the mailboxes', () => boxes.synced() > synced)
  const as = (user: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'A' })
  const heard = (user: string) => {
    const got: TelephonyEvent[] = []
    bus.subscribe('A', user, e => void got.push(e))
    return got
  }
  const transcriptOf = async (user: string, id: string) => (await app.inject({ url: '/api/v1/voicemails', headers: as(user) })).json<{ items: Voicemail[] }>().items.find(v => v.id === id)?.transcript
  const rowOf = async (holder: string, id: string) => (await store.listTranscripts('A', holder, [id], true))[0]
  const alerts = async () => (await store.listAlerts('A', {})).map(a => a.alert.param)
  return { app, store, boxes, hs, as, heard, heardAudio, transcriptOf, rowOf, alerts }
}

describe('the transcription of the messages and the notices in Chat (step 11b)', () => {
  it('transcribes a new message once, shows it to its holder only, and the bot tells them in a room of their own, nobody else', async () => {
    const { app, boxes, hs, as, heard, heardAudio, transcriptOf } = await setup()
    const jean = heard('jean')
    const bob = heard('bob')
    const alice = heard('alice')
    boxes.leave('102', message('m1'))
    // At once: the message, its transcription on its way.
    await until('the message', () => jean.length >= 1)
    expect(jean[0]).toMatchObject({ type: 'voicemail.created', payload: { voicemail: { id: 'm1', transcript: { status: 'pending' } } } })
    await until('the transcription', () => jean.some(e => e.type === 'voicemail.transcribed'))
    expect(jean.find(e => e.type === 'voicemail.transcribed')).toMatchObject({ payload: { id: 'm1', transcript: { status: 'done', text: SAID, lang: 'fr' } } })
    expect(heardAudio).toEqual(['RIFF-audio-of-m1'])
    expect(await transcriptOf('jean', 'm1')).toEqual({ status: 'done', text: SAID, lang: 'fr' })
    await until('the notice', () => hs.notices().length === 1)
    const [notice] = hs.notices()
    expect(notice!.people.sort()).toEqual([BOT, `@jean:${SERVER}`].sort())
    expect(notice!.content).toMatchObject({ msgtype: 'm.notice', format: 'org.matrix.custom.html', [NOTICE_FIELD]: noticeKey('A', { holder: 'jean', messageId: 'm1' }) })
    const body = String(notice!.content.body)
    expect(body).toContain("du 0612345678 (nom annoncé par l'appelant : « Alice Martin »)")
    expect(body).toContain('durée 0:12')
    expect(body).toContain(`« ${SAID} »`)
    expect(body).toContain('https://phone.example.test/voicemail')
    // A private room the bot alone may invite to, history from the invitation on, never encrypted, at an address of its own.
    const room = [...hs.rooms.values()][0]!.created
    expect(room).toMatchObject({ preset: 'private_chat', is_direct: true, invite: [`@jean:${SERVER}`], power_level_content_override: { invite: 100 } })
    expect(String(room.room_alias_name)).toMatch(/^twakephone-[0-9a-f]{32}$/)
    // The creator is never named in the power levels: a homeserver refuses it for a room of version 12.
    expect((room as { power_level_content_override: Record<string, unknown> }).power_level_content_override).not.toHaveProperty('users')
    expect(JSON.stringify(room)).not.toContain('m.room.encryption')
    // Their account asked for before the room was made.
    expect(hs.calls.indexOf('GET profile')).toBeLessThan(hs.calls.indexOf('POST createRoom'))
    // Nobody else: neither their screens, nor the bot.
    expect(bob).toEqual([])
    expect(alice).toEqual([])
    expect(await transcriptOf('bob', 'm1')).toBeUndefined()
    // Once: a second look sends nothing more, transcribes nothing more.
    await sleep(100)
    expect(heardAudio).toHaveLength(1)
    expect(hs.events.size).toBe(1)
    // A second message: the same room.
    boxes.leave('102', message('m2', { from: undefined, fromName: undefined }))
    await until('the second notice', () => hs.notices().length === 2)
    expect(hs.rooms.size).toBe(1)
    expect(String(hs.notices()[1]!.content.body)).toContain("d'un numéro masqué")
    expect((await app.inject({ url: '/api/v1/capabilities', headers: as('jean') })).json()).toMatchObject({ voicemail: true, voicemailTranscription: true })
    await app.close()
  })

  it('erases the transcription of a message deleted and withdraws its notice, whoever deleted it, for its holder only', async () => {
    const { app, store, boxes, hs, as, rowOf } = await setup()
    boxes.leave('102', message('m1'))
    boxes.leave('102', message('m2'))
    // Bob's mailbox has a message of the same id: its own.
    boxes.leave('103', message('m2'))
    await until('the notices', () => hs.notices().length === 3)
    // From the app.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/voicemails/m1', headers: as('jean') })).statusCode).toBe(204)
    await until('m1 withdrawn', () => hs.notices().length === 2)
    expect((await store.listTranscripts('A', 'jean')).map(t => t.messageId)).toEqual(['m2'])
    // From a phone (the voicemail server tells it).
    boxes.remove('jean', 'm2')
    boxes.emit({ extension: '102', event: { type: 'voicemail.deleted', timestamp: new Date().toISOString(), payload: { id: 'm2' } } })
    await until('m2 withdrawn', () => hs.notices().length === 1)
    await until('no transcription left', async () => !(await store.dueTranscripts('A', 'notice', 10)).length && !(await store.listTranscripts('A', 'jean', undefined, true)).length)
    expect(hs.calls.filter(c => c === 'PUT redact')).toHaveLength(2)
    // Bob's is his: still there, its notice too.
    expect(await rowOf('bob', 'm2')).toMatchObject({ status: 'done', notice: 'sent' })
    expect(hs.notices()[0]!.people).toContain(`@bob:${SERVER}`)
    await app.close()
  })

  it("erases a person's transcriptions with their messages (their right to erasure), withdraws the bot's notices, forgets their room and leaves it", async () => {
    const { app, store, boxes, hs, as } = await setup()
    boxes.leave('102', message('m1'))
    boxes.leave('103', message('m3'))
    await until('the notices', () => hs.notices().length === 2)
    const rooms = await store.listOperatorState('A', 'matrix:room:')
    expect(rooms).toHaveLength(2)
    const jeanRoom = rooms.map(r => r.value as { matrixId: string; roomId: string }).find(v => v.matrixId === `@jean:${SERVER}`)!
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })
    expect(res.json()).toEqual({ deleted: 0, voicemailErasure: 'asked' })
    await until("Jean's notice withdrawn", () => hs.notices().length === 1)
    expect(hs.notices()[0]!.people).toContain(`@bob:${SERVER}`)
    await until('his transcriptions gone', async () => !(await store.listTranscripts('A', 'jean', undefined, true)).length)
    expect((await store.listOperatorState('A', 'matrix:room:')).map(r => (r.value as { matrixId: string }).matrixId)).toEqual([`@bob:${SERVER}`])
    // The bot leaves his room once its notice is withdrawn, and gives its address back.
    await until('his room left', () => hs.rooms.get(jeanRoom.roomId)!.members.get(BOT) === 'leave')
    expect([...hs.aliases.values()]).not.toContain(jeanRoom.roomId)
    await until('nothing left to leave', async () => !(await store.listOperatorState('A', 'matrix:leave:')).length)
    expect(await store.listTranscripts('A', 'bob')).toHaveLength(1)
    // A later message: another room, invited once more.
    boxes.leave('102', message('m4'))
    await until('the new notice', () => hs.notices().length === 2)
    expect(hs.rooms.size).toBe(3)
    await app.close()
  })

  it('erases the transcriptions of the messages past the retention period, and withdraws their notices', async () => {
    const store = new MemoryStore()
    const { app, boxes, hs } = await setup({ store, retentionDays: 30, purgeMs: 50 })
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString()
    boxes.leave('102', message('m-old', { receivedAt: old }))
    boxes.leave('102', message('m-new'))
    await until('the notices', () => hs.notices().length === 2)
    await until('the old one withdrawn', () => hs.notices().length === 1, 5_000)
    await until('its transcription gone', async () => (await store.listTranscripts('A', 'jean', undefined, true)).map(t => t.messageId).join() === 'm-new')
    await app.close()
  })

  it('erases, deletes and expires the transcriptions with the transcription and the bot off, and says the notices left in Chat', async () => {
    const store = new MemoryStore()
    const boxes = mailboxes()
    const on = await setup({ store, boxes, retentionDays: 0 })
    on.boxes.leave('102', message('m1'))
    on.boxes.leave('103', message('m3'))
    on.boxes.leave('101', message('m-old', { receivedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }))
    await until('the notices', () => on.hs.notices().length === 3)
    await on.app.close()
    // The pilot ends: LINTO_URL and MATRIX_* taken out, the Gateway started again.
    const logs: string[] = []
    const off = await setup({ store, boxes, transcribe: false, notices: false, retentionDays: 30, purgeMs: 50, logs })
    const res = await off.app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: off.as('jean') })
    expect(res.json()).toEqual({ deleted: 0, voicemailErasure: 'asked', chatNotices: 'not-withdrawn' })
    await until("Jean's row gone", async () => !(await store.listTranscripts('A', 'jean', undefined, true)).length)
    // The erasure says how many of the bot's notices it left in Chat.
    await until('the erasure logged', () => logs.some(l => l.includes('the messages of a person erased')))
    expect(logs.find(l => l.includes('the messages of a person erased'))).toContain('"notWithdrawn":1')
    // A message deleted, a message past the retention period: their rows go too.
    expect((await off.app.inject({ method: 'DELETE', url: '/api/v1/voicemails/m3', headers: off.as('bob') })).statusCode).toBe(204)
    await until("Bob's row gone", async () => !(await store.listTranscripts('A', 'bob', undefined, true)).length)
    await until("Alice's old row gone", async () => !(await store.listTranscripts('A', 'alice', undefined, true)).length)
    expect(await off.alerts()).toContain('notice-not-withdrawn')
    // Their room is forgotten with them: no Matrix id of theirs kept.
    expect(JSON.stringify(await store.listOperatorState('A', 'matrix:'))).not.toContain('@jean')
    await off.app.close()
  })

  it('catches up the messages it did not hear while another Gateway held the lease, and erases one deleted meanwhile once two reads apart confirm it', async () => {
    const { app, store, boxes, hs, transcriptOf, rowOf } = await setup({ reconcileMs: 50, orphanMs: 1_000 })
    boxes.leave('102', message('m0'))
    await until("m0's notice", () => hs.notices().length === 1)
    // Another Gateway holds the lease a moment (a restart, a lease in transit): what is said meanwhile is not heard here.
    await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 600, 99)
    await sleep(100)
    boxes.leave('102', message('m1'))
    boxes.leave('102', message('m-old', { receivedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }))
    boxes.remove('jean', 'm0')
    boxes.emit({ extension: '102', event: { type: 'voicemail.deleted', timestamp: new Date().toISOString(), payload: { id: 'm0' } } })
    await sleep(100)
    expect(await rowOf('jean', 'm1')).toBeUndefined()
    expect(await rowOf('jean', 'm0')).toMatchObject({ notice: 'sent' })
    // The lease back: the mailboxes reconciled with the table.
    await until('m1 transcribed', async () => (await transcriptOf('jean', 'm1'))?.status === 'done', 5_000)
    await until("m1's notice", () => hs.notices().length === 2, 5_000)
    // Its absence read once: m0 kept a while, its notice too.
    expect(await rowOf('jean', 'm0')).toBeDefined()
    await until("m1's notice, m0's withdrawn", () => hs.notices().length === 1 && String(hs.notices()[0]!.content[NOTICE_FIELD]) === noticeKey('A', { holder: 'jean', messageId: 'm1' }), 5_000)
    await until("m0's row gone", async () => !(await rowOf('jean', 'm0')))
    // Older than it catches up with: said so, never transcribed.
    expect(await transcriptOf('jean', 'm-old')).toEqual({ status: 'none', reason: 'untracked' })
    expect(await rowOf('jean', 'm-old')).toBeUndefined()
    await app.close()
  })

  it('catches up after a gap in the stream of the voicemail server', async () => {
    const { app, boxes, hs, transcriptOf } = await setup()
    boxes.leave('102', message('m1'), true)
    await sleep(100)
    expect(hs.events.size).toBe(0)
    // On the screen meanwhile: on its way.
    expect(await transcriptOf('jean', 'm1')).toEqual({ status: 'pending' })
    boxes.leave('102', message('m2'), true)
    boxes.heard()
    await until('both caught up', () => hs.notices().length === 2)
    expect(await transcriptOf('jean', 'm2')).toMatchObject({ status: 'done' })
    await app.close()
  })

  it('writes nothing from a Gateway that lost the lease of the mailboxes, not even a transcription it finished', async () => {
    const g = gate()
    const { app, store, boxes, hs, transcriptOf } = await setup({
      transcribe: async () => {
        await g.closed
        return { text: SAID }
      }
    })
    boxes.leave('102', message('m1'))
    await until('the transcription asked', async () => (await store.listTranscripts('A', 'jean')).length === 1)
    // Another Gateway takes the lease meanwhile.
    await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 60_000, 99)
    await sleep(400)
    g.open()
    await sleep(200)
    const [row] = await store.listTranscripts('A', 'jean')
    expect([row!.status, row!.text, row!.notice]).toEqual(['pending', undefined, 'pending'])
    expect(hs.events.size).toBe(0)
    // Nor a new message.
    boxes.leave('102', message('m2'))
    await sleep(200)
    expect((await store.listTranscripts('A', 'jean')).map(t => t.messageId)).toEqual(['m1'])
    expect(await transcriptOf('jean', 'm1')).toEqual({ status: 'pending' })
    await app.close()
  })

  it("never tells a newcomer given an id another person had of that person's message, nor shows them its text", async () => {
    const g = gate()
    let n = 0
    const { app, store, boxes, hs, transcriptOf, rowOf } = await setup({
      transcribe: async () => {
        if (n++ === 0) await g.closed
        return { text: n === 1 ? 'le message de l’ancien Jean' : SAID }
      }
    })
    boxes.leave('102', message('m1'))
    await until('the transcription asked', async () => (await rowOf('jean', 'm1'))?.status === 'pending' && n === 1)
    // Jean leaves, someone else is given his id (HolderRecord: the second holder of it), his mailbox their own.
    await store.putOperatorState('A', 'voicemail:holder:jean', { epoch: 1 })
    const newcomer = 'jean\u00001'
    boxes.boxes.set(newcomer, [message('m1')])
    boxes.at.set('102', newcomer)
    g.open()
    await until("the old Jean's transcription", async () => (await rowOf('jean', 'm1'))?.status === 'done')
    // No notice of it: whoever has the id now is not him.
    await until('no notice', async () => (await rowOf('jean', 'm1'))?.notice === 'none')
    expect(hs.events.size).toBe(0)
    // The newcomer's own m1: never the old one's text.
    expect((await transcriptOf('jean', 'm1'))?.text).not.toBe('le message de l’ancien Jean')
    // The stream heard again: the newcomer's mailbox read, their m1 theirs.
    boxes.heard()
    await until("the newcomer's own", async () => (await transcriptOf('jean', 'm1'))?.text === SAID)
    await until("the newcomer's notice", () => hs.notices().length === 1)
    expect(hs.notices()[0]!.people).toContain(`@jean:${SERVER}`)
    expect(await rowOf(newcomer, 'm1')).toMatchObject({ notice: 'sent' })
    // Their rooms are each holder's: the old one's erasure leaves the newcomer's alone.
    expect((await store.listOperatorState('A', 'matrix:room:')).length).toBe(1)
    await app.close()
  })

  it('reads a message through the mailbox of its holder, whatever extension reaches it now', async () => {
    const { app, store, boxes, hs, transcriptOf } = await setup()
    const g = gate()
    boxes.state.recordingGate = g.closed
    boxes.leave('102', message('m0'))
    await until('m0 read', () => boxes.recordings() === 1)
    boxes.leave('102', message('m1'))
    await until('m1 written down', async () => (await store.listTranscripts('A', 'jean')).length === 2)
    // Jean moves to 104 before m1 is transcribed: his mailbox with him.
    await store.deleteMapping('A', 'jean')
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '104', displayName: 'Jean Dupont' })
    boxes.at.delete('102')
    boxes.at.set('104', 'jean')
    boxes.state.recordingGate = undefined
    g.open()
    await until('both told', () => hs.notices().length === 2)
    expect(await transcriptOf('jean', 'm1')).toMatchObject({ status: 'done' })
    await app.close()
  })

  it('transcribes no message longer than the bound, nor past the messages waiting allowed, says why, and tells the administrators once', async () => {
    const g = gate()
    const { app, store, boxes, hs, heard, heardAudio, transcriptOf } = await setup({
      maxSec: 60,
      queueMax: 1,
      transcribe: async () => {
        await g.closed
        return { text: SAID }
      }
    })
    const jean = heard('jean')
    boxes.leave('102', message('m-long', { durationSec: 61 }))
    await until('the long one', () => jean.some(e => e.type === 'voicemail.transcribed'))
    expect(jean[0]).toMatchObject({ payload: { voicemail: { transcript: { status: 'none', reason: 'too-long' } } } })
    expect(await transcriptOf('jean', 'm-long')).toEqual({ status: 'none', reason: 'too-long' })
    // Told all the same, without a text.
    await until('its notice', () => hs.notices().length === 1)
    expect(String(hs.notices()[0]!.content.body)).toContain('trop long pour être transcrit')
    boxes.leave('102', message('m1'))
    await until('m1 waiting', async () => (await transcriptOf('jean', 'm1'))?.status === 'pending')
    boxes.leave('102', message('m2'))
    boxes.leave('102', message('m3'))
    await until('m2 and m3 left without', async () => (await transcriptOf('jean', 'm3'))?.reason === 'busy' && (await transcriptOf('jean', 'm2'))?.reason === 'busy')
    const alerts = (await store.listAlerts('A', {})).filter(a => a.alert.param === 'transcription-busy')
    expect(alerts.map(a => [a.alert.kind, a.alert.value])).toEqual([['voicemail', 1]])
    // The notices of those not transcribed do not wait behind the one being transcribed.
    await until('their notices', () => hs.notices().length === 3)
    g.open()
    await until('m1 done', async () => (await transcriptOf('jean', 'm1'))?.status === 'done')
    expect(heardAudio).toEqual(['RIFF-audio-of-m1'])
    await until('every notice', () => hs.notices().length === 4)
    await app.close()
  })

  it('keeps a text without control characters and 10 000 characters long at most, and a recording too large is a message too long', async () => {
    const { app, boxes, heardAudio, transcriptOf } = await setup({ transcribe: async () => ({ text: `a\u0000b\u0007c\nd\te${'x'.repeat(TRANSCRIPT_TEXT_MAX + 50)}` }) })
    boxes.leave('102', message('m1'))
    boxes.leave('102', message('big1'))
    boxes.leave('102', message('huge1'))
    await until('m1 done', async () => (await transcriptOf('jean', 'm1'))?.status === 'done')
    const text = (await transcriptOf('jean', 'm1'))!.text!
    expect(text.startsWith('abc\nd\texxx')).toBe(true)
    expect(text).toHaveLength(TRANSCRIPT_TEXT_MAX)
    await until('big1 and huge1 too long', async () => (await transcriptOf('jean', 'big1'))?.reason === 'too-long' && (await transcriptOf('jean', 'huge1'))?.reason === 'too-long')
    expect(heardAudio).toEqual(['RIFF-audio-of-m1'])
    await app.close()
  })

  it('tries a transcription that fails twice more, then says it failed, tells the administrators, and still sends the notice', async () => {
    let tries = 0
    const { app, boxes, hs, transcriptOf, alerts } = await setup({
      transcribe: async () => {
        tries++
        throw new Error('LinTO answered 500')
      }
    })
    boxes.leave('102', message('m1'))
    await until('given up', async () => (await transcriptOf('jean', 'm1'))?.status === 'none')
    expect(tries).toBe(3)
    expect(await transcriptOf('jean', 'm1')).toEqual({ status: 'none', reason: 'failed' })
    expect(await alerts()).toContain('transcription-failed')
    await until('the notice', () => hs.notices().length === 1)
    expect(String(hs.notices()[0]!.content.body)).toContain("n'a pas pu le transcrire")
    await app.close()
  })

  it('sends a notice again after a failure of the homeserver, once, even when its answer was lost, and gives up past its tries with an alert', async () => {
    const { app, store, boxes, hs, alerts } = await setup()
    hs.fail(500, 429)
    boxes.leave('102', message('m1'))
    await until('the notice', async () => (await store.listTranscripts('A', 'jean', ['m1']))[0]?.notice === 'sent')
    expect(hs.events.size).toBe(1)
    // The notice sent, its answer lost: the next try sends nothing more.
    hs.lose('PUT send')
    boxes.leave('102', message('m2'))
    await until('the second notice', async () => (await store.listTranscripts('A', 'jean', ['m2']))[0]?.notice === 'sent')
    expect(hs.events.size).toBe(2)
    expect(new Set(hs.sentTxns).size).toBe(2)
    // The room made, its answer lost: the next try takes it, no second room, no second invitation.
    hs.lose('POST createRoom')
    boxes.leave('103', message('b1'))
    await until("Bob's notice", async () => (await store.listTranscripts('A', 'bob', ['b1']))[0]?.notice === 'sent')
    expect(hs.rooms.size).toBe(2)
    expect(hs.calls.filter(c => c === 'POST createRoom')).toHaveLength(2)
    // A homeserver that keeps refusing: given up after its tries (three here), told to the administrators.
    hs.fail(500, 500, 500)
    boxes.leave('102', message('m3'))
    await until('given up', async () => (await store.listTranscripts('A', 'jean', ['m3']))[0]?.notice === 'none')
    expect(await alerts()).toContain('notice-failed')
    expect(hs.events.size).toBe(3)
    await app.close()
  })

  it('finds again a notice sent before whose answer was lost, whatever transaction sent it', async () => {
    const { app, store, boxes, hs } = await setup()
    boxes.leave('102', message('m1'))
    await until('the first notice', () => hs.notices().length === 1)
    const [roomId] = [...hs.rooms.keys()]
    // Sent by a token since rotated (its transaction id unknown now): there, with its print.
    hs.events.set('$sent-before', { roomId: roomId!, content: { msgtype: 'm.notice', body: 'x', [NOTICE_FIELD]: noticeKey('A', { holder: 'jean', messageId: 'm2' }) }, redacted: false })
    boxes.leave('102', message('m2'))
    await until('m2 told', async () => (await store.listTranscripts('A', 'jean', ['m2']))[0]?.notice === 'sent')
    expect((await store.listTranscripts('A', 'jean', ['m2']))[0]!.noticeEvent).toBe('$sent-before')
    expect(hs.events.size).toBe(2)
    await app.close()
  })

  it("sends no notice to an account on another server than the bot's, nor to one the directory and the template give none or a wrong one, nor to one the homeserver does not have; says so and tells the administrators", async () => {
    const ids: Record<string, string> = { jean: '@jean:elsewhere.example.net', bob: 'Bob.Durand@chat.example.test' }
    const logs: string[] = []
    const level = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'info'
    const { app, store, boxes, hs, transcriptOf, alerts } = await setup({ logs, matrixIdOf: async (_t, userId) => ids[userId] }).finally(() => (process.env.LOG_LEVEL = level))
    hs.noAccount.add(`@alice:${SERVER}`)
    boxes.leave('102', message('m1'))
    boxes.leave('103', message('m3'))
    boxes.leave('101', message('m4'))
    await until('transcribed', async () => (await transcriptOf('jean', 'm1'))?.status === 'done')
    await until('no notice', async () => (await Promise.all(['jean', 'bob', 'alice'].map(async h => (await store.listTranscripts('A', h))[0]?.notice))).every(n => n === 'none'))
    expect(hs.calls.filter(c => !['GET account/whoami', 'GET profile'].includes(c))).toEqual([])
    expect(await alerts()).toContain('notice-no-account')
    const all = logs.join('\n')
    expect(all).toContain("not on the bot's server")
    expect(all).toContain('not a Matrix user id')
    expect(all).toContain('no such account on the homeserver')
    await app.close()
    // The directory's word first: Bob's own account, not the template's; two of them: none.
    const second = await setup({
      matrixIdOf: async (_t, userId) => {
        if (userId === 'jean') throw Object.assign(new Error('two'), { code: MATRIX_ID_AMBIGUOUS })
        return userId === 'bob' ? `@bob.durand:${SERVER}` : undefined
      }
    })
    second.boxes.leave('103', message('m3'))
    second.boxes.leave('102', message('m1'))
    await until('the notice', () => second.hs.notices().length === 1)
    expect(second.hs.notices()[0]!.people).toContain(`@bob.durand:${SERVER}`)
    await until("none for Jean's", async () => (await second.store.listTranscripts('A', 'jean'))[0]?.notice === 'none')
    await second.app.close()
  })

  it('sends a notice to an account with neither name nor avatar (a profile not found), and none to the bot itself (second review)', async () => {
    const { app, store, boxes, hs, alerts } = await setup({ matrixIdOf: async (_t, userId) => (userId === 'bob' ? BOT : undefined) })
    hs.noProfile.add(`@jean:${SERVER}`)
    boxes.leave('102', message('m1'))
    await until("Jean's notice", () => hs.notices().length === 1)
    expect(hs.notices()[0]!.people).toContain(`@jean:${SERVER}`)
    boxes.leave('103', message('b1'))
    await until("none for Bob's", async () => (await store.listTranscripts('A', 'bob'))[0]?.notice === 'none')
    expect(hs.calls.filter(c => c === 'POST createRoom')).toHaveLength(1)
    expect(await alerts()).toContain('notice-no-account')
    await app.close()
  })

  it('finds the room it made at its address, the homeserver saying it is taken while the address is not yet seen (second review)', async () => {
    const logs: string[] = []
    const { app, boxes, hs, rowOf } = await setup({ logs })
    // The room made, its answer lost; then the address not yet seen (a replica late): the room in use at it is the one.
    hs.lose('POST createRoom')
    hs.state.lag = 2
    boxes.leave('102', message('m1'))
    await until('the notice', () => hs.notices().length === 1)
    expect(hs.rooms.size).toBe(1)
    expect(hs.calls.filter(c => c === 'POST createRoom')).toHaveLength(2)
    expect((await rowOf('jean', 'm1'))!.noticeRoom).toBe([...hs.rooms.keys()][0])
    expect(logs.filter(l => l.includes('voicemail notice not sent'))).toHaveLength(1)
    await app.close()
  })

  it('invites no more someone who turned the room down, leaves it once its notices are gone, and makes another room when someone else got in', async () => {
    const { app, store, boxes, hs, as } = await setup()
    boxes.leave('102', message('m1'))
    await until('the notice', () => hs.notices().length === 1)
    const [first] = [...hs.rooms.keys()]
    // Jean declines (or leaves): no new room, no new invitation, message after message.
    hs.rooms.get(first!)!.members.set(`@jean:${SERVER}`, 'leave')
    boxes.leave('102', message('m2'))
    boxes.leave('102', message('m3'))
    await until('no notice', async () => (await store.listTranscripts('A', 'jean', ['m2', 'm3'])).every(r => r.notice === 'none'))
    expect(hs.rooms.size).toBe(1)
    expect(hs.calls.filter(c => c === 'POST createRoom')).toHaveLength(1)
    // The bot stays while its notice is there (to withdraw it), and leaves once it is withdrawn.
    expect(hs.rooms.get(first!)!.members.get(BOT)).toBe('join')
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/voicemails/m1', headers: as('jean') })).statusCode).toBe(204)
    await until('the room left', () => hs.rooms.get(first!)!.members.get(BOT) === 'leave')
    expect(hs.aliases.size).toBe(0)
    // His messages erased (his right): his refusal stays, still not invited again.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).json()).toMatchObject({ voicemailErasure: 'asked' })
    await until('his transcriptions gone', async () => !(await store.listTranscripts('A', 'jean', undefined, true)).length)
    boxes.leave('102', message('m4'))
    await until('no notice for m4', async () => (await store.listTranscripts('A', 'jean', ['m4']))[0]?.notice === 'none')
    expect(hs.calls.filter(c => c === 'POST createRoom')).toHaveLength(1)
    // Someone else in Bob's room: another one, the first left once its notice goes.
    boxes.leave('103', message('b1'))
    await until("Bob's notice", () => hs.notices().length === 1)
    const bobs = [...hs.rooms.keys()][1]!
    hs.rooms.get(bobs)!.members.set(`@eve:${SERVER}`, 'join')
    boxes.leave('103', message('b2'))
    await until("Bob's second notice", () => hs.notices().length === 2)
    expect(hs.rooms.size).toBe(3)
    expect(hs.rooms.get(bobs)!.members.get(BOT)).toBe('join')
    await app.close()
  })

  it('invites again once in a while someone who declined', async () => {
    const { app, store, boxes, hs } = await setup({ declinedMs: 100 })
    boxes.leave('102', message('m1'))
    await until('the notice', () => hs.notices().length === 1)
    hs.rooms.get([...hs.rooms.keys()][0]!)!.members.set(`@jean:${SERVER}`, 'leave')
    boxes.leave('102', message('m2'))
    await until('none for m2', async () => (await store.listTranscripts('A', 'jean', ['m2']))[0]?.notice === 'none')
    await sleep(150)
    boxes.leave('102', message('m3'))
    await until('invited again', () => hs.rooms.size === 2 && hs.notices().length === 2)
    await app.close()
  })

  it('gives a withdrawal up when the bot can no longer make it (left the room, the event gone), and sends no notice of a message gone before it', async () => {
    const g = gate()
    let n = 0
    const { app, boxes, hs, as, rowOf, alerts } = await setup({
      transcribe: async () => {
        if (n++ === 2) await g.closed
        return { text: SAID }
      }
    })
    boxes.leave('102', message('m1'))
    boxes.leave('103', message('m2'))
    await until('the notices', () => hs.notices().length === 2)
    // The event gone (404), the bot out of the room (403).
    const m1 = (await rowOf('jean', 'm1'))!.noticeEvent!
    hs.events.delete(m1)
    hs.rooms.get((await rowOf('bob', 'm2'))!.noticeRoom!)!.members.set(BOT, 'leave')
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/voicemails/m1', headers: as('jean') })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/voicemails/m2', headers: as('bob') })).statusCode).toBe(204)
    await until('both rows gone', async () => !(await rowOf('jean', 'm1')) && !(await rowOf('bob', 'm2')))
    expect(hs.calls.filter(c => c === 'PUT redact')).toHaveLength(2)
    // A message transcribed, then gone before its notice (no event of it): none sent, nothing counted, looked for
    // again later (left to the reconciliation, which erases it once its absence is confirmed), no alert.
    boxes.leave('102', message('m5'))
    await until('m5 being transcribed', () => n === 3)
    boxes.remove('jean', 'm5')
    g.open()
    await until('m5 put off', async () => Date.parse((await rowOf('jean', 'm5'))?.noticeNextAt ?? '0') > Date.now() + 60_000)
    expect(await rowOf('jean', 'm5')).toMatchObject({ status: 'done', notice: 'pending', noticeAttempts: 0 })
    expect(await alerts()).not.toContain('notice-failed')
    expect(hs.events.size).toBe(1)
    await app.close()
  })

  it('tells the subscribers of a message left and of its transcription, never its text nor its recording', async () => {
    const store = new MemoryStore()
    await store.addWebhookSubscription({ tenantId: 'A', id: 'wh_00000000000000e1', url: 'https://crm.example.org/in', events: ['voicemail.created', 'voicemail.transcribed'], enabled: true, secretEnc: 'enc', failures: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 20)
    const queued: { type: string; body: string }[] = []
    const enqueue = store.enqueueWebhookEvent.bind(store)
    store.enqueueWebhookEvent = async (...args: Parameters<Store['enqueueWebhookEvent']>) => {
      queued.push({ type: args[2], body: args[3] })
      return enqueue(...args)
    }
    const { app, boxes } = await setup({ store, hub: true, notices: false })
    boxes.leave('102', message('m1'))
    await until('both events', () => queued.length === 2)
    expect(queued.map(q => q.type)).toEqual(['voicemail.created', 'voicemail.transcribed'])
    expect(JSON.parse(queued[0]!.body)).toMatchObject({ type: 'voicemail.created', voicemail: { id: 'm1', user: 'jean', extension: '102', from: '0612345678', duration_sec: 12 } })
    expect(JSON.parse(queued[1]!.body)).toMatchObject({ type: 'voicemail.transcribed', voicemail: { id: 'm1', user: 'jean', extension: '102' }, transcript: { status: 'done' } })
    expect(queued.map(q => q.body).join()).not.toMatch(/Bonjour|RIFF/)
    await app.close()
  })

  it('logs neither a recording nor a text, nor a Matrix id', async () => {
    const level = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'debug'
    const logs: string[] = []
    try {
      const { app, boxes, hs, as } = await setup({ logs, matrixIdOf: async () => `@jean:elsewhere.example.net` })
      boxes.leave('102', message('m1'))
      await until('transcribed', () => logs.some(l => l.includes("not on the bot's server")))
      await app.inject({ url: '/api/v1/voicemails', headers: as('jean') })
      expect(hs.events.size).toBe(0)
      await app.close()
    } finally {
      process.env.LOG_LEVEL = level
    }
    const all = logs.join('\n')
    expect(all).toContain("not on the bot's server")
    expect(all).not.toMatch(/Bonjour|RIFF|elsewhere\.example|@jean|syt_/)
  })

  it('sends no text in the notices when asked not to: who called, when, and the link only', async () => {
    const { app, boxes, hs } = await setup({ withText: false })
    boxes.leave('102', message('m1'))
    await until('the notice', () => hs.notices().length === 1)
    const c = hs.notices()[0]!.content
    expect(String(c.body)).not.toContain('Bonjour')
    expect(String(c.formatted_body)).not.toContain('Bonjour')
    expect(String(c.body)).toContain('https://phone.example.test/voicemail')
    await app.close()
  })

  it('sends nothing to Chat without a bot, and transcribes nothing without a transcription service', async () => {
    const quiet = await setup({ notices: false })
    quiet.boxes.leave('102', message('m1'))
    await until('transcribed', async () => (await quiet.transcriptOf('jean', 'm1'))?.status === 'done')
    expect(quiet.hs.calls).toEqual([])
    await quiet.app.close()
    const bare = await setup({ transcribe: false })
    const jean = bare.heard('jean')
    bare.boxes.leave('102', message('m2'))
    await until('the notice', () => bare.hs.notices().length === 1)
    expect(String(bare.hs.notices()[0]!.content.body)).not.toContain('Transcription')
    expect(jean[0]).toMatchObject({ type: 'voicemail.created' })
    expect((jean[0] as { payload: { voicemail: Voicemail } }).payload.voicemail.transcript).toBeUndefined()
    expect(await bare.transcriptOf('jean', 'm2')).toBeUndefined()
    expect((await bare.app.inject({ url: '/api/v1/capabilities', headers: bare.as('jean') })).json().voicemailTranscription).toBeUndefined()
    await bare.app.close()
  })
})

/** The extension of each holder of the tests of VoicemailTranscripts on its own. */
const EXTENSION: Record<string, string> = { jean: '102', bob: '103' }

/** VoicemailTranscripts on its own, its lease in the test's hands: Jean's mailbox, or those of `holders`. */
const unit = async (o: Partial<VoicemailTranscriptsOptions> & { transcribe?: TranscriptionProvider['transcribe']; hs?: ReturnType<typeof homeserver>; queueMax?: number; holders?: string[] } = {}) => {
  const store = new MemoryStore()
  const taken = await store.takeWebhookLease('voicemail:A', 'gw_1', 60_000)
  const lease: FencedLease = { role: 'voicemail:A', holder: 'gw_1', generation: taken!.generation }
  const boxes = mailboxes()
  const held = (o.holders ?? ['jean']).map(holder => ({ extension: EXTENSION[holder]!, holder }))
  await boxes.vm.syncMailboxes(
    held.map(b => ({ extension: b.extension, userId: b.holder })),
    { mayWrite: () => true }
  )
  const state = { held: true }
  const heardAudio: string[] = []
  const signals: AbortSignal[] = []
  const warnings: string[] = []
  const settled: string[] = []
  const alerts: string[] = []
  const t = new VoicemailTranscripts(
    {
      store,
      voicemail: () => boxes.vm,
      transcription: {
        provider: {
          id: 'fake-transcription',
          transcribe: async (audio, options) => {
            heardAudio.push(new TextDecoder().decode(audio))
            if (options?.signal) signals.push(options.signal)
            return (o.transcribe ?? (async () => ({ text: SAID })))(audio, options)
          }
        },
        maxSec: 180,
        queueMax: o.queueMax ?? 100,
        maxBytes: 1_000_000
      },
      ...(o.hs ? { notices: { bot: new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: o.hs.fetch }), userTemplate: `@{uid}:${SERVER}`, timeZone: 'UTC', matrixIdOf: async () => undefined } } : {}),
      lease: () => (state.held ? lease : undefined),
      holderIdFor: async (_t, userId) => userId,
      mailboxes: async () => held,
      onSettled: (_t, r) => void settled.push(r.messageId),
      alert: async (_t, param) => void alerts.push(param),
      log: { info: () => {}, warn: (_obj, msg) => void warnings.push(msg), error: () => {} },
      everyMs: 0,
      retryMs: [1, 1],
      noticeRetryMs: [1, 1],
      ...o
    },
    () => ['A']
  )
  const add = async (id: string, holder = 'jean') => {
    boxes.leave(EXTENSION[holder]!, message(id), true)
    await t.heard('A', EXTENSION[holder]!, holder, message(id))
  }
  const rows = async (holder = 'jean') => (await store.listTranscripts('A', holder, undefined, true)).map(r => r.messageId).sort()
  /** A reconciliation, and the rounds it starts. */
  const reconcile = async () => {
    await t.reconcile('A')
    await t.settled('A')
  }
  return { t, store, boxes, state, heardAudio, signals, warnings, settled, alerts, add, rows, reconcile, lease }
}

describe('VoicemailTranscripts', () => {
  it('asks the lease before the transcription service and before each message, and reads nothing more once it is lost', async () => {
    const u = await unit()
    const g = gate()
    u.boxes.state.recordingGate = g.closed
    await u.add('m1')
    await until('m1 read', () => u.boxes.recordings() === 1)
    u.state.held = false
    g.open()
    await u.t.settled('A')
    expect(u.heardAudio).toEqual([])
    // Lost right after a transcription written: the next message is not even read.
    const w = await unit({ onSettled: () => void (w.state.held = false) })
    await w.store.addTranscript({ tenantId: 'A', holder: 'jean', messageId: 'm2', extension: '102', receivedAt: new Date().toISOString(), status: 'pending', notice: 'none' }, w.lease, 9)
    w.boxes.leave('102', message('m2'), true)
    await w.add('m1')
    await w.t.settled('A')
    expect(w.boxes.recordings()).toBe(1)
    expect(w.heardAudio).toHaveLength(1)
  })

  it('stops at once, the call to the transcription service aborted, the message left due for the next writer', async () => {
    const u = await unit({ transcribe: (_a, options) => new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) })
    await u.add('m1')
    await until('asked', () => u.signals.length === 1)
    const start = Date.now()
    await u.t.stop()
    expect(Date.now() - start).toBeLessThan(500)
    expect(u.signals[0]!.aborted).toBe(true)
    expect((await u.store.listTranscripts('A', 'jean'))[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('withdraws notices and sends them without their text while the transcription service hangs', async () => {
    const hs = homeserver()
    const u = await unit({ hs, everyMs: 20, noticeWaitMs: 50, transcribe: (_a, options) => new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) })
    u.t.start()
    await u.add('m1')
    await until('the notice without its text', () => hs.notices().length === 1, 2_000)
    expect(String(hs.notices()[0]!.content.body)).toContain('pas encore prête')
    // Erased meanwhile (the person's right): withdrawn, the transcription still hanging.
    await u.t.erase('A', 'jean')
    await until('withdrawn', () => hs.notices().length === 0)
    expect(u.heardAudio).toHaveLength(1)
    await u.t.stop()
  })

  it('leaves a failing transcription service alone a while after three failures in a row', async () => {
    let calls = 0
    const u = await unit({
      breakerMs: [60_000],
      retryMs: [1, 1, 1, 1, 1],
      transcribe: async () => {
        calls++
        throw new Error('LinTO answered 503')
      }
    })
    await u.add('m1')
    await u.add('m2')
    await u.add('m3')
    await u.add('m4')
    for (let i = 0; i < 5; i++) {
      u.t.kick('A')
      await u.t.settled('A')
      await sleep(5)
    }
    expect(calls).toBe(3)
    expect(u.warnings.some(w => w.includes('left alone a while'))).toBe(true)
    expect((await u.store.listTranscripts('A', 'jean')).map(r => r.status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('counts nothing while the voicemail server does not answer, and says so once', async () => {
    const u = await unit()
    await u.add('m1')
    await u.t.settled('A')
    u.boxes.state.down = true
    await u.add('m2')
    for (let i = 0; i < 3; i++) {
      u.t.kick('A')
      await u.t.settled('A')
    }
    expect((await u.store.listTranscripts('A', 'jean', ['m2']))[0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(u.warnings.filter(w => w.includes('does not answer'))).toHaveLength(1)
    u.boxes.state.down = false
    u.t.kick('A')
    await u.t.settled('A')
    expect((await u.store.listTranscripts('A', 'jean', ['m2']))[0]!.status).toBe('done')
  })

  it('suspends the notices too while the voicemail server does not answer: no try counted, sent once it answers', async () => {
    const hs = homeserver()
    const u = await unit({ hs, noticeRetryMs: [50, 50] })
    // A first try fails (the homeserver): one counted.
    hs.fail(500)
    await u.add('m1')
    await u.t.settled('A')
    expect((await u.store.listTranscripts('A', 'jean', ['m1']))[0]).toMatchObject({ status: 'done', notice: 'pending', noticeAttempts: 1 })
    u.boxes.state.down = true
    for (let i = 0; i < 4; i++) {
      await sleep(20)
      u.t.kick('A', 'notice')
      await u.t.settled('A')
    }
    expect((await u.store.listTranscripts('A', 'jean', ['m1']))[0]).toMatchObject({ notice: 'pending', noticeAttempts: 1 })
    u.boxes.state.down = false
    await sleep(20)
    u.t.kick('A', 'notice')
    await u.t.settled('A')
    expect((await u.store.listTranscripts('A', 'jean', ['m1']))[0]!.notice).toBe('sent')
    expect(hs.notices()).toHaveLength(1)
  })

  it('erases nothing, withdraws nothing and sends nothing twice while the voicemail server reads its mailboxes empty (its spool out of its sight), and tells the administrators (second review)', async () => {
    const hs = homeserver()
    const u = await unit({ hs, holders: ['jean', 'bob'], orphanConfirmMs: 1 })
    await u.add('m1')
    await u.add('m2')
    await u.add('b1', 'bob')
    await u.t.settled('A')
    expect(hs.notices()).toHaveLength(3)
    // wazo-calld no longer sees the spool: every mailbox read empty, without an error.
    u.boxes.state.blind = true
    // A message heard meanwhile: neither it nor its recording found, its row kept, looked for again later.
    await u.add('m3')
    for (let i = 0; i < 3; i++) {
      await sleep(5)
      await u.reconcile()
    }
    expect(await u.rows()).toEqual(['m1', 'm2', 'm3'])
    expect(await u.rows('bob')).toEqual(['b1'])
    expect(hs.notices()).toHaveLength(3)
    expect(hs.calls).not.toContain('PUT redact')
    expect(u.alerts).toContain('transcription-held')
    const m3 = (await u.store.listTranscripts('A', 'jean', ['m3']))[0]!
    expect(m3).toMatchObject({ status: 'pending', attempts: 0, notice: 'pending' })
    expect(Date.parse(m3.nextAt)).toBeGreaterThan(Date.now() + 60_000)
    // The spool seen again: every message known, none written down nor told twice.
    u.boxes.state.blind = false
    await u.reconcile()
    u.t.kick('A')
    await u.t.settled('A')
    expect(await u.rows()).toEqual(['m1', 'm2', 'm3'])
    expect(hs.notices()).toHaveLength(3)
    expect(hs.sentTxns).toHaveLength(3)
    // One message in one mailbox, read empty: held all the same.
    const one = await unit({ hs: homeserver(), orphanConfirmMs: 1 })
    await one.add('m1')
    await one.t.settled('A')
    one.boxes.state.blind = true
    for (let i = 0; i < 3; i++) {
      await sleep(5)
      await one.reconcile()
    }
    expect(await one.rows()).toEqual(['m1'])
    expect(one.alerts).toContain('transcription-held')
    // One mailbox of two messages read empty, the others read: held too, however few of the organisation's they are.
    const box = await unit({ hs: homeserver(), holders: ['jean', 'bob'], orphanConfirmMs: 1 })
    await box.add('m1')
    await box.add('m2')
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) await box.add(id, 'bob')
    await box.t.settled('A')
    box.boxes.state.blindTo.add('jean')
    for (let i = 0; i < 3; i++) {
      await sleep(5)
      await box.reconcile()
    }
    expect(await box.rows()).toEqual(['m1', 'm2'])
    expect(box.alerts).toContain('transcription-held')
  })

  it("erases the row of a message gone (its event missed) only once two reads apart do not see it, and none when too many went at once (second review)", async () => {
    const hs = homeserver()
    const u = await unit({ hs, orphanConfirmMs: 100 })
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']) await u.add(id)
    await u.t.settled('A')
    expect(hs.notices()).toHaveLength(7)
    // Gone, read once: kept.
    u.boxes.remove('jean', 'm1')
    await u.reconcile()
    expect(await u.rows()).toHaveLength(7)
    await sleep(60)
    await u.reconcile()
    expect(await u.rows()).toHaveLength(7)
    // Still not there past the wait: erased, its notice withdrawn.
    await sleep(60)
    await u.reconcile()
    expect(await u.rows()).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7'])
    expect(hs.notices()).toHaveLength(6)
    // Not seen, then seen again: counted from scratch.
    u.boxes.remove('jean', 'm2')
    await u.reconcile()
    u.boxes.boxes.get('jean')!.push(message('m2'))
    await sleep(120)
    await u.reconcile()
    u.boxes.remove('jean', 'm2')
    await u.reconcile()
    expect(await u.rows()).toContain('m2')
    await sleep(120)
    await u.reconcile()
    expect(await u.rows()).toEqual(['m3', 'm4', 'm5', 'm6', 'm7'])
    expect(u.alerts).not.toContain('transcription-held')
    // Three of five gone at once: held, nothing erased however long, the administrators told.
    for (const id of ['m3', 'm4', 'm5']) u.boxes.remove('jean', id)
    for (let i = 0; i < 3; i++) {
      await u.reconcile()
      await sleep(120)
    }
    expect(await u.rows()).toEqual(['m3', 'm4', 'm5', 'm6', 'm7'])
    expect(hs.notices()).toHaveLength(5)
    expect(u.alerts).toContain('transcription-held')
  })

  it('reconciles the other mailboxes when one cannot be read, tells a backlog all the same, and tells the administrators of one that stays unreadable (second review)', async () => {
    const u = await unit({ holders: ['jean', 'bob'], backlogMs: 1 })
    await u.add('m1')
    await u.t.settled('A')
    u.boxes.state.failing.add('jean')
    // Its message not read: its transcription waits.
    await u.add('m2')
    // Bob's, its event missed.
    u.boxes.leave('103', message('b1'), true)
    await sleep(5)
    await u.reconcile()
    expect((await u.store.listTranscripts('A', 'bob')).map(r => [r.messageId, r.status])).toEqual([['b1', 'done']])
    expect(await u.rows()).toEqual(['m1', 'm2'])
    expect(u.alerts).toContain('transcription-backlog')
    expect(u.alerts).not.toContain('transcription-unreadable')
    await u.reconcile()
    expect(u.alerts).not.toContain('transcription-unreadable')
    await u.reconcile()
    expect(u.alerts.filter(a => a === 'transcription-unreadable')).toHaveLength(1)
    // Read again: counted from scratch.
    u.boxes.state.failing.delete('jean')
    await u.reconcile()
    u.boxes.state.failing.add('jean')
    await u.reconcile()
    await u.reconcile()
    expect(u.alerts.filter(a => a === 'transcription-unreadable')).toHaveLength(1)
    // Not one read (the voicemail server out): not a mailbox's trouble, no such alert.
    const all = await unit({ holders: ['jean', 'bob'] })
    all.boxes.state.failing.add('jean')
    all.boxes.state.failing.add('bob')
    for (let i = 0; i < 4; i++) await all.reconcile()
    expect(all.alerts).not.toContain('transcription-unreadable')
  })

  it('reads no further mailbox once the lease is lost', async () => {
    const u = await unit({ holders: ['jean', 'bob'] })
    const list = u.boxes.vm.listMessages.bind(u.boxes.vm)
    u.boxes.vm.listMessages = async o => {
      u.state.held = false
      return list(o)
    }
    await u.t.reconcile('A')
    expect(u.boxes.state.lists).toBe(1)
  })

  it('leaves a message missed for a later reconciliation while too many wait, neither written down nor said busy', async () => {
    const g = gate()
    const u = await unit({ queueMax: 1, transcribe: async () => {
      await g.closed
      return { text: SAID }
    } })
    await u.add('m1')
    u.boxes.leave('102', message('m2'), true)
    await u.t.reconcile('A')
    expect(await u.rows()).toEqual(['m1'])
    expect(u.alerts).not.toContain('transcription-busy')
    g.open()
    await u.t.settled('A')
    await u.reconcile()
    expect((await u.store.listTranscripts('A', 'jean')).map(r => [r.messageId, r.status])).toEqual([['m1', 'done'], ['m2', 'done']])
  })

  it('completes a notice sent before its transcription with it (a replacement), and withdraws both', async () => {
    const hs = homeserver()
    const g = gate()
    const u = await unit({ hs, everyMs: 20, noticeWaitMs: 50, transcribe: async () => {
      await g.closed
      return { text: SAID }
    } })
    u.t.start()
    await u.add('m1')
    await until('the notice without its text', () => hs.notices().length === 1, 2_000)
    expect(String(hs.notices()[0]!.content.body)).toContain('pas encore prête')
    expect((await u.store.listTranscripts('A', 'jean', ['m1']))[0]!.notice).toBe('early')
    g.open()
    await until('completed', async () => (await u.store.listTranscripts('A', 'jean', ['m1']))[0]?.notice === 'sent', 2_000)
    const r = (await u.store.listTranscripts('A', 'jean', ['m1']))[0]!
    const edit = hs.events.get(r.noticeEdit!)!
    expect(edit.content).toMatchObject({ 'm.relates_to': { rel_type: 'm.replace', event_id: r.noticeEvent } })
    expect(String((edit.content['m.new_content'] as { body: string }).body)).toContain(`« ${SAID} »`)
    expect(String(edit.content.body)).toMatch(/^\* /)
    expect(hs.events.size).toBe(2)
    await u.t.erase('A', 'jean')
    await until('both withdrawn', () => hs.notices().length === 0)
    expect(hs.events.get(r.noticeEvent!)!.redacted && hs.events.get(r.noticeEdit!)!.redacted).toBe(true)
    await u.t.stop()
  })

  it('withdraws at once a notice whose message was erased while it was sent, and its replacement too (second review)', async () => {
    const hs = homeserver()
    let erase: (() => Promise<void>) | undefined
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const now = erase
      if (now && (input instanceof Request ? input.url : String(input)).includes('/send/')) {
        erase = undefined
        await now()
      }
      return hs.fetch(input, init)
    }) as typeof globalThis.fetch
    const u = await unit({ hs: { ...hs, fetch } })
    erase = () => u.t.deleted('A', 'jean', 'm1')
    await u.add('m1')
    await u.t.settled('A')
    expect(await u.rows()).toEqual([])
    expect(hs.events.size).toBe(1)
    expect(hs.notices()).toHaveLength(0)
    // A replacement sent while its message was erased: withdrawn too.
    const g = gate()
    const w = await unit({ hs: { ...hs, fetch }, everyMs: 20, noticeWaitMs: 30, transcribe: async () => {
      await g.closed
      return { text: SAID }
    } })
    w.t.start()
    await w.add('m2')
    await until('the notice without its text', () => hs.notices().length === 1, 2_000)
    erase = () => w.t.deleted('A', 'jean', 'm2')
    g.open()
    await until('both withdrawn', async () => hs.events.size === 3 && hs.notices().length === 0 && !(await w.rows()).length, 2_000)
    await w.t.stop()
    // Its row gone altogether meanwhile (nothing left to withdraw it by): the replacement withdrawn at once.
    const h = gate()
    const x = await unit({ hs: { ...hs, fetch }, everyMs: 20, noticeWaitMs: 30, transcribe: async () => {
      await h.closed
      return { text: SAID }
    } })
    x.t.start()
    await x.add('m3')
    await until('the notice without its text', () => hs.notices().length === 1, 2_000)
    erase = async () => void (await x.store.deleteTranscript('A', 'jean', 'm3', x.lease))
    h.open()
    await until('the replacement sent', () => hs.events.size === 5, 2_000)
    const replacement = [...hs.events.values()].at(-1)!
    expect(replacement.content['m.relates_to']).toBeDefined()
    await until('the replacement withdrawn', () => replacement.redacted, 2_000)
    await x.t.stop()
  })
})

describe('TranscriptWatcher', () => {
  it("tells this Gateway's screens of the transcriptions any Gateway settled, once each, to their holder only", async () => {
    const store = new MemoryStore()
    const taken = await store.takeWebhookLease('voicemail:A', 'gw_1', 60_000)
    const lease: FencedLease = { role: 'voicemail:A', holder: 'gw_1', generation: taken!.generation }
    const told: string[] = []
    const holders: Record<string, string> = { jean: 'jean', bob: 'bob\u00001' }
    const watcher = new TranscriptWatcher({
      store,
      tenants: () => ['A'],
      listening: (_t, userId) => userId !== 'alice',
      holderIdFor: async (_t, userId) => holders[userId] ?? userId,
      publish: (_t, userId, e) => void told.push(`${userId} ${e.type} ${JSON.stringify(e.payload)}`),
      log: { error: () => {} },
      lang: 'fr',
      everyMs: 3_600_000
    })
    await watcher.start()
    const add = (holder: string, messageId: string) => store.addTranscript({ tenantId: 'A', holder, messageId, extension: '102', receivedAt: new Date().toISOString(), status: 'pending', notice: 'none' }, lease, 9)
    await add('jean', 'm1')
    await add('alice', 'm2')
    // Bob's id was someone else's before him (`bob`): that one's message is not his.
    await add('bob', 'm3')
    await add('jean', 'm4')
    await watcher.tick()
    expect(told).toEqual([])
    await sleep(5)
    for (const [h, m] of [['jean', 'm1'], ['alice', 'm2'], ['bob', 'm3']] as const) await store.updateTranscript('A', h, m, { status: 'done', text: `texte ${m}` }, lease)
    await store.updateTranscript('A', 'jean', 'm4', { status: 'none', reason: 'failed' }, lease)
    await watcher.tick()
    await watcher.tick()
    expect(told).toEqual(['jean voicemail.transcribed {"id":"m1","transcript":{"status":"done","text":"texte m1","lang":"fr"}}', 'jean voicemail.transcribed {"id":"m4","transcript":{"status":"none","reason":"failed"}}'])
    watcher.stop()
  })
})

describe('the bot (MatrixBot)', () => {
  it('says what failed in a few words and its code, never what the homeserver said nor the token', async () => {
    const hs = homeserver()
    const bot = new MatrixBot({ homeserverUrl: `https://${SERVER}/`, token: TOKEN, fetch: hs.fetch })
    expect(await bot.whoami()).toEqual({ userId: BOT, serverName: SERVER })
    hs.fail(429)
    const err = (await bot.send('!room1:x', 't1', { body: 'x' }).catch((e: unknown) => e)) as MatrixError
    expect(err).toBeInstanceOf(MatrixError)
    expect([err.status, err.errcode, err.retryAfterMs]).toEqual([429, 'M_LIMIT_EXCEEDED', 30])
    hs.fail(500)
    const other = (await bot.members('!room1:x').catch((e: unknown) => e)) as MatrixError
    expect(other.message).toBe('GET rooms: 500 M_UNKNOWN')
    expect(`${err.message} ${other.message}`).not.toMatch(/internal detail|Too many|syt_/)
    const refused = new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: 'syt_another_fake_token', fetch: hs.fetch })
    await expect(refused.probe()).rejects.toThrow(/401 M_UNKNOWN_TOKEN/)
    expect(() => new MatrixBot({ homeserverUrl: 'https://bot:pw@chat.example.test', token: TOKEN })).toThrow(/credentials/)
    expect(() => new MatrixBot({ homeserverUrl: 'ftp://chat.example.test', token: TOKEN })).toThrow(/http/)
    expect(() => new MatrixBot({ homeserverUrl: 'https://chat.example.test', token: 'two words' })).toThrow(/not an access token/)
    await expect(bot.createDirectRoom('jean', 'n', 't')).rejects.toThrow(/not a Matrix user id/)
    await expect(bot.createDirectRoom(`@jean:${SERVER}`, 'n', 't', 'Not An Alias')).rejects.toThrow(/not an alias/)
  })

  it('knows whose account exists, makes a room once at its address, finds it again, leaves it, and gives its address back', async () => {
    const hs = homeserver()
    const bot = new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: hs.fetch })
    hs.noAccount.add(`@nobody:${SERVER}`)
    expect(await bot.exists(`@jean:${SERVER}`)).toBe(true)
    expect(await bot.exists(`@nobody:${SERVER}`)).toBe(false)
    // An account with neither name nor avatar: Synapse says its profile is not found, not that there is no account.
    hs.noProfile.add(`@quiet:${SERVER}`)
    expect(await bot.exists(`@quiet:${SERVER}`)).toBeUndefined()
    const room = await bot.createDirectRoom(`@jean:${SERVER}`, 'n', 't', 'twakephone-abc')
    expect(await bot.resolveAlias('twakephone-abc')).toBe(room)
    await expect(bot.createDirectRoom(`@jean:${SERVER}`, 'n', 't', 'twakephone-abc')).rejects.toMatchObject({ errcode: 'M_ROOM_IN_USE' })
    const sent = await bot.send(room, 'txn1', { body: 'x', [NOTICE_FIELD]: 'k1' })
    expect(await bot.findSent(room, NOTICE_FIELD, 'k1')).toBe(sent)
    expect(await bot.findSent(room, NOTICE_FIELD, 'k2')).toBeUndefined()
    await bot.leave(room)
    await bot.leave(room)
    await bot.deleteAlias('twakephone-abc')
    await bot.deleteAlias('twakephone-abc')
    expect(await bot.resolveAlias('twakephone-abc')).toBeUndefined()
    // Stopped: said so, nothing sent.
    const stop = new AbortController()
    stop.abort()
    await expect(new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: hs.fetch }).whoami(stop.signal)).rejects.toThrow(/stopped/)
  })

  it('finds a notice sent before among more long messages than one answer holds, page by page, back to its bound (second review)', async () => {
    const hs = homeserver()
    const bot = new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: hs.fetch })
    const room = await bot.createDirectRoom(`@jean:${SERVER}`, 'n', 't', 'twakephone-pages')
    const long = 'x'.repeat(20_000)
    const first = await bot.send(room, 'txn0', { body: long, [NOTICE_FIELD]: 'k0' })
    for (let i = 1; i < 30; i++) await bot.send(room, `txn${i}`, { body: long, [NOTICE_FIELD]: `k${i}` })
    // 30 notices of 20 kB: more than one answer of 256 kB.
    const asked = hs.calls.filter(c => c === 'GET messages').length
    expect(await bot.findSent(room, NOTICE_FIELD, 'k0')).toBe(first)
    expect(hs.calls.filter(c => c === 'GET messages').length - asked).toBe(3)
    expect(await bot.findSent(room, NOTICE_FIELD, 'k29')).toBe([...hs.events.keys()].at(-1))
    // Past its fiftieth: not looked for any further.
    for (let i = 30; i < 60; i++) await bot.send(room, `txn${i}`, { body: 'x', [NOTICE_FIELD]: `k${i}` })
    const before = hs.calls.filter(c => c === 'GET messages').length
    expect(await bot.findSent(room, NOTICE_FIELD, 'k0')).toBeUndefined()
    expect(hs.calls.filter(c => c === 'GET messages').length - before).toBe(5)
  })

  it('refuses an answer too large, and one that is not JSON', async () => {
    const big = (async () => new Response('{"chunk":[' + '{},'.repeat(100_000) + '{}]}', { status: 200 })) as unknown as typeof globalThis.fetch
    await expect(new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: big }).members('!r:x')).rejects.toThrow(/too large/)
    const html = (async () => new Response('<html>oops</html>', { status: 502 })) as unknown as typeof globalThis.fetch
    await expect(new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: html }).whoami()).rejects.toThrow(/unreadable answer \(502\)/)
  })

  it('sends a notice and its withdrawal under transaction ids of their own, the same whatever the Gateway and the try', () => {
    const r = { holder: 'jean', messageId: 'm1' }
    expect(txnOf('n', 'A', r)).toBe(txnOf('n', 'A', { ...r }))
    expect(txnOf('n', 'A', r)).toMatch(/^twakephone-n-[0-9a-f]{32}$/)
    expect(txnOf('r', 'A', r).slice(13)).toBe(txnOf('n', 'A', r).slice(13))
    expect(txnOf('n', 'A', { holder: 'jean\u00001', messageId: 'm1' })).not.toBe(txnOf('n', 'A', r))
    expect(txnOf('n', 'B', r)).not.toBe(txnOf('n', 'A', r))
    expect(txnOf('n', 'A', { holder: 'jean', messageId: 'm2' })).not.toBe(txnOf('n', 'A', r))
  })
})

describe('the notice of a message', () => {
  it('says who called (the name they gave as theirs), when in the time zone given, how long, what they said, and links to the Messagerie vocale; escaped in HTML', () => {
    const v = message('m1', { fromName: 'Alice & <b>Fils</b>', from: '0612345678', receivedAt: '2026-10-18T08:05:00.000Z', durationSec: 75 })
    const c = noticeContent(v, { status: 'done', text: 'Rappelle <moi>' }, { appUrl: 'https://phone.example.test', timeZone: 'Europe/Paris' }, 'k1')
    expect(c.body).toBe("Nouveau message vocal du 0612345678 (nom annoncé par l'appelant : « Alice & b Fils b »), le 18 octobre 2026 à 10:05, durée 1:15.\nTranscription : « Rappelle <moi> »\nÉcouter dans TwakePhone : https://phone.example.test/voicemail")
    expect(c[NOTICE_FIELD]).toBe('k1')
    expect(c.formatted_body).toContain('Alice &amp; b Fils b')
    expect(c.formatted_body).toContain('<blockquote>Rappelle &lt;moi&gt;</blockquote>')
    expect(c.formatted_body).not.toContain('<moi>')
    expect(noticeContent(v, { status: 'done', text: '' }, { timeZone: 'UTC' }).body).toBe("Nouveau message vocal du 0612345678 (nom annoncé par l'appelant : « Alice & b Fils b »), le 18 octobre 2026 à 08:05, durée 1:15.\nTranscription : aucune parole reconnue.")
    expect(noticeContent(message('m2', { from: undefined, fromName: undefined }), { status: 'none' }, { timeZone: 'UTC' }).body).toMatch(/^Nouveau message vocal d'un numéro masqué,/)
    // Without the text: neither what was said, nor that it is on its way; why there is none still said.
    const bare = noticeContent(v, { status: 'done', text: 'Rappelle-moi' }, { appUrl: 'https://phone.example.test', timeZone: 'UTC', withText: false })
    expect(`${bare.body}${bare.formatted_body}`).not.toContain('Rappelle')
    expect(noticeContent(v, { status: 'pending' }, { timeZone: 'UTC', withText: false }).body).not.toContain('Transcription')
    expect(noticeContent(v, { status: 'pending' }, { timeZone: 'UTC' }).body).toContain('Transcription : pas encore prête')
    expect(noticeContent(v, { status: 'none', reason: 'busy' }, { timeZone: 'UTC', withText: false }).body).toContain('Pas de transcription')
  })

  it('takes out of the name a caller gave what changes how a text reads, and any address a client would make a link of', () => {
    expect(callerName('‮Service informatique​')).toBe('Service informatique')
    expect(callerName('Banque https://pay.example.test/x')).toBe('Banque https pay example test x')
    expect(callerName('www.example.test')).toBe('www example test')
    expect(callerName('support@example.test')).toBe('support example test')
    expect(callerName("Jean-Luc O'Brien, Dupont & Fils (SAV)")).toBe("Jean-Luc O'Brien, Dupont & Fils (SAV)")
    expect(callerName('Élodie Müller 2')).toBe('Élodie Müller 2')
    expect(callerName('Alice⁦ ⁩Martin\nIT')).toBe('Alice Martin IT')
    expect(callerName('​‮')).toBeUndefined()
    expect(callerName(undefined)).toBeUndefined()
    expect(Array.from(callerName('é'.repeat(100))!)).toHaveLength(64)
    const c = noticeContent(message('m1', { fromName: '\u202eService informatique' }), { status: 'none' }, { timeZone: 'UTC' })
    expect(c.body).toContain("(nom annoncé par l'appelant : « Service informatique »)")
    expect(c.body).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b]/)
  })

  it('shows the screens a transcription as it is, its text in its language, nothing of one erased or never made', () => {
    expect(publicTranscript({ status: 'pending' }, 'fr')).toEqual({ status: 'pending' })
    expect(publicTranscript({ status: 'done', text: 'x' }, 'fr')).toEqual({ status: 'done', text: 'x', lang: 'fr' })
    expect(publicTranscript({ status: 'done', text: 'x' })).toEqual({ status: 'done', text: 'x' })
    expect(publicTranscript({ status: 'none', reason: 'busy' })).toEqual({ status: 'none', reason: 'busy' })
    expect(publicTranscript({ status: 'none' })).toBeUndefined()
    expect(publicTranscript({ status: 'erased', text: 'x' })).toBeUndefined()
  })
})

describe('transcriptionFromEnv and matrixFromEnv', () => {
  it('is off without LINTO_URL, and reads the bounds of the messages transcribed and their language', () => {
    expect(transcriptionFromEnv({}, true)).toBeUndefined()
    const t = transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', VOICEMAIL_MAX_SEC: '120' }, true)!
    expect([t.maxSec, t.queueMax, t.provider.id, t.lang]).toEqual([120, 100, 'linto', 'fr'])
    // A recording of 16 kHz is read whole; a bound under 10 s is not one.
    expect(transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', VOICEMAIL_TRANSCRIBE_MAX_SEC: '60', VOICEMAIL_TRANSCRIBE_QUEUE_MAX: '5', LINTO_LANGUAGE: 'fr-FR' }, true)).toMatchObject({ maxSec: 60, queueMax: 5, maxBytes: 60 * 48_000 + 65_536, lang: 'fr-FR' })
    expect(transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', VOICEMAIL_MAX_SEC: '5' }, true)!.maxSec).toBe(10)
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090' }, false)).toThrow(/voicemail server/)
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://u:p@127.0.0.1:8090' }, true)).toThrow(/LINTO_URL/)
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', VOICEMAIL_TRANSCRIBE_QUEUE_MAX: '0' }, true)).toThrow(/VOICEMAIL_TRANSCRIBE_QUEUE_MAX/)
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', LINTO_LANGUAGE: 'fr FR' }, true)).toThrow(/LINTO_LANGUAGE/)
  })

  it('takes the bot from its homeserver and its token only together, a template with {uid}, the link of the app, and whether the notices carry the text', () => {
    expect(matrixFromEnv({}, true)).toBeUndefined()
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test' }, true)).toThrow(/go together/)
    expect(() => matrixFromEnv({ MATRIX_BOT_TOKEN: TOKEN }, true)).toThrow(/go together/)
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN }, false)).toThrow(/voicemail server/)
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, MATRIX_USER_TEMPLATE: '@jean:chat.example.test' }, true)).toThrow(/\{uid\}/)
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, NOTICE_TIME_ZONE: 'Mars/Olympus' }, true)).toThrow(/NOTICE_TIME_ZONE/)
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, MATRIX_NOTICE_TEXT: 'no' }, true)).toThrow(/MATRIX_NOTICE_TEXT/)
    const n = matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, MATRIX_USER_TEMPLATE: '@{uid}:chat.example.test', CORS_ORIGINS: 'http://localhost:3000, https://phone.example.test/' }, true)!
    expect([n.userTemplate, n.appUrl, n.timeZone, n.withText]).toEqual(['@{uid}:chat.example.test', 'https://phone.example.test', 'Europe/Paris', true])
    expect(matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, MATRIX_NOTICE_TEXT: 'off' }, true)!.withText).toBe(false)
    expect(matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, APP_URL: 'https://app.example.test/phone/' }, true)!.appUrl).toBe('https://app.example.test/phone')
    expect(matrixIdFromTemplate('@{uid}:chat.example.test', 'JDupont')).toBe('@jdupont:chat.example.test')
    expect(matrixIdFromTemplate('@{uid}:chat.example.test', 'jean dupont')).toBeUndefined()
    expect(matrixIdFromTemplate(undefined, 'jean')).toBeUndefined()
  })
})
