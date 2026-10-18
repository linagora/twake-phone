import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MESSAGE_ID, WazoVoicemail, holderKey as keyedWith, voicemailOf, type Fetch, type WebSocketLike } from './index.js'

/** The key of the prints of the holders, as the Gateway derives it from SECRETS_KEY (a fake one). */
const SECRET = Buffer.alloc(32, 7)
const holderKey = (userId: string) => keyedWith(SECRET, userId)
const DAY = 86_400_000

// A Wazo as its APIs answered on the Docker stack (wazo 26.10: wazo-auth, wazo-confd, wazo-calld, wazo-websocketd),
// trimmed to what this package reads, in memory.
const CONTEXT = 'ctx-None-internal-210d0144-9bcc-45c1-b36b-317577cedc2f'
const folderTypes = [
  { id: 1, type: 'new', name: 'inbox' },
  { id: 2, type: 'old', name: 'old' },
  { id: 3, type: 'urgent', name: 'urgent' },
  { id: 4, type: 'other', name: 'work' }
]

const fakeWazo = () => {
  const state = {
    contexts: [] as { id: number; name: string; label: string; type: string }[],
    users: [] as { uuid: string; firstname: string; userfield: string | null; voicemail: { id: number } | null }[],
    voicemails: [] as { id: number; number: string; context: string; name: string; max_messages: number | null; options: [string, string][]; users: { uuid: string }[] }[],
    messages: new Map<number, { id: string; folder: number; caller_id_num: string | null; caller_id_name: string | null; timestamp: number; duration: number }[]>(),
    tokens: 0,
    expired: new Set<string>(),
    requests: [] as string[],
    down: false,
    /** A recording sent without its length (chunked). */
    noLength: false
  }
  let next = 1
  const json = (status: number, body?: unknown) => ({ status, headers: { get: (n: string) => (n === 'content-type' ? 'application/json' : null) }, json: async () => body, text: async () => JSON.stringify(body ?? ''), body: null })
  const fetch: Fetch = async (url, init) => {
    if (state.down) throw new TypeError('fetch failed')
    const u = new URL(url)
    const path = u.pathname
    state.requests.push(`${init.method} ${path}`)
    const body = init.body ? JSON.parse(init.body) : undefined
    if (path === '/0.1/token') {
      if (init.headers.authorization !== `Basic ${Buffer.from('twakephone:not-a-real-password').toString('base64')}`) return json(401)
      expect(typeof body.expiration).toBe('number')
      return json(200, { data: { token: `tok-${++state.tokens}` } })
    }
    const token = init.headers['x-auth-token']
    if (!token?.startsWith('tok-') || state.expired.has(token)) return json(401)
    const page = <T>(items: T[]) => json(200, { total: items.length, items: items.slice(Number(u.searchParams.get('offset') ?? 0), Number(u.searchParams.get('offset') ?? 0) + Number(u.searchParams.get('limit') ?? 1000)) })
    let m: RegExpExecArray | null
    if (path === '/1.1/contexts' && init.method === 'GET') return page(state.contexts)
    if (path === '/1.1/contexts' && init.method === 'POST') {
      const c = { id: next++, name: CONTEXT, label: body.label, type: body.type }
      state.contexts.push(c)
      return json(201, c)
    }
    if (path === '/1.1/users' && init.method === 'GET') return page(state.users)
    if (path === '/1.1/users' && init.method === 'POST') {
      const user = { uuid: `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`, firstname: body.firstname, userfield: body.userfield ?? null, voicemail: null }
      state.users.push(user)
      return json(201, user)
    }
    if ((m = /^\/1\.1\/users\/([^/]+)$/.exec(path)) && init.method === 'GET') {
      const user = state.users.find(x => x.uuid === m![1])
      return user ? json(200, user) : json(404, ['Resource Not Found'])
    }
    if ((m = /^\/1\.1\/users\/([^/]+)$/.exec(path)) && init.method === 'DELETE') {
      state.users = state.users.filter(x => x.uuid !== m![1])
      return json(204)
    }
    if ((m = /^\/1\.1\/users\/([^/]+)\/voicemails\/(\d+)$/.exec(path)) && init.method === 'PUT') {
      const user = state.users.find(x => x.uuid === m![1])!
      user.voicemail = { id: Number(m[2]) }
      state.voicemails.find(v => v.id === Number(m![2]))!.users.push({ uuid: user.uuid })
      return json(204)
    }
    if ((m = /^\/1\.1\/users\/([^/]+)\/voicemails$/.exec(path)) && init.method === 'DELETE') {
      const user = state.users.find(x => x.uuid === m![1])!
      for (const v of state.voicemails) v.users = v.users.filter(x => x.uuid !== user.uuid)
      user.voicemail = null
      return json(204)
    }
    if (path === '/1.1/voicemails' && init.method === 'GET') {
      const search = u.searchParams.get('search')
      return page(state.voicemails.filter(v => !search || v.number.includes(search)))
    }
    if (path === '/1.1/voicemails' && init.method === 'POST') {
      if (state.voicemails.some(v => v.number === body.number && v.context === body.context)) return json(400, ['Resource Error - Voicemail already exists'])
      const vm = { id: next++, number: body.number, context: body.context, name: body.name, max_messages: body.max_messages ?? null, options: body.options ?? [], users: [] }
      state.voicemails.push(vm)
      state.messages.set(vm.id, [])
      return json(201, vm)
    }
    if ((m = /^\/1\.1\/voicemails\/(\d+)$/.exec(path)) && init.method === 'PUT') {
      // Another number: Wazo moves the messages with the mailbox (wazo-sysconfd), its id stays.
      const vm = state.voicemails.find(v => v.id === Number(m![1]))
      if (!vm) return json(404, ['Resource Not Found'])
      if (state.voicemails.some(v => v !== vm && v.number === body.number && v.context === body.context)) return json(400, ['Resource Error - Voicemail already exists'])
      Object.assign(vm, { number: body.number, context: body.context, name: body.name, max_messages: body.max_messages ?? null, options: body.options ?? [] })
      return json(204)
    }
    if ((m = /^\/1\.1\/voicemails\/(\d+)$/.exec(path)) && init.method === 'DELETE') {
      const vm = state.voicemails.find(v => v.id === Number(m![1]))!
      if (vm.users.length) return json(400, ['Resource Error - Voicemail is associated with a User'])
      state.voicemails = state.voicemails.filter(v => v !== vm)
      state.messages.delete(vm.id)
      return json(204)
    }
    if ((m = /^\/1\.0\/voicemails\/(\d+)$/.exec(path))) {
      const msgs = state.messages.get(Number(m[1]))
      if (!msgs) return json(404, { message: 'No such voicemail' })
      return json(200, { id: Number(m[1]), folders: folderTypes.map(f => ({ ...f, messages: msgs.filter(x => x.folder === f.id).map(({ folder: _, ...x }) => ({ ...x, empty: false, transcription: null })) })) })
    }
    if ((m = /^\/1\.0\/voicemails\/(\d+)\/messages\/([^/]+)(\/recording)?$/.exec(path))) {
      const msgs = state.messages.get(Number(m[1]))
      const msg = msgs?.find(x => x.id === m![2])
      if (!msgs || !msg) return json(404, { message: 'No such message' })
      if (m[3]) {
        const bytes = new TextEncoder().encode(`RIFF${msg.id}`)
        // Sent in two pieces, as a stream.
        const body = (async function* () {
          yield bytes.slice(0, 4)
          yield bytes.slice(4)
        })()
        return { status: 200, headers: { get: (n: string) => (n === 'content-type' ? 'audio/wav' : n === 'content-length' && !state.noLength ? String(bytes.length) : null) }, json: async () => ({}), text: async () => '', body }
      }
      if (init.method === 'PUT') {
        msg.folder = body.folder_id
        return json(204)
      }
      if (init.method === 'DELETE') {
        state.messages.set(Number(m[1]), msgs.filter(x => x !== msg))
        return json(204)
      }
    }
    return json(404, { path })
  }
  return { state, fetch }
}

/** wazo-websocketd as it spoke on the Docker stack: init, then the subscriptions and start, then the events. */
const fakeSockets = () => {
  const sockets: (WebSocketLike & { url: string; sent: unknown[]; event(name: string, data: unknown): void; drop(code?: number): void })[] = []
  const open = (url: string) => {
    const ws = {
      url,
      sent: [] as unknown[],
      onopen: null,
      onmessage: null as WebSocketLike['onmessage'],
      onclose: null as WebSocketLike['onclose'],
      onerror: null,
      send(data: string) {
        const msg = JSON.parse(data)
        ws.sent.push(msg)
        if (msg.op === 'start') queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ op: 'start', code: 0, data: { message: 'success' } }) }))
      },
      close() {
        ws.onclose?.({ code: 1000 })
      },
      event(name: string, data: unknown) {
        ws.onmessage?.({ data: JSON.stringify({ op: 'event', code: 0, data: { name, tenant_uuid: 'ignored', required_acl: 'events.users.x.voicemails', data } }) })
      },
      drop(code = 1006) {
        ws.onclose?.({ code })
      }
    }
    sockets.push(ws)
    queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ op: 'init', code: 0, data: { version: 2 } }) }))
    return ws
  }
  return { sockets, open }
}

const make = (over: Partial<ConstructorParameters<typeof WazoVoicemail>[0]> = {}) => {
  const wazo = fakeWazo()
  const ws = fakeSockets()
  const logs: string[] = []
  const vm = new WazoVoicemail({
    authUrl: 'http://wazo.test:9497/0.1',
    confdUrl: 'http://wazo.test:9486/1.1',
    calldUrl: 'http://wazo.test:9500/1.0',
    websocketdUrl: 'ws://wazo.test:9502/',
    username: 'twakephone',
    password: 'not-a-real-password',
    holderSecret: SECRET,
    fetch: wazo.fetch,
    webSocket: ws.open,
    reconnectMs: [5],
    logger: { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) },
    ...over
  })
  return { vm, wazo, ws, logs }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
/** The bytes of a recording, read as the Gateway sends them on. */
const read = async (body: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = []
  for await (const part of body) parts.push(part)
  return new TextDecoder().decode(Buffer.concat(parts))
}
/** A clock the test moves. */
const clock = (start = Date.parse('2026-10-18T10:00:00.000Z')) => {
  const c = { at: start, now: () => c.at }
  return c
}
const jean = { extension: '102', userId: 'jean' }
const alice = { extension: '103', userId: 'alice' }

describe('WazoVoicemail, the mailboxes', () => {
  it('makes one mailbox per extension in a context of its own, for a user that stands for its holder, and keeps it at the next sync', async () => {
    const { vm, wazo } = make()
    expect(vm.getStatus()).toBe('DISCONNECTED')
    const boxes = await vm.syncMailboxes([
      { extension: '102', userId: 'jean', displayName: 'Jean Dupont' },
      { extension: '103', userId: 'alice' },
      // Not a number Asterisk's mailboxes take: left out.
      { extension: 'alice.b', userId: 'bob' }
    ])
    expect(boxes).toEqual([
      { extension: '102', mailbox: `102@${CONTEXT}` },
      { extension: '103', mailbox: `103@${CONTEXT}` }
    ])
    expect(vm.getStatus()).toBe('CONNECTED')
    expect(wazo.state.contexts).toMatchObject([{ label: 'TwakePhone', type: 'internal' }])
    expect(wazo.state.users.map(u => [u.firstname, u.userfield])).toEqual([
      ['Jean Dupont', holderKey('jean')],
      ['103', holderKey('alice')]
    ])
    // Nothing of the person's id in Wazo: a print of it keyed with a key Wazo never has (review 11a, n°9), not the plain
    // hash that trying the directory's ids gives back.
    expect(holderKey('jean')).toMatch(/^twakephone:[0-9a-f]{40}$/)
    expect(holderKey('jean')).not.toBe(keyedWith(Buffer.alloc(32, 8), 'jean'))
    expect(holderKey('jean')).not.toContain(createHash('sha256').update('jean').digest('hex').slice(0, 40))
    expect(JSON.stringify(wazo.state)).not.toContain('"jean"')
    // Each mailbox has its bounds (review 11a, n°3): 50 messages, 3 minutes each, 10 s of silence end one.
    expect(wazo.state.voicemails.map(v => [v.max_messages, v.options])).toEqual([
      [50, [['maxsecs', '180'], ['maxsilence', '10']]],
      [50, [['maxsecs', '180'], ['maxsilence', '10']]]
    ])
    expect(wazo.state.voicemails.map(v => [v.number, v.context, v.users.length])).toEqual([
      ['102', CONTEXT, 1],
      ['103', CONTEXT, 1]
    ])
    // Again: nothing made, nothing removed.
    const before = wazo.state.requests.length
    expect(await vm.syncMailboxes([{ extension: '103', userId: 'alice' }, { extension: '102', userId: 'jean', displayName: 'Jean Dupont' }])).toEqual(boxes)
    expect(wazo.state.requests.slice(before).filter(r => !r.startsWith('GET'))).toEqual([])
  })

  it("sets aside the mailbox of an extension given to someone else, with its messages, and gives the new holder a new one: nobody hears another's messages", async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now })
    await vm.syncMailboxes([
      { extension: '102', userId: 'jean' },
      { extension: '103', userId: 'alice' }
    ])
    const jeans = wazo.state.voicemails.find(v => v.number === '102')!
    wazo.state.messages.get(jeans.id)!.push({ id: '1792289524-00000004', folder: 1, caller_id_num: '101', caller_id_name: 'Alice', timestamp: 1792289524, duration: 7 })
    expect(await vm.listMessages(jean)).toHaveLength(1)
    // 102 goes to Marie: until the next sync, her Gateway already says so, the mailbox is still Jean's, and not hers.
    const marie = { extension: '102', userId: 'marie' }
    expect(await vm.owns(marie)).toBe(false)
    expect(await vm.listMessages(marie)).toEqual([])
    expect(await vm.getRecording(marie, '1792289524-00000004')).toBeUndefined()
    expect(await vm.markRead(marie, '1792289524-00000004')).toBe(false)
    expect(await vm.deleteMessage(marie, '1792289524-00000004')).toBe(false)
    expect(await vm.owns(jean)).toBe(true)
    // Then the sync; Alice leaves. Their mailboxes are set aside (review 11a, n°2): renumbered out of the extensions
    // (no extension starts with 0: no call reaches them), their messages kept, nobody's here.
    await vm.syncMailboxes([marie])
    const parked = (id: number) => wazo.state.voicemails.find(v => v.id === id)!.number
    expect(parked(jeans.id)).toBe(`0000${Math.floor(time.at / 1000)}${String(jeans.id).padStart(10, '0')}`)
    expect(wazo.state.voicemails.filter(v => !v.number.startsWith('0000')).map(v => v.number)).toEqual(['102'])
    const maries = wazo.state.voicemails.find(v => v.number === '102')!
    expect(maries.id).not.toBe(jeans.id)
    expect(wazo.state.messages.get(jeans.id)).toHaveLength(1)
    expect(await vm.listMessages(marie)).toEqual([])
    expect(await vm.owns(marie)).toBe(true)
    expect(await vm.owns(jean)).toBe(false)
    expect(await vm.listMessages(jean)).toEqual([])
    expect(await vm.listMessages(alice)).toEqual([])
    expect(await vm.owns({ extension: parked(jeans.id), userId: 'jean' })).toBe(false)
    // Within the grace period, nothing more goes; past it, the mailboxes aside go with their messages and users.
    time.at += 7 * DAY - 1000
    await vm.syncMailboxes([marie])
    expect(wazo.state.messages.get(jeans.id)).toHaveLength(1)
    time.at += 1000
    await vm.syncMailboxes([marie])
    expect(wazo.state.voicemails.map(v => v.number)).toEqual(['102'])
    expect(wazo.state.messages.has(jeans.id)).toBe(false)
    expect(wazo.state.users.map(u => u.userfield)).toEqual([holderKey('marie')])
  })

  it('moves a mailbox with its messages when its holder takes another extension, and swaps two (review 11a, n°2)', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([jean, alice])
    const jeans = wazo.state.voicemails.find(v => v.number === '102')!
    const alices = wazo.state.voicemails.find(v => v.number === '103')!
    wazo.state.messages.get(jeans.id)!.push({ id: '1-1', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1, duration: 3 })
    wazo.state.messages.get(alices.id)!.push({ id: '2-2', folder: 1, caller_id_num: '104', caller_id_name: null, timestamp: 2, duration: 4 })
    // Jean takes 104: his mailbox goes there, messages and all, the same one.
    expect(await vm.syncMailboxes([{ extension: '104', userId: 'jean' }, alice])).toEqual([
      { extension: '103', mailbox: `103@${CONTEXT}` },
      { extension: '104', mailbox: `104@${CONTEXT}` }
    ])
    expect(jeans.number).toBe('104')
    expect((await vm.listMessages({ extension: '104', userId: 'jean' })).map(m => m.id)).toEqual(['1-1'])
    expect(await vm.listMessages(jean)).toEqual([])
    // Jean and Alice swap: each one's messages follow them.
    await vm.syncMailboxes([
      { extension: '103', userId: 'jean' },
      { extension: '104', userId: 'alice' }
    ])
    expect([jeans.number, alices.number]).toEqual(['103', '104'])
    expect((await vm.listMessages({ extension: '103', userId: 'jean' })).map(m => m.id)).toEqual(['1-1'])
    expect((await vm.listMessages({ extension: '104', userId: 'alice' })).map(m => m.id)).toEqual(['2-2'])
    expect(await vm.listMessages({ extension: '103', userId: 'alice' })).toEqual([])
    expect(wazo.state.voicemails).toHaveLength(2)
    expect(wazo.state.users).toHaveLength(2)
  })

  it('gives back the mailbox set aside to its holder who comes back within the grace period, at whatever extension', async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now })
    await vm.syncMailboxes([jean, alice])
    const jeans = wazo.state.voicemails.find(v => v.number === '102')!
    wazo.state.messages.get(jeans.id)!.push({ id: '1-1', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1, duration: 3 })
    await vm.syncMailboxes([alice])
    expect(jeans.number).toMatch(/^0000/)
    time.at += 3 * DAY
    await vm.syncMailboxes([alice, { extension: '106', userId: 'jean', displayName: 'Jean Dupont' }])
    expect([jeans.number, jeans.name]).toEqual(['106', 'Jean Dupont'])
    expect((await vm.listMessages({ extension: '106', userId: 'jean' })).map(m => m.id)).toEqual(['1-1'])
  })

  it('removes none of the mailboxes past their grace period when more than half of them would go at once, and says so', async () => {
    const time = clock()
    const { vm, wazo, logs } = make({ now: time.now })
    const four = ['102', '103', '104', '105'].map((extension, i) => ({ extension, userId: `u${i}` }))
    await vm.syncMailboxes(four)
    // A directory that came back empty: set aside, never removed while it lasts.
    await vm.syncMailboxes([])
    time.at += 8 * DAY
    await vm.syncMailboxes([])
    expect(wazo.state.voicemails).toHaveLength(4)
    expect(logs.some(l => /4 of 4 mailboxes .* none removed/.test(l))).toBe(true)
    // It came back: each one has theirs again. Then one leaves for good.
    await vm.syncMailboxes(four)
    expect(wazo.state.voicemails.map(v => v.number).sort()).toEqual(['102', '103', '104', '105'])
    await vm.syncMailboxes(four.slice(1))
    time.at += 8 * DAY
    await vm.syncMailboxes(four.slice(1))
    expect(wazo.state.voicemails.map(v => v.number).sort()).toEqual(['103', '104', '105'])
  })

  it('sets the bounds of a mailbox again when they changed in Wazo, and takes them from its configuration', async () => {
    const { vm, wazo } = make({ maxMessages: 20, maxMessageSec: 120, maxSilenceSec: 5 })
    await vm.syncMailboxes([jean])
    const box = wazo.state.voicemails[0]!
    expect([box.max_messages, box.options]).toEqual([20, [['maxsecs', '120'], ['maxsilence', '5']]])
    box.max_messages = null
    box.options = []
    await vm.syncMailboxes([jean])
    expect([box.max_messages, box.options]).toEqual([20, [['maxsecs', '120'], ['maxsilence', '5']]])
    expect(() => make({ maxMessages: 0 })).toThrow(/maxMessages/)
    expect(() => make({ holderSecret: Buffer.alloc(8) })).toThrow(/holderSecret/)
  })

  it("leaves Wazo's own users alone, and sets aside a mailbox of the context made by hand at an extension", async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now })
    await vm.syncMailboxes([])
    // A user made in Wazo by hand, with a mailbox in the context of the platform.
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', firstname: 'Admin', userfield: null, voicemail: { id: 900 } })
    wazo.state.voicemails.push({ id: 900, number: '102', context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000001' }] })
    wazo.state.messages.set(900, [])
    await vm.syncMailboxes([{ extension: '102', userId: 'jean' }])
    expect(wazo.state.users.map(u => [u.firstname, u.voicemail !== null])).toEqual([
      ['Admin', true],
      ['102', true]
    ])
    expect(wazo.state.voicemails.find(v => v.id === 900)!.number).toMatch(/^0000/)
    expect(await vm.owns(jean)).toBe(true)
    time.at += 8 * DAY
    await vm.syncMailboxes([{ extension: '102', userId: 'jean' }])
    expect(wazo.state.users.map(u => [u.firstname, u.voicemail !== null])).toEqual([
      ['Admin', false],
      ['102', true]
    ])
    expect(wazo.state.voicemails.map(v => v.id)).not.toContain(900)
  })

  it('renews its token before it expires and once more when Wazo says it did (401)', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([{ extension: '102', userId: 'jean' }])
    expect(wazo.state.tokens).toBe(1)
    wazo.state.expired.add('tok-1')
    expect(await vm.listMessages(jean)).toEqual([])
    expect(wazo.state.tokens).toBe(2)
  })

  it('says it is disconnected, and why in a few words, when Wazo cannot be reached or refuses its account', async () => {
    const down = make()
    down.wazo.state.down = true
    await expect(down.vm.syncMailboxes([])).rejects.toThrow(/voicemail server not reached/)
    expect(down.vm.getStatus()).toBe('DISCONNECTED')
    expect(down.vm.getStatusReason()).toMatch(/not reached/)
    const refused = make({ password: 'wrong-password' })
    await expect(refused.vm.listMessages(jean)).rejects.toThrow(/refused the Gateway account/)
    expect(refused.vm.getStatus()).toBe('DISCONNECTED')
  })
})

describe('WazoVoicemail, the messages', () => {
  const withMessages = async () => {
    const t = make()
    await t.vm.syncMailboxes([
      { extension: '102', userId: 'jean' },
      { extension: '103', userId: 'alice' }
    ])
    const box = t.wazo.state.voicemails.find(v => v.number === '102')!
    t.wazo.state.messages.get(box.id)!.push(
      { id: '1792289400-00000001', folder: 2, caller_id_num: '+33612345678', caller_id_name: 'unknown', timestamp: 1792289400, duration: 12 },
      { id: '1792289524-00000004', folder: 1, caller_id_num: '101', caller_id_name: 'Alice Martin', timestamp: 1792289524, duration: 7 },
      { id: '1792289000-00000000', folder: 3, caller_id_num: 'anonymous', caller_id_name: null, timestamp: 1792289000, duration: 0 }
    )
    return { ...t, box }
  }

  it('lists the messages of the mailbox of the extension, newest first, unread those not listened to', async () => {
    const { vm } = await withMessages()
    expect(await vm.listMessages(jean)).toEqual([
      { id: '1792289524-00000004', from: '101', fromName: 'Alice Martin', receivedAt: '2026-10-18T02:12:04.000Z', durationSec: 7, unread: true },
      { id: '1792289400-00000001', from: '+33612345678', receivedAt: '2026-10-18T02:10:00.000Z', durationSec: 12, unread: false },
      // A caller who hid their number: no number, no name.
      { id: '1792289000-00000000', receivedAt: '2026-10-18T02:03:20.000Z', durationSec: 0, unread: true }
    ])
    expect(await vm.listMessages(alice)).toEqual([])
    // An extension with no mailbox, or no extension at all.
    expect(await vm.listMessages({ extension: '104', userId: 'bob' })).toEqual([])
    expect(await vm.listMessages({ extension: '../1', userId: 'jean' })).toEqual([])
  })

  it('gives the recording of a message of the mailbox of the extension only', async () => {
    const { vm } = await withMessages()
    const rec = await vm.getRecording(jean, '1792289524-00000004')
    expect(rec?.contentType).toBe('audio/wav')
    expect(rec?.size).toBe(23)
    expect(await read(rec!.body)).toBe('RIFF1792289524-00000004')
    // Another's mailbox does not have it; an id that is no message id never reaches a URL.
    expect(await vm.getRecording(alice, '1792289524-00000004')).toBeUndefined()
    expect(await vm.getRecording(jean, '../../voicemails/2')).toBeUndefined()
    expect(MESSAGE_ID.test('1792289524-00000004')).toBe(true)
    expect(MESSAGE_ID.test('a/b')).toBe(false)
  })

  it('marks a message as read by moving it to the folder of those listened to, and deletes one, in its own mailbox only', async () => {
    const { vm, wazo, box } = await withMessages()
    expect(await vm.markRead(alice, '1792289524-00000004')).toBe(false)
    expect(await vm.markRead(jean, '1792289524-00000004')).toBe(true)
    expect(wazo.state.messages.get(box.id)!.find(m => m.id === '1792289524-00000004')!.folder).toBe(2)
    expect(wazo.state.requests.filter(r => r.startsWith('PUT /1.0'))).toEqual([`PUT /1.0/voicemails/${box.id}/messages/1792289524-00000004`])
    // Already read: nothing to move.
    expect(await vm.markRead(jean, '1792289524-00000004')).toBe(true)
    expect(wazo.state.requests.filter(r => r.startsWith('PUT /1.0'))).toHaveLength(1)
    expect(await vm.markRead(jean, 'nope')).toBe(false)
    expect(await vm.deleteMessage(alice, '1792289524-00000004')).toBe(false)
    expect(await vm.deleteMessage(jean, '1792289524-00000004')).toBe(true)
    expect(await vm.deleteMessage(jean, '1792289524-00000004')).toBe(false)
    expect((await vm.listMessages(jean)).map(m => m.id)).toEqual(['1792289400-00000001', '1792289000-00000000'])
  })

  it('finds the mailbox of an extension another Gateway made since its last sync', async () => {
    const { vm, wazo } = make()
    const other = make()
    await vm.syncMailboxes([])
    // The same Wazo, a sync from elsewhere.
    Object.assign(other.wazo.state, wazo.state)
    await new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: wazo.fetch, logger: { info() {}, warn() {}, error() {} } }).syncMailboxes([{ extension: '102', userId: 'jean' }])
    const box = wazo.state.voicemails[0]!
    wazo.state.messages.get(box.id)!.push({ id: '1-1', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1, duration: 1 })
    expect((await vm.listMessages(jean)).map(m => m.id)).toEqual(['1-1'])
    expect(await vm.listMessages({ extension: '102', userId: 'marie' })).toEqual([])
  })
})

describe('WazoVoicemail, the bounds and the erasure of the messages', () => {
  const withMessage = async (over: Partial<ConstructorParameters<typeof WazoVoicemail>[0]> = {}) => {
    const t = make(over)
    await t.vm.syncMailboxes([jean, alice])
    const box = t.wazo.state.voicemails.find(v => v.number === '102')!
    t.wazo.state.messages.get(box.id)!.push({ id: '1792289524-00000004', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1792289524, duration: 7 })
    return { ...t, box }
  }

  it('refuses a recording larger than its bound before reading it, and cuts one that says nothing of its length (review 11a, n°3)', async () => {
    const { vm, wazo } = await withMessage({ maxRecordingBytes: 10 })
    await expect(vm.getRecording(jean, '1792289524-00000004')).rejects.toMatchObject({ status: 502, message: /larger than 10 bytes/ })
    wazo.state.noLength = true
    const rec = await vm.getRecording(jean, '1792289524-00000004')
    expect(rec?.size).toBeUndefined()
    await expect(read(rec!.body)).rejects.toMatchObject({ status: 502 })
    // Within its bound, whole.
    const { vm: ok } = await withMessage({ maxRecordingBytes: 23 })
    expect(await read((await ok.getRecording(jean, '1792289524-00000004'))!.body)).toBe('RIFF1792289524-00000004')
  })

  it("erases every message of a person, in the mailbox of their extension and those set aside, nobody else's (review 11a, n°10)", async () => {
    const { vm, wazo, box } = await withMessage()
    // Jean held 105 too, left it: its mailbox is aside with a message.
    await vm.syncMailboxes([jean, alice, { extension: '105', userId: 'jean' }])
    const other = wazo.state.voicemails.find(v => v.number === '105')!
    wazo.state.messages.get(other.id)!.push({ id: '5-5', folder: 2, caller_id_num: '101', caller_id_name: null, timestamp: 5, duration: 1 })
    await vm.syncMailboxes([jean, alice])
    expect(other.number).toMatch(/^0000/)
    const alices = wazo.state.voicemails.find(v => v.number === '103')!
    wazo.state.messages.get(alices.id)!.push({ id: '3-3', folder: 1, caller_id_num: '102', caller_id_name: null, timestamp: 3, duration: 1 })
    expect(await vm.eraseMessages({ userId: 'jean' })).toBe(2)
    expect(wazo.state.messages.get(box.id)).toEqual([])
    expect(wazo.state.messages.get(other.id)).toEqual([])
    expect(wazo.state.messages.get(alices.id)).toHaveLength(1)
    expect(await vm.eraseMessages({ userId: 'nobody' })).toBe(0)
  })

  it('deletes the messages older than the retention period, in every mailbox', async () => {
    const { vm, wazo, box, logs } = await withMessage()
    wazo.state.messages.get(box.id)!.push({ id: '1792300000-00000005', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1792300000, duration: 2 })
    expect(await vm.purgeMessages(new Date(1792290000 * 1000))).toBe(1)
    expect(wazo.state.messages.get(box.id)!.map(m => m.id)).toEqual(['1792300000-00000005'])
    expect(logs.some(l => /1 message\(s\) older than the retention period deleted/.test(l))).toBe(true)
  })
})

describe('WazoVoicemail, the events', () => {
  it('renews its token at four fifths of its life while it hears the events, even when no request needs one (review 11a, n°8)', async () => {
    const { vm, wazo, ws } = make({ tokenTtlSec: 0.05 })
    await vm.syncMailboxes([])
    vm.subscribe()
    await tick(5)
    expect(wazo.state.tokens).toBe(1)
    await tick(60)
    expect(wazo.state.tokens).toBeGreaterThanOrEqual(2)
    expect(ws.sockets[0]!.sent).toContainEqual({ op: 'token', data: { token: 'tok-2' } })
    await vm.close()
    const after = wazo.state.tokens
    await tick(60)
    expect(wazo.state.tokens).toBe(after)
  })

  it('tells nothing of a mailbox set aside', async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([jean])
    const box = wazo.state.voicemails[0]!
    await vm.syncMailboxes([])
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick(1)
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: '1-1', message: { id: '1-1' } })
    await tick(5)
    const next = events.next()
    await vm.close()
    expect((await next).done).toBe(true)
  })

  it('hears wazo-websocketd with its token, subscribes to the events of the messages, and tells each as the extension of its mailbox', async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([{ extension: '102', userId: 'jean' }])
    const box = wazo.state.voicemails[0]!
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick()
    expect(ws.sockets).toHaveLength(1)
    const url = new URL(ws.sockets[0]!.url)
    expect([url.host, url.searchParams.get('token'), url.searchParams.get('version')]).toEqual(['wazo.test:9502', 'tok-1', '2'])
    expect(ws.sockets[0]!.sent).toEqual([
      { op: 'subscribe', data: { event_name: 'user_voicemail_message_created' } },
      { op: 'subscribe', data: { event_name: 'user_voicemail_message_updated' } },
      { op: 'subscribe', data: { event_name: 'user_voicemail_message_deleted' } },
      { op: 'start' }
    ])
    await tick()
    expect(vm.getStatus()).toBe('CONNECTED')
    // As wazo-calld sent it on the Docker stack (user_voicemail_message_created).
    const message = { caller_id_name: 'Alice Martin', caller_id_num: '101', timestamp: 1792289524, empty: false, voicemail: { accesstype: 'personal', name: 'Jean', id: box.id }, transcription: null, folder: { type: 'new', name: 'inbox', id: 1 }, duration: 7, id: '1792289524-00000004' }
    ws.sockets[0]!.event('user_voicemail_message_created', { user_uuid: wazo.state.users[0]!.uuid, voicemail_id: box.id, message_id: message.id, message })
    expect((await events.next()).value).toEqual({ extension: '102', event: { type: 'voicemail.created', timestamp: expect.any(String), payload: { voicemail: { id: message.id, from: '101', fromName: 'Alice Martin', receivedAt: '2026-10-18T02:12:04.000Z', durationSec: 7, unread: true } } } })
    ws.sockets[0]!.event('user_voicemail_message_updated', { voicemail_id: box.id, message_id: message.id, message: { ...message, folder: { type: 'old', name: 'old', id: 2 } } })
    expect((await events.next()).value).toMatchObject({ extension: '102', event: { type: 'voicemail.updated', payload: { voicemail: { id: message.id, unread: false } } } })
    ws.sockets[0]!.event('user_voicemail_message_deleted', { voicemail_id: box.id, message_id: message.id, message })
    expect((await events.next()).value).toMatchObject({ extension: '102', event: { type: 'voicemail.deleted', payload: { id: message.id } } })
    // Another event, a mailbox of nobody here, a message id that is none: nothing.
    ws.sockets[0]!.event('call_created', { voicemail_id: box.id, message_id: 'x' })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: 999, message_id: '1-2', message: {} })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: 'a/b', message: {} })
    await tick(5)
    await vm.close()
    expect((await events.next()).done).toBe(true)
  })

  it('says its events are lost while wazo-websocketd is gone, and hears it again', async () => {
    const { vm, ws, logs } = make()
    await vm.syncMailboxes([])
    vm.subscribe()
    await tick(1)
    expect(vm.getStatus()).toBe('CONNECTED')
    ws.sockets[0]!.drop()
    expect(vm.getStatus()).toBe('DEGRADED')
    expect(vm.getStatusReason()).toMatch(/events not heard/)
    expect(logs.some(l => /voicemail events lost/.test(l))).toBe(true)
    await tick(20)
    expect(ws.sockets).toHaveLength(2)
    expect(vm.getStatus()).toBe('CONNECTED')
    // A token it refused: a new one for the next try.
    ws.sockets[1]!.drop(4002)
    await tick(20)
    expect(new URL(ws.sockets[2]!.url).searchParams.get('token')).toBe('tok-2')
    await vm.close()
  })

  it('reads a message as Wazo gives it: no number that is none, no name that is a number or Asterisk saying it has none', () => {
    expect(voicemailOf({ id: '1-1', caller_id_num: '<unknown>', caller_id_name: '101', timestamp: 0, duration: -1 }, { type: 'old' })).toEqual({ id: '1-1', fromName: '101', receivedAt: '1970-01-01T00:00:00.000Z', durationSec: 0, unread: false })
    expect(voicemailOf({ id: '1-1', caller_id_num: '101', caller_id_name: '101' }, undefined)).toEqual({ id: '1-1', from: '101', receivedAt: '1970-01-01T00:00:00.000Z', durationSec: 0, unread: false })
  })
})
