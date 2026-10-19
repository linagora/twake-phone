// A Wazo as its APIs answered on the Docker stack, in memory: for the tests of provider-wazo and of the Gateway.
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import type { Fetch } from '../src/index.js'

/**
 * The rights of the Gateway's account in Wazo, as the stack gives them (docker/wazo/bootstrap.py, TWAKE_ACL): the fake
 * Wazo refuses (401) any request they do not cover, as wazo-auth's token check does.
 */
export const ACL = [.../TWAKE_ACL = \[([\s\S]*?)\n\]/.exec(readFileSync(new URL('../../../docker/wazo/bootstrap.py', import.meta.url), 'utf8'))![1]!.matchAll(/^\s*'([^']+)',/gm)].map(m => m[1]!)
const ACTIONS: Record<string, string> = { GET: 'read', POST: 'create', PUT: 'update', DELETE: 'delete' }
/** Whether one of the rights covers this one (`*`: one part, `#`: any number of them). */
const covers = (acl: string[], wanted: string) =>
  acl.some(a => new RegExp(`^${a.split('.').map(p => (p === '*' ? '[^.]+' : p === '#' ? '.*' : p.replace(/[-]/g, '\\$&'))).join('\\.')}$`).test(wanted))
/** The right a request to wazo-confd (1.1) or wazo-calld (1.0) needs. */
const rightOf = (method: string, path: string) => {
  const parts = path.split('/').filter(Boolean).slice(1)
  return [path.startsWith('/1.1/') ? 'confd' : 'calld', ...parts, ACTIONS[method]!].join('.')
}
/** Every fake Wazo made: none may have been asked for anything outside the rights. */
export const made: { denied: string[] }[] = []

// A Wazo as its APIs answered on the Docker stack (wazo 26.10: wazo-auth, wazo-confd, wazo-calld, wazo-websocketd),
// trimmed to what this package reads, in memory. What it answers is a copy (as JSON over HTTP would be): nothing the
// provider changes in what it was given changes Wazo.
export const CONTEXT = 'ctx-None-internal-210d0144-9bcc-45c1-b36b-317577cedc2f'
const folderTypes = [
  { id: 1, type: 'new', name: 'inbox' },
  { id: 2, type: 'old', name: 'old' },
  { id: 3, type: 'urgent', name: 'urgent' },
  { id: 4, type: 'other', name: 'work' }
]
export type Message = { id: string; folder: number; caller_id_num: string | null; caller_id_name: string | null; timestamp: number; duration: number }

/** A Wazo in memory, where `numberOf` says the number of a person's mailbox (from their print). */
export const fakeWazo = (numberOf: (userId: string) => string) => {
  const state = {
    contexts: [] as { id: number; name: string; label: string; type: string }[],
    users: [] as { uuid: string; firstname: string; userfield: string | null; voicemail: { id: number } | null }[],
    /** The SIP endpoints and lines (step 11c-1): an endpoint's `line` is the id of the line it is associated with. */
    endpoints: [] as { uuid: string; name: string; label: string; auth_section_options: [string, string][]; aor_section_options: [string, string][]; line: { id: number } | null }[],
    lines: [] as { id: number; context: string }[],
    /** The next line made is made, then refused (500: wazo-sysconfd failing after wazo-confd committed). */
    lineMadeThenFails: false,
    voicemails: [] as { id: number; number: string; context: string; name: string; max_messages: number | null; options: [string, string][]; users: { uuid: string }[] }[],
    messages: new Map<number, Message[]>(),
    tokens: 0,
    expired: new Set<string>(),
    requests: [] as string[],
    /** Each request with its query (what a search asked). */
    urls: [] as string[],
    /** The requests outside the rights of the Gateway's account (refused, 401): there must be none. */
    denied: [] as string[],
    down: false,
    /** A recording sent without its length (chunked). */
    noLength: false,
    /** The length a recording says it has (its own by default). */
    lengthSaid: undefined as number | undefined,
    /** Mailboxes whose changes Wazo refuses (400), by id; numbers at which it refuses to make one. */
    refuse: new Set<number>(),
    refuseNumbers: new Set<string>(),
    /** Every change of a mailbox's number (wazo-sysconfd's move_voicemail): there must be none. */
    moves: [] as string[],
    /** The next read of a mailbox by its id waits this long (ms), once; the next ones fail (503), `failRead` times. */
    slowRead: 0,
    failRead: 0,
    /** wazo-auth's answer waits this long (ms); each request of wazo-confd too. */
    tokenMs: 0,
    confdMs: 0,
    /** The next request that starts so ("METHOD /path") is refused once, its token expired (401). */
    expireOn: undefined as string | undefined
  }
  let next = 1
  const json = (status: number, body?: unknown) => {
    const copy = body === undefined ? undefined : structuredClone(body)
    return { status, headers: { get: (n: string) => (n === 'content-type' ? 'application/json' : null) }, json: async () => copy, text: async () => JSON.stringify(copy ?? ''), body: null }
  }
  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      })
    })
  const fetch: Fetch = async (url, init) => {
    if (state.down) throw new TypeError('fetch failed')
    const u = new URL(url)
    const path = u.pathname
    state.requests.push(`${init.method} ${path}`)
    state.urls.push(`${init.method} ${path}${u.search}`)
    const body = init.body ? JSON.parse(init.body) : undefined
    if (path === '/0.1/token') {
      if (state.tokenMs) await wait(state.tokenMs, init.signal)
      if (init.headers.authorization !== `Basic ${Buffer.from('twakephone:not-a-real-password').toString('base64')}`) return json(401)
      expect(typeof body.expiration).toBe('number')
      return json(200, { data: { token: `tok-${++state.tokens}` } })
    }
    const token = init.headers['x-auth-token']
    if (!token?.startsWith('tok-') || state.expired.has(token)) return json(401)
    if (!covers(ACL, rightOf(init.method, path))) {
      state.denied.push(`${init.method} ${path}`)
      return json(401)
    }
    if (state.confdMs && path.startsWith('/1.1')) await wait(state.confdMs, init.signal)
    if (state.expireOn && `${init.method} ${path}`.startsWith(state.expireOn)) {
      state.expireOn = undefined
      state.expired.add(token)
      return json(401)
    }
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
    if (path === '/1.1/endpoints/sip' && init.method === 'GET') return page(state.endpoints)
    if (path === '/1.1/endpoints/sip' && init.method === 'POST') {
      if (state.endpoints.some(e => e.name === body.name)) return json(400, ['Resource Error - SIPEndpoint already exists'])
      const endpoint = { uuid: `00000000-0000-4000-9000-${String(next++).padStart(12, '0')}`, name: body.name, label: body.label, auth_section_options: body.auth_section_options ?? [], aor_section_options: body.aor_section_options ?? [], line: null }
      state.endpoints.push(endpoint)
      return json(201, endpoint)
    }
    if ((m = /^\/1\.1\/endpoints\/sip\/([^/]+)$/.exec(path)) && init.method === 'DELETE') {
      const endpoint = state.endpoints.find(e => e.uuid === m![1])
      if (!endpoint) return json(404, ['Resource Not Found'])
      if (endpoint.line) return json(400, ['Resource Error - SIPEndpoint is associated with a Line'])
      state.endpoints = state.endpoints.filter(e => e !== endpoint)
      return json(204)
    }
    if (path === '/1.1/lines' && init.method === 'GET') return page(state.lines.map(l => ({ ...l, endpoint_sip: state.endpoints.find(e => e.line?.id === l.id) ?? null, users: [], extensions: [] })))
    if (path === '/1.1/lines' && init.method === 'POST') {
      const line = { id: next++, context: body.context }
      state.lines.push(line)
      if (state.lineMadeThenFails) {
        state.lineMadeThenFails = false
        return json(500, ['sysconfd error'])
      }
      return json(201, line)
    }
    if ((m = /^\/1\.1\/lines\/(\d+)\/endpoints\/sip\/([^/]+)$/.exec(path)) && (init.method === 'PUT' || init.method === 'DELETE')) {
      const endpoint = state.endpoints.find(e => e.uuid === m![2])
      if (!endpoint || !state.lines.some(l => l.id === Number(m![1]))) return json(404, ['Resource Not Found'])
      endpoint.line = init.method === 'PUT' ? { id: Number(m[1]) } : null
      return json(204)
    }
    if ((m = /^\/1\.1\/lines\/(\d+)$/.exec(path)) && init.method === 'DELETE') {
      if (state.endpoints.some(e => e.line?.id === Number(m![1]))) return json(400, ['Resource Error - Line is associated with an Endpoint'])
      state.lines = state.lines.filter(l => l.id !== Number(m![1]))
      return json(204)
    }
    if (path === '/1.1/users' && init.method === 'GET') {
      // As wazo-confd: a search matches part of the name or the userfield (among others).
      const search = u.searchParams.get('search')
      return page(state.users.filter(x => !search || x.firstname.includes(search) || (x.userfield ?? '').includes(search)))
    }
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
      if (state.refuseNumbers.has(body.number)) return json(400, ['Resource Error - refused'])
      if (state.voicemails.some(v => v.number === body.number && v.context === body.context)) return json(400, ['Resource Error - Voicemail already exists'])
      const vm = { id: next++, number: body.number, context: body.context, name: body.name, max_messages: body.max_messages ?? null, options: body.options ?? [], users: [] }
      state.voicemails.push(vm)
      state.messages.set(vm.id, [])
      return json(201, vm)
    }
    if ((m = /^\/1\.1\/voicemails\/(\d+)$/.exec(path)) && init.method === 'GET') {
      if (state.failRead > 0) {
        state.failRead--
        return json(503, ['Service Unavailable'])
      }
      if (state.slowRead) {
        const ms = state.slowRead
        state.slowRead = 0
        await new Promise(r => setTimeout(r, ms))
      }
      const vm = state.voicemails.find(v => v.id === Number(m![1]))
      return vm ? json(200, vm) : json(404, ['Resource Not Found'])
    }
    if ((m = /^\/1\.1\/voicemails\/(\d+)$/.exec(path)) && init.method === 'PUT') {
      if (state.refuse.has(Number(m[1]))) return json(400, ['Resource Error - refused'])
      const vm = state.voicemails.find(v => v.id === Number(m![1]))
      if (!vm) return json(404, ['Resource Not Found'])
      if (state.voicemails.some(v => v !== vm && v.number === body.number && v.context === body.context)) return json(400, ['Resource Error - Voicemail already exists'])
      // Another number: wazo-sysconfd's move_voicemail, as its source does it (rm -rf of the target, then mv).
      if (body.number !== vm.number) state.moves.push(`${vm.number}>${body.number}`)
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
  made.push(state)
  /** The mailbox at a person's number, and its name (TwakePhone, or since when it is aside). */
  const boxOf = (userId: string) => state.voicemails.find(v => v.number === numberOf(userId))
  const nameOf = (userId: string) => boxOf(userId)?.name
  const msg = (id: string, over: Partial<Message> = {}): Message => ({ id, folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1, duration: 3, ...over })
  return { state, fetch, boxOf, nameOf, msg }
}
