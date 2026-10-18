import { describe, expect, it } from 'vitest'
import { MESSAGE_ID, WazoVoicemail, holderKey, voicemailOf, type Fetch, type WebSocketLike } from './index.js'

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
    voicemails: [] as { id: number; number: string; context: string; name: string; users: { uuid: string }[] }[],
    messages: new Map<number, { id: string; folder: number; caller_id_num: string | null; caller_id_name: string | null; timestamp: number; duration: number }[]>(),
    tokens: 0,
    expired: new Set<string>(),
    requests: [] as string[],
    down: false
  }
  let next = 1
  const json = (status: number, body?: unknown) => ({ status, headers: { get: (n: string) => (n === 'content-type' ? 'application/json' : null) }, json: async () => body, text: async () => JSON.stringify(body ?? ''), arrayBuffer: async () => new ArrayBuffer(0) })
  const fetch: Fetch = async (url, init) => {
    if (state.down) throw new TypeError('fetch failed')
    const u = new URL(url)
    const path = u.pathname
    state.requests.push(`${init.method} ${path}`)
    const body = init.body ? JSON.parse(init.body) : undefined
    if (path === '/0.1/token') {
      if (init.headers.authorization !== `Basic ${Buffer.from('twakephone:not-a-real-password').toString('base64')}`) return json(401)
      expect(body).toEqual({ expiration: 3600 })
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
      const vm = { id: next++, number: body.number, context: body.context, name: body.name, users: [] }
      state.voicemails.push(vm)
      state.messages.set(vm.id, [])
      return json(201, vm)
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
      if (m[3]) return { status: 200, headers: { get: (n: string) => (n === 'content-type' ? 'audio/wav' : null) }, json: async () => ({}), text: async () => '', arrayBuffer: async () => new TextEncoder().encode(`RIFF${msg.id}`).buffer }
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
    fetch: wazo.fetch,
    webSocket: ws.open,
    reconnectMs: [5],
    logger: { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) },
    ...over
  })
  return { vm, wazo, ws, logs }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
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
    // Nothing of the person's id in Wazo: a hash of it.
    expect(holderKey('jean')).toMatch(/^twakephone:[0-9a-f]{40}$/)
    expect(JSON.stringify(wazo.state)).not.toContain('"jean"')
    expect(wazo.state.voicemails.map(v => [v.number, v.context, v.users.length])).toEqual([
      ['102', CONTEXT, 1],
      ['103', CONTEXT, 1]
    ])
    // Again: nothing made, nothing removed.
    const before = wazo.state.requests.length
    expect(await vm.syncMailboxes([{ extension: '103', userId: 'alice' }, { extension: '102', userId: 'jean' }])).toEqual(boxes)
    expect(wazo.state.requests.slice(before).filter(r => !r.startsWith('GET'))).toEqual([])
  })

  it("removes the mailbox of an extension given to someone else, with its messages, and gives the new holder a new one: nobody hears another's messages", async () => {
    const { vm, wazo } = make()
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
    // Then the sync; Alice leaves.
    await vm.syncMailboxes([marie])
    expect(wazo.state.voicemails.map(v => v.number)).toEqual(['102'])
    expect(wazo.state.voicemails[0]!.id).not.toBe(jeans.id)
    expect(wazo.state.messages.has(jeans.id)).toBe(false)
    expect(await vm.listMessages(marie)).toEqual([])
    expect(await vm.owns(marie)).toBe(true)
    expect(await vm.owns(jean)).toBe(false)
    expect(await vm.listMessages(jean)).toEqual([])
    expect(await vm.listMessages(alice)).toEqual([])
    expect(wazo.state.users.map(u => u.userfield)).toEqual([holderKey('marie')])
  })

  it("leaves Wazo's own users alone, and takes a mailbox of the context made by hand for nobody's", async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([])
    // A user made in Wazo by hand, with a mailbox in the context of the platform.
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', firstname: 'Admin', userfield: null, voicemail: { id: 900 } })
    wazo.state.voicemails.push({ id: 900, number: '102', context: CONTEXT, name: 'x', users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000001' }] })
    wazo.state.messages.set(900, [])
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
    expect(new TextDecoder().decode(rec!.body)).toBe('RIFF1792289524-00000004')
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
    await new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', fetch: wazo.fetch, logger: { info() {}, warn() {}, error() {} } }).syncMailboxes([{ extension: '102', userId: 'jean' }])
    const box = wazo.state.voicemails[0]!
    wazo.state.messages.get(box.id)!.push({ id: '1-1', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1, duration: 1 })
    expect((await vm.listMessages(jean)).map(m => m.id)).toEqual(['1-1'])
    expect(await vm.listMessages({ extension: '102', userId: 'marie' })).toEqual([])
  })
})

describe('WazoVoicemail, the events', () => {
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
