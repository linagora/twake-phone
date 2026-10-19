import type { TranscriptionProvider } from '@twake/telephony-provider-sdk'

// LinTO STT (linto-stt, LINAGORA, AGPL), as the Gateway transcribes the messages of the mailboxes with it (step 11b,
// ADR 0023): its HTTP mode, `POST /transcribe` (the recording as the `file` of a multipart form, `Accept:
// application/json`) and `GET /healthcheck`. Whatever its engine and model: the Gateway only reads the text.

/** A failure of LinTO, in a few words: never its body, never the audio. `status`: its HTTP status, when it answered. */
export class LintoError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'LintoError'
  }
}

export interface LintoConfig {
  /** Where LinTO STT listens (`http://127.0.0.1:8090`): its routes under it. */
  url: string
  /**
   * The language asked of it (`fr-FR`), sent only when given: the Kaldi engine refuses any (its model has one), the
   * multilingual ones take it.
   */
  language?: string
  /** How long it has to answer, the recording sent included: 120 s by default. */
  timeoutMs?: number
  /** The largest recording sent, in bytes: one larger is refused before (8 MB by default). */
  maxBytes?: number
  /** The largest answer read, in bytes (1 MB by default): one larger is an error. */
  maxAnswerBytes?: number
  /** Tests: another fetch. */
  fetch?: typeof globalThis.fetch
}

/** The answer of `POST /transcribe`: a JSON object, or that object encoded once more as a JSON string (its HTTP server does). */
const textOf = (raw: string): string | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
    if (typeof value === 'string') value = JSON.parse(value)
  } catch {
    return undefined
  }
  const text = (value as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text : undefined
}

/** A body read up to `max` bytes; past it, an error (the connection let go). */
const readCapped = async (res: Response, max: number) => {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) throw new LintoError(`answer larger than ${max} bytes`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** LinTO STT's HTTP API (the transcription of the messages, TranscriptionProvider). */
export class LintoTranscription implements TranscriptionProvider {
  readonly id = 'linto'
  private readonly base: string
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly maxAnswerBytes: number
  private readonly fetch: typeof globalThis.fetch

  constructor(private readonly config: LintoConfig) {
    const url = new URL(config.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('LinTO: its URL must be http: or https:')
    if (url.username || url.password) throw new Error('LinTO: its URL must not carry credentials')
    if (url.search || url.hash) throw new Error('LinTO: its URL must have no query nor fragment')
    this.base = url.toString().replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 120_000
    this.maxBytes = config.maxBytes ?? 8 * 1024 * 1024
    this.maxAnswerBytes = config.maxAnswerBytes ?? 1024 * 1024
    this.fetch = config.fetch ?? globalThis.fetch
  }

  async transcribe(audio: Uint8Array, options: { contentType?: string; signal?: AbortSignal } = {}): Promise<{ text: string }> {
    if (audio.byteLength > this.maxBytes) throw new LintoError(`recording larger than ${this.maxBytes} bytes`)
    if (!audio.byteLength) throw new LintoError('empty recording')
    const form = new FormData()
    // A copy of its own bytes (a Blob takes an ArrayBuffer, not a view of a shared one).
    form.append('file', new Blob([new Uint8Array(audio)], { type: options.contentType ?? 'audio/wav' }), 'message.wav')
    const query = this.config.language ? `?language=${encodeURIComponent(this.config.language)}` : ''
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
    let res: Response
    try {
      res = await this.fetch(`${this.base}/transcribe${query}`, { method: 'POST', headers: { accept: 'application/json' }, body: form, signal, redirect: 'error' })
    } catch (err) {
      throw new LintoError(signal.aborted ? `no answer within ${this.timeoutMs / 1000} s` : `not reached (${err instanceof Error ? err.name : 'error'})`)
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined)
      throw new LintoError(`answered ${res.status}`, res.status)
    }
    let raw: string
    try {
      raw = await readCapped(res, this.maxAnswerBytes)
    } catch (err) {
      throw err instanceof LintoError ? err : new LintoError(signal.aborted ? `no answer within ${this.timeoutMs / 1000} s` : 'answer cut')
    }
    const text = textOf(raw)
    if (text === undefined) throw new LintoError('answer without a text')
    return { text: text.replace(/\s+/g, ' ').trim() }
  }

  async probe() {
    let res: Response
    try {
      res = await this.fetch(`${this.base}/healthcheck`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000), redirect: 'error' })
    } catch {
      throw new LintoError('not reached')
    }
    await res.body?.cancel().catch(() => undefined)
    if (res.status !== 200) throw new LintoError(`healthcheck answered ${res.status}`, res.status)
  }
}
