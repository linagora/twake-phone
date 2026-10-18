import { createHash } from 'node:crypto'
import type { TranscriptionProvider, VoicemailProvider } from '@twake/telephony-provider-sdk'
import type { TelephonyEvent, Voicemail, VoicemailTranscript } from '@twake/telephony-types'
import { LintoTranscription } from '@twake/transcription-linto'
import { MATRIX_USER_ID, MatrixBot, MatrixError } from './matrix.js'
import type { FencedLease, Store, TranscriptRecord } from './store/types.js'

// The transcription of the messages of the mailboxes and the bot's notice of each in Twake Chat (step 11b, ADR 0023).
// Each new message is written down once (Store.addTranscript) by the Gateway that writes the mailboxes, under its lease
// and its generation; that Gateway alone transcribes it (TranscriptionProvider: LinTO), sends the notice (MatrixBot) and
// withdraws it when the message goes: every write is asked of the lease first (`mayWrite`), and the store refuses one
// made under a lease no longer held. Every Gateway tells its own screens of a transcription done (TranscriptWatcher).
// Nothing of a recording nor of a text reaches the log: the counts, the tenant, an error's own few words.

/** The longest text kept of a transcription: a message of the longest kept, said fast. */
export const TRANSCRIPT_TEXT_MAX = 10_000
/** The bytes a second of a recording takes at most (WAV, 8 kHz, 16 bits, mono: Asterisk's), with a margin. */
const BYTES_PER_SEC = 16_000 * 1.5

/** What the platform transcribes with (step 11b): LINTO_URL and its bounds. */
export interface TranscriptionSettings {
  provider: TranscriptionProvider
  /** A message longer than this (seconds) is not transcribed (`too-long`). */
  maxSec: number
  /** The messages of a tenant that may wait for their transcription: past it, one is not transcribed (`busy`). */
  queueMax: number
  /** The largest recording read for it, in bytes. */
  maxBytes: number
}

const whole = (env: NodeJS.ProcessEnv, name: string, min: number, max: number, fallback: number) => {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return Number(raw)
}

/**
 * LinTO STT from the environment (step 11b), for the mailboxes of the platform, or nothing (no transcription):
 *
 *   LINTO_URL                       where LinTO STT's HTTP API listens (`http://127.0.0.1:8090`);
 *   LINTO_LANGUAGE                  the language asked of it (none by default: the Kaldi engine has its model's);
 *   LINTO_TIMEOUT_SEC               how long it has to answer one message (120);
 *   VOICEMAIL_TRANSCRIBE_MAX_SEC    the longest message transcribed, in seconds (180, VOICEMAIL_MAX_SEC by default);
 *   VOICEMAIL_TRANSCRIBE_QUEUE_MAX  how many messages of an organisation may wait for theirs (100).
 *
 * Only with a voicemail server (Wazo): without one there is nothing to transcribe.
 */
export const transcriptionFromEnv = (env: NodeJS.ProcessEnv, hasVoicemail: boolean, fetch?: typeof globalThis.fetch): TranscriptionSettings | undefined => {
  if (!env.LINTO_URL) return undefined
  if (!hasVoicemail) throw new Error('LINTO_URL: the transcription of the messages needs a voicemail server (WAZO_URL)')
  if (env.LINTO_LANGUAGE !== undefined && env.LINTO_LANGUAGE !== '' && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(env.LINTO_LANGUAGE)) throw new Error('LINTO_LANGUAGE must be a language tag (fr-FR)')
  const maxSec = whole(env, 'VOICEMAIL_TRANSCRIBE_MAX_SEC', 10, 3600, whole(env, 'VOICEMAIL_MAX_SEC', 1, 3600, 180))
  const maxBytes = Math.ceil(maxSec * BYTES_PER_SEC) + 65_536
  let provider: LintoTranscription
  try {
    provider = new LintoTranscription({
      url: env.LINTO_URL,
      ...(env.LINTO_LANGUAGE ? { language: env.LINTO_LANGUAGE } : {}),
      timeoutMs: whole(env, 'LINTO_TIMEOUT_SEC', 5, 3600, 120) * 1000,
      maxBytes,
      ...(fetch ? { fetch } : {})
    })
  } catch (err) {
    throw new Error(`LINTO_URL: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  return { provider, maxSec, queueMax: whole(env, 'VOICEMAIL_TRANSCRIBE_QUEUE_MAX', 1, 10_000, 100), maxBytes }
}

/** How the bot of TwakePhone reaches each person in Twake Chat (step 11b). */
export interface NoticeSettings {
  bot: MatrixBot
  /** `@{uid}:example.org`: the Matrix user id of someone the directory gives none (MATRIX_USER_TEMPLATE). */
  userTemplate?: string
  /** Where the link of a notice leads: TwakePhone's own address, its Messagerie vocale under it. */
  appUrl?: string
  /** The time zone the time of a message is told in (NOTICE_TIME_ZONE, Europe/Paris by default). */
  timeZone: string
}

/** A person's Matrix user id from MATRIX_USER_TEMPLATE: `{uid}` their id in the directory (lowercased); undefined when it makes no valid one. */
export const matrixIdFromTemplate = (template: string | undefined, userId: string): string | undefined => {
  if (!template) return undefined
  const id = template.replaceAll('{uid}', userId.toLowerCase())
  return MATRIX_USER_ID.test(id) ? id : undefined
}

/**
 * The bot from the environment (step 11b), or nothing (no notices in Chat):
 *
 *   MATRIX_HOMESERVER_URL   the organisation's Matrix homeserver (its client-server API);
 *   MATRIX_BOT_TOKEN        the access token of the bot's account there (never anywhere else than in the environment);
 *   MATRIX_USER_TEMPLATE    `@{uid}:example.org`: the Matrix user id of a person the directory gives none
 *                           (LDAP_ATTR_MATRIX) from their id in the directory;
 *   APP_URL                 TwakePhone's address, for the link of the notices (the first https origin of CORS_ORIGINS
 *                           by default);
 *   NOTICE_TIME_ZONE        the time zone of the times told (Europe/Paris).
 *
 * Both of the first two or neither; only with a voicemail server.
 */
export const matrixFromEnv = (env: NodeJS.ProcessEnv, hasVoicemail: boolean, fetch?: typeof globalThis.fetch): NoticeSettings | undefined => {
  if (!env.MATRIX_HOMESERVER_URL && !env.MATRIX_BOT_TOKEN) return undefined
  if (!env.MATRIX_HOMESERVER_URL || !env.MATRIX_BOT_TOKEN) throw new Error('MATRIX_HOMESERVER_URL and MATRIX_BOT_TOKEN go together')
  if (!hasVoicemail) throw new Error('MATRIX_HOMESERVER_URL: the notices of the messages need a voicemail server (WAZO_URL)')
  const template = env.MATRIX_USER_TEMPLATE || undefined
  if (template && (!template.includes('{uid}') || !MATRIX_USER_ID.test(template.replaceAll('{uid}', 'x')))) throw new Error('MATRIX_USER_TEMPLATE must be a Matrix user id with {uid} in its localpart (@{uid}:example.org)')
  const app = env.APP_URL || env.CORS_ORIGINS?.split(',').map(o => o.trim()).find(o => o.startsWith('https://'))
  let appUrl: string | undefined
  if (app) {
    const u = new URL(app)
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('APP_URL must be an http(s) address without credentials')
    appUrl = u.toString().replace(/\/+$/, '')
  }
  const timeZone = env.NOTICE_TIME_ZONE || 'Europe/Paris'
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone })
  } catch {
    throw new Error('NOTICE_TIME_ZONE is not a time zone (Europe/Paris)')
  }
  return { bot: new MatrixBot({ homeserverUrl: env.MATRIX_HOMESERVER_URL, token: env.MATRIX_BOT_TOKEN, ...(fetch ? { fetch } : {}) }), ...(template ? { userTemplate: template } : {}), ...(appUrl ? { appUrl } : {}), timeZone }
}

/** A transcription as the person's screens read it (Voicemail.transcript); undefined when the platform did not transcribe it. */
export const publicTranscript = (r: Pick<TranscriptRecord, 'status' | 'text' | 'reason'>): VoicemailTranscript | undefined => {
  if (r.status === 'pending') return { status: 'pending' }
  if (r.status === 'done') return { status: 'done', text: r.text ?? '' }
  if (r.status === 'none' && r.reason) return { status: 'none', reason: r.reason }
  return undefined
}

/** The person's id in the directory, of the id their mailbox knows them by (HolderRecord: `<id>\0<rank>` after someone before them). */
export const userOfHolder = (holder: string) => holder.split('\u0000')[0]!

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec)) % 60).padStart(2, '0')}`
const NO_TEXT: Record<NonNullable<TranscriptRecord['reason']>, string> = {
  'too-long': 'le message est trop long pour être transcrit',
  busy: "trop de messages attendaient leur transcription",
  failed: "le service de transcription n'a pas pu le transcrire"
}

/**
 * The bot's notice of a message (an `m.notice`, plain and HTML): who called, when, how long, what they said (or why it
 * is not written), and the link to the Messagerie vocale. In French, the language of the platform's people.
 */
export const noticeContent = (v: Voicemail, r: Pick<TranscriptRecord, 'status' | 'text' | 'reason'>, settings: Pick<NoticeSettings, 'appUrl' | 'timeZone'>) => {
  const who = v.fromName ? (v.from ? `${v.fromName} (${v.from})` : v.fromName) : (v.from ?? 'un numéro masqué')
  const at = new Date(v.receivedAt)
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone: settings.timeZone, dateStyle: 'long' }).format(at)
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: settings.timeZone, timeStyle: 'short' }).format(at)
  const said = r.status === 'done' ? (r.text ? { plain: `Transcription : « ${r.text} »`, html: `<p>Transcription :</p><blockquote>${escapeHtml(r.text)}</blockquote>` } : { plain: 'Transcription : aucune parole reconnue.', html: '<p>Transcription : aucune parole reconnue.</p>' }) : r.reason ? { plain: `Pas de transcription : ${NO_TEXT[r.reason]}.`, html: `<p>Pas de transcription : ${escapeHtml(NO_TEXT[r.reason])}.</p>` } : undefined
  const link = settings.appUrl ? `${settings.appUrl}/voicemail` : undefined
  const head = `Nouveau message vocal de ${who}, le ${day} à ${time}, durée ${clock(v.durationSec)}.`
  const body = [head, said?.plain, link ? `Écouter dans TwakePhone : ${link}` : undefined].filter(Boolean).join('\n')
  const formatted = [
    `<p><strong>Nouveau message vocal</strong> de ${escapeHtml(who)}, le ${escapeHtml(day)} à ${escapeHtml(time)}, durée ${clock(v.durationSec)}.</p>`,
    said?.html,
    link ? `<p><a href="${escapeHtml(link)}">Écouter dans TwakePhone</a></p>` : undefined
  ]
    .filter(Boolean)
    .join('')
  return { msgtype: 'm.notice', body, format: 'org.matrix.custom.html', formatted_body: formatted }
}

/** A recording read whole, `max` bytes at most (past it, an error: the stream let go). */
const readAll = async (body: AsyncIterable<Uint8Array>, max: number) => {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > max) throw new Error(`recording larger than ${max} bytes`)
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** An error in a few words for the log: its own message (LinTO's, Matrix's, Wazo's: never a body, never a text). */
const brief = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : 'error')

/** Stopped: the Gateway no longer writes the mailboxes of the tenant. */
class NotTheWriter extends Error {}

export interface VoicemailTranscriptsOptions {
  store: Store
  voicemail(tenantId: string): VoicemailProvider | undefined
  transcription?: TranscriptionSettings
  notices?: NoticeSettings & { matrixIdOf: (tenantId: string, userId: string) => Promise<string | undefined> }
  /** The lease of the mailboxes of the tenant held now (its fencing token), or undefined: this Gateway writes nothing. */
  lease(tenantId: string): FencedLease | undefined
  /** The id the mailboxes know a person by now (HolderRecord): a message of someone who had their id before is not theirs. */
  holderIdFor(tenantId: string, userId: string): Promise<string>
  /** A message's transcription settled (done, or none): the subscribers are told (voicemail.transcribed). */
  onSettled?(tenantId: string, record: TranscriptRecord): void
  /** Tells the administrators (kind `voicemail`). */
  alert(tenantId: string, param: 'transcription-busy' | 'transcription-failed' | 'notice-failed', value: number): Promise<void>
  /** A print of a Matrix id for the log (never the id itself). */
  pseudonym?(tenantId: string, value: string): string
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void }
  /** The waits before each new try of a transcription (two more after the first: 30 s, 2 min). */
  retryMs?: number[]
  /** The waits before each new try of a notice, or of its withdrawal (the last one repeated, a notice given up past them). */
  noticeRetryMs?: number[]
  /** How often what is due is looked at, besides each new message: 10 s by default (0: never). */
  everyMs?: number
}

const NOTICE_RETRY_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000]

/** The transcriptions and notices of the messages, done by the Gateway that writes the mailboxes. */
export class VoicemailTranscripts {
  private readonly running = new Map<string, { again: boolean; ended: Promise<void> }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private readonly retryMs: number[]
  private readonly noticeRetryMs: number[]

  constructor(
    private readonly o: VoicemailTranscriptsOptions,
    private readonly tenants: () => Iterable<string>
  ) {
    this.retryMs = o.retryMs ?? [30_000, 120_000]
    this.noticeRetryMs = o.noticeRetryMs ?? NOTICE_RETRY_MS
  }

  /** Whether there is anything to do: a transcription service or a bot. */
  get on() {
    return !!(this.o.transcription || this.o.notices)
  }

  /** Whether the messages are transcribed (Capabilities.voicemailTranscription). */
  get transcribes() {
    return !!this.o.transcription
  }

  /**
   * What the screens are told of a new message's transcription with its `voicemail.created`, before any is done: on
   * its way, or none (too long); nothing when the platform does not transcribe.
   */
  initial(v: Pick<Voicemail, 'durationSec'>): VoicemailTranscript | undefined {
    const t = this.o.transcription
    if (!t) return undefined
    return v.durationSec > t.maxSec ? { status: 'none', reason: 'too-long' } : { status: 'pending' }
  }

  start() {
    const every = this.o.everyMs ?? 10_000
    if (!this.on || every <= 0) return
    this.timer = setInterval(() => {
      for (const t of this.tenants()) this.kick(t)
    }, every)
    this.timer.unref()
  }

  async stop() {
    this.closed = true
    clearInterval(this.timer)
    await Promise.all([...this.running.values()].map(r => r.ended))
  }

  private lease(tenantId: string) {
    if (this.closed) return undefined
    return this.o.lease(tenantId)
  }

  private mayWrite(tenantId: string, lease: FencedLease) {
    const now = this.lease(tenantId)
    return !!now && now.generation === lease.generation && now.holder === lease.holder
  }

  /**
   * A message left (`voicemail.created`) in the mailbox of `holder`, reached at `extension`: written down to transcribe
   * and to tell, once, by the Gateway that writes the mailboxes (the others: nothing).
   */
  async heard(tenantId: string, extension: string, holder: string, v: Voicemail) {
    if (!this.on) return
    const lease = this.lease(tenantId)
    if (!lease) return
    const t = this.o.transcription
    const tooLong = !!t && v.durationSec > t.maxSec
    const record = { tenantId, holder, messageId: v.id, extension, receivedAt: v.receivedAt, status: t && !tooLong ? ('pending' as const) : ('none' as const), ...(tooLong ? { reason: 'too-long' as const } : {}), notice: this.o.notices ? ('pending' as const) : ('none' as const) }
    const added = await this.o.store.addTranscript(record, lease, t?.queueMax ?? 0)
    if (added === 'busy') {
      this.o.log.warn({ tenantId, waiting: t?.queueMax }, 'voicemail transcription: too many messages waiting, one left without its transcription')
      await this.o.alert(tenantId, 'transcription-busy', t?.queueMax ?? 0).catch(() => undefined)
    }
    // Settled at once (too long, busy): the subscribers told as for one transcribed.
    const settled = added === 'busy' ? { ...record, status: 'none' as const, reason: 'busy' as const } : added === 'added' && record.status === 'none' && t ? record : undefined
    if (settled) this.o.onSettled?.(tenantId, { ...settled, attempts: 0, nextAt: v.receivedAt, updatedAt: v.receivedAt })
    if (added === 'added' || added === 'busy') this.kick(tenantId)
  }

  /** A message deleted (`voicemail.deleted`, wherever): its transcription goes, its notice is withdrawn. */
  async deleted(tenantId: string, messageId: string) {
    if (!this.on) return
    const lease = this.lease(tenantId)
    if (!lease) return
    if (await this.o.store.eraseTranscripts(tenantId, { messageId }, lease)) this.kick(tenantId)
  }

  /**
   * The person's right to erasure (the erasure of their messages, step 11a): every transcription of `holder` goes, every
   * notice is withdrawn. Rejects when this Gateway no longer writes the mailboxes (the erasure is asked again).
   */
  async erase(tenantId: string, holder: string) {
    if (!this.on) return 0
    const lease = this.lease(tenantId)
    const n = lease ? await this.o.store.eraseTranscripts(tenantId, { holder }, lease) : null
    if (n === null) throw new NotTheWriter('the mailboxes are no longer written by this Gateway')
    // The room of the bot with them is forgotten too (their Matrix id with it): a later notice makes another.
    await this.o.store.deleteOperatorState(tenantId, `matrix:room:${userOfHolder(holder)}`)
    if (n) this.kick(tenantId)
    return n
  }

  /** The retention period: the transcriptions of the messages received before `before` go, their notices withdrawn. */
  async expire(tenantId: string, before: Date) {
    if (!this.on) return 0
    const lease = this.lease(tenantId)
    if (!lease) return 0
    const n = (await this.o.store.eraseTranscripts(tenantId, { before: before.toISOString() }, lease)) ?? 0
    if (n) {
      this.o.log.info({ tenantId, erased: n }, 'voicemail transcriptions past the retention period erased')
      this.kick(tenantId)
    }
    return n
  }

  /** Looks at what is due for the tenant now (one round at a time; one asked meanwhile runs after it). */
  kick(tenantId: string) {
    if (!this.on || this.closed) return
    const running = this.running.get(tenantId)
    if (running) {
      running.again = true
      return
    }
    const state = { again: true, ended: Promise.resolve() }
    state.ended = (async () => {
      try {
        while (state.again && !this.closed) {
          state.again = false
          await this.round(tenantId)
        }
      } catch (err) {
        this.o.log.error({ tenantId, err: brief(err) }, 'voicemail transcriptions: round failed, again at the next one')
      } finally {
        this.running.delete(tenantId)
      }
    })()
    this.running.set(tenantId, state)
  }

  /** Waits for the round under way of a tenant, if any (tests). */
  async settled(tenantId: string) {
    while (this.running.get(tenantId)) await this.running.get(tenantId)!.ended
  }

  private async round(tenantId: string) {
    for (let batch = 0; batch < 10; batch++) {
      const lease = this.lease(tenantId)
      if (!lease) return
      const due = await this.o.store.dueTranscripts(tenantId, 20)
      if (!due.length) return
      for (const r of due) {
        if (!this.mayWrite(tenantId, lease)) return
        try {
          await this.step(tenantId, r, lease)
        } catch (err) {
          if (err instanceof NotTheWriter) return
          this.o.log.error({ tenantId, err: brief(err) }, 'voicemail transcription: a step failed, again at the next round')
        }
      }
    }
  }

  private guard(tenantId: string, lease: FencedLease) {
    if (!this.mayWrite(tenantId, lease)) throw new NotTheWriter()
  }

  private async step(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    if (r.notice === 'redact') return this.withdraw(tenantId, r, lease)
    if (r.status === 'pending') return this.transcribe(tenantId, r, lease)
    if (r.notice === 'pending') return this.notify(tenantId, r, lease)
  }

  private update(tenantId: string, r: TranscriptRecord, change: Parameters<Store['updateTranscript']>[3], lease: FencedLease) {
    return this.o.store.updateTranscript(tenantId, r.holder, r.messageId, change, lease)
  }

  private async messageOf(tenantId: string, r: TranscriptRecord) {
    const vm = this.o.voicemail(tenantId)
    if (!vm) return { vm: undefined, message: undefined }
    const owner = { extension: r.extension, userId: r.holder }
    return { vm, owner, message: (await vm.listMessages(owner)).find(m => m.id === r.messageId) }
  }

  private async transcribe(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    const t = this.o.transcription
    if (!t) {
      await this.settle(tenantId, r, { status: 'none' }, lease)
      return
    }
    const { vm, owner, message } = await this.messageOf(tenantId, r)
    if (!vm || !owner) return
    // Gone meanwhile (deleted, purged): nothing to transcribe nor to tell.
    if (!message) {
      this.guard(tenantId, lease)
      await this.o.store.deleteTranscript(tenantId, r.holder, r.messageId, lease)
      return
    }
    if (message.durationSec > t.maxSec) return this.settle(tenantId, r, { status: 'none', reason: 'too-long' }, lease)
    const attempts = r.attempts + 1
    try {
      const recording = await vm.getRecording(owner, r.messageId)
      if (!recording) {
        this.guard(tenantId, lease)
        await this.o.store.deleteTranscript(tenantId, r.holder, r.messageId, lease)
        return
      }
      const audio = await readAll(recording.body, t.maxBytes)
      this.guard(tenantId, lease)
      const { text } = await t.provider.transcribe(audio, { contentType: recording.contentType })
      // eslint-disable-next-line no-control-regex -- the control characters are what is taken out
      await this.settle(tenantId, r, { status: 'done', text: text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, TRANSCRIPT_TEXT_MAX) }, lease)
    } catch (err) {
      if (err instanceof NotTheWriter) throw err
      this.o.log.warn({ tenantId, attempt: attempts, err: brief(err) }, 'voicemail transcription failed')
      if (attempts > this.retryMs.length) {
        await this.settle(tenantId, r, { status: 'none', reason: 'failed' }, lease)
        await this.o.alert(tenantId, 'transcription-failed', 1).catch(() => undefined)
        return
      }
      this.guard(tenantId, lease)
      await this.update(tenantId, r, { attempts, nextAt: new Date(Date.now() + this.retryMs[attempts - 1]!).toISOString() }, lease)
    }
  }

  /** A transcription settled: written (the notice due at once), and the subscribers told. */
  private async settle(tenantId: string, r: TranscriptRecord, change: { status: 'done' | 'none'; text?: string; reason?: TranscriptRecord['reason'] }, lease: FencedLease) {
    this.guard(tenantId, lease)
    if (!(await this.update(tenantId, r, { ...change, attempts: 0, nextAt: new Date().toISOString() }, lease))) return
    const settled = { ...r, ...change, attempts: 0 }
    if (publicTranscript(settled)) this.o.onSettled?.(tenantId, settled)
    this.kick(tenantId)
  }

  private async noticeFailed(tenantId: string, r: TranscriptRecord, lease: FencedLease, err: unknown, withdraw: boolean) {
    const attempts = r.attempts + 1
    const retryAfter = err instanceof MatrixError ? (err.retryAfterMs ?? 0) : 0
    this.o.log.warn({ tenantId, attempt: attempts, err: brief(err) }, withdraw ? 'voicemail notice not withdrawn' : 'voicemail notice not sent')
    if (!withdraw && attempts > this.noticeRetryMs.length) {
      this.guard(tenantId, lease)
      await this.update(tenantId, r, { notice: 'none', attempts }, lease)
      await this.o.alert(tenantId, 'notice-failed', 1).catch(() => undefined)
      return
    }
    const wait = Math.max(this.noticeRetryMs[Math.min(attempts, this.noticeRetryMs.length) - 1]!, retryAfter)
    this.guard(tenantId, lease)
    await this.update(tenantId, r, { attempts, nextAt: new Date(Date.now() + wait).toISOString() }, lease)
  }

  private async notify(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    const n = this.o.notices
    const none = async () => {
      this.guard(tenantId, lease)
      await this.update(tenantId, r, { notice: 'none' }, lease)
    }
    if (!n) return none()
    try {
      const userId = userOfHolder(r.holder)
      // The id is someone else's now (given to a newcomer after this holder): no notice to whoever has it.
      if ((await this.o.holderIdFor(tenantId, userId)) !== r.holder) return none()
      const matrixId = (await n.matrixIdOf(tenantId, userId)) ?? matrixIdFromTemplate(n.userTemplate, userId)
      if (!matrixId || !MATRIX_USER_ID.test(matrixId)) return none()
      const me = await n.bot.whoami()
      // The bot's own server only: a notice never leaves the organisation's homeserver.
      if (matrixId.slice(matrixId.indexOf(':') + 1) !== me.serverName || matrixId === me.userId) {
        this.o.log.warn({ tenantId, ...(this.o.pseudonym ? { matrix: this.o.pseudonym(tenantId, matrixId) } : {}) }, "voicemail notice: the person's Matrix account is not on the bot's server, none sent")
        return none()
      }
      const { message } = await this.messageOf(tenantId, r)
      if (!message) return none()
      const roomId = await this.roomFor(tenantId, userId, matrixId, me.userId, lease)
      this.guard(tenantId, lease)
      const eventId = await n.bot.send(roomId, txnOf('n', tenantId, r), noticeContent(message, r, n))
      if (await this.update(tenantId, r, { notice: 'sent', noticeRoom: roomId, noticeEvent: eventId, attempts: 0 }, lease)) return
      // Erased while it was sent (its row gone): withdrawn at once. Under a lease lost, the next writer sends it again
      // with the same transaction id: the homeserver answers with this very event.
      if (!(await this.o.store.listTranscripts(tenantId, r.holder, [r.messageId])).length && this.mayWrite(tenantId, lease)) await n.bot.redact(roomId, eventId, txnOf('r', tenantId, r), 'TwakePhone')
    } catch (err) {
      if (err instanceof NotTheWriter) throw err
      await this.noticeFailed(tenantId, r, lease, err, false)
    }
  }

  /**
   * The room of the bot with the person: the one kept (`matrix:room:<userId>`) while they are in it alone with the bot
   * (joined or invited), else a new one, kept from then on.
   */
  private async roomFor(tenantId: string, userId: string, matrixId: string, bot: string, lease: FencedLease) {
    const n = this.o.notices!
    const key = `matrix:room:${userId}`
    const kept = (await this.o.store.getOperatorState(tenantId, key)) as { roomId?: unknown; matrixId?: unknown } | undefined
    if (kept && typeof kept.roomId === 'string' && kept.matrixId === matrixId) {
      const members = await n.bot.members(kept.roomId).catch((err: unknown) => {
        // The bot is no longer in it (left, kicked): another room.
        if (err instanceof MatrixError && (err.status === 403 || err.status === 404)) return undefined
        throw err
      })
      const present = (members ?? []).filter(m => ['join', 'invite', 'knock'].includes(m.membership))
      const alone = present.every(m => m.userId === bot || m.userId === matrixId)
      const person = present.find(m => m.userId === matrixId && (m.membership === 'join' || m.membership === 'invite'))
      const self = present.find(m => m.userId === bot && m.membership === 'join')
      if (members && alone && person && self) return kept.roomId
    }
    this.guard(tenantId, lease)
    const roomId = await n.bot.createDirectRoom(matrixId, 'TwakePhone', 'Vos messages vocaux de TwakePhone')
    this.guard(tenantId, lease)
    await this.o.store.putOperatorState(tenantId, key, { roomId, matrixId })
    return roomId
  }

  private async withdraw(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    const n = this.o.notices
    const gone = async () => {
      this.guard(tenantId, lease)
      await this.o.store.deleteTranscript(tenantId, r.holder, r.messageId, lease)
    }
    if (!r.noticeRoom || !r.noticeEvent) return gone()
    if (!n) {
      this.o.log.warn({ tenantId }, 'voicemail notice not withdrawn: no bot any more (MATRIX_*): it stays in Chat')
      return gone()
    }
    try {
      this.guard(tenantId, lease)
      await n.bot.redact(r.noticeRoom, r.noticeEvent, txnOf('r', tenantId, r), 'TwakePhone')
      await gone()
    } catch (err) {
      if (err instanceof NotTheWriter) throw err
      // The bot can no longer withdraw it (it left the room, the event is gone): nothing more to try.
      if (err instanceof MatrixError && (err.status === 403 || err.status === 404)) {
        this.o.log.warn({ tenantId, err: brief(err) }, 'voicemail notice cannot be withdrawn any more')
        return gone()
      }
      await this.noticeFailed(tenantId, r, lease, err, true)
    }
  }
}

/** The transaction id of a notice (`n`) or of its withdrawal (`r`): the same for the same message, whatever the Gateway. */
const txnOf = (what: 'n' | 'r', tenantId: string, r: Pick<TranscriptRecord, 'holder' | 'messageId'>) =>
  `twakephone-${what}-${createHash('sha256').update([tenantId, r.holder, r.messageId].join('\u0000')).digest('hex').slice(0, 32)}`

export interface TranscriptWatcherOptions {
  store: Pick<Store, 'transcriptsChangedSince' | 'clock'>
  tenants(): Iterable<string>
  /** Whether this Gateway has a screen of the person open (anything to tell). */
  listening(tenantId: string, userId: string): boolean
  holderIdFor(tenantId: string, userId: string): Promise<string>
  publish(tenantId: string, userId: string, event: TelephonyEvent): void
  log: { error(obj: object, msg: string): void }
  /** How often it looks (2 s by default). */
  everyMs?: number
}

/**
 * Tells the screens of this Gateway of the transcriptions settled, whichever Gateway did them (`voicemail.transcribed`),
 * to the holder only: an id given to someone else since never shows them the previous holder's.
 */
export class TranscriptWatcher {
  private since = new Map<string, number>()
  private readonly seen = new Map<string, Map<string, number>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false

  constructor(private readonly o: TranscriptWatcherOptions) {}

  async start() {
    const now = Date.parse(await this.o.store.clock().catch(() => new Date().toISOString()))
    for (const t of this.o.tenants()) this.since.set(t, now)
    this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 2_000)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
  }

  /** One look (tests call it). Changes are read again a few seconds back (one written late is not missed), each told once. */
  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const clock = Date.parse(await this.o.store.clock())
      for (const tenantId of this.o.tenants()) {
        const since = this.since.get(tenantId) ?? clock
        const seen = this.seen.get(tenantId) ?? new Map<string, number>()
        this.seen.set(tenantId, seen)
        const rows = await this.o.store.transcriptsChangedSince(tenantId, new Date(since - 5_000).toISOString(), 500)
        let last = since
        for (const r of rows) {
          const at = Date.parse(r.updatedAt)
          const k = `${r.holder}\u0000${r.messageId}`
          last = Math.max(last, at)
          if (seen.get(k) === at) continue
          seen.set(k, at)
          const transcript = publicTranscript(r)
          const userId = userOfHolder(r.holder)
          if (!transcript || !this.o.listening(tenantId, userId)) continue
          if ((await this.o.holderIdFor(tenantId, userId)) !== r.holder) continue
          this.o.publish(tenantId, userId, { type: 'voicemail.transcribed', timestamp: r.updatedAt, payload: { id: r.messageId, transcript } })
        }
        // A full page: the next look goes on from its last change, else from the clock.
        this.since.set(tenantId, rows.length >= 500 ? last : Math.max(last, clock - 5_000))
        for (const [k, at] of seen) if (at < this.since.get(tenantId)! - 10_000) seen.delete(k)
      }
    } catch (err) {
      this.o.log.error({ err: brief(err) }, 'voicemail transcriptions: changes not read, again in a moment')
    } finally {
      this.busy = false
    }
  }
}
