import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MESSAGE_ID, WazoStopped, WazoVoicemail, holderKey as keyedWith, voicemailOf, type Fetch, type WebSocketLike } from './index.js'

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
    noLength: false,
    /** The length a recording says it has (its own by default). */
    lengthSaid: undefined as number | undefined,
    /** Mailboxes whose changes Wazo refuses (400), by id. */
    refuse: new Set<number>(),
    /**
     * Messages left in the spool under a number with no mailbox there (third review 11a, n°4): a mailbox made at that
     * number shows them; one moved there shows them too, its own staying under its number of before, as Wazo's own
     * wazo-sysconfd leaves a move whose target directory exists.
     */
    leftovers: new Map<string, { id: string; folder: number; caller_id_num: string | null; caller_id_name: string | null; timestamp: number; duration: number }[]>(),
    /** The next read of a mailbox by its id waits this long (ms), once; the next one fails (503), once. */
    slowRead: 0,
    failRead: false
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
      // The first one as on the Docker stack; another (two Gateways at their first start) named after its id.
      const id = next++
      const c = { id, name: state.contexts.length ? `ctx-None-internal-${id}` : CONTEXT, label: body.label, type: body.type }
      state.contexts.push(c)
      return json(201, c)
    }
    if ((m = /^\/1\.1\/contexts\/(\d+)$/.exec(path)) && init.method === 'DELETE') {
      state.contexts = state.contexts.filter(c => c.id !== Number(m![1]))
      return json(204)
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
      state.messages.set(vm.id, state.leftovers.get(body.number) ?? [])
      state.leftovers.delete(body.number)
      return json(201, vm)
    }
    if ((m = /^\/1\.1\/voicemails\/(\d+)$/.exec(path)) && init.method === 'GET') {
      if (state.failRead) {
        state.failRead = false
        return json(503, ['Service Unavailable'])
      }
      if (state.slowRead) {
        const wait = state.slowRead
        state.slowRead = 0
        await new Promise(r => setTimeout(r, wait))
      }
      const vm = state.voicemails.find(v => v.id === Number(m![1]))
      return vm ? json(200, vm) : json(404, ['Resource Not Found'])
    }
    if ((m = /^\/1\.1\/voicemails\/(\d+)$/.exec(path)) && init.method === 'PUT') {
      if (state.refuse.has(Number(m[1]))) return json(400, ['Resource Error - refused'])
      // Another number: Wazo moves the messages with the mailbox (wazo-sysconfd), its id stays.
      const vm = state.voicemails.find(v => v.id === Number(m![1]))
      if (!vm) return json(404, ['Resource Not Found'])
      if (state.voicemails.some(v => v !== vm && v.number === body.number && v.context === body.context)) return json(400, ['Resource Error - Voicemail already exists'])
      const left = body.number !== vm.number ? state.leftovers.get(body.number) : undefined
      if (left) {
        state.leftovers.set(vm.number, state.messages.get(vm.id) ?? [])
        state.messages.set(vm.id, left)
        state.leftovers.delete(body.number)
      }
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
        return { status: 200, headers: { get: (n: string) => (n === 'content-type' ? 'audio/wav' : n === 'content-length' && !state.noLength ? String(state.lengthSaid ?? bytes.length) : null) }, json: async () => ({}), text: async () => '', body }
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
    const { boxes, failed } = await vm.syncMailboxes([
      { extension: '102', userId: 'jean', displayName: 'Jean Dupont' },
      { extension: '103', userId: 'alice' },
      // Not a number Asterisk's mailboxes take: left out.
      { extension: 'alice.b', userId: 'bob' }
    ])
    expect(boxes).toEqual([
      { extension: '102', mailbox: `102@${CONTEXT}` },
      { extension: '103', mailbox: `103@${CONTEXT}` }
    ])
    expect(failed).toBe(0)
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
    expect((await vm.syncMailboxes([{ extension: '103', userId: 'alice' }, { extension: '102', userId: 'jean', displayName: 'Jean Dupont' }])).boxes).toEqual(boxes)
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
    expect((await vm.syncMailboxes([{ extension: '104', userId: 'jean' }, alice])).boxes).toEqual([
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

  it('holds back the mailboxes of more than two people gone at once, more than half of those at an extension, until it is said to be meant (second review 11a, n°9)', async () => {
    const time = clock()
    const { vm, wazo, logs } = make({ now: time.now })
    const four = ['102', '103', '104', '105'].map((extension, i) => ({ extension, userId: `u${i}` }))
    await vm.syncMailboxes(four)
    // A directory that came back empty: nothing set aside, each mailbox still reached at its extension; said once.
    const held = await vm.syncMailboxes([])
    expect(held).toEqual({ boxes: four.map(h => ({ extension: h.extension, mailbox: `${h.extension}@${CONTEXT}` })), failed: 0, heldBack: { park: 4, of: 4 } })
    expect(wazo.state.voicemails.map(v => v.number).sort()).toEqual(['102', '103', '104', '105'])
    await vm.syncMailboxes([])
    expect(logs.filter(l => /held back/.test(l))).toHaveLength(1)
    expect(logs.find(l => /held back/.test(l))).toMatch(/4 of 4 of people who hold no extension left where they are/)
    // It came back: nothing held any more.
    expect((await vm.syncMailboxes(four)).heldBack).toBeUndefined()
    // An administrator says they left, having seen four of four (third review 11a, n°6): what they saw goes, nothing
    // else. A release of another mass (three of four, four of five) lets nothing go: held back again, said.
    for (const release of [{ park: 3, of: 4 }, { park: 4, of: 5 }, { remove: 4, of: 4 }]) {
      const again = await vm.syncMailboxes([], { release })
      expect([again.heldBack, again.released]).toEqual([{ park: 4, of: 4 }, undefined])
    }
    expect(logs.filter(l => /release of .* not applied/.test(l))).toHaveLength(3)
    const let_go = await vm.syncMailboxes([], { release: { park: 4, of: 4 } })
    expect([let_go.boxes, let_go.released, let_go.heldBack]).toEqual([[], true, undefined])
    expect(wazo.state.voicemails.every(v => v.number.startsWith('0000'))).toBe(true)
    // Past the grace period, the four would go at once, none reached: kept until said again, for that.
    time.at += 8 * DAY
    expect((await vm.syncMailboxes([])).heldBack).toEqual({ remove: 4, of: 0 })
    expect(wazo.state.voicemails).toHaveLength(4)
    expect((await vm.syncMailboxes([], { release: { park: 4, of: 0 } })).heldBack).toEqual({ remove: 4, of: 0 })
    expect(wazo.state.voicemails).toHaveLength(4)
    expect((await vm.syncMailboxes([], { release: { remove: 4, of: 0 } })).released).toBe(true)
    expect(wazo.state.voicemails).toEqual([])
  })

  it('holds back from three people gone, and more than half: two of four go, three of six go, three of five wait (the bound of n°9)', async () => {
    const outcome = async (total: number, leaving: number) => {
      const { vm, wazo } = make()
      const all = Array.from({ length: total }, (_, i) => ({ extension: String(110 + i), userId: `p${i}` }))
      await vm.syncMailboxes(all)
      const { heldBack } = await vm.syncMailboxes(all.slice(leaving))
      return [heldBack?.park ?? 0, wazo.state.voicemails.filter(v => v.number.startsWith('0000')).length]
    }
    expect(await outcome(4, 2)).toEqual([0, 2])
    expect(await outcome(6, 3)).toEqual([0, 3])
    expect(await outcome(5, 3)).toEqual([3, 0])
    expect(await outcome(3, 3)).toEqual([3, 0])
  })

  it('holds nothing back when the whole plan is renumbered: everyone still holds an extension, every mailbox follows its holder (third review 11a, n°12)', async () => {
    const { vm, wazo } = make()
    const before = ['101', '102', '103', '104', '105'].map((extension, i) => ({ extension, userId: `r${i}` }))
    await vm.syncMailboxes(before)
    for (const v of wazo.state.voicemails) wazo.state.messages.get(v.id)!.push({ id: `1-${v.number}`, folder: 1, caller_id_num: '110', caller_id_name: null, timestamp: 1, duration: 3 })
    const after = before.map(h => ({ ...h, extension: `2${h.extension.slice(1)}` }))
    const res = await vm.syncMailboxes(after)
    expect([res.heldBack, res.failed]).toEqual([undefined, 0])
    expect(res.boxes.map(b => b.extension)).toEqual(['201', '202', '203', '204', '205'])
    for (const h of after) expect((await vm.listMessages(h)).map(m => m.id)).toEqual([`1-1${h.extension.slice(1)}`])
    expect(wazo.state.voicemails).toHaveLength(5)
  })

  it('stops before its next change once it may no longer write, and purges nothing more (third review 11a, n°2)', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([jean])
    const writes = () => wazo.state.requests.filter(r => !r.startsWith('GET')).length
    // It may write once more: Jean's mailbox set aside, then nothing (no mailbox made for Marie).
    let allowed = 1
    const before = writes()
    await expect(vm.syncMailboxes([{ extension: '102', userId: 'marie' }], { mayWrite: () => allowed-- > 0 })).rejects.toBeInstanceOf(WazoStopped)
    expect(writes()).toBe(before + 1)
    expect(wazo.state.voicemails.map(v => v.number)).toEqual([expect.stringMatching(/^0000/)])
    // Not at all: nothing written, not even the context of a first start.
    const fresh = make()
    await expect(fresh.vm.syncMailboxes([jean], { mayWrite: () => false })).rejects.toBeInstanceOf(WazoStopped)
    expect(fresh.wazo.state.requests.filter(r => !r.startsWith('GET'))).toEqual(['POST /0.1/token'])
    // The purge likewise.
    const box = wazo.state.voicemails[0]!
    wazo.state.messages.get(box.id)!.push({ id: '1-1', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1, duration: 3 })
    await expect(vm.purgeMessages(new Date(), { mayWrite: () => false })).rejects.toBeInstanceOf(WazoStopped)
    expect(wazo.state.messages.get(box.id)).toHaveLength(1)
  })

  it('never shows a holder messages that are not theirs: a mailbox made or moved where the spool has some is set aside, nobody\'s, and a new one made (third review 11a, n°4)', async () => {
    const time = clock()
    const { vm, wazo, logs } = make({ now: time.now })
    await vm.syncMailboxes([jean])
    const jeans = wazo.state.voicemails[0]!
    wazo.state.messages.get(jeans.id)!.push({ id: '1-jean', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1, duration: 3 })
    const left = (id: string) => ({ id, folder: 1, caller_id_num: '109', caller_id_name: null, timestamp: 2, duration: 3 })
    // Messages under 107 with no mailbox there: Marie, given 107, has an empty mailbox; they are nobody's.
    wazo.state.leftovers.set('107', [left('2-left')])
    const marie = { extension: '107', userId: 'marie' }
    const res = await vm.syncMailboxes([jean, marie])
    expect(res.boxes.map(b => b.extension)).toEqual(['102', '107'])
    expect(await vm.listMessages(marie)).toEqual([])
    const isolated = wazo.state.voicemails.find(v => wazo.state.messages.get(v.id)?.some(m => m.id === '2-left'))!
    expect([isolated.number, isolated.users]).toEqual([expect.stringMatching(/^0000/), []])
    expect(logs.some(l => /made at 107 shows messages already/.test(l))).toBe(true)
    // Messages under 105, and the move of Jean's mailbox there leaves his own under 102 (as Wazo's wazo-sysconfd does):
    // his mailbox, which shows the others', is set aside nobody's; he gets a new, empty one; the loss is said.
    wazo.state.leftovers.set('105', [left('3-left')])
    const moved = await vm.syncMailboxes([{ extension: '105', userId: 'jean' }, marie])
    expect(moved.boxes.map(b => b.extension)).toEqual(['105', '107'])
    expect(moved.failed).toBe(2)
    expect(await vm.listMessages({ extension: '105', userId: 'jean' })).toEqual([])
    expect([jeans.number, jeans.users]).toEqual([expect.stringMatching(/^0000/), []])
    expect(logs.some(l => /did not move with it to 105/.test(l))).toBe(true)
    // Bob given 102 later: his mailbox shows nothing of Jean's, left under 102.
    const bob = { extension: '102', userId: 'bob' }
    await vm.syncMailboxes([{ extension: '105', userId: 'jean' }, marie, bob])
    expect(await vm.listMessages(bob)).toEqual([])
    for (const who of [{ extension: '105', userId: 'jean' }, marie, bob]) expect((await vm.listMessages(who)).map(m => m.id)).toEqual([])
    // Nobody's, they go with the grace period (three against three reached: once an administrator said so).
    time.at += 8 * DAY
    const three = [{ extension: '105', userId: 'jean' }, marie, bob]
    expect((await vm.syncMailboxes(three)).heldBack).toEqual({ remove: 3, of: 3 })
    await vm.syncMailboxes(three, { release: { remove: 3, of: 3 } })
    expect(wazo.state.voicemails.map(v => v.number).sort()).toEqual(['102', '105', '107'])
  })

  it('removes the mailboxes aside past their grace period one by one when few go at once, the bound counted on those reached', async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now })
    const six = ['102', '103', '104', '105', '106', '107'].map((extension, i) => ({ extension, userId: `u${i}` }))
    await vm.syncMailboxes(six)
    // Three leave (three of six: not more than half), set aside.
    await vm.syncMailboxes(six.slice(3))
    time.at += 8 * DAY
    // Past the grace period, three would go against three mailboxes reached: more than half of those, held back.
    expect((await vm.syncMailboxes(six.slice(3))).heldBack).toEqual({ remove: 3, of: 3 })
    expect(wazo.state.voicemails).toHaveLength(6)
    // Two only: they go.
    const { vm: other, wazo: w2 } = make({ now: time.now })
    await other.syncMailboxes(six)
    time.at -= 8 * DAY
    await other.syncMailboxes(six.slice(2))
    time.at += 8 * DAY
    expect((await other.syncMailboxes(six.slice(2))).heldBack).toBeUndefined()
    expect(w2.state.voicemails.map(v => v.number).sort()).toEqual(['104', '105', '106', '107'])
    // Three against six reached: half, not more than half: they go.
    const nine = ['102', '103', '104', '105', '106', '107', '108', '109', '110'].map((extension, i) => ({ extension, userId: `n${i}` }))
    const { vm: third, wazo: w3 } = make({ now: time.now })
    time.at -= 8 * DAY
    await third.syncMailboxes(nine)
    await third.syncMailboxes(nine.slice(3))
    time.at += 8 * DAY
    expect((await third.syncMailboxes(nine.slice(3))).heldBack).toBeUndefined()
    expect(w3.state.voicemails.map(v => v.number).sort()).toEqual(['105', '106', '107', '108', '109', '110'])
  })

  it('tells the SIP side the mailboxes at their holder only, before it changes anything (second review 11a, n°3)', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([jean, alice])
    const writes = () => wazo.state.requests.filter(r => !r.startsWith('GET')).length
    let seen: { boxes: unknown; writes: number } | undefined
    // 102 passes to Marie: before Jean's mailbox is set aside (and Marie's made), the SIP side keeps 103 only.
    const before = writes()
    await vm.syncMailboxes([{ extension: '102', userId: 'marie' }, alice], { beforeChanges: async boxes => void (seen = { boxes, writes: writes() }) })
    expect(seen).toEqual({ boxes: [{ extension: '103', mailbox: `103@${CONTEXT}` }], writes: before })
    expect(writes()).toBeGreaterThan(before)
  })

  it('leaves out a mailbox Wazo refuses to change, and does the others (second review 11a, n°8)', async () => {
    const { vm, wazo, logs } = make()
    await vm.syncMailboxes([jean, alice])
    const jeans = wazo.state.voicemails.find(v => v.number === '102')!
    wazo.state.refuse.add(jeans.id)
    // Jean leaves, Marie takes 102, Bob comes at 104: Jean's mailbox cannot be set aside, so 102 has none (never
    // Jean's for Marie), Bob gets his.
    const res = await vm.syncMailboxes([{ extension: '102', userId: 'marie' }, alice, { extension: '104', userId: 'bob' }])
    expect(res.boxes.map(b => b.extension)).toEqual(['103', '104'])
    expect(res.failed).toBe(2)
    expect(logs.some(l => /setting mailbox \d+ aside not done/.test(l))).toBe(true)
    expect(await vm.owns({ extension: '102', userId: 'marie' })).toBe(false)
    // Wazo takes it again: Marie has hers.
    wazo.state.refuse.clear()
    expect((await vm.syncMailboxes([{ extension: '102', userId: 'marie' }, alice, { extension: '104', userId: 'bob' }])).boxes.map(b => b.extension)).toEqual(['102', '103', '104'])
    expect(await vm.owns({ extension: '102', userId: 'marie' })).toBe(true)
  })

  it('makes one context only when two Gateways start at once, and both synchronise (second review 11a, n°1)', async () => {
    const a = make()
    const b = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: a.wazo.fetch, logger: { info() {}, warn() {}, error() {} } })
    await Promise.all([a.vm.syncMailboxes([jean]), b.syncMailboxes([jean])].map(p => p.catch(() => undefined)))
    expect(a.wazo.state.contexts.map(c => c.name)).toEqual([CONTEXT])
    expect((await b.syncMailboxes([jean])).boxes).toEqual([{ extension: '102', mailbox: `102@${CONTEXT}` }])
    expect(a.wazo.state.voicemails.map(v => [v.number, v.context])).toEqual([['102', CONTEXT]])
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
    // A message longer than a call to a mailbox lasts: refused at the start (second review 11a, n°11).
    expect(() => make({ maxMessageSec: 600, maxCallSec: 300 })).toThrow(/longer than a call to a mailbox lasts/)
    expect(() => make({ maxMessageSec: 600 })).not.toThrow()
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

  it('bounds a recording on the longest call to a mailbox, not on the longest message now (second review 11a, n°11)', async () => {
    // Messages of 60 s now; one of 5 minutes left before (the call's bound) is still read; past the call's bound and
    // its margin, refused.
    const { vm, wazo } = await withMessage({ maxMessageSec: 60 })
    wazo.state.lengthSaid = 300 * 16_000 + 44
    expect((await vm.getRecording(jean, '1792289524-00000004'))?.size).toBe(300 * 16_000 + 44)
    wazo.state.lengthSaid = Math.ceil(300 * 16_000 * 1.5) + 65_537
    await expect(vm.getRecording(jean, '1792289524-00000004')).rejects.toMatchObject({ status: 502 })
    const { vm: longer, wazo: w2 } = await withMessage({ maxMessageSec: 60, maxCallSec: 900 })
    w2.state.lengthSaid = 900 * 16_000 + 44
    expect((await longer.getRecording(jean, '1792289524-00000004'))?.size).toBe(900 * 16_000 + 44)
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
    // One without a date (second review 11a, n°22): not one of 1970, it stays, and it is said.
    wazo.state.messages.get(box.id)!.push({ id: '0-0', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: undefined as unknown as number, duration: 2 })
    expect(await vm.purgeMessages(new Date(1792290000 * 1000))).toBe(0)
    expect(wazo.state.messages.get(box.id)!.map(m => m.id)).toEqual(['1792300000-00000005', '0-0'])
    expect(logs.some(l => /1 message\(s\) without a date left out/.test(l))).toBe(true)
  })
})

describe('WazoVoicemail, the events', () => {
  it('renews its token at four fifths of its life while it hears the events, even when no request needs one (review 11a, n°8)', async () => {
    const { vm, wazo, ws } = make({ tokenTtlSec: 0.05 })
    await vm.syncMailboxes([])
    vm.subscribe()
    await tick(5)
    expect(wazo.state.tokens).toBe(1)
    // Several cycles (second review 11a, n°12): each renewal arms the next one, the WebSocket hears each token.
    await tick(200)
    expect(wazo.state.tokens).toBeGreaterThanOrEqual(4)
    for (const token of ['tok-2', 'tok-3', 'tok-4']) expect(ws.sockets[0]!.sent).toContainEqual({ op: 'token', data: { token } })
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

  it("tells a message as the extension its mailbox has now, whatever Gateway moved it, and owns says whose mailbox it is (second review 11a, n°2)", async () => {
    const a = make()
    await a.vm.syncMailboxes([jean])
    const jeans = a.wazo.state.voicemails[0]!
    const events = a.vm.subscribe()[Symbol.asyncIterator]()
    await tick(1)
    // Another Gateway: Jean moves from 102 to 105, Marie takes 102. This one heard nothing of it.
    const b = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: a.wazo.fetch, logger: { info() {}, warn() {}, error() {} } })
    await b.syncMailboxes([{ extension: '105', userId: 'jean' }, { extension: '102', userId: 'marie' }])
    expect(jeans.number).toBe('105')
    const message = { caller_id_name: 'Alice Martin', caller_id_num: '101', timestamp: 1792289524, folder: { type: 'new', name: 'inbox', id: 1 }, duration: 7, id: '1792289524-00000004' }
    a.ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: jeans.id, message_id: message.id, message })
    const got = (await events.next()).value as { extension: string; mailbox: string }
    expect([got.extension, got.mailbox]).toEqual(['105', String(jeans.id)])
    expect(await a.vm.owns({ extension: '105', userId: 'jean', mailbox: got.mailbox })).toBe(true)
    // Marie, who holds 102 now, never owns Jean's mailbox; nor someone a stale directory gives 105.
    expect(await a.vm.owns({ extension: '102', userId: 'marie', mailbox: got.mailbox })).toBe(false)
    expect(await a.vm.owns({ extension: '105', userId: 'marie', mailbox: got.mailbox })).toBe(false)
    expect(await a.vm.owns({ extension: '105', userId: 'jean', mailbox: 'x' })).toBe(false)
    // And what this Gateway knew of 102 (Jean's) gave way: Marie's own messages are hers.
    expect(await a.vm.owns({ extension: '102', userId: 'marie' })).toBe(true)
    expect(await a.vm.owns(jean)).toBe(false)
    // Jean leaves: his mailbox set aside is nobody's, whatever extension is asked for.
    await b.syncMailboxes([{ extension: '102', userId: 'marie' }])
    expect(jeans.number).toMatch(/^0000/)
    for (const extension of ['105', jeans.number]) expect(await a.vm.owns({ extension, userId: 'jean', mailbox: String(jeans.id) })).toBe(false)
    await a.vm.close()
  })

  it('tells nothing of a mailbox of nobody, and finds the holder among its users whatever their order (third review 11a, n°12 and n°14)', async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([jean])
    const jeans = wazo.state.voicemails[0]!
    // A user made in Wazo by hand, first of Jean's mailbox; and a mailbox of the context with no user of ours.
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000002', firstname: 'Admin', userfield: null, voicemail: { id: jeans.id } })
    jeans.users.unshift({ uuid: 'aaaaaaaa-0000-4000-8000-000000000002' })
    wazo.state.voicemails.push({ id: 901, number: '108', context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000002' }] })
    wazo.state.messages.set(901, [])
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick(1)
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: 901, message_id: '1-1', message: { id: '1-1' } })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: jeans.id, message_id: '1-2', message: { id: '1-2' } })
    const got = (await events.next()).value as { extension: string; mailbox: string }
    expect([got.extension, got.mailbox]).toEqual(['102', String(jeans.id)])
    // The routes too: a new Gateway (nothing known) finds Jean's mailbox his.
    const other = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: wazo.fetch, logger: { info() {}, warn() {}, error() {} } })
    expect(await other.owns(jean)).toBe(true)
    expect(await other.owns({ extension: '108', userId: 'jean' })).toBe(false)
    await vm.close()
  })

  it("tells a mailbox's events in the order they came, its mailbox read once for the event and its owns, and once more when Wazo did not answer (third review 11a, n°8)", async () => {
    const { vm, wazo, ws, logs } = make()
    await vm.syncMailboxes([jean])
    const box = wazo.state.voicemails[0]!
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick(1)
    // The first read waits: the second event, read at once, is told after it all the same.
    wazo.state.slowRead = 30
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: '1-1', message: { id: '1-1' } })
    ws.sockets[0]!.event('user_voicemail_message_deleted', { voicemail_id: box.id, message_id: '1-1', message: { id: '1-1' } })
    const first = (await events.next()).value as { event: { type: string }; mailbox: string }
    const second = (await events.next()).value as { event: { type: string } }
    expect([first.event.type, second.event.type]).toEqual(['voicemail.created', 'voicemail.deleted'])
    // The Gateway's owns of the event: the mailbox as the event read it, not read again.
    const reads = () => wazo.state.requests.filter(r => r === `GET /1.1/voicemails/${box.id}`).length
    const n = reads()
    expect(await vm.owns({ ...jean, mailbox: first.mailbox })).toBe(true)
    expect(reads()).toBe(n)
    // Wazo does not answer the read of an event: read once more, a moment later, and told.
    wazo.state.failRead = true
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: '1-3', message: { id: '1-3' } })
    expect(((await events.next()).value as { event: { payload: { voicemail: { id: string } } } }).event.payload.voicemail.id).toBe('1-3')
    expect(logs.some(l => /voicemail event not told/.test(l))).toBe(false)
    await vm.close()
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
    expect((await events.next()).value).toEqual({ extension: '102', mailbox: String(box.id), event: { type: 'voicemail.created', timestamp: expect.any(String), payload: { voicemail: { id: message.id, from: '101', fromName: 'Alice Martin', receivedAt: '2026-10-18T02:12:04.000Z', durationSec: 7, unread: true } } } })
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
