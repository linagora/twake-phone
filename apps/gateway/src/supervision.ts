import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SupervisionError, WazoSupervision } from '@twake/provider-wazo'
import type { SupervisionProvider } from '@twake/telephony-provider-sdk'
import type { Recording, SupervisedCall, SupervisionLogEntry, User } from '@twake/telephony-types'
import type { Identity } from './auth.js'
import type { RecordingRecord, Store } from './store/types.js'

// Recording and supervision of the calls that have a channel at Wazo (step 11d, ADR 0029): who may (a supervisor), what
// is kept (the record, never the voice, in the store; the audio on the recordings server), for how long, and the journal.
// The routes are `/api/v1/supervision/...`; Wazo's own words stay in provider-wazo.

/** The role that makes a supervisor, besides an administrator, as the identity provider writes it. */
export const DEFAULT_SUPERVISOR_ROLE = 'twakephone-supervisor'

export interface SupervisorPolicy {
  supervisorRole: string
  /** "tenant:user" entries; a bare user id means the default tenant. */
  supervisorUsers: Set<string>
}

/** SUPERVISOR_ROLE (default twakephone-supervisor) and SUPERVISOR_USERS ("alice,acme:bob": a bare id is in DEFAULT_TENANT). */
export const supervisorPolicyFromEnv = (env: NodeJS.ProcessEnv): SupervisorPolicy => {
  const defaultTenant = env.DEFAULT_TENANT ?? (env.AUTH_MODE === 'dev' ? 'dev' : 'default')
  const supervisorUsers = new Set(
    (env.SUPERVISOR_USERS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(entry => (entry.includes(':') ? entry : `${defaultTenant}:${entry}`))
  )
  return { supervisorRole: env.SUPERVISOR_ROLE || DEFAULT_SUPERVISOR_ROLE, supervisorUsers }
}

export const isSupervisor = (identity: Identity, policy: SupervisorPolicy, administrator: boolean): boolean =>
  administrator || (identity.roles ?? []).includes(policy.supervisorRole) || policy.supervisorUsers.has(`${identity.tenantId}:${identity.userId}`)

/**
 * RECORDING_RETENTION_DAYS: how long a recording is kept (30 days by default; 0: no purge by age, which is discouraged).
 * Refused at the start when it is not a number of days.
 */
export const recordingRetentionDaysOf = (env: NodeJS.ProcessEnv) => {
  const raw = env.RECORDING_RETENTION_DAYS
  if (raw === undefined || raw === '') return 30
  if (!/^[0-9]+$/.test(raw) || Number(raw) > 3650) throw new Error('RECORDING_RETENTION_DAYS must be a whole number of days from 0 to 3650')
  return Number(raw)
}

/**
 * Supervision from the environment, or nothing when it is not set (no supervision, the routes say so):
 *   WAZO_AMI, WAZO_AMI_USER, WAZO_AMI_PASSWORD
 *                          the AMI of Wazo's Asterisk (host:port) and the Gateway's account in it, for the calls and
 *                          MixMonitor (`system`, `reporting`);
 *   WAZO_AMI_ORIGINATE_USER, WAZO_AMI_ORIGINATE_PASSWORD
 *                          its other account there, for Originate only (`originate`, read `call`): never the same as
 *                          the first, whose `system` would let an Originate run any application;
 *   WAZO_RECORDINGS_URL, WAZO_RECORDINGS_TOKEN
 *                          the recordings server (docker/wazo/recordings.py, or its equal) and its bearer token (32 to
 *                          128 letters, digits, dots, dashes or underscores);
 *   RECORDING_NOTICE_SOUND the announcement a recording starts with, a sound of Asterisk (custom/twake-recording-notice);
 *   RECORDING_RETENTION_DAYS see recordingRetentionDaysOf.
 */
export const supervisionFromEnv = (env: NodeJS.ProcessEnv): WazoSupervision | undefined => {
  if (!env.WAZO_AMI && !env.WAZO_RECORDINGS_URL) return undefined
  const ami = /^(.+):([0-9]{1,5})$/.exec(env.WAZO_AMI ?? '')
  if (!ami || Number(ami[2]) < 1 || Number(ami[2]) > 65535) throw new Error('Supervision: WAZO_AMI must be host:port (the AMI of the Asterisk of Wazo)')
  if (!env.WAZO_AMI_USER || !env.WAZO_AMI_PASSWORD) throw new Error('Supervision: WAZO_AMI_USER and WAZO_AMI_PASSWORD are required with WAZO_AMI')
  if (!env.WAZO_AMI_ORIGINATE_USER || !env.WAZO_AMI_ORIGINATE_PASSWORD) throw new Error('Supervision: WAZO_AMI_ORIGINATE_USER and WAZO_AMI_ORIGINATE_PASSWORD (a second account, for Originate only) are required with WAZO_AMI')
  if (env.WAZO_AMI_ORIGINATE_USER === env.WAZO_AMI_USER) throw new Error('Supervision: WAZO_AMI_ORIGINATE_USER must not be WAZO_AMI_USER: the account that holds `system` must not originate')
  let url: URL
  try {
    url = new URL(env.WAZO_RECORDINGS_URL ?? '')
  } catch {
    throw new Error('Supervision: WAZO_RECORDINGS_URL must be the URL of the recordings server')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Supervision: WAZO_RECORDINGS_URL must be http: or https:, without credentials')
  if (!/^[A-Za-z0-9._-]{32,128}$/.test(env.WAZO_RECORDINGS_TOKEN ?? '')) throw new Error('Supervision: WAZO_RECORDINGS_TOKEN (32 to 128 letters, digits, dots, dashes or underscores) is required with WAZO_RECORDINGS_URL')
  return new WazoSupervision({
    ami: { host: ami[1] as string, port: Number(ami[2]), username: env.WAZO_AMI_USER, password: env.WAZO_AMI_PASSWORD },
    originate: { host: ami[1] as string, port: Number(ami[2]), username: env.WAZO_AMI_ORIGINATE_USER, password: env.WAZO_AMI_ORIGINATE_PASSWORD },
    recordingsUrl: env.WAZO_RECORDINGS_URL as string,
    recordingsToken: env.WAZO_RECORDINGS_TOKEN as string,
    ...(env.RECORDING_NOTICE_SOUND ? { noticeSound: env.RECORDING_NOTICE_SOUND } : {})
  })
}

/** The folder of a tenant's recordings at the recordings server: its id when that is a name, else a print of it. */
export const tenantFolder = (tenantId: string) => (/^[A-Za-z0-9_-]{1,64}$/.test(tenantId) ? tenantId : `t-${createHash('sha256').update(tenantId).digest('hex').slice(0, 32)}`)

const secondsBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))

/** A recording as the API gives it: no call id, no tenant, its length once it ended. */
export const publicRecording = (r: RecordingRecord): Recording => ({
  id: r.id,
  extension: r.extension,
  ...(r.displayName ? { displayName: r.displayName } : {}),
  startedAt: r.startedAt,
  ...(r.endedAt ? { endedAt: r.endedAt, durationSec: secondsBetween(r.startedAt, r.endedAt) } : {}),
  state: r.state,
  startedBy: r.startedBy,
  ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {})
})

const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) })
/** A WAV with no sound in it: its header (44 bytes) only. */
const EMPTY_WAV = 44
/** How long the Gateway keeps the journal: a year, and a month. */
const LOG_KEPT_MS = 395 * 86_400_000
/** How many recordings a sweep takes in hand. */
const SWEEP_BATCH = 100

export interface SupervisionDeps {
  store: Store
  provider: (tenantId: string) => SupervisionProvider | undefined
  retentionDays: number
  /** Who may: the identity, the policy, and whether the platform's administrator policy says it is one. */
  isSupervisor: (identity: Identity) => boolean
  isAdmin: (identity: Identity) => boolean
  authenticate: (req: FastifyRequest) => Promise<Identity>
  resolve: (identity: Identity) => Promise<User>
  userIdForExtension: (tenantId: string, extension: string) => Promise<string | undefined>
  log: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void; info(obj: object, msg: string): void }
  /** How long the calls listed are kept for the screens that ask at once. Default: 2 s. */
  callsCacheMs?: number
  /** How long a closing waits for the file to be written whole. Default: 2 s. */
  settleMs?: number
  /** How long a supervisor's call is waited for before saying it still rings. Default: 6 s. */
  spyWaitMs?: number
}

/**
 * The supervision of the tenants: the routes, the closing of the recordings whose call ended, and the sweep (retention,
 * erasure). One per Gateway; every function is safe to run on several Gateways at once.
 */
export class Supervision {
  private readonly cache = new Map<string, { at: number; calls: Promise<SupervisedCall[]> }>()
  private timer: NodeJS.Timeout | undefined
  private sweeping: Promise<void> | undefined
  private stopped = false

  constructor(private readonly deps: SupervisionDeps) {}

  private file(r: { tenantId: string; id: string }) {
    return { tenant: tenantFolder(r.tenantId), name: r.id }
  }

  private provider(tenantId: string) {
    const p = this.deps.provider(tenantId)
    if (!p) throw fail(501, 'Supervision is not available on this platform', 'SUPERVISION_UNAVAILABLE')
    return p
  }

  private unavailable(err: unknown): never {
    if (err instanceof SupervisionError && err.code === 'gone') throw fail(404, 'Call not found', 'CALL_GONE')
    this.deps.log.warn({ err }, 'supervision failed')
    throw fail(502, 'The telephony server is not available, try again later', 'SUPERVISION_FAILED')
  }

  /** The calls in progress at Wazo, shared between the readers of the same moment. */
  private async calls(tenantId: string, p: SupervisionProvider): Promise<SupervisedCall[]> {
    const hit = this.cache.get(tenantId)
    if (hit && Date.now() - hit.at < (this.deps.callsCacheMs ?? 2000)) return hit.calls
    const calls = p.listCalls()
    this.cache.set(tenantId, { at: Date.now(), calls })
    calls.catch(() => this.cache.delete(tenantId))
    return calls
  }

  private async journal(tenantId: string, entry: Omit<SupervisionLogEntry, 'at'>) {
    await this.deps.store.addSupervisionLog(tenantId, { at: new Date().toISOString(), ...entry }).catch((err: unknown) => this.deps.log.error({ err }, 'supervision journal not written'))
  }

  /** Closes the recording of a call that ended (or was stopped): ready when the file has sound, failed when it has none. */
  private async close(r: RecordingRecord, p: SupervisionProvider) {
    let size: number | undefined
    let last = -1
    // The file is closed a moment after the stop: its size is read until it has sound and stopped growing, or the wait is over.
    const until = Date.now() + (this.deps.settleMs ?? 2000)
    for (;;) {
      // A recordings server that does not answer leaves the recording under way (closed at the next look), never failed.
      size = (await p.statRecording(this.file(r)))?.size
      if ((size ?? 0) > EMPTY_WAV && size === last) break
      last = size ?? -1
      if (Date.now() >= until) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const ok = (size ?? 0) > EMPTY_WAV
    return this.deps.store.updateRecording(r.tenantId, r.id, ['recording'], { state: ok ? 'ready' : 'failed', endedAt: new Date().toISOString(), ...(size !== undefined ? { sizeBytes: size } : {}) })
  }

  /** Closes the recordings under way whose call is no longer there. */
  private async settle(tenantId: string | undefined, p: SupervisionProvider, calls?: SupervisedCall[]) {
    const underWay = await this.deps.store.listRecordingsUnderWay(tenantId)
    if (!underWay.length) return
    const alive = new Set((calls ?? (await p.listCalls())).map(c => c.id))
    for (const r of underWay) if (!alive.has(r.callId)) await this.close(r, p)
  }

  /** Erases the audio of the recordings past their days or asked to be erased, then marks them purged. */
  async sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping
    this.sweeping = (async () => {
      const store = this.deps.store
      // Under way, their call gone (nobody stopped them): closed first, per tenant, so that retention reaches them.
      const underWay = await store.listRecordingsUnderWay()
      for (const tenantId of new Set(underWay.map(r => r.tenantId))) {
        const p = this.deps.provider(tenantId)
        if (p) await this.settle(tenantId, p).catch((err: unknown) => this.deps.log.warn({ err, tenantId }, 'recordings under way not closed'))
      }
      const before = this.deps.retentionDays > 0 ? new Date(Date.now() - this.deps.retentionDays * 86_400_000).toISOString() : null
      for (const r of await store.listRecordingsToErase(before, SWEEP_BATCH)) {
        const p = this.deps.provider(r.tenantId)
        if (!p || this.stopped) continue
        try {
          // Already gone (false) is as good as erased.
          await p.deleteRecording(this.file(r))
          const done = await store.updateRecording(r.tenantId, r.id, ['ready', 'failed', 'erasing'], { state: 'purged' })
          if (done) await this.journal(r.tenantId, { actor: 'system', action: r.state === 'erasing' ? 'erase' : 'purge', ...(r.extension ? { extension: r.extension } : {}), recordingId: r.id })
        } catch (err) {
          this.deps.log.warn({ err, recording: r.id }, 'recording not erased, tried again at the next sweep')
        }
      }
      await store.purgeSupervisionLog(new Date(Date.now() - LOG_KEPT_MS).toISOString()).catch((err: unknown) => this.deps.log.error({ err }, 'supervision journal not purged'))
    })().finally(() => {
      this.sweeping = undefined
    })
    return this.sweeping
  }

  start(everyMs: number) {
    if (everyMs <= 0) return
    this.timer = setInterval(() => void this.sweep().catch((err: unknown) => this.deps.log.error({ err }, 'recordings not swept')), everyMs)
    this.timer.unref()
  }

  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    await this.sweeping
  }

  routes(v1: FastifyInstance) {
    const { store } = this.deps
    const supervisor = async (req: FastifyRequest) => {
      const identity = await this.deps.authenticate(req)
      if (!this.deps.isSupervisor(identity)) throw fail(403, 'Supervisors only')
      const user = await this.deps.resolve(identity)
      return { identity, user, provider: this.provider(user.tenantId) }
    }
    const CALL = /^[0-9]{1,12}\.[0-9]{1,12}$/
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

    v1.get('/supervision/calls', async req => {
      const { user, provider } = await supervisor(req)
      const calls = await this.calls(user.tenantId, provider).catch(err => this.unavailable(err))
      await this.settle(user.tenantId, provider, calls).catch((err: unknown) => req.log.warn({ err }, 'recordings under way not closed'))
      const underWay = new Map((await store.listRecordingsUnderWay(user.tenantId)).map(r => [r.callId, r] as const))
      const items = await Promise.all(
        calls.map(async c => {
          const name = (await store.getMappingByExtension(user.tenantId, c.extension))?.displayName
          const rec = underWay.get(c.id)
          return { ...c, ...(name ? { displayName: name } : {}), ...(rec ? { recording: { id: rec.id, startedAt: rec.startedAt } } : {}) }
        })
      )
      return { items }
    })

    v1.post<{ Params: { id: string }; Body: { action?: string } | undefined }>('/supervision/calls/:id/recording', async (req, reply) => {
      const { identity, user, provider } = await supervisor(req)
      const action = req.body?.action
      if (action !== 'start' && action !== 'stop') throw fail(400, 'action must be start or stop')
      if (!CALL.test(req.params.id)) throw fail(404, 'Call not found', 'CALL_GONE')
      const tenantId = user.tenantId
      if (action === 'stop') {
        const rec = await store.getRecordingUnderWay(tenantId, req.params.id)
        if (!rec) throw fail(404, 'No recording of this call', 'NO_RECORDING')
        await provider.stopRecording({ id: req.params.id }).catch(err => this.unavailable(err))
        const closed = (await this.close(rec, provider).catch(err => this.unavailable(err))) ?? (await store.getRecording(tenantId, rec.id)) ?? rec
        await this.journal(tenantId, { actor: identity.userId, action: 'record-stop', extension: rec.extension, recordingId: rec.id })
        return reply.send(publicRecording(closed))
      }
      const call = (await this.calls(tenantId, provider).catch(err => this.unavailable(err))).find(c => c.id === req.params.id)
      if (!call) throw fail(404, 'Call not found', 'CALL_GONE')
      const holder = await this.deps.userIdForExtension(tenantId, call.extension)
      const name = (await store.getMappingByExtension(tenantId, call.extension))?.displayName
      const rec: RecordingRecord = {
        id: randomUUID(),
        tenantId,
        extension: call.extension,
        ...(holder ? { userId: holder } : {}),
        ...(name ? { displayName: name } : {}),
        callId: call.id,
        startedBy: identity.userId,
        startedAt: new Date().toISOString(),
        state: 'recording'
      }
      // Reserved first: a call is recorded once at a time, whatever Gateway and screen ask.
      try {
        await store.addRecording(rec)
      } catch {
        throw fail(409, 'This call is being recorded', 'RECORDING_UNDER_WAY')
      }
      try {
        await provider.startRecording({ id: call.id }, this.file(rec))
      } catch (err) {
        await store.updateRecording(tenantId, rec.id, ['recording'], { state: 'failed', endedAt: new Date().toISOString() }).catch(() => undefined)
        return this.unavailable(err)
      }
      await this.journal(tenantId, { actor: identity.userId, action: 'record-start', extension: call.extension, recordingId: rec.id })
      return reply.code(201).send(publicRecording(rec))
    })

    v1.post<{ Params: { id: string }; Body: { mode?: string } | undefined }>('/supervision/calls/:id/spy', async (req, reply) => {
      const { identity, user, provider } = await supervisor(req)
      const mode = req.body?.mode
      if (mode !== 'listen' && mode !== 'whisper' && mode !== 'barge') throw fail(400, 'mode must be listen, whisper or barge')
      if (!CALL.test(req.params.id)) throw fail(404, 'Call not found', 'CALL_GONE')
      if (!user.extension) throw fail(409, 'You have no extension: the call to supervise you is made to it', 'NO_EXTENSION')
      const call = (await this.calls(user.tenantId, provider).catch(err => this.unavailable(err))).find(c => c.id === req.params.id)
      if (!call) throw fail(404, 'Call not found', 'CALL_GONE')
      if (call.extension === user.extension) throw fail(409, 'You cannot supervise your own call', 'OWN_CALL')
      await this.journal(user.tenantId, { actor: identity.userId, action: `spy-${mode}` as SupervisionLogEntry['action'], extension: call.extension })
      const joined = provider.spy({ id: call.id }, { extension: user.extension }, mode).then(() => 'answered' as const)
      // The refusals come at once (no line, the call over); a supervisor who has not answered yet keeps ringing.
      const outcome = await Promise.race([joined, new Promise<'ringing'>(resolve => setTimeout(() => resolve('ringing'), this.deps.spyWaitMs ?? 6000).unref())]).catch(err => {
        if (err instanceof SupervisionError && err.code === 'refused') throw fail(409, 'Your line did not take the call: is your phone connected?', 'SPY_REFUSED')
        return this.unavailable(err)
      })
      if (outcome === 'ringing') joined.catch((err: unknown) => req.log.info({ err }, 'supervision call not answered'))
      return reply.code(202).send({ state: outcome })
    })

    v1.get<{ Querystring: { limit?: string } }>('/supervision/recordings', async req => {
      const { user, provider } = await supervisor(req)
      await this.settle(user.tenantId, provider).catch((err: unknown) => req.log.warn({ err }, 'recordings under way not closed'))
      const limit = Number(req.query.limit)
      return { items: (await store.listRecordings(user.tenantId, Number.isInteger(limit) && limit > 0 ? limit : 50)).map(publicRecording) }
    })

    v1.get<{ Params: { id: string } }>('/supervision/recordings/:id/audio', async (req, reply) => {
      const { identity, user, provider } = await supervisor(req)
      const rec = UUID.test(req.params.id) ? await store.getRecording(user.tenantId, req.params.id) : null
      if (!rec || rec.state !== 'ready') throw fail(404, 'Recording not found')
      const audio = await provider.getRecording(this.file(rec)).catch(err => this.unavailable(err))
      if (!audio) throw fail(404, 'Recording not found')
      await this.journal(user.tenantId, { actor: identity.userId, action: 'listen-recording', extension: rec.extension, recordingId: rec.id })
      const body = Readable.from(audio.body, { objectMode: false })
      body.on('error', err => req.log.warn({ err }, 'recording not sent whole'))
      reply.header('content-type', audio.contentType).header('cache-control', 'private, no-store')
      if (audio.size !== undefined) reply.header('content-length', String(audio.size))
      return reply.send(body)
    })

    v1.delete<{ Params: { id: string } }>('/supervision/recordings/:id', async (req, reply) => {
      const identity = await this.deps.authenticate(req)
      if (!this.deps.isAdmin(identity)) throw fail(403, 'Administrators only')
      const user = await this.deps.resolve(identity)
      const provider = this.provider(user.tenantId)
      const rec = UUID.test(req.params.id) ? await store.getRecording(user.tenantId, req.params.id) : null
      if (!rec || rec.state === 'purged') throw fail(404, 'Recording not found')
      if (rec.state === 'recording') throw fail(409, 'This recording is under way: stop it first', 'RECORDING_UNDER_WAY')
      await provider.deleteRecording(this.file(rec)).catch(err => this.unavailable(err))
      await store.updateRecording(user.tenantId, rec.id, ['ready', 'failed', 'erasing'], { state: 'purged' })
      await this.journal(user.tenantId, { actor: identity.userId, action: 'delete-recording', extension: rec.extension, recordingId: rec.id })
      return reply.code(204).send()
    })

    v1.get<{ Querystring: { limit?: string } }>('/supervision/log', async req => {
      const { user } = await supervisor(req)
      const limit = Number(req.query.limit)
      const entries = await store.listSupervisionLog(user.tenantId, Number.isInteger(limit) && limit > 0 ? limit : 100)
      const names = new Map<string, string | undefined>()
      for (const a of new Set(entries.map(e => e.actor))) names.set(a, a === 'system' ? undefined : (await store.getMappingByUser(user.tenantId, a))?.displayName)
      return { items: entries.map(e => ({ ...e, ...(names.get(e.actor) ? { actorName: names.get(e.actor) } : {}) })) }
    })
  }
}
