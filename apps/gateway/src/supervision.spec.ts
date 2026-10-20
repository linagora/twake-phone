import { afterEach, describe, expect, it } from 'vitest'
import { SupervisionError } from '@twake/provider-wazo'
import type { ProviderFactory, SupervisionProvider, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { SupervisedCall, SupervisionMode } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { Supervision, publicRecording, recordingRetentionDaysOf, supervisionFromEnv, supervisorPolicyFromEnv, tenantFolder } from './supervision.js'

const as = (user: string, roles?: string, tenant = 'dev') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant, ...(roles ? { 'x-dev-roles': roles } : {}) })
const SUP = 'twakephone-supervisor'
const ADMIN = 'twakephone-admin'
const CALL = '1792479546.12'
const WAV = Buffer.concat([Buffer.from('RIFF----WAVEfmt '), Buffer.alloc(1000, 1)])

/** What Wazo's side does, in memory: the calls in progress, the files, what was asked of it. */
const fakeSupervision = () => {
  const state = {
    calls: [{ id: CALL, extension: '103', peer: '0100', peerName: 'Standard', state: 'up', startedAt: '2026-10-20T10:00:00.000Z' }] as SupervisedCall[],
    files: new Map<string, Buffer>(),
    started: [] as { id: string; file: { tenant: string; name: string } }[],
    stopped: [] as string[],
    spied: [] as { id: string; supervisor: string; mode: SupervisionMode }[],
    announceFails: false,
    down: false,
    spy: 'answered' as 'answered' | 'refused' | 'never',
    sizeAfterStop: undefined as number | undefined
  }
  const key = (f: { tenant: string; name: string }) => `${f.tenant}/${f.name}`
  const unavailable = () => {
    if (state.down) throw new SupervisionError('down', 'unavailable')
  }
  const provider: SupervisionProvider = {
    id: 'fake',
    async listCalls() {
      unavailable()
      return structuredClone(state.calls)
    },
    async startRecording(call, file) {
      unavailable()
      if (state.announceFails) throw new SupervisionError('the call did not come up', 'refused')
      if (!state.calls.some(c => c.id === call.id)) throw new SupervisionError('gone', 'gone')
      state.started.push({ id: call.id, file })
      state.files.set(key(file), Buffer.from(WAV))
    },
    async stopRecording(call) {
      unavailable()
      state.stopped.push(call.id)
    },
    async spy(call, supervisor, mode) {
      unavailable()
      state.spied.push({ id: call.id, supervisor: supervisor.extension, mode })
      if (state.spy === 'refused') throw new SupervisionError('refused', 'refused')
      if (state.spy === 'never') await new Promise(() => undefined)
    },
    async getRecording(file) {
      unavailable()
      const b = state.files.get(key(file))
      return b ? { contentType: 'audio/wav', size: b.length, body: (async function* () { yield new Uint8Array(b) })() } : undefined
    },
    async statRecording(file) {
      unavailable()
      const b = state.files.get(key(file))
      return b ? { size: state.sizeAfterStop ?? b.length } : undefined
    },
    async deleteRecording(file) {
      unavailable()
      return state.files.delete(key(file))
    },
    async close() {}
  }
  return { state, provider }
}

const apps: { close(): Promise<undefined | void> }[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
})

const setup = async (opts: { retentionDays?: number; withProvider?: boolean } = {}) => {
  process.env.AUTH_MODE = 'dev'
  const store = new MemoryStore()
  await store.upsertMapping({ tenantId: 'dev', userId: 'bdurand', extension: '103', displayName: 'Bob Durand' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'amartin', extension: '101', displayName: 'Alice Martin' })
  await store.upsertMapping({ tenantId: 'dev', userId: 'nolines', extension: '104' })
  const fake = fakeSupervision()
  const telephony: ProviderFactory<unknown> = { type: 'fake', create: () => ({ getStatus: () => 'CONNECTED', getCapabilities: async () => ({}), subscribe: async function* () {}, close: async () => {} }) as unknown as TelephonyProvider }
  const app = await buildApp(new ProviderRegistry(['dev', 'other'].map(tenantId => ({ tenantId, type: 'fake', config: {} })), [telephony]), {
    store,
    admin: { adminRole: ADMIN, adminUsers: new Set() },
    supervisor: { supervisorRole: SUP, supervisorUsers: new Set(['dev:listed']) },
    ...(opts.withProvider === false ? {} : { supervision: () => fake.provider }),
    recordingRetentionDays: opts.retentionDays ?? 30,
    recordingSweepMs: 0,
    supervisionSpyWaitMs: 150,
    supervisionSettleMs: 0
  })
  apps.push(app)
  const get = (url: string, user = 'amartin', roles = SUP) => app.inject({ url: `/api/v1${url}`, headers: as(user, roles) })
  const post = (url: string, payload: unknown, user = 'amartin', roles = SUP) => app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object, headers: as(user, roles) })
  return { app, store, ...fake, get, post }
}

describe('who supervises', () => {
  it('lets in a supervisor, an administrator and a listed user, and no one else: 403, and 401 without a session', async () => {
    const { app, get } = await setup()
    expect((await get('/supervision/calls')).statusCode).toBe(200)
    expect((await get('/supervision/calls', 'root', ADMIN)).statusCode).toBe(200)
    expect((await get('/supervision/calls', 'listed', '')).statusCode).toBe(200)
    for (const [method, url, payload] of [
      ['GET', '/supervision/calls'],
      ['POST', `/supervision/calls/${CALL}/recording`, { action: 'start' }],
      ['POST', `/supervision/calls/${CALL}/spy`, { mode: 'listen' }],
      ['GET', '/supervision/recordings'],
      ['GET', '/supervision/recordings/3f2b8c0e-4d1a-4b7e-9c55-0a1b2c3d4e5f/audio'],
      ['DELETE', '/supervision/recordings/3f2b8c0e-4d1a-4b7e-9c55-0a1b2c3d4e5f'],
      ['GET', '/supervision/log']
    ] as [string, string, unknown?][]) {
      const opts = { method: method as 'GET', url: `/api/v1${url}`, ...(payload ? { payload } : {}) }
      expect((await app.inject({ ...opts, headers: as('bdurand', 'staff') })).statusCode, `${method} ${url}`).toBe(403)
      expect((await app.inject({ ...opts, headers: { ...as('bdurand'), 'x-supervisor': 'true' } })).statusCode, `${method} ${url}`).toBe(403)
      expect((await app.inject(opts)).statusCode, `${method} ${url} anonymous`).toBe(401)
    }
  })

  it('says it in /me and /capabilities, only to those who may, and only with a supervision server', async () => {
    const { get } = await setup()
    expect((await get('/me')).json().features.supervision).toBe(true)
    expect((await get('/me', 'bdurand', 'staff')).json().features.supervision).toBeUndefined()
    expect((await get('/capabilities')).json().supervision).toBe(true)
    expect((await get('/capabilities', 'bdurand', 'staff')).json().supervision).toBeUndefined()
    const none = await setup({ withProvider: false })
    expect((await none.get('/me')).json().features.supervision).toBeUndefined()
    expect((await none.get('/supervision/calls')).statusCode).toBe(501)
    expect((await none.get('/supervision/recordings')).statusCode).toBe(501)
  })

  it('reads SUPERVISOR_ROLE and SUPERVISOR_USERS, a bare user id being in the default tenant', () => {
    expect([...supervisorPolicyFromEnv({ DEFAULT_TENANT: 'acme', SUPERVISOR_USERS: ' alice, other:bob ,' }).supervisorUsers]).toEqual(['acme:alice', 'other:bob'])
    expect(supervisorPolicyFromEnv({}).supervisorRole).toBe('twakephone-supervisor')
    expect(supervisorPolicyFromEnv({ SUPERVISOR_ROLE: 'chef' }).supervisorRole).toBe('chef')
  })
})

describe('the calls in progress', () => {
  it('lists them with the name the directory gives of the line and whether they are being recorded', async () => {
    const { get, post } = await setup()
    expect((await get('/supervision/calls')).json().items).toEqual([{ id: CALL, extension: '103', peer: '0100', peerName: 'Standard', state: 'up', startedAt: '2026-10-20T10:00:00.000Z', displayName: 'Bob Durand' }])
    await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })
    expect((await get('/supervision/calls')).json().items[0].recording).toMatchObject({ startedAt: expect.any(String) })
  })

  it('says the telephony server is not available when it does not answer', async () => {
    const { get, state } = await setup()
    state.down = true
    const r = await get('/supervision/calls')
    expect(r.statusCode).toBe(502)
    expect(r.json().code).toBe('SUPERVISION_FAILED')
  })
})

describe('recording', () => {
  it('announces and records a call, keeps the record and the journal, closes it ready on the stop, and refuses a second recording of the call', async () => {
    const { get, post, state, store } = await setup()
    const started = await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })
    expect(started.statusCode).toBe(201)
    const rec = started.json()
    expect(rec).toMatchObject({ extension: '103', displayName: 'Bob Durand', state: 'recording', startedBy: 'amartin' })
    expect(rec.callId).toBeUndefined()
    expect(state.started).toEqual([{ id: CALL, file: { tenant: 'dev', name: rec.id } }])
    expect((await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json().code).toBe('RECORDING_UNDER_WAY')
    expect(await store.getRecording('dev', rec.id)).toMatchObject({ userId: 'bdurand', callId: CALL })
    const stopped = await post(`/supervision/calls/${CALL}/recording`, { action: 'stop' })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json()).toMatchObject({ id: rec.id, state: 'ready', sizeBytes: WAV.length, durationSec: expect.any(Number) })
    expect(state.stopped).toEqual([CALL])
    expect((await post(`/supervision/calls/${CALL}/recording`, { action: 'stop' })).json().code).toBe('NO_RECORDING')
    expect((await get('/supervision/recordings')).json().items.map((r: { id: string }) => r.id)).toEqual([rec.id])
    expect((await get('/supervision/log')).json().items.map((e: { action: string }) => e.action)).toEqual(['record-stop', 'record-start'])
  })

  it('records nothing and keeps a failed record when the announcement does not go, and says the call is gone when it is', async () => {
    const { post, get, state } = await setup()
    state.announceFails = true
    const r = await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })
    expect(r.statusCode).toBe(502)
    expect(state.started).toEqual([])
    expect((await get('/supervision/recordings')).json().items.map((x: { state: string }) => x.state)).toEqual(['failed'])
    state.announceFails = false
    // The failed one does not stand in the way of another try.
    expect((await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).statusCode).toBe(201)
    expect((await post('/supervision/calls/1792479546.99/recording', { action: 'start' })).statusCode).toBe(404)
    expect((await post('/supervision/calls/not-a-call/recording', { action: 'start' })).statusCode).toBe(404)
    expect((await post(`/supervision/calls/${CALL}/recording`, { action: 'pause' })).statusCode).toBe(400)
  })

  it('closes the recording of a call that ended without a stop, ready with its file, the next time anyone looks', async () => {
    const { get, post, state } = await setup()
    const rec = (await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json()
    state.calls = []
    const list = (await get('/supervision/recordings')).json().items
    expect(list).toEqual([expect.objectContaining({ id: rec.id, state: 'ready', sizeBytes: WAV.length })])
    expect(list[0].endedAt).toBeTruthy()
  })

  it('fails a recording that kept no sound, and leaves one under way when the recordings server does not answer', async () => {
    const { get, post, state } = await setup()
    const rec = (await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json()
    state.calls = []
    state.sizeAfterStop = 44
    expect((await get('/supervision/recordings')).json().items[0]).toMatchObject({ id: rec.id, state: 'failed' })
    const again = await setup()
    const second = (await again.post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json()
    again.state.calls = []
    again.state.down = true
    expect((await again.get('/supervision/recordings')).statusCode).toBe(200)
    again.state.down = false
    expect((await again.store.getRecording('dev', second.id))?.state).toBe('recording')
    expect((await again.get('/supervision/recordings')).json().items[0].state).toBe('ready')
  })

  it('gives the audio of a recording that is ready, journals each listening, and nothing of another tenant or of one not ready', async () => {
    const { app, get, post, state } = await setup()
    const rec = (await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json()
    expect((await get(`/supervision/recordings/${rec.id}/audio`)).statusCode).toBe(404)
    await post(`/supervision/calls/${CALL}/recording`, { action: 'stop' })
    const audio = await get(`/supervision/recordings/${rec.id}/audio`)
    expect(audio.statusCode).toBe(200)
    expect(audio.headers['content-type']).toBe('audio/wav')
    expect(audio.headers['cache-control']).toBe('private, no-store')
    expect(audio.rawPayload.equals(WAV)).toBe(true)
    expect((await get(`/supervision/recordings/${rec.id}/audio`, 'listed', '')).statusCode).toBe(200)
    const log = (await get('/supervision/log')).json().items
    expect(log.filter((e: { action: string }) => e.action === 'listen-recording')).toHaveLength(2)
    expect(log.find((e: { action: string }) => e.action === 'listen-recording')).toMatchObject({ actor: 'listed', extension: '103', recordingId: rec.id })
    expect(log.find((e: { action: string }) => e.action === 'record-start')).toMatchObject({ actor: 'amartin', actorName: 'Alice Martin' })
    // Another organisation's supervisor sees none of it, not even that it exists.
    const other = { headers: as('amartin', SUP, 'other') }
    expect((await app.inject({ url: `/api/v1/supervision/recordings/${rec.id}/audio`, ...other })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/v1/supervision/recordings', ...other })).json().items).toEqual([])
    expect((await app.inject({ url: '/api/v1/supervision/log', ...other })).json().items).toEqual([])
    state.down = true
    expect((await get(`/supervision/recordings/${rec.id}/audio`)).statusCode).toBe(502)
  })

  it('lets only an administrator delete a recording, which is then purged: no audio, the record and the journal stay', async () => {
    const { get, post, app, state } = await setup()
    const rec = (await post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json()
    const del = (roles: string) => app.inject({ method: 'DELETE', url: `/api/v1/supervision/recordings/${rec.id}`, headers: as('root', roles) })
    expect((await del(ADMIN)).statusCode).toBe(409)
    await post(`/supervision/calls/${CALL}/recording`, { action: 'stop' })
    expect((await del(SUP)).statusCode).toBe(403)
    expect((await del(ADMIN)).statusCode).toBe(204)
    expect(state.files.size).toBe(0)
    expect((await del(ADMIN)).statusCode).toBe(404)
    expect((await get('/supervision/recordings')).json().items[0]).toMatchObject({ id: rec.id, state: 'purged' })
    expect((await get(`/supervision/recordings/${rec.id}/audio`)).statusCode).toBe(404)
    expect((await get('/supervision/log')).json().items[0]).toMatchObject({ action: 'delete-recording', actor: 'root' })
  })
})

describe('supervising', () => {
  it.each(['listen', 'whisper', 'barge'] as const)('calls the supervisor\'s own line into the call (%s) and journals the request', async mode => {
    const { post, get, state } = await setup()
    const r = await post(`/supervision/calls/${CALL}/spy`, { mode })
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual({ state: 'answered' })
    expect(state.spied).toEqual([{ id: CALL, supervisor: '101', mode }])
    expect((await get('/supervision/log')).json().items[0]).toMatchObject({ action: `spy-${mode}`, actor: 'amartin', extension: '103' })
  })

  it('says it still rings when the supervisor has not answered, and refuses their own call, a mode that is none, a missing line and a call that is gone', async () => {
    const { post, state } = await setup()
    state.spy = 'never'
    expect((await post(`/supervision/calls/${CALL}/spy`, { mode: 'listen' })).json()).toEqual({ state: 'ringing' })
    expect((await post(`/supervision/calls/${CALL}/spy`, { mode: 'whisper' }, 'bdurand')).json().code).toBe('OWN_CALL')
    expect((await post(`/supervision/calls/${CALL}/spy`, { mode: 'shout' })).statusCode).toBe(400)
    expect((await post(`/supervision/calls/${CALL}/spy`, { mode: 'listen' }, 'nobody-has-no-extension')).json().code).toBe('NO_EXTENSION')
    expect((await post('/supervision/calls/1792479546.99/spy', { mode: 'listen' })).statusCode).toBe(404)
    state.spy = 'refused'
    const r = await post(`/supervision/calls/${CALL}/spy`, { mode: 'listen' })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('SPY_REFUSED')
  })
})

describe('what is kept, and for how long', () => {
  const recordAndStop = async (s: Awaited<ReturnType<typeof setup>>) => {
    const rec = (await s.post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json()
    await s.post(`/supervision/calls/${CALL}/recording`, { action: 'stop' })
    return rec.id as string
  }
  /** Ages a recording in the store: the retention counts from the beginning of the call. */
  const age = async (s: Awaited<ReturnType<typeof setup>>, id: string, startedAt: string) =>
    (s.store as unknown as { recordings: Map<string, unknown> }).recordings.set(`dev\u0000${id}`, { ...(await s.store.getRecording('dev', id)), startedAt })
  const sweeper = (s: Awaited<ReturnType<typeof setup>>, retentionDays: number) =>
    new Supervision({
      store: s.store,
      provider: () => s.provider,
      retentionDays,
      isSupervisor: () => true,
      isAdmin: () => true,
      authenticate: async () => ({ userId: 'x', tenantId: 'dev' }),
      resolve: async () => ({ id: 'x', tenantId: 'dev', displayName: 'x' }),
      userIdForExtension: async () => undefined,
      log: { warn() {}, error() {}, info() {} },
      settleMs: 0
    })

  it('erases the audio of the recordings past their days, marks them purged and journals it, and keeps the others', async () => {
    const s = await setup()
    const old = await recordAndStop(s)
    s.state.calls = [{ ...s.state.calls[0]! }]
    const young = await recordAndStop(s)
    await age(s, old, new Date(Date.now() - 31 * 86_400_000).toISOString())
    await sweeper(s, 30).sweep()
    expect([...s.state.files.keys()].map(k => k.split('/')[1])).toEqual([young])
    expect((await s.store.getRecording('dev', old))?.state).toBe('purged')
    expect((await s.store.getRecording('dev', young))?.state).toBe('ready')
    expect((await s.store.listSupervisionLog('dev', 1))[0]).toMatchObject({ actor: 'system', action: 'purge', recordingId: old })
  })

  it('keeps everything with 0 days, and tries again at the next sweep when the recordings server does not answer', async () => {
    const s = await setup()
    const id = await recordAndStop(s)
    await age(s, id, '2020-01-01T00:00:00.000Z')
    await sweeper(s, 0).sweep()
    expect(s.state.files.size).toBe(1)
    s.state.down = true
    await sweeper(s, 30).sweep()
    expect((await s.store.getRecording('dev', id))?.state).toBe('ready')
    expect(s.state.files.size).toBe(1)
    s.state.down = false
    await sweeper(s, 30).sweep()
    expect((await s.store.getRecording('dev', id))?.state).toBe('purged')
    expect(s.state.files.size).toBe(0)
  })

  it('closes, by the sweep, a recording whose call ended and that nobody looked at', async () => {
    const s = await setup()
    const rec = (await s.post(`/supervision/calls/${CALL}/recording`, { action: 'start' })).json()
    s.state.calls = []
    await sweeper(s, 30).sweep()
    expect((await s.store.getRecording('dev', rec.id))?.state).toBe('ready')
  })

  it('erases the recordings of a person who erases their history, and says how many', async () => {
    const s = await setup()
    const id = await recordAndStop(s)
    const bob = await s.app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('bdurand', 'staff') })
    expect(bob.statusCode).toBe(200)
    expect(bob.json()).toMatchObject({ recordings: 1 })
    await until(async () => (await s.store.getRecording('dev', id))?.state === 'purged')
    expect(s.state.files.size).toBe(0)
    expect((await s.store.listSupervisionLog('dev', 1))[0]).toMatchObject({ action: 'erase', recordingId: id })
    // Someone who has none says nothing of it.
    const alice = await s.app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('amartin', 'staff') })
    expect(alice.json().recordings).toBeUndefined()
  })
})

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('not reached')
}

describe('the environment', () => {
  const env = { WAZO_AMI: '127.0.0.1:5038', WAZO_AMI_USER: 'twake', WAZO_AMI_PASSWORD: 'pw', WAZO_AMI_ORIGINATE_USER: 'twake-originate', WAZO_AMI_ORIGINATE_PASSWORD: 'pw2', WAZO_RECORDINGS_URL: 'http://127.0.0.1:8670', WAZO_RECORDINGS_TOKEN: 'a'.repeat(40) }

  it('makes the supervision with its AMI and its recordings server, none without them, and refuses what is half set or wrong', () => {
    expect(supervisionFromEnv({})).toBeUndefined()
    expect(supervisionFromEnv(env)?.id).toBe('wazo')
    expect(() => supervisionFromEnv({ ...env, WAZO_AMI: 'nowhere' })).toThrow('WAZO_AMI')
    expect(() => supervisionFromEnv({ ...env, WAZO_AMI: 'host:99999' })).toThrow('WAZO_AMI')
    expect(() => supervisionFromEnv({ ...env, WAZO_AMI_PASSWORD: '' })).toThrow('WAZO_AMI_USER')
    expect(() => supervisionFromEnv({ ...env, WAZO_AMI_ORIGINATE_PASSWORD: '' })).toThrow('WAZO_AMI_ORIGINATE_USER')
    expect(() => supervisionFromEnv({ ...env, WAZO_AMI_ORIGINATE_USER: 'twake' })).toThrow('must not be')
    expect(() => supervisionFromEnv({ ...env, WAZO_RECORDINGS_URL: 'ftp://x' })).toThrow('WAZO_RECORDINGS_URL')
    expect(() => supervisionFromEnv({ ...env, WAZO_RECORDINGS_URL: 'http://u:p@x' })).toThrow('credentials')
    expect(() => supervisionFromEnv({ ...env, WAZO_RECORDINGS_TOKEN: 'short' })).toThrow('WAZO_RECORDINGS_TOKEN')
    expect(() => supervisionFromEnv({ ...env, RECORDING_NOTICE_SOUND: '../x' })).toThrow('sound')
    expect(() => supervisionFromEnv({ WAZO_RECORDINGS_URL: env.WAZO_RECORDINGS_URL })).toThrow('WAZO_AMI')
  })

  it('reads RECORDING_RETENTION_DAYS (30 by default, 0 for good) and refuses what is not a number of days', () => {
    expect(recordingRetentionDaysOf({})).toBe(30)
    expect(recordingRetentionDaysOf({ RECORDING_RETENTION_DAYS: '0' })).toBe(0)
    expect(recordingRetentionDaysOf({ RECORDING_RETENTION_DAYS: '90' })).toBe(90)
    for (const bad of ['-1', '1.5', 'x', '3651']) expect(() => recordingRetentionDaysOf({ RECORDING_RETENTION_DAYS: bad })).toThrow('RECORDING_RETENTION_DAYS')
  })

  it('names the folder of a tenant after it when it can be one, else by a print of it, and gives the length of a recording', () => {
    expect(tenantFolder('acme-1')).toBe('acme-1')
    expect(tenantFolder('../x')).toMatch(/^t-[0-9a-f]{32}$/)
    expect(tenantFolder('../x')).not.toBe(tenantFolder('../y'))
    expect(publicRecording({ id: 'i', tenantId: 't', callId: 'c', extension: '103', startedBy: 'a', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:01:05.400Z', state: 'ready' })).toEqual({ id: 'i', extension: '103', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:01:05.400Z', durationSec: 65, state: 'ready', startedBy: 'a' })
  })
})
