import { createHash, randomBytes } from 'node:crypto'
import type { TranscriptionProvider, VoicemailProvider } from '@twake/telephony-provider-sdk'
import type { TelephonyEvent, Voicemail, VoicemailTranscript } from '@twake/telephony-types'
import { LintoTranscription } from '@twake/transcription-linto'
import { MATRIX_ID_AMBIGUOUS, MATRIX_USER_ID, MatrixBot, MatrixError } from './matrix.js'
import { holderIn, holderOut, type FencedLease, type Store, type TranscriptLane, type TranscriptNotice, type TranscriptRecord } from './store/types.js'

// The transcription of the messages of the mailboxes and the bot's notice of each in Twake Chat (step 11b, ADR 0023).
// Each new message is written down once (Store.addTranscript) by the Gateway that writes the mailboxes, under its lease
// and its generation; that Gateway alone transcribes it (TranscriptionProvider: LinTO), sends the notice (MatrixBot) and
// withdraws it when the message goes: every write is asked of the lease first (`mayWrite`), and the store refuses one
// made under a lease no longer held. A message whose event that Gateway did not hear (it was not the writer then, it
// restarted, the voicemail server's stream broke) is caught up by the reconciliation of the mailboxes with the table, at
// each lease taken, after each gap in the stream and at intervals. Transcriptions and notices are two queues of their
// own: a transcription service that hangs never holds back a notice nor a withdrawal. Every Gateway tells its own screens
// of a transcription done (TranscriptWatcher). The erasures, deletions and the retention period hold whether the
// transcription and the bot are on or not. Nothing of a recording nor of a text reaches the log: the counts, the
// tenant, an error's own few words.

/** The longest text kept of a transcription: a message of the longest kept, said fast. */
export const TRANSCRIPT_TEXT_MAX = 10_000
/** The bytes a second of a recording takes at most (WAV, 16 kHz, 16 bits, mono: Asterisk's wav16; its wav takes half), with a margin. */
const BYTES_PER_SEC = 32_000 * 1.5
/** The field of the bot's notice that says which message it tells of (its print): a notice sent before is found again by it. */
export const NOTICE_FIELD = 'org.twakephone.message'

/** What the platform transcribes with (step 11b): LINTO_URL and its bounds. */
export interface TranscriptionSettings {
  provider: TranscriptionProvider
  /** A message longer than this (seconds) is not transcribed (`too-long`). */
  maxSec: number
  /** The messages of a tenant that may wait for their transcription: past it, one is not transcribed (`busy`). */
  queueMax: number
  /** The largest recording read for it, in bytes: past it, the message is too long (`too-long`). */
  maxBytes: number
  /** The language of the texts (a language tag: LINTO_LANGUAGE, `fr` by default): the screens read them out in it. */
  lang?: string
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
 *   LINTO_LANGUAGE                  the language asked of it, and that of the texts (none asked by default: the Kaldi
 *                                   engine has its model's; the texts are then said to be in French);
 *   LINTO_TIMEOUT_SEC               how long it has to answer one message (120);
 *   VOICEMAIL_TRANSCRIBE_MAX_SEC    the longest message transcribed, in seconds (180, VOICEMAIL_MAX_SEC by default, 10
 *                                   at least);
 *   VOICEMAIL_TRANSCRIBE_QUEUE_MAX  how many messages of an organisation may wait for theirs (100).
 *
 * Only with a voicemail server (Wazo): without one there is nothing to transcribe.
 */
export const transcriptionFromEnv = (env: NodeJS.ProcessEnv, hasVoicemail: boolean, fetch?: typeof globalThis.fetch): TranscriptionSettings | undefined => {
  if (!env.LINTO_URL) return undefined
  if (!hasVoicemail) throw new Error('LINTO_URL: the transcription of the messages needs a voicemail server (WAZO_URL)')
  if (env.LINTO_LANGUAGE !== undefined && env.LINTO_LANGUAGE !== '' && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(env.LINTO_LANGUAGE)) throw new Error('LINTO_LANGUAGE must be a language tag (fr-FR)')
  const maxSec = whole(env, 'VOICEMAIL_TRANSCRIBE_MAX_SEC', 10, 3600, Math.max(10, whole(env, 'VOICEMAIL_MAX_SEC', 1, 3600, 180)))
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
  return { provider, maxSec, queueMax: whole(env, 'VOICEMAIL_TRANSCRIBE_QUEUE_MAX', 1, 10_000, 100), maxBytes, lang: env.LINTO_LANGUAGE || 'fr' }
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
  /** Whether a notice carries what the caller said (MATRIX_NOTICE_TEXT, on by default): off, who called, when, and the link only. */
  withText?: boolean
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
 *   MATRIX_NOTICE_TEXT      `off`: the notices carry no transcription (who called, when, and the link only), for a
 *                           homeserver whose push notifications and e-mails the organisation does not control (`on`);
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
  if (env.MATRIX_NOTICE_TEXT && !['on', 'off'].includes(env.MATRIX_NOTICE_TEXT)) throw new Error('MATRIX_NOTICE_TEXT must be on or off')
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
  return {
    bot: new MatrixBot({ homeserverUrl: env.MATRIX_HOMESERVER_URL, token: env.MATRIX_BOT_TOKEN, ...(fetch ? { fetch } : {}) }),
    ...(template ? { userTemplate: template } : {}),
    ...(appUrl ? { appUrl } : {}),
    timeZone,
    withText: env.MATRIX_NOTICE_TEXT !== 'off'
  }
}

/** A transcription as the person's screens read it (Voicemail.transcript), its text in `lang`; undefined when the platform did not transcribe it. */
export const publicTranscript = (r: Pick<TranscriptRecord, 'status' | 'text' | 'reason'>, lang?: string): VoicemailTranscript | undefined => {
  if (r.status === 'pending') return { status: 'pending' }
  if (r.status === 'done') return { status: 'done', text: r.text ?? '', ...(lang ? { lang } : {}) }
  if (r.status === 'none' && r.reason) return { status: 'none', reason: r.reason }
  return undefined
}

/** The person's id in the directory, of the id their mailbox knows them by (HolderRecord: `<id>\0<rank>` after someone before them). */
export const userOfHolder = (holder: string) => holder.split('\u0000')[0]!

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec)) % 60).padStart(2, '0')}`
const NO_TEXT: Record<NonNullable<TranscriptRecord['reason']>, string> = {
  'too-long': 'le message est trop long pour être transcrit',
  busy: 'trop de messages attendaient leur transcription',
  failed: "le service de transcription n'a pas pu le transcrire"
}

/**
 * The name the caller gave (`fromName`: theirs to choose), as a notice may show it: letters, digits, spaces and a
 * simple punctuation only (apostrophes, hyphens, commas, brackets, `&`), so that neither what changes how a text reads
 * (bidirectional controls, invisible joiners, line breaks) nor an address a client would make a link of (`://`,
 * `www.`, `@`) is left; its spaces folded, 64 characters at most.
 */
export const callerName = (name: string | undefined) => {
  const clean = (name ?? '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Zs}'’\-,()&]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean ? Array.from(clean).slice(0, 64).join('') : undefined
}

/** The text a transcription service gave, as kept: without control characters (line breaks and tabs left), 10 000 characters at most. */
// eslint-disable-next-line no-control-regex -- the control characters are what is taken out
export const keptText = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, TRANSCRIPT_TEXT_MAX)

/**
 * The bot's notice of a message (an `m.notice`, plain and HTML): who called (the name they gave said to be theirs),
 * when, how long, what they said (or why it is not written, or that it is on its way; nothing of it with
 * `withText: false`), and the link to the Messagerie vocale. In French, the language of the platform's people. `key`:
 * the message's print (NOTICE_FIELD), by which a notice sent before is found again.
 */
export const noticeContent = (v: Voicemail, r: Pick<TranscriptRecord, 'status' | 'text' | 'reason'>, settings: Pick<NoticeSettings, 'appUrl' | 'timeZone' | 'withText'>, key?: string) => {
  const name = callerName(v.fromName)
  const number = v.from ? `du ${v.from}` : "d'un numéro masqué"
  const given = name ? ` (nom annoncé par l'appelant : « ${name} »)` : ''
  const at = new Date(v.receivedAt)
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone: settings.timeZone, dateStyle: 'long' }).format(at)
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: settings.timeZone, timeStyle: 'short' }).format(at)
  const withText = settings.withText !== false
  const said =
    r.status === 'done'
      ? withText
        ? r.text
          ? { plain: `Transcription : « ${r.text} »`, html: `<p>Transcription :</p><blockquote>${escapeHtml(r.text)}</blockquote>` }
          : { plain: 'Transcription : aucune parole reconnue.', html: '<p>Transcription : aucune parole reconnue.</p>' }
        : undefined
      : r.status === 'pending'
        ? withText
          ? { plain: 'Transcription : pas encore prête, à lire dans TwakePhone.', html: '<p>Transcription : pas encore prête, à lire dans TwakePhone.</p>' }
          : undefined
        : r.reason
          ? { plain: `Pas de transcription : ${NO_TEXT[r.reason]}.`, html: `<p>Pas de transcription : ${escapeHtml(NO_TEXT[r.reason])}.</p>` }
          : undefined
  const link = settings.appUrl ? `${settings.appUrl}/voicemail` : undefined
  const head = `Nouveau message vocal ${number}${given}, le ${day} à ${time}, durée ${clock(v.durationSec)}.`
  const body = [head, said?.plain, link ? `Écouter dans TwakePhone : ${link}` : undefined].filter(Boolean).join('\n')
  const formatted = [
    `<p><strong>Nouveau message vocal</strong> ${escapeHtml(number)}${escapeHtml(given)}, le ${escapeHtml(day)} à ${escapeHtml(time)}, durée ${clock(v.durationSec)}.</p>`,
    said?.html,
    link ? `<p><a href="${escapeHtml(link)}">Écouter dans TwakePhone</a></p>` : undefined
  ]
    .filter(Boolean)
    .join('')
  return { msgtype: 'm.notice', body, format: 'org.matrix.custom.html', formatted_body: formatted, ...(key ? { [NOTICE_FIELD]: key } : {}) }
}

/** A recording larger than the platform transcribes: the message is too long (`too-long`). */
class TooLong extends Error {}

/** A recording read whole, `max` bytes at most (past it, TooLong: the stream let go). */
const readAll = async (body: AsyncIterable<Uint8Array>, max: number) => {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > max) throw new TooLong(`recording larger than ${max} bytes`)
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** An error in a few words for the log: its own message (LinTO's, Matrix's, Wazo's: never a body, never a text). */
const brief = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : 'error')

/** Stopped: the Gateway no longer writes the mailboxes of the tenant (or it stops). */
class NotTheWriter extends Error {}
/** The round ends here, the rows left as they are (the voicemail server, or the transcription service, out a while). */
class Suspended extends Error {}

/** What the administrators are told of (kind `voicemail`). */
export type TranscriptAlert = 'transcription-busy' | 'transcription-failed' | 'transcription-backlog' | 'transcription-held' | 'transcription-unreadable' | 'notice-failed' | 'notice-no-account' | 'notice-not-withdrawn'

export interface VoicemailTranscriptsOptions {
  store: Store
  voicemail(tenantId: string): VoicemailProvider | undefined
  transcription?: TranscriptionSettings
  notices?: NoticeSettings & { matrixIdOf: (tenantId: string, userId: string) => Promise<string | undefined> }
  /** The lease of the mailboxes of the tenant held now (its fencing token), or undefined: this Gateway writes nothing. */
  lease(tenantId: string): FencedLease | undefined
  /** The id the mailboxes know a person by now (HolderRecord): a message of someone who had their id before is not theirs. */
  holderIdFor(tenantId: string, userId: string): Promise<string>
  /** The mailboxes of the tenant held now: where each is reached, and its holder (the reconciliation reads each one). */
  mailboxes(tenantId: string): Promise<{ extension: string; holder: string }[]>
  /** A message's transcription settled (done, or none): the subscribers are told (voicemail.transcribed). */
  onSettled?(tenantId: string, record: TranscriptRecord): void
  /** Tells the administrators (kind `voicemail`). */
  alert(tenantId: string, param: TranscriptAlert, value: number): Promise<void>
  /** A print of a Matrix id for the log (never the id itself). */
  pseudonym?(tenantId: string, value: string): string
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void }
  /** The waits before each new try of a transcription (two more after the first: 30 s, 2 min). */
  retryMs?: number[]
  /** The waits before each new try of a notice, or of its withdrawal (the last one repeated, a notice given up past them). */
  noticeRetryMs?: number[]
  /** How often what is due is looked at, besides each new message: 10 s by default (0: never). */
  everyMs?: number
  /** How often the mailboxes are reconciled with the table besides each lease taken and each gap of the stream: 15 min (0: never). */
  reconcileEveryMs?: number
  /** How old a message may be that the reconciliation still takes in hand: 24 h. Older ones are said `untracked`. */
  catchUpMs?: number
  /**
   * How long apart two reconciliations must not see a message for its row to be erased (its notice withdrawn): 10 min.
   * One read alone never erases (a voicemail server that does not see its spool for a while answers empty mailboxes).
   */
  orphanConfirmMs?: number
  /** The retention period of the messages (0: none): a message past it is never taken in hand again. */
  retentionMs?: number
  /** How long a notice waits for its transcription before it goes without: 10 min. */
  noticeWaitMs?: number
  /** How long a transcription or a notice may wait before the administrators are told of a backlog: 30 min. */
  backlogMs?: number
  /** How long the transcription service is left alone after three failures in a row, each time it fails again (1 min, 5 min, 15 min). */
  breakerMs?: number[]
  /** How long a person who declined the bot's room (or left it) is not invited again: 30 days. */
  declinedMs?: number
}

const NOTICE_RETRY_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000]
const BREAKER_FAILURES = 3
/** A message its transcription does not find (not in its mailbox): looked for again this much later, its row kept. */
const LOOK_AGAIN_MS = 300_000
/** A round of a queue ends once this many mailboxes could not be read (the voicemail server out, not one mailbox). */
const STALLED_MAX = 3
/** A mailbox unreadable this many reconciliations in a row: told to the administrators. */
const UNREADABLE_PASSES = 3
const ROOM = 'matrix:room:'
const LEAVE = 'matrix:leave:'

/** The room of the bot with a holder (operator state ROOM + print of the holder): its address, whose it is, and since when declined. */
interface RoomState {
  alias?: string
  matrixId?: string
  roomId?: string
  declinedAt?: string
}
/** The rooms of a holder the bot leaves once none of their notices is left in them (operator state LEAVE + print). */
interface LeaveState {
  holder: string
  rooms: { roomId: string; alias?: string }[]
}

/** The print of a holder in the keys of the operator state: never their id, never a NUL. */
const holderKey = (tenantId: string, holder: string) => createHash('sha256').update(`${tenantId}\u0000${holder}`).digest('hex').slice(0, 32)
/** A room kept is used only as written: its address, ids of the right form. */
const roomStateOf = (v: unknown): RoomState | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const s = v as Record<string, unknown>
  const str = (k: string) => (typeof s[k] === 'string' ? { [k]: s[k] } : {})
  return { ...str('alias'), ...str('matrixId'), ...str('roomId'), ...str('declinedAt') }
}

/** The transcriptions and notices of the messages, done by the Gateway that writes the mailboxes. */
export class VoicemailTranscripts {
  private readonly running = new Map<string, { again: boolean; ended: Promise<void> }>()
  private readonly reconciling = new Map<string, { again: boolean; ended: Promise<void> }>()
  private readonly reconciled = new Map<string, number>()
  private readonly swept = new Map<string, number>()
  private readonly quiet = new Map<string, number>()
  private readonly noAccounts = new Map<string, number>()
  /** Rows whose message a reconciliation did not see (by tenant, then holder and message): since when. */
  private readonly orphans = new Map<string, Map<string, number>>()
  /** Mailboxes the reconciliation could not read (tenant and holder): how many times in a row. */
  private readonly unreadable = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private readonly abort = new AbortController()
  private readonly retryMs: number[]
  private readonly noticeRetryMs: number[]
  private readonly breakerMs: number[]
  /** The transcription service: its failures in a row, until when it is left alone, how many times it was. */
  private breaker = { failures: 0, until: 0, opened: 0 }

  constructor(
    private readonly o: VoicemailTranscriptsOptions,
    private readonly tenants: () => Iterable<string>
  ) {
    this.retryMs = o.retryMs ?? [30_000, 120_000]
    this.noticeRetryMs = o.noticeRetryMs ?? NOTICE_RETRY_MS
    this.breakerMs = o.breakerMs ?? [60_000, 300_000, 900_000]
  }

  /** Whether there is anything to do for a new message: a transcription service or a bot. */
  get on() {
    return !!(this.o.transcription || this.o.notices)
  }

  /** Whether the messages are transcribed (Capabilities.voicemailTranscription). */
  get transcribes() {
    return !!this.o.transcription
  }

  /** Whether the bot's notices can be withdrawn (a bot): without, an erasure leaves them in Chat. */
  get notifies() {
    return !!this.o.notices
  }

  /** The language of the texts (the screens read them out in it). */
  get lang() {
    return this.o.transcription?.lang
  }

  private get catchUpMs() {
    const catchUp = this.o.catchUpMs ?? 86_400_000
    return this.o.retentionMs ? Math.min(catchUp, this.o.retentionMs) : catchUp
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

  /**
   * What the screens are told of a message the table has no row of: on its way (the next reconciliation takes it in
   * hand, asked now when this Gateway writes the mailboxes), or `untracked` when it is older than it catches up with.
   */
  missing(tenantId: string, v: Pick<Voicemail, 'durationSec' | 'receivedAt'>): VoicemailTranscript | undefined {
    if (!this.o.transcription) return undefined
    if (Date.parse(v.receivedAt) < Date.now() - this.catchUpMs) return { status: 'none', reason: 'untracked' }
    if (Date.now() - (this.reconciled.get(tenantId) ?? 0) > 60_000) void this.reconcile(tenantId)
    return this.initial(v)
  }

  start() {
    const every = this.o.everyMs ?? 10_000
    if (every <= 0) return
    const reconcileEvery = this.o.reconcileEveryMs ?? 900_000
    this.timer = setInterval(() => {
      for (const t of this.tenants()) {
        this.kick(t)
        if (reconcileEvery > 0 && this.on && Date.now() - (this.reconciled.get(t) ?? 0) >= reconcileEvery) void this.reconcile(t)
      }
    }, every)
    this.timer.unref()
  }

  /** Stops: the calls under way to the transcription service and the homeserver aborted, their rows left due for the next writer. */
  async stop() {
    this.closed = true
    clearInterval(this.timer)
    this.abort.abort()
    await Promise.all([...this.running.values(), ...this.reconciling.values()].map(r => r.ended))
  }

  private get signal() {
    return this.abort.signal
  }

  private lease(tenantId: string) {
    if (this.closed) return undefined
    return this.o.lease(tenantId)
  }

  private mayWrite(tenantId: string, lease: FencedLease) {
    const now = this.lease(tenantId)
    return !!now && now.generation === lease.generation && now.holder === lease.holder
  }

  /** A log line once in a while for the same trouble (`what`), not one per row nor per round. */
  private quietly(tenantId: string, what: string, obj: object, msg: string) {
    const k = `${tenantId}\u0000${what}`
    if (Date.now() - (this.quiet.get(k) ?? 0) < 300_000) return
    this.quiet.set(k, Date.now())
    this.o.log.warn({ tenantId, ...obj }, msg)
  }

  /**
   * A message left (`voicemail.created`) in the mailbox of `holder`, reached at `extension`: written down to transcribe
   * and to tell, once, by the Gateway that writes the mailboxes (the others: nothing; the reconciliation catches up).
   */
  async heard(tenantId: string, extension: string, holder: string, v: Voicemail, whenFull: 'busy' | 'wait' = 'busy') {
    if (!this.on) return undefined
    const lease = this.lease(tenantId)
    if (!lease) return undefined
    const t = this.o.transcription
    const tooLong = !!t && v.durationSec > t.maxSec
    const record = { tenantId, holder, messageId: v.id, extension, receivedAt: v.receivedAt, status: t && !tooLong ? ('pending' as const) : ('none' as const), ...(tooLong ? { reason: 'too-long' as const } : {}), notice: this.o.notices ? ('pending' as const) : ('none' as const) }
    // `wait` (the reconciliation): a queue full leaves the message for a later pass, never `busy` for good.
    const added = await this.o.store.addTranscript(record, lease, t?.queueMax ?? 0, whenFull)
    if (added === 'busy') {
      this.o.log.warn({ tenantId, waiting: t?.queueMax }, 'voicemail transcription: too many messages waiting, one left without its transcription')
      await this.o.alert(tenantId, 'transcription-busy', t?.queueMax ?? 0).catch(() => undefined)
    }
    // Settled at once (too long, busy): the subscribers told as for one transcribed.
    const settled = added === 'busy' ? { ...record, status: 'none' as const, reason: 'busy' as const } : added === 'added' && record.status === 'none' && t ? record : undefined
    const now = new Date().toISOString()
    if (settled) this.o.onSettled?.(tenantId, { ...settled, attempts: 0, nextAt: now, noticeAttempts: 0, noticeNextAt: now, createdAt: now, updatedAt: now })
    if (added === 'added' || added === 'busy') this.kick(tenantId)
    return added
  }

  /** Erases what matches under the lease, the notices withdrawn when there is a bot; without, they are said to stay in Chat. */
  private async eraseUnder(tenantId: string, match: Parameters<Store['eraseTranscripts']>[1], lease: FencedLease) {
    const done = await this.o.store.eraseTranscripts(tenantId, match, lease, this.notifies)
    if (!done) return done
    if (done.notices && !this.notifies) {
      this.o.log.warn({ tenantId, notices: done.notices }, 'voicemail transcriptions erased; the notices of the bot not withdrawn: no bot any more (MATRIX_*), they stay in Chat')
      await this.o.alert(tenantId, 'notice-not-withdrawn', done.notices).catch(() => undefined)
    }
    if (done.erased) this.kick(tenantId, 'notice')
    return done
  }

  /** A message of `holder` deleted (`voicemail.deleted`, the app): its transcription goes, its notice is withdrawn. */
  async deleted(tenantId: string, holder: string, messageId: string) {
    const lease = this.lease(tenantId)
    if (!lease) return
    await this.eraseUnder(tenantId, { holder, messageId }, lease)
  }

  /**
   * The person's right to erasure (the erasure of their messages, step 11a): every transcription of `holder` goes, every
   * notice is withdrawn (left in Chat without a bot: `notWithdrawn` says how many), the room of the bot with them is
   * left once its notices are. Rejects when this Gateway no longer writes the mailboxes (the erasure is asked again).
   */
  async erase(tenantId: string, holder: string) {
    const lease = this.lease(tenantId)
    const done = lease ? await this.eraseUnder(tenantId, { holder }, lease) : null
    if (!lease || !done) throw new NotTheWriter('the mailboxes are no longer written by this Gateway')
    const key = holderKey(tenantId, holder)
    const room = roomStateOf(await this.o.store.getOperatorState(tenantId, ROOM + key))
    if (this.mayWrite(tenantId, lease)) {
      // Forgotten (their Matrix id with it): a later notice makes another room. Left once its notices are withdrawn.
      // Their refusal of the bot stays (with the id it is of): erasing their messages does not invite them again.
      if (room?.roomId && this.notifies) await this.toLeave(tenantId, holder, room)
      else if (!this.notifies) await this.o.store.deleteOperatorState(tenantId, LEAVE + key)
      if (room?.declinedAt && room.matrixId) await this.o.store.putOperatorState(tenantId, ROOM + key, { matrixId: room.matrixId, declinedAt: room.declinedAt } satisfies RoomState)
      else await this.o.store.deleteOperatorState(tenantId, ROOM + key)
      // A round of the notices that ended before the room was set to be left leaves it at the next one.
      if (room?.roomId && this.notifies) this.kick(tenantId, 'notice')
    }
    return { erased: done.erased, notWithdrawn: this.notifies ? 0 : done.notices }
  }

  /** Whether the bot's notices of `holder` would stay in Chat if erased now (no bot to withdraw them). */
  async noticesLeft(tenantId: string, holder: string) {
    if (this.notifies) return false
    return (await this.o.store.listTranscripts(tenantId, holder, undefined, true)).some(r => !!r.noticeEvent)
  }

  /** The retention period: the transcriptions of the messages received before `before` go, their notices withdrawn. */
  async expire(tenantId: string, before: Date) {
    const lease = this.lease(tenantId)
    if (!lease) return 0
    const n = (await this.eraseUnder(tenantId, { before: before.toISOString() }, lease))?.erased ?? 0
    if (n) this.o.log.info({ tenantId, erased: n }, 'voicemail transcriptions past the retention period erased')
    return n
  }

  /**
   * The mailboxes reconciled with the table (by the Gateway that writes them): each recent message without a row
   * written down (its event missed: another Gateway wrote then, this one restarted, the stream broke), each row whose
   * message is gone erased (its notice withdrawn). One at a time per tenant; one asked meanwhile runs after it. Then
   * what waits too long is told to the administrators.
   */
  reconcile(tenantId: string): Promise<void> {
    if (!this.on || this.closed) return Promise.resolve()
    const running = this.reconciling.get(tenantId)
    if (running) {
      running.again = true
      return running.ended
    }
    const state = { again: true, ended: Promise.resolve() }
    state.ended = (async () => {
      try {
        while (state.again && !this.closed) {
          state.again = false
          await this.reconcileOnce(tenantId)
        }
      } catch (err) {
        if (!(err instanceof NotTheWriter)) this.o.log.error({ tenantId, err: brief(err) }, 'voicemail transcriptions: the mailboxes not reconciled, again at the next time')
      } finally {
        this.reconciling.delete(tenantId)
      }
    })()
    this.reconciling.set(tenantId, state)
    return state.ended
  }

  /**
   * One reconciliation. A row whose message is not in its mailbox is erased only when a reconciliation at least
   * `orphanConfirmMs` later still does not see it, never on one read. None of a mailbox that had two rows or more and
   * reads empty, and none at all when every mailbox read is empty or more than half of the rows read (two at least)
   * went at once (a spool the voicemail server no longer sees reads empty, without failing): held back, the
   * administrators told (`transcription-held`), the rows left for their `voicemail.deleted` or the retention period. A
   * mailbox that cannot be read is passed (the next ones read all the same), told once it stays so UNREADABLE_PASSES
   * times in a row.
   */
  private async reconcileOnce(tenantId: string) {
    const lease = this.lease(tenantId)
    const vm = this.o.voicemail(tenantId)
    if (!lease || !vm) return
    this.reconciled.set(tenantId, Date.now())
    const since = Date.now() - this.catchUpMs
    let added = 0
    let erased = 0
    let read = 0
    let rowsRead = 0
    let emptied = 0
    let goneAll = 0
    let listed = 0
    const missing: { holder: string; messageId: string }[] = []
    const boxes = await this.o.mailboxes(tenantId)
    for (const box of boxes) {
      if (!this.mayWrite(tenantId, lease)) return
      // The rows first: a row written after them is of a message the list below has (a message comes before its row).
      const rows = await this.o.store.listTranscripts(tenantId, box.holder)
      const unreadable = `${tenantId}\u0000${box.holder}`
      let messages: Voicemail[]
      try {
        messages = await vm.listMessages({ extension: box.extension, userId: box.holder })
        this.unreadable.delete(unreadable)
      } catch (err) {
        this.unreadable.set(unreadable, (this.unreadable.get(unreadable) ?? 0) + 1)
        this.quietly(tenantId, 'reconcile', { err: brief(err) }, 'voicemail transcriptions: a mailbox not read, reconciled at the next time')
        continue
      }
      read++
      listed += messages.length
      rowsRead += rows.length
      const known = new Set(rows.map(r => r.messageId))
      const there = new Set(messages.map(m => m.id))
      for (const m of messages) {
        if (known.has(m.id) || !(Date.parse(m.receivedAt) >= since)) continue
        const got = await this.heard(tenantId, box.extension, box.holder, m, 'wait')
        if (got === 'added') added++
        if (got === 'fenced') return
      }
      const gone = rows.filter(r => !there.has(r.messageId))
      goneAll += gone.length
      if (!messages.length && gone.length >= 2) emptied++
      else missing.push(...gone.map(r => ({ holder: box.holder, messageId: r.messageId })))
    }
    const seen = this.orphans.get(tenantId) ?? new Map<string, number>()
    const mass = goneAll > 0 && (listed === 0 || (goneAll >= 2 && goneAll * 2 > rowsRead))
    if (mass || emptied) {
      this.quietly(tenantId, 'held', { emptied, gone: goneAll, rows: rowsRead }, 'voicemail transcriptions: mailboxes read empty, or too many messages gone at once: not erased, the administrators told')
      await this.o.alert(tenantId, 'transcription-held', goneAll).catch(() => undefined)
    }
    if (mass) {
      // Not one erased this time, and those seen before are seen again from scratch.
      this.orphans.delete(tenantId)
    } else {
      const next = new Map<string, number>()
      const confirm = this.o.orphanConfirmMs ?? 600_000
      for (const m of missing) {
        const k = `${m.holder}\u0000${m.messageId}`
        const first = seen.get(k)
        if (first === undefined || Date.now() - first < confirm) {
          next.set(k, first ?? Date.now())
          continue
        }
        const done = await this.eraseUnder(tenantId, { holder: m.holder, messageId: m.messageId }, lease)
        if (!done) return
        erased += done.erased
      }
      this.orphans.set(tenantId, next)
    }
    if (added || erased) this.o.log.info({ tenantId, added, erased }, 'voicemail transcriptions: the mailboxes reconciled, the messages missed caught up')
    // A mailbox that stays unreadable (the voicemail server answers for the others): told. All of them: the server is out.
    const stuck = read ? boxes.filter(b => (this.unreadable.get(`${tenantId}\u0000${b.holder}`) ?? 0) >= UNREADABLE_PASSES).length : 0
    if (stuck) {
      this.quietly(tenantId, 'unreadable', { mailboxes: stuck }, 'voicemail transcriptions: mailboxes the voicemail server keeps failing to read')
      await this.o.alert(tenantId, 'transcription-unreadable', stuck).catch(() => undefined)
    }
    const waiting = await this.o.store.staleTranscripts(tenantId, new Date(Date.now() - (this.o.backlogMs ?? 1_800_000)).toISOString())
    if (waiting > 0) {
      this.quietly(tenantId, 'backlog', { waiting }, 'voicemail transcriptions: transcriptions or notices wait for too long')
      await this.o.alert(tenantId, 'transcription-backlog', waiting).catch(() => undefined)
    }
  }

  /** Looks at what is due for the tenant now, in each queue (`lane`) or one: one round at a time each, one asked meanwhile runs after it. */
  kick(tenantId: string, lane?: TranscriptLane) {
    if (this.closed) return
    for (const l of lane ? [lane] : (['transcribe', 'notice'] as const)) {
      const k = `${l}\u0000${tenantId}`
      const running = this.running.get(k)
      if (running) {
        running.again = true
        continue
      }
      const state = { again: true, ended: Promise.resolve() }
      state.ended = (async () => {
        try {
          while (state.again && !this.closed) {
            state.again = false
            await this.round(tenantId, l)
          }
        } catch (err) {
          this.o.log.error({ tenantId, err: brief(err) }, 'voicemail transcriptions: round failed, again at the next one')
        } finally {
          this.running.delete(k)
        }
      })()
      this.running.set(k, state)
    }
  }

  /** Waits for the rounds and the reconciliation under way of a tenant, if any (tests). */
  async settled(tenantId: string) {
    for (;;) {
      const under = [...this.running].filter(([k]) => k.endsWith(`\u0000${tenantId}`)).map(([, r]) => r.ended)
      const r = this.reconciling.get(tenantId)
      if (r) under.push(r.ended)
      if (!under.length) return
      await Promise.all(under)
    }
  }

  private async round(tenantId: string, lane: TranscriptLane) {
    // The mailboxes not read this round (their rows passed): one unreadable leaves the others' going; a few, the
    // voicemail server is out, the round ends.
    const stalled = new Set<string>()
    for (let batch = 0; batch < 10; batch++) {
      const lease = this.lease(tenantId)
      if (!lease) return
      if (lane === 'transcribe' && this.o.transcription && Date.now() < this.breaker.until) return
      const due = await this.o.store.dueTranscripts(tenantId, lane, 20, this.o.transcription ? (this.o.noticeWaitMs ?? 600_000) : undefined)
      if (!due.length) break
      for (const r of due) {
        if (!this.mayWrite(tenantId, lease)) return
        if (stalled.has(r.holder)) continue
        try {
          if (lane === 'transcribe') await this.transcribe(tenantId, r, lease)
          else if (r.notice === 'redact') await this.withdraw(tenantId, r, lease)
          else if (r.notice === 'edit') await this.complete(tenantId, r, lease)
          else await this.notify(tenantId, r, lease)
        } catch (err) {
          if (err instanceof NotTheWriter) return
          if (err instanceof Suspended) {
            if (stalled.add(r.holder).size >= STALLED_MAX) return
            continue
          }
          this.o.log.error({ tenantId, err: brief(err) }, 'voicemail transcription: a step failed, again at the next round')
        }
      }
      if (stalled.size) break
    }
    if (lane === 'notice') await this.sweep(tenantId)
  }

  private guard(tenantId: string, lease: FencedLease) {
    if (!this.mayWrite(tenantId, lease)) throw new NotTheWriter()
  }

  private update(tenantId: string, r: TranscriptRecord, change: Parameters<Store['updateTranscript']>[3], lease: FencedLease, ifNotice?: TranscriptNotice) {
    return this.o.store.updateTranscript(tenantId, r.holder, r.messageId, change, lease, ifNotice)
  }

  /** The message of a row from its mailbox; the voicemail server out: the round ends (Suspended), nothing counted, said once a while. */
  private async messageOrSuspend(tenantId: string, r: TranscriptRecord) {
    try {
      return await this.messageOf(tenantId, r)
    } catch (err) {
      this.quietly(tenantId, 'voicemail', { err: brief(err) }, 'voicemail transcription: the voicemail server does not answer, the transcriptions and notices wait')
      throw new Suspended()
    }
  }

  /** A row whose message its transcription does not find: kept, looked for again later (the reconciliation erases it once its absence is confirmed). */
  private async lookAgain(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    this.guard(tenantId, lease)
    await this.update(tenantId, r, { nextAt: new Date(Date.now() + LOOK_AGAIN_MS).toISOString() }, lease)
  }

  private async messageOf(tenantId: string, r: TranscriptRecord) {
    const vm = this.o.voicemail(tenantId)
    if (!vm) return { vm: undefined, message: undefined }
    const owner = { extension: r.extension, userId: r.holder }
    return { vm, owner, message: (await vm.listMessages(owner)).find(m => m.id === r.messageId) }
  }

  /** The transcription service failed: three times in a row, it is left alone a while (each time longer), the rows kept as they are. */
  private failed() {
    this.breaker.failures++
    if (this.breaker.failures < BREAKER_FAILURES) return
    const wait = this.breakerMs[Math.min(this.breaker.opened, this.breakerMs.length - 1)]!
    this.breaker.until = Date.now() + wait
    this.breaker.opened++
    this.o.log.warn({ failures: this.breaker.failures, pauseSec: wait / 1000 }, 'voicemail transcription: the transcription service keeps failing, left alone a while (the notices go without the text)')
  }

  private async transcribe(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    const t = this.o.transcription
    if (!t) {
      await this.settle(tenantId, r, { status: 'none' }, lease)
      return
    }
    if (Date.now() < this.breaker.until) throw new Suspended()
    const { vm, owner, message } = await this.messageOrSuspend(tenantId, r)
    if (!vm || !owner) return
    // Not seen (deleted, purged, or a mailbox read empty a while): its row kept, looked for again later.
    if (!message) return this.lookAgain(tenantId, r, lease)
    if (message.durationSec > t.maxSec) return this.settle(tenantId, r, { status: 'none', reason: 'too-long' }, lease)
    const attempts = r.attempts + 1
    let asked = false
    try {
      const recording = await vm.getRecording(owner, r.messageId)
      if (!recording) return await this.lookAgain(tenantId, r, lease)
      if (recording.size !== undefined && recording.size > t.maxBytes) throw new TooLong(`recording of ${recording.size} bytes`)
      const audio = await readAll(recording.body, t.maxBytes)
      this.guard(tenantId, lease)
      asked = true
      const { text } = await t.provider.transcribe(audio, { contentType: recording.contentType, signal: this.signal })
      this.breaker = { failures: 0, until: 0, opened: 0 }
      await this.settle(tenantId, r, { status: 'done', text: keptText(text) }, lease)
    } catch (err) {
      if (err instanceof NotTheWriter) throw err
      if (err instanceof TooLong) return this.settle(tenantId, r, { status: 'none', reason: 'too-long' }, lease)
      // Stopped (the Gateway closes): nothing counted, the row left due for the next writer.
      if (this.closed) throw new NotTheWriter()
      if (asked) this.failed()
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
    // Its notice sent without it (the wait past): completed now, unless withdrawn meanwhile.
    if (this.o.notices && this.o.notices.withText !== false) await this.update(tenantId, r, { notice: 'edit', noticeAttempts: 0, noticeNextAt: new Date().toISOString() }, lease, 'early')
    this.kick(tenantId, 'notice')
  }

  private async noticeFailed(tenantId: string, r: TranscriptRecord, lease: FencedLease, err: unknown, withdraw: boolean) {
    const attempts = r.noticeAttempts + 1
    const retryAfter = err instanceof MatrixError ? (err.retryAfterMs ?? 0) : 0
    if (this.closed) throw new NotTheWriter()
    this.o.log.warn({ tenantId, attempt: attempts, err: brief(err) }, withdraw ? 'voicemail notice not withdrawn' : 'voicemail notice not sent')
    if (!withdraw && attempts > this.noticeRetryMs.length) {
      this.guard(tenantId, lease)
      await this.update(tenantId, r, { notice: 'none', noticeAttempts: attempts }, lease)
      await this.o.alert(tenantId, 'notice-failed', 1).catch(() => undefined)
      return
    }
    const wait = Math.max(this.noticeRetryMs[Math.min(attempts, this.noticeRetryMs.length) - 1]!, retryAfter)
    this.guard(tenantId, lease)
    await this.update(tenantId, r, { noticeAttempts: attempts, noticeNextAt: new Date(Date.now() + wait).toISOString() }, lease)
  }

  /** No notice for this message: nobody's account to send it to. Said in the log (a print of the id), counted, told to the administrators. */
  private async noAccount(tenantId: string, r: TranscriptRecord, lease: FencedLease, why: string, matrixId?: string) {
    const count = (this.noAccounts.get(tenantId) ?? 0) + 1
    this.noAccounts.set(tenantId, count)
    this.o.log.warn({ tenantId, why, ...(matrixId && this.o.pseudonym ? { matrix: this.o.pseudonym(tenantId, matrixId) } : {}) }, `voicemail notice: no Matrix account to send it to (${why}), none sent`)
    await this.o.alert(tenantId, 'notice-no-account', count).catch(() => undefined)
    this.guard(tenantId, lease)
    await this.update(tenantId, r, { notice: 'none' }, lease)
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
      let matrixId: string | undefined
      try {
        matrixId = (await n.matrixIdOf(tenantId, userId)) ?? matrixIdFromTemplate(n.userTemplate, userId)
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === MATRIX_ID_AMBIGUOUS) return this.noAccount(tenantId, r, lease, 'two ids in the directory')
        throw err
      }
      if (!matrixId) return this.noAccount(tenantId, r, lease, 'none in the directory nor from the template')
      if (!MATRIX_USER_ID.test(matrixId)) return this.noAccount(tenantId, r, lease, 'not a Matrix user id')
      const me = await n.bot.whoami(this.signal)
      // The bot's own server only: a notice never leaves the organisation's homeserver.
      if (matrixId.slice(matrixId.indexOf(':') + 1) !== me.serverName || matrixId === me.userId) return this.noAccount(tenantId, r, lease, "not on the bot's server", matrixId)
      const { message } = await this.messageOrSuspend(tenantId, r)
      // Not seen (deleted, purged, or a mailbox read empty a while): nothing sent now, looked for again later; the
      // reconciliation erases its row once its absence is confirmed.
      if (!message) {
        this.guard(tenantId, lease)
        await this.update(tenantId, r, { noticeNextAt: new Date(Date.now() + LOOK_AGAIN_MS).toISOString() }, lease)
        return
      }
      const room = await this.roomFor(tenantId, r.holder, matrixId, me.userId, lease)
      if (room === 'declined') return none()
      if (room === 'no-account') return this.noAccount(tenantId, r, lease, 'no such account on the homeserver', matrixId)
      const key = noticeKey(tenantId, r)
      this.guard(tenantId, lease)
      // One sent before whose answer was lost (another token, a transaction the homeserver no longer keeps): found again.
      const before = room.made ? undefined : await n.bot.findSent(room.roomId, NOTICE_FIELD, key, this.signal)
      this.guard(tenantId, lease)
      const eventId = before ?? (await n.bot.send(room.roomId, txnOf('n', tenantId, r), noticeContent(message, r, n, key), this.signal))
      // Sent before its transcription (the wait past): `early`, completed once it is settled.
      const early = r.status === 'pending' && n.withText !== false
      if (await this.update(tenantId, r, { notice: early ? 'early' : 'sent', noticeRoom: room.roomId, noticeEvent: eventId, noticeAttempts: 0 }, lease)) {
        // Settled meanwhile (its own `early` to `edit` came before this): completed all the same.
        if (early && (await this.o.store.listTranscripts(tenantId, r.holder, [r.messageId]))[0]?.status !== 'pending') await this.update(tenantId, r, { notice: 'edit', noticeNextAt: new Date().toISOString() }, lease, 'early')
        return
      }
      // Erased while it was sent (its row gone): withdrawn at once. Under a lease lost, the next writer finds it again.
      if (!(await this.o.store.listTranscripts(tenantId, r.holder, [r.messageId])).length && this.mayWrite(tenantId, lease)) await n.bot.redact(room.roomId, eventId, txnOf('r', tenantId, r), 'TwakePhone', this.signal)
    } catch (err) {
      if (err instanceof NotTheWriter || err instanceof Suspended) throw err
      await this.noticeFailed(tenantId, r, lease, err, false)
    }
  }

  /**
   * A notice sent before its transcription, completed with it: a replacement (`m.replace`) of the same notice, with the
   * text (or why there is none). Withdrawn with it. A message gone meanwhile: left as it is (withdrawn with its erasure).
   */
  private async complete(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    const n = this.o.notices
    const sent = async () => {
      this.guard(tenantId, lease)
      await this.update(tenantId, r, { notice: 'sent' }, lease, 'edit')
    }
    if (!n || !r.noticeRoom || !r.noticeEvent) return sent()
    try {
      const { message } = await this.messageOrSuspend(tenantId, r)
      if (!message) return sent()
      const content = noticeContent(message, r, n)
      this.guard(tenantId, lease)
      const editId = await n.bot.send(
        r.noticeRoom,
        txnOf('e', tenantId, r),
        { msgtype: content.msgtype, body: `* ${content.body}`, 'm.new_content': content, 'm.relates_to': { rel_type: 'm.replace', event_id: r.noticeEvent } },
        this.signal
      )
      if (await this.update(tenantId, r, { notice: 'sent', noticeEdit: editId, noticeAttempts: 0 }, lease, 'edit')) return
      // Erased meanwhile: withdrawn with the notice (kept to withdraw), or at once when its row is gone.
      if (!(await this.update(tenantId, r, { noticeEdit: editId }, lease)) && this.mayWrite(tenantId, lease)) await n.bot.redact(r.noticeRoom, editId, txnOf('x', tenantId, r), 'TwakePhone', this.signal)
    } catch (err) {
      if (err instanceof NotTheWriter || err instanceof Suspended) throw err
      if (this.closed) throw new NotTheWriter()
      // Past its tries: the notice stays as it was sent (the text in TwakePhone), nothing more tried.
      const attempts = r.noticeAttempts + 1
      this.o.log.warn({ tenantId, attempt: attempts, err: brief(err) }, 'voicemail notice not completed with its transcription')
      this.guard(tenantId, lease)
      if (attempts > this.noticeRetryMs.length) await this.update(tenantId, r, { notice: 'sent', noticeAttempts: 0 }, lease, 'edit')
      else await this.update(tenantId, r, { noticeAttempts: attempts, noticeNextAt: new Date(Date.now() + this.noticeRetryMs[attempts - 1]!).toISOString() }, lease, 'edit')
    }
  }

  /**
   * Whether the bot may write in a room to the person: `ok` while they are in it (joined or invited) alone with the bot;
   * `declined` when they turned the invitation down or left; `lost` when the bot is no longer in it, or someone else is.
   */
  private async usable(roomId: string, matrixId: string, bot: string): Promise<'ok' | 'declined' | 'lost'> {
    const members = await this.o.notices!.bot.members(roomId, this.signal).catch((err: unknown) => {
      if (err instanceof MatrixError && (err.status === 403 || err.status === 404)) return undefined
      throw err
    })
    if (!members) return 'lost'
    const present = members.filter(m => ['join', 'invite', 'knock'].includes(m.membership))
    if (!present.some(m => m.userId === bot && m.membership === 'join')) return 'lost'
    if (!present.every(m => m.userId === bot || m.userId === matrixId)) return 'lost'
    if (present.some(m => m.userId === matrixId && (m.membership === 'join' || m.membership === 'invite'))) return 'ok'
    return members.some(m => m.userId === matrixId) ? 'declined' : 'lost'
  }

  /** A room the bot no longer writes in: left once none of the holder's notices is left in it (sweep). */
  private async toLeave(tenantId: string, holder: string, room: RoomState) {
    if (!room.roomId) return
    const key = LEAVE + holderKey(tenantId, holder)
    const kept = (await this.o.store.getOperatorState(tenantId, key)) as LeaveState | undefined
    const rooms = (Array.isArray(kept?.rooms) ? kept.rooms : []).filter(x => x.roomId !== room.roomId)
    await this.o.store.putOperatorState(tenantId, key, { holder: holderIn(holder), rooms: [...rooms, { roomId: room.roomId, ...(room.alias ? { alias: room.alias } : {}) }] } satisfies LeaveState)
    this.swept.delete(tenantId)
  }

  /**
   * The room of the bot with the holder (operator state, by a print of the holder): the one kept while the person is in
   * it alone with the bot; `declined` when they turned it down or left it (not invited again for a while); else a new
   * one, made once whatever fails: its address (a random alias) written before it is made, a room already at it taken.
   */
  private async roomFor(tenantId: string, holder: string, matrixId: string, bot: string, lease: FencedLease): Promise<{ roomId: string; made: boolean } | 'declined' | 'no-account'> {
    const n = this.o.notices!
    const key = ROOM + holderKey(tenantId, holder)
    const kept = roomStateOf(await this.o.store.getOperatorState(tenantId, key))
    const declinedFor = this.o.declinedMs ?? 30 * 86_400_000
    if (kept?.declinedAt && kept.matrixId === matrixId && Date.now() - Date.parse(kept.declinedAt) < declinedFor) return 'declined'
    if (kept?.roomId) {
      const verdict = kept.matrixId === matrixId ? await this.usable(kept.roomId, matrixId, bot) : 'lost'
      if (verdict === 'ok') return { roomId: kept.roomId, made: false }
      this.guard(tenantId, lease)
      await this.toLeave(tenantId, holder, kept)
      if (verdict === 'declined') {
        await this.o.store.putOperatorState(tenantId, key, { matrixId, declinedAt: new Date().toISOString() } satisfies RoomState)
        this.o.log.info({ tenantId, ...(this.o.pseudonym ? { matrix: this.o.pseudonym(tenantId, matrixId) } : {}) }, "voicemail notices: the person turned the bot's room down, not invited again for a while")
        return 'declined'
      }
    }
    // Made before, its answer lost: the address kept says where.
    let alias = kept && !kept.roomId && !kept.declinedAt && kept.matrixId === matrixId ? kept.alias : undefined
    for (let tries = 0; tries < 2; tries++) {
      if (!alias) {
        // The person's account first: no room for an id nobody has.
        if ((await n.bot.exists(matrixId, this.signal)) === false) return 'no-account'
        alias = `twakephone-${randomBytes(16).toString('hex')}`
        this.guard(tenantId, lease)
        await this.o.store.putOperatorState(tenantId, key, { alias, matrixId } satisfies RoomState)
      }
      let roomId = await n.bot.resolveAlias(alias, this.signal)
      if (!roomId) {
        this.guard(tenantId, lease)
        roomId = await n.bot.createDirectRoom(matrixId, 'TwakePhone', 'Vos messages vocaux de TwakePhone', alias, this.signal).catch(async (err: unknown) => {
          if (err instanceof MatrixError && err.errcode === 'M_ROOM_IN_USE') return n.bot.resolveAlias(alias!, this.signal)
          throw err
        })
        if (!roomId) throw new MatrixError('createRoom: the address taken, no room at it')
      } else if ((await this.usable(roomId, matrixId, bot)) !== 'ok') {
        // Not the bot's room with them (someone else's at that address, or left): another address.
        alias = undefined
        continue
      }
      this.guard(tenantId, lease)
      await this.o.store.putOperatorState(tenantId, key, { alias, matrixId, roomId } satisfies RoomState)
      return { roomId, made: true }
    }
    throw new MatrixError('createRoom: no address free')
  }

  /** The rooms the bot no longer writes in, left once none of the holder's notices is left in them: once a minute at most. */
  private async sweep(tenantId: string) {
    const n = this.o.notices
    if (!n || Date.now() - (this.swept.get(tenantId) ?? 0) < 60_000) return
    this.swept.set(tenantId, Date.now())
    for (const { key, value } of await this.o.store.listOperatorState(tenantId, LEAVE)) {
      const lease = this.lease(tenantId)
      if (!lease) return
      const v = value as LeaveState | undefined
      if (!v || typeof v.holder !== 'string' || !Array.isArray(v.rooms)) continue
      const holder = holderOut(v.holder)
      const rows = await this.o.store.listTranscripts(tenantId, holder, undefined, true)
      const stay: LeaveState['rooms'] = []
      for (const room of v.rooms) {
        if (rows.some(r => r.noticeRoom === room.roomId && r.noticeEvent && r.notice !== 'none')) {
          stay.push(room)
          continue
        }
        try {
          this.guard(tenantId, lease)
          await n.bot.leave(room.roomId, this.signal)
          if (room.alias) await n.bot.deleteAlias(room.alias, this.signal)
        } catch (err) {
          if (err instanceof NotTheWriter) return
          this.o.log.warn({ tenantId, err: brief(err) }, 'voicemail notices: a room of the bot not left, again later')
          stay.push(room)
        }
      }
      if (stay.length === v.rooms.length) continue
      if (!this.mayWrite(tenantId, lease)) return
      if (stay.length) await this.o.store.putOperatorState(tenantId, key, { holder: v.holder, rooms: stay } satisfies LeaveState)
      else await this.o.store.deleteOperatorState(tenantId, key, value)
    }
  }

  private async withdraw(tenantId: string, r: TranscriptRecord, lease: FencedLease) {
    const n = this.o.notices
    const gone = async () => {
      this.guard(tenantId, lease)
      await this.o.store.deleteTranscript(tenantId, r.holder, r.messageId, lease)
      this.swept.delete(tenantId)
    }
    if (!r.noticeRoom || !r.noticeEvent) return gone()
    if (!n) {
      this.o.log.warn({ tenantId }, 'voicemail notice not withdrawn: no bot any more (MATRIX_*): it stays in Chat')
      await this.o.alert(tenantId, 'notice-not-withdrawn', 1).catch(() => undefined)
      return gone()
    }
    // The bot can no longer withdraw one (it left the room, the event is gone): nothing more to try for it.
    const redact = async (eventId: string, what: 'r' | 'x') => {
      this.guard(tenantId, lease)
      await n.bot.redact(r.noticeRoom!, eventId, txnOf(what, tenantId, r), 'TwakePhone', this.signal).catch((err: unknown) => {
        if (!(err instanceof MatrixError && (err.status === 403 || err.status === 404))) throw err
        this.o.log.warn({ tenantId, err: brief(err) }, 'voicemail notice cannot be withdrawn any more')
      })
    }
    try {
      // Its replacement first (it carries the text too), then the notice.
      if (r.noticeEdit) await redact(r.noticeEdit, 'x')
      await redact(r.noticeEvent, 'r')
      await gone()
    } catch (err) {
      if (err instanceof NotTheWriter) throw err
      await this.noticeFailed(tenantId, r, lease, err, true)
    }
  }
}

/** The print of a message (its tenant, holder and id): the same whatever the Gateway, never the ids themselves. */
const printOf = (tenantId: string, r: Pick<TranscriptRecord, 'holder' | 'messageId'>) => createHash('sha256').update([tenantId, r.holder, r.messageId].join('\u0000')).digest('hex').slice(0, 32)
/**
 * The transaction id of a notice (`n`), of its withdrawal (`r`), of its replacement with the transcription (`e`) and of
 * the withdrawal of that one (`x`): the same for the same message, whatever the Gateway.
 */
export const txnOf = (what: 'n' | 'r' | 'e' | 'x', tenantId: string, r: Pick<TranscriptRecord, 'holder' | 'messageId'>) => `twakephone-${what}-${printOf(tenantId, r)}`
/** What a notice carries in NOTICE_FIELD: the print of its message. */
export const noticeKey = (tenantId: string, r: Pick<TranscriptRecord, 'holder' | 'messageId'>) => printOf(tenantId, r)

export interface TranscriptWatcherOptions {
  store: Pick<Store, 'transcriptsChangedSince' | 'clock'>
  tenants(): Iterable<string>
  /** Whether this Gateway has a screen of the person open (anything to tell). */
  listening(tenantId: string, userId: string): boolean
  holderIdFor(tenantId: string, userId: string): Promise<string>
  publish(tenantId: string, userId: string, event: TelephonyEvent): void
  log: { error(obj: object, msg: string): void }
  /** The language of the texts. */
  lang?: string
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
          const transcript = publicTranscript(r, this.o.lang)
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
