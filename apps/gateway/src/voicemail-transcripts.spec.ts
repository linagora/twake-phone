import { describe, expect, it } from 'vitest'
import type { ProviderFactory, RoutedEvent, TelephonyProvider, TranscriptionProvider, VoicemailBox, VoicemailProvider } from '@twake/telephony-provider-sdk'
import type { TelephonyEvent, Voicemail } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { MatrixBot, MatrixError } from './matrix.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import type { FencedLease, Store } from './store/types.js'
import { voicemailRole } from './voicemail-lease.js'
import { TranscriptWatcher, matrixFromEnv, matrixIdFromTemplate, noticeContent, publicTranscript, transcriptionFromEnv } from './voicemail-transcripts.js'

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

const SERVER = 'chat.example.test'
const BOT = `@twakephone:${SERVER}`
const TOKEN = 'syt_not_a_real_token'

/**
 * A Matrix homeserver in memory, as Synapse answers the client-server API the bot uses: who it is, a room made (the bot
 * joined, the person invited), its members, a message sent once per transaction id, a message withdrawn (redacted).
 * `fail` makes the next requests fail with these statuses.
 */
const homeserver = () => {
  const rooms = new Map<string, { members: Map<string, string>; created: Record<string, unknown> }>()
  const events = new Map<string, { roomId: string; content: Record<string, unknown>; redacted: boolean }>()
  const txns = new Map<string, string>()
  const calls: string[] = []
  const failures: number[] = []
  let n = 0
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init.method ?? 'GET'
    const headers = (init.headers ?? {}) as Record<string, string>
    if (headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' })
    const parts = url.pathname.replace(/^\/_matrix\/client\/v3\//, '').split('/').map(decodeURIComponent)
    calls.push(`${method} ${parts[0] === 'rooms' ? parts[2] : parts.join('/')}`)
    const failure = failures.shift()
    if (failure) return answer(failure, failure === 429 ? { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 30 } : { errcode: 'M_UNKNOWN', error: 'an internal detail' })
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (parts.join('/') === 'account/whoami') return answer(200, { user_id: BOT })
    if (parts[0] === 'createRoom') {
      const roomId = `!room${++n}:${SERVER}`
      rooms.set(roomId, { members: new Map([[BOT, 'join'], ...(body.invite as string[]).map(u => [u, 'invite'] as [string, string])]), created: body })
      return answer(200, { room_id: roomId })
    }
    if (parts[0] === 'rooms') {
      const room = rooms.get(parts[1]!)
      if (!room || room.members.get(BOT) !== 'join') return answer(403, { errcode: 'M_FORBIDDEN', error: 'not in the room' })
      if (parts[2] === 'members') return answer(200, { chunk: [...room.members].map(([u, m]) => ({ type: 'm.room.member', state_key: u, content: { membership: m } })) })
      if (parts[2] === 'send') {
        const k = `${parts[1]}|${parts[4]}`
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
  }) as typeof globalThis.fetch
  /** The messages of the bot still readable, with their room's invited or joined people. */
  const notices = () => [...events.values()].filter(e => !e.redacted).map(e => ({ ...e, people: [...rooms.get(e.roomId)!.members].filter(([, m]) => m !== 'leave').map(([u]) => u) }))
  return { fetch, rooms, events, calls, fail: (...statuses: number[]) => void failures.push(...statuses), notices }
}

/** A voicemail server in memory: a mailbox per holder of an extension, its messages, their recordings, its events. */
const mailboxes = () => {
  const holders = new Map<string, string>()
  const messages = new Map<string, Voicemail[]>()
  let synced = 0
  let push: ((e: RoutedEvent) => void) | undefined
  const pending: RoutedEvent[] = []
  const mine = (o: { extension: string; userId: string }) => holders.get(o.extension) === o.userId
  const vm: VoicemailProvider = {
    id: 'fake-voicemail',
    getStatus: () => 'CONNECTED',
    probe: async () => {},
    async syncMailboxes(list, options = {}) {
      await options.beforeChanges?.([])
      if (!options.mayWrite?.()) throw new Error('stopped')
      for (const h of list) {
        if (holders.get(h.extension) !== h.userId) messages.set(h.extension, [])
        holders.set(h.extension, h.userId)
      }
      synced++
      return { boxes: list.map(h => ({ extension: h.extension, mailbox: `${h.userId}@ctx` })), failed: 0 }
    },
    mailboxIsOf: (mailbox, userId) => mailbox === `${userId}@ctx`,
    owns: async o => mine(o),
    listMessages: async o => (mine(o) ? [...(messages.get(o.extension) ?? [])] : []),
    getRecording: async (o, id) => {
      if (!mine(o) || !messages.get(o.extension)?.some(m => m.id === id)) return undefined
      const bytes = new TextEncoder().encode(`RIFF-audio-of-${id}`)
      return { contentType: 'audio/wav', size: bytes.length, body: (async function* () { yield bytes })() }
    },
    markRead: async () => true,
    async deleteMessage(o, id) {
      const list = mine(o) ? messages.get(o.extension) : undefined
      if (!list?.some(m => m.id === id)) return false
      messages.set(o.extension, list.filter(m => m.id !== id))
      return true
    },
    async eraseMessages(o, options = {}) {
      if (!options.mayWrite?.()) throw new Error('stopped')
      let n = 0
      for (const [ext, user] of holders) {
        if (user !== o.userId) continue
        n += messages.get(ext)?.length ?? 0
        messages.set(ext, [])
      }
      return n
    },
    async purgeMessages(before, options = {}) {
      if (!options.mayWrite?.()) throw new Error('stopped')
      let n = 0
      for (const [ext, list] of messages) {
        const kept = list.filter(m => Date.parse(m.receivedAt) >= before.getTime())
        n += list.length - kept.length
        messages.set(ext, kept)
      }
      return n
    },
    subscribe() {
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
  /** A caller leaves a message at `extension`: in its mailbox, then told (voicemail.created). */
  const leave = (extension: string, v: Voicemail) => {
    messages.get(extension)!.unshift(v)
    emit({ extension, event: { type: 'voicemail.created', timestamp: v.receivedAt, payload: { voicemail: v } } })
  }
  return { vm, holders, messages, emit, leave, synced: () => synced }
}

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
const SAID = 'Bonjour Jean, ici Alice, rappelez-moi demain matin.'

const setup = async (
  o: {
    store?: MemoryStore
    transcribe?: TranscriptionProvider['transcribe'] | false
    notices?: false
    maxSec?: number
    queueMax?: number
    matrixIdOf?: (tenantId: string, userId: string) => Promise<string | undefined>
    retentionDays?: number
    purgeMs?: number
    hub?: boolean
    logs?: string[]
  } = {}
) => {
  process.env.AUTH_MODE = 'dev'
  const store = o.store ?? new MemoryStore()
  await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101', displayName: 'Alice Martin' })
  await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '102', displayName: 'Jean Dupont' })
  await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '103', displayName: 'Bob Durand' })
  const boxes = mailboxes()
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
    ...(provider ? { transcription: { provider, maxSec: o.maxSec ?? 180, queueMax: o.queueMax ?? 100, maxBytes: 1_000_000 } } : {}),
    ...(o.notices === false
      ? {}
      : { notices: { bot: new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: hs.fetch }), userTemplate: `@{uid}:${SERVER}`, appUrl: 'https://phone.example.test', timeZone: 'Europe/Paris', ...(o.matrixIdOf ? { matrixIdOf: o.matrixIdOf } : {}) } }),
    transcriptRetryMs: [20, 20],
    noticeRetryMs: [20, 20],
    transcriptEveryMs: 20,
    transcriptWatchMs: 20,
    ...(o.hub ? { secretsKey: Buffer.alloc(32, 7), webhooks: { pollMs: 3_600_000, stateLeaseMs: 300, streamSettleMs: 0 }, trunkWatchMs: 0 } : {}),
    ...(o.logs ? { logStream: { write: (line: string) => void o.logs!.push(line) } } : {})
  })
  await app.ready()
  registry.startAll()
  await until('the mailboxes', () => boxes.synced() > 0)
  const as = (user: string) => ({ 'x-dev-user': user, 'x-dev-tenant': 'A' })
  const heard = (user: string) => {
    const got: TelephonyEvent[] = []
    bus.subscribe('A', user, e => void got.push(e))
    return got
  }
  const transcriptOf = async (user: string, id: string) => (await app.inject({ url: '/api/v1/voicemails', headers: as(user) })).json<{ items: Voicemail[] }>().items.find(v => v.id === id)?.transcript
  return { app, store, boxes, hs, as, heard, heardAudio, transcriptOf }
}

describe('the transcription of the messages and the notices in Chat (step 11b)', () => {
  it("transcribes a new message once, shows it to its holder only, and the bot tells them in a room of their own, nobody else", async () => {
    const { app, boxes, hs, as, heard, heardAudio, transcriptOf } = await setup()
    const jean = heard('jean')
    const bob = heard('bob')
    const alice = heard('alice')
    boxes.leave('102', message('m1'))
    // At once: the message, its transcription on its way.
    await until('the message', () => jean.length >= 1)
    expect(jean[0]).toMatchObject({ type: 'voicemail.created', payload: { voicemail: { id: 'm1', transcript: { status: 'pending' } } } })
    await until('the transcription', () => jean.some(e => e.type === 'voicemail.transcribed'))
    expect(jean.find(e => e.type === 'voicemail.transcribed')).toMatchObject({ payload: { id: 'm1', transcript: { status: 'done', text: SAID } } })
    expect(heardAudio).toEqual(['RIFF-audio-of-m1'])
    expect(await transcriptOf('jean', 'm1')).toEqual({ status: 'done', text: SAID })
    await until('the notice', () => hs.notices().length === 1)
    const [notice] = hs.notices()
    expect(notice!.people.sort()).toEqual([BOT, `@jean:${SERVER}`].sort())
    expect(notice!.content).toMatchObject({ msgtype: 'm.notice', format: 'org.matrix.custom.html' })
    const body = String(notice!.content.body)
    expect(body).toContain('Alice Martin (0612345678)')
    expect(body).toContain('durée 0:12')
    expect(body).toContain(`« ${SAID} »`)
    expect(body).toContain('https://phone.example.test/voicemail')
    // A private room the bot alone may invite to, history from the invitation on, never encrypted.
    const room = [...hs.rooms.values()][0]!.created
    expect(room).toMatchObject({ preset: 'private_chat', is_direct: true, invite: [`@jean:${SERVER}`], power_level_content_override: { invite: 100 } })
    // The creator is never named in the power levels: a homeserver refuses it for a room of version 12.
    expect((room as { power_level_content_override: Record<string, unknown> }).power_level_content_override).not.toHaveProperty('users')
    expect(JSON.stringify(room)).not.toContain('m.room.encryption')
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
    expect(String(hs.notices()[1]!.content.body)).toContain('un numéro masqué')
    expect((await app.inject({ url: '/api/v1/capabilities', headers: as('jean') })).json()).toMatchObject({ voicemail: true, voicemailTranscription: true })
    await app.close()
  })

  it('erases the transcription of a message deleted and withdraws its notice, whoever deleted it', async () => {
    const { app, store, boxes, hs, as } = await setup()
    boxes.leave('102', message('m1'))
    boxes.leave('102', message('m2'))
    await until('the notices', () => hs.notices().length === 2)
    // From the app.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/voicemails/m1', headers: as('jean') })).statusCode).toBe(204)
    await until('m1 withdrawn', () => hs.notices().length === 1)
    expect((await store.listTranscripts('A', 'jean')).map(t => t.messageId)).toEqual(['m2'])
    // From a phone (the voicemail server tells it).
    boxes.messages.set('102', [])
    boxes.emit({ extension: '102', event: { type: 'voicemail.deleted', timestamp: new Date().toISOString(), payload: { id: 'm2' } } })
    await until('m2 withdrawn', () => hs.notices().length === 0)
    await until('no transcription left', async () => !(await store.dueTranscripts('A', 10)).length && !(await store.listTranscripts('A', 'jean')).length)
    expect(hs.calls.filter(c => c === 'PUT redact')).toHaveLength(2)
    await app.close()
  })

  it("erases a person's transcriptions with their messages (their right to erasure), withdraws the bot's notices and forgets their room", async () => {
    const { app, store, boxes, hs, as } = await setup()
    boxes.leave('102', message('m1'))
    boxes.leave('103', message('m3'))
    await until('the notices', () => hs.notices().length === 2)
    expect(await store.getOperatorState('A', 'matrix:room:jean')).toMatchObject({ matrixId: `@jean:${SERVER}` })
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })
    expect(res.json()).toMatchObject({ voicemailErasure: 'asked' })
    await until("Jean's notice withdrawn", () => hs.notices().length === 1)
    expect(hs.notices()[0]!.people).toContain(`@bob:${SERVER}`)
    await until('his transcriptions gone', async () => !(await store.listTranscripts('A', 'jean')).length && !(await store.dueTranscripts('A', 10)).length)
    expect(await store.getOperatorState('A', 'matrix:room:jean')).toBeUndefined()
    expect(await store.listTranscripts('A', 'bob')).toHaveLength(1)
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
    expect(String(hs.notices()[0]!.content.body)).not.toContain('2026-09')
    await until('its transcription gone', async () => (await store.listTranscripts('A', 'jean')).map(t => t.messageId).join() === 'm-new')
    await app.close()
  })

  it('writes nothing from a Gateway that lost the lease of the mailboxes, not even a transcription it finished', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    const { app, store, boxes, hs, transcriptOf } = await setup({
      transcribe: async () => {
        await gate
        return { text: SAID }
      }
    })
    boxes.leave('102', message('m1'))
    await until('the transcription asked', async () => (await store.listTranscripts('A', 'jean')).length === 1)
    // Another Gateway takes the lease meanwhile.
    await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 60_000, 99)
    await sleep(400)
    open()
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

  it('transcribes no message longer than the bound, nor past the messages waiting allowed, says why, and tells the administrators once', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    const { app, store, boxes, hs, heard, heardAudio, transcriptOf } = await setup({
      maxSec: 60,
      queueMax: 1,
      transcribe: async () => {
        await gate
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
    open()
    await until('m1 done', async () => (await transcriptOf('jean', 'm1'))?.status === 'done')
    expect(heardAudio).toEqual(['RIFF-audio-of-m1'])
    await until('every notice', () => hs.notices().length === 4)
    await app.close()
  })

  it('tries a transcription that fails twice more, then says it failed, tells the administrators, and still sends the notice', async () => {
    let tries = 0
    const { app, store, boxes, hs, transcriptOf } = await (async () => {
      const lines: string[] = []
      const s = await setup({
        logs: lines,
        transcribe: async () => {
          tries++
          throw new Error('LinTO answered 500')
        }
      })
      return { ...s, logs: lines }
    })()
    boxes.leave('102', message('m1'))
    await until('given up', async () => (await transcriptOf('jean', 'm1'))?.status === 'none')
    expect(tries).toBe(3)
    expect(await transcriptOf('jean', 'm1')).toEqual({ status: 'none', reason: 'failed' })
    expect((await store.listAlerts('A', {})).map(a => a.alert.param)).toContain('transcription-failed')
    await until('the notice', () => hs.notices().length === 1)
    expect(String(hs.notices()[0]!.content.body)).toContain("n'a pas pu le transcrire")
    await app.close()
  })

  it('sends a notice again after a failure of the homeserver, once (its transaction id), and gives up past its tries with an alert', async () => {
    const { app, store, boxes, hs } = await setup()
    hs.fail(500, 429)
    boxes.leave('102', message('m1'))
    await until('the notice', () => hs.notices().length === 1)
    expect(hs.events.size).toBe(1)
    // A homeserver that keeps refusing: given up after its tries (three here), told to the administrators.
    hs.fail(500, 500, 500, 500, 500, 500, 500, 500)
    boxes.leave('102', message('m2'))
    await until('given up', async () => (await store.listTranscripts('A', 'jean', ['m2']))[0]?.notice === 'none')
    expect((await store.listAlerts('A', {})).map(a => a.alert.param)).toContain('notice-failed')
    expect(hs.events.size).toBe(1)
    await app.close()
  })

  it("sends no notice to an account on another server than the bot's, nor to someone the directory and the template give none", async () => {
    const ids: Record<string, string> = { jean: '@jean:elsewhere.example.net' }
    const { app, store, boxes, hs, transcriptOf } = await setup({ matrixIdOf: async (_t, userId) => ids[userId] })
    boxes.leave('102', message('m1'))
    await until('transcribed', async () => (await transcriptOf('jean', 'm1'))?.status === 'done')
    await until('no notice', async () => (await store.listTranscripts('A', 'jean', ['m1']))[0]?.notice === 'none')
    expect(hs.calls.filter(c => c !== 'GET account/whoami')).toEqual([])
    await app.close()
    // The directory's word first: Bob's own account, not the template's.
    const second = await setup({ matrixIdOf: async (_t, userId) => (userId === 'bob' ? `@bob.durand:${SERVER}` : undefined) })
    second.boxes.leave('103', message('m3'))
    await until('the notice', () => second.hs.notices().length === 1)
    expect(second.hs.notices()[0]!.people).toContain(`@bob.durand:${SERVER}`)
    await second.app.close()
  })

  it('writes in a new room once the person left the one the bot kept, or someone else got in it', async () => {
    const { app, boxes, hs } = await setup()
    boxes.leave('102', message('m1'))
    await until('the notice', () => hs.notices().length === 1)
    const [first] = [...hs.rooms.keys()]
    hs.rooms.get(first!)!.members.set(`@jean:${SERVER}`, 'leave')
    boxes.leave('102', message('m2'))
    await until('the second notice', () => hs.notices().length === 2)
    expect(hs.rooms.size).toBe(2)
    const [, second] = [...hs.rooms.keys()]
    hs.rooms.get(second!)!.members.set(`@eve:${SERVER}`, 'join')
    boxes.leave('102', message('m3'))
    await until('the third notice', () => hs.notices().length === 3)
    expect(hs.rooms.size).toBe(3)
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
      await until('transcribed', () => logs.some(l => l.includes('elsewhere') || l.includes("not on the bot's server")))
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
    expect(told).toEqual(['jean voicemail.transcribed {"id":"m1","transcript":{"status":"done","text":"texte m1"}}', 'jean voicemail.transcribed {"id":"m4","transcript":{"status":"none","reason":"failed"}}'])
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
  })

  it('refuses an answer too large, and one that is not JSON', async () => {
    const big = (async () => new Response('{"chunk":[' + '{},'.repeat(100_000) + '{}]}', { status: 200 })) as unknown as typeof globalThis.fetch
    await expect(new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: big }).members('!r:x')).rejects.toThrow(/too large/)
    const html = (async () => new Response('<html>oops</html>', { status: 502 })) as unknown as typeof globalThis.fetch
    await expect(new MatrixBot({ homeserverUrl: `https://${SERVER}`, token: TOKEN, fetch: html }).whoami()).rejects.toThrow(/unreadable answer \(502\)/)
  })
})

describe('the notice of a message', () => {
  it('says who called, when in the time zone given, how long, what they said, and links to the Messagerie vocale; escaped in HTML', () => {
    const v = message('m1', { fromName: 'Alice <b>&</b>', from: '0612345678', receivedAt: '2026-10-18T08:05:00.000Z', durationSec: 75 })
    const c = noticeContent(v, { status: 'done', text: 'Rappelle <moi>' }, { appUrl: 'https://phone.example.test', timeZone: 'Europe/Paris' })
    expect(c.body).toBe('Nouveau message vocal de Alice <b>&</b> (0612345678), le 18 octobre 2026 à 10:05, durée 1:15.\nTranscription : « Rappelle <moi> »\nÉcouter dans TwakePhone : https://phone.example.test/voicemail')
    expect(c.formatted_body).toContain('Alice &lt;b&gt;&amp;&lt;/b&gt;')
    expect(c.formatted_body).toContain('<blockquote>Rappelle &lt;moi&gt;</blockquote>')
    expect(c.formatted_body).not.toContain('<moi>')
    expect(noticeContent(v, { status: 'done', text: '' }, { timeZone: 'UTC' }).body).toBe('Nouveau message vocal de Alice <b>&</b> (0612345678), le 18 octobre 2026 à 08:05, durée 1:15.\nTranscription : aucune parole reconnue.')
    expect(noticeContent(message('m2', { from: undefined, fromName: undefined }), { status: 'none' }, { timeZone: 'UTC' }).body).toMatch(/^Nouveau message vocal de un numéro masqué,/)
  })

  it('shows the screens a transcription as it is, nothing of one erased or never made', () => {
    expect(publicTranscript({ status: 'pending' })).toEqual({ status: 'pending' })
    expect(publicTranscript({ status: 'done', text: 'x' })).toEqual({ status: 'done', text: 'x' })
    expect(publicTranscript({ status: 'none', reason: 'busy' })).toEqual({ status: 'none', reason: 'busy' })
    expect(publicTranscript({ status: 'none' })).toBeUndefined()
    expect(publicTranscript({ status: 'erased', text: 'x' })).toBeUndefined()
  })
})

describe('transcriptionFromEnv and matrixFromEnv', () => {
  it('is off without LINTO_URL, and reads the bounds of the messages transcribed', () => {
    expect(transcriptionFromEnv({}, true)).toBeUndefined()
    const t = transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', VOICEMAIL_MAX_SEC: '120' }, true)!
    expect([t.maxSec, t.queueMax, t.provider.id]).toEqual([120, 100, 'linto'])
    expect(transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', VOICEMAIL_TRANSCRIBE_MAX_SEC: '60', VOICEMAIL_TRANSCRIBE_QUEUE_MAX: '5' }, true)).toMatchObject({ maxSec: 60, queueMax: 5, maxBytes: 60 * 24_000 + 65_536 })
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090' }, false)).toThrow(/voicemail server/)
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://u:p@127.0.0.1:8090' }, true)).toThrow(/LINTO_URL/)
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', VOICEMAIL_TRANSCRIBE_QUEUE_MAX: '0' }, true)).toThrow(/VOICEMAIL_TRANSCRIBE_QUEUE_MAX/)
    expect(() => transcriptionFromEnv({ LINTO_URL: 'http://127.0.0.1:8090', LINTO_LANGUAGE: 'fr FR' }, true)).toThrow(/LINTO_LANGUAGE/)
  })

  it('takes the bot from its homeserver and its token only together, a template with {uid}, and the link of the app', () => {
    expect(matrixFromEnv({}, true)).toBeUndefined()
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test' }, true)).toThrow(/go together/)
    expect(() => matrixFromEnv({ MATRIX_BOT_TOKEN: TOKEN }, true)).toThrow(/go together/)
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN }, false)).toThrow(/voicemail server/)
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, MATRIX_USER_TEMPLATE: '@jean:chat.example.test' }, true)).toThrow(/\{uid\}/)
    expect(() => matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, NOTICE_TIME_ZONE: 'Mars/Olympus' }, true)).toThrow(/NOTICE_TIME_ZONE/)
    const n = matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, MATRIX_USER_TEMPLATE: '@{uid}:chat.example.test', CORS_ORIGINS: 'http://localhost:3000, https://phone.example.test/' }, true)!
    expect([n.userTemplate, n.appUrl, n.timeZone]).toEqual(['@{uid}:chat.example.test', 'https://phone.example.test', 'Europe/Paris'])
    expect(matrixFromEnv({ MATRIX_HOMESERVER_URL: 'https://chat.example.test', MATRIX_BOT_TOKEN: TOKEN, APP_URL: 'https://app.example.test/phone/' }, true)!.appUrl).toBe('https://app.example.test/phone')
    expect(matrixIdFromTemplate('@{uid}:chat.example.test', 'JDupont')).toBe('@jdupont:chat.example.test')
    expect(matrixIdFromTemplate('@{uid}:chat.example.test', 'jean dupont')).toBeUndefined()
    expect(matrixIdFromTemplate(undefined, 'jean')).toBeUndefined()
  })
})
