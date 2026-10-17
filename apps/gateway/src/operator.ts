import type { OperatorFallback, WebhookTrunkFallback } from '@twake/telephony-types'
import { OperatorError, type OperatorErrorCode, type OperatorProvider } from '@twake/telephony-provider-sdk'
import { extensionOfDid, matchCdrs } from './reconcile.js'
import type { HistoryEntry, OperatorCdrOutcome, OperatorCdrStats, Store, TrunkRecord } from './store/types.js'

/** How often the operator is read (fallbacks, records of calls): every 10 minutes. */
export const OPERATOR_SYNC_MS = 600_000
/** The records of calls asked at each read: the last 48 hours (the operator may list one late). */
export const OPERATOR_CDR_WINDOW_MS = 48 * 3_600_000
/** A record is reconciled once read that long ago: the entry of its call is written by then (the call ended before the operator listed it). */
export const OPERATOR_SETTLE_MS = 5 * 60_000
/** The records of the operator are kept 90 days. */
export const OPERATOR_CDR_RETENTION_MS = 90 * 86_400_000
/** The statistics of the administration: the last 7 days. */
export const OPERATOR_STATS_MS = 7 * 86_400_000
/** Records read per tenant and round at most (one request each), 4 at a time. */
const READ_PER_ROUND = 500
const READ_PARALLEL = 4
/** Records reconciled per batch, batches per round. */
const RECONCILE_BATCH = 500
const RECONCILE_BATCHES = 4
/** The calls of the history a record may be of: started at most that long before it (no call lasts longer). */
const HISTORY_SPAN_MS = 4 * 3_600_000
const HISTORY_LIMIT = 5_000
/** A fallback read longer ago is read again when a trunk event tells it (within FRESH_READ_MS, else what was read). */
const FRESH_FALLBACK_MS = 60_000
const FRESH_READ_MS = 3_000

export interface OperatorLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export interface OperatorSyncOptions {
  store: Store
  /** The operator of each tenant that has one (step 10b: OVHcloud, for the organisation of the pilot). */
  operators: ReadonlyMap<string, OperatorProvider>
  /** Whether this Gateway runs the rounds (WebhookHub.leading: one Gateway reads for all); always by default. */
  leading?: () => boolean
  everyMs?: number
  settleMs?: number
  /** The first round, that long after start (5 s by default). */
  firstMs?: number
  logger?: OperatorLogger
  now?: () => number
}

/** One line of a trunk at the operator, as this Gateway last saw it. */
export interface OperatorLineStatus {
  line: string
  /** The fallback set there, as last read (or written). */
  fallback?: OperatorFallback
  /** The trunk asks the Gateway to keep its fallback there (TrunkOperator.fallback). */
  managed: boolean
  /** What is there is what is asked (managed only). */
  inSync?: boolean
  readAt?: string
  /** When this Gateway last set it there; when it found it changed there (the manager) and put it back. */
  appliedAt?: string
  restoredAt?: string
  error?: OperatorErrorCode
}

export interface OperatorStatus {
  operator: string
  trunks: { id: string; lines: OperatorLineStatus[] }[]
  cdrs: { readAt?: string; read?: number; error?: OperatorErrorCode; stats: OperatorCdrStats; since: string }
}

const isOn = (f: OperatorFallback) => f.onUnavailable || f.noAnswerAfterSec !== undefined
/** Whether two fallbacks forward the same calls to the same number (two that forward none are the same). */
export const sameFallback = (a: OperatorFallback, b: OperatorFallback) =>
  (!isOn(a) && !isOn(b)) || (a.onUnavailable === b.onUnavailable && a.noAnswerAfterSec === b.noAnswerAfterSec && a.number === b.number)
const plain = (f: OperatorFallback): OperatorFallback => (isOn(f) ? f : { onUnavailable: false })

const codeOf = (err: unknown): OperatorErrorCode => (err instanceof OperatorError ? err.code : 'unreachable')
const key = (...parts: string[]) => parts.join('\u0000')

const within = <T>(p: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operator: no answer in time')), ms)
    timer.unref()
    p.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })

/** `items` through `run`, `parallel` at a time, in order. */
const mapLimit = async <T, R>(items: readonly T[], parallel: number, run: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await run(items[i]!)
      }
    })
  )
  return out
}

/**
 * What the platform keeps in step with the operator of its trunks (step 10b, ADR 0021), every OPERATOR_SYNC_MS by
 * the Gateway that leads, and on demand:
 * - the fallback forward of each line of a trunk that asks for one, set there, read back, and put back when someone
 *   changed it in the operator's manager (said in the log); a trunk that asks none has its lines read only;
 * - the records of calls of those lines over the last 48 hours, each read once and kept;
 * - those records reconciled with the history once read OPERATOR_SETTLE_MS ago (matchCdrs), one inbound that matches
 *   no call entered in the history of whom its direct number rings, the others counted.
 */
export class OperatorSync {
  private readonly lines = new Map<string, OperatorLineStatus & { asked?: string }>()
  private readonly cdrs = new Map<string, Omit<OperatorStatus['cdrs'], 'stats' | 'since'>>()
  private readonly rounds = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private first: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => number

  constructor(private readonly options: OperatorSyncOptions) {
    this.now = options.now ?? Date.now
  }

  /** Whether the tenant has an operator. */
  serves(tenantId: string) {
    return this.options.operators.has(tenantId)
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString()
  }

  start() {
    if (this.timer) return
    this.first = setTimeout(() => void this.tick(), this.options.firstMs ?? 5_000)
    this.first.unref()
    this.timer = setInterval(() => void this.tick(), this.options.everyMs ?? OPERATOR_SYNC_MS)
    this.timer.unref()
  }

  stop() {
    clearTimeout(this.first)
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** One round over the tenants (the schedule runs it; tests call it), and the purge of the old records. */
  async tick() {
    if (this.options.leading && !this.options.leading()) return
    for (const tenantId of this.options.operators.keys()) await this.round(tenantId).catch((err: unknown) => this.options.logger?.warn({ err, tenantId }, 'operator: round not done'))
    await this.options.store.purgeOperatorCdrs(this.iso(this.now() - OPERATOR_CDR_RETENTION_MS)).catch((err: unknown) => this.options.logger?.warn({ err }, 'operator: old records of calls not purged'))
  }

  /** A round for one tenant: one at a time (asked again meanwhile: the one under way). */
  round(tenantId: string): Promise<void> {
    let r = this.rounds.get(tenantId)
    if (!r) {
      r = this.run(tenantId).finally(() => this.rounds.delete(tenantId))
      this.rounds.set(tenantId, r)
    }
    return r
  }

  private async run(tenantId: string) {
    if (!this.serves(tenantId)) return
    const trunks = await this.options.store.listTrunks(tenantId)
    await this.fallbacks(tenantId, trunks, true)
    await this.importCdrs(tenantId, trunks)
    await this.reconcile(tenantId)
  }

  /** The fallbacks of one trunk now (an administrator changed it): set where asked, read everywhere. */
  async applyTrunk(tenantId: string, trunkId: string) {
    if (!this.serves(tenantId)) return
    const trunk = (await this.options.store.listTrunks(tenantId)).find(t => t.id === trunkId)
    if (trunk) await this.fallbacks(tenantId, [trunk], false)
    else for (const k of [...this.lines.keys()]) if (k.startsWith(key(tenantId, trunkId, ''))) this.lines.delete(k)
  }

  private async fallbacks(tenantId: string, trunks: readonly TrunkRecord[], all: boolean) {
    // What was seen of lines no longer on their trunk, or of trunks gone, is forgotten.
    for (const k of [...this.lines.keys()]) {
      const [t, trunkId, line] = k.split('\u0000')
      if (t !== tenantId) continue
      const trunk = trunks.find(x => x.id === trunkId)
      if ((trunk || all) && !trunk?.config.operator?.lines.includes(line!)) this.lines.delete(k)
    }
    for (const trunk of trunks) for (const line of trunk.config.operator?.lines ?? []) await this.line(tenantId, trunk.id, line, trunk.config.operator?.fallback)
  }

  private async line(tenantId: string, trunkId: string, line: string, asked: OperatorFallback | undefined) {
    const operator = this.options.operators.get(tenantId)
    if (!operator) return
    const k = key(tenantId, trunkId, line)
    const before = this.lines.get(k)
    const wanted = asked ? JSON.stringify(plain(asked)) : undefined
    const kept = { ...(before?.appliedAt ? { appliedAt: before.appliedAt } : {}), ...(before?.restoredAt ? { restoredAt: before.restoredAt } : {}) }
    try {
      let fallback = await operator.getFallback(line)
      const now = this.iso()
      if (asked && !sameFallback(asked, fallback)) {
        await operator.setFallback(line, plain(asked))
        // It was there as asked, and is no longer: someone changed it at the operator (its manager). Put back.
        const restored = before?.inSync === true && before.asked === wanted
        if (restored) this.options.logger?.warn({ tenantId, trunkId, line }, 'operator: the fallback was changed at the operator, put back as asked')
        else this.options.logger?.info({ tenantId, trunkId, line }, 'operator: fallback set at the operator')
        Object.assign(kept, { appliedAt: now, ...(restored ? { restoredAt: now } : {}) })
        fallback = plain(asked)
      }
      this.lines.set(k, { line, fallback, managed: !!asked, ...(asked ? { inSync: true } : {}), readAt: now, ...kept, ...(wanted ? { asked: wanted } : {}) })
    } catch (err) {
      this.options.logger?.warn({ err, tenantId, trunkId, line }, 'operator: the fallback of a line not read or not set')
      this.lines.set(k, { ...(before ?? {}), line, managed: !!asked, ...(asked ? { inSync: false } : { inSync: undefined }), error: codeOf(err), ...(wanted ? { asked: wanted } : {}) })
    }
  }

  private async importCdrs(tenantId: string, trunks: readonly TrunkRecord[]) {
    const operator = this.options.operators.get(tenantId)!
    const lines = [...new Set(trunks.flatMap(t => t.config.operator?.lines ?? []))]
    if (!lines.length) return
    const from = this.iso(this.now() - OPERATOR_CDR_WINDOW_MS)
    const to = this.iso()
    let read = 0
    try {
      for (const line of lines) {
        // Kept by line and id: two lines may number their records alike.
        const ids = (await operator.listCdrIds(line, from, to)).map(id => ({ id, kept: `${line}:${id}` }))
        const known = new Set(await this.options.store.knownOperatorCdrs(tenantId, operator.id, ids.map(i => i.kept)))
        const fresh = ids.filter(i => !known.has(i.kept)).slice(0, READ_PER_ROUND - read)
        const cdrs = (await mapLimit(fresh, READ_PARALLEL, async i => {
          const cdr = await operator.getCdr(line, i.id)
          return cdr && { ...cdr, id: i.kept, line }
        })).filter(c => !!c)
        await this.options.store.addOperatorCdrs(tenantId, operator.id, cdrs)
        read += cdrs.length
        if (read >= READ_PER_ROUND) break
      }
      this.cdrs.set(tenantId, { readAt: this.iso(), read })
    } catch (err) {
      this.options.logger?.warn({ err, tenantId }, 'operator: records of calls not read')
      this.cdrs.set(tenantId, { ...(this.cdrs.get(tenantId) ?? {}), error: codeOf(err) })
    }
  }

  private async reconcile(tenantId: string) {
    const operator = this.options.operators.get(tenantId)!
    const store = this.options.store
    const readBefore = this.iso(this.now() - (this.options.settleMs ?? OPERATOR_SETTLE_MS))
    let dids: Awaited<ReturnType<Store['listDids']>> | undefined
    for (let batch = 0; batch < RECONCILE_BATCHES; batch++) {
      const pending = await store.pendingOperatorCdrs(tenantId, operator.id, readBefore, RECONCILE_BATCH)
      if (!pending.length) return
      const starts = pending.map(p => Date.parse(p.startedAt))
      const history = await store.unreconciledHistory(tenantId, this.iso(Math.min(...starts) - HISTORY_SPAN_MS), this.iso(Math.max(...starts) + 60_000), HISTORY_LIMIT)
      const matched = matchCdrs(pending, history)
      const outcomes: OperatorCdrOutcome[] = []
      for (const r of pending) {
        if (r.forwarded) outcomes.push({ id: r.id, outcome: 'forwarded' })
        else if (matched.has(r.id)) outcomes.push({ id: r.id, outcome: 'matched', callId: matched.get(r.id)! })
        else if (r.direction === 'inbound' && r.calling && r.called) {
          // A call the platform never had (received while it could not be reached, or an event lost): in the
          // history of whom its direct number rings, when that is one person (an extension, not a group).
          dids ??= await store.listDids(tenantId)
          const extension = extensionOfDid(dids, r.called)
          const holder = extension ? await store.getMappingByExtension(tenantId, extension) : null
          if (!holder) {
            outcomes.push({ id: r.id, outcome: 'unmatched' })
            continue
          }
          const answered = r.durationSec > 0
          const entry: HistoryEntry = {
            tenantId,
            userId: holder.userId,
            callId: `${operator.id}:${r.id}`,
            direction: 'inbound',
            remoteNumber: r.calling,
            startedAt: r.startedAt,
            endedAt: this.iso(Date.parse(r.startedAt) + r.durationSec * 1000),
            durationSec: r.durationSec,
            state: answered ? 'ended' : 'missed',
            answered
          }
          outcomes.push({ id: r.id, outcome: 'orphan', entry })
        } else outcomes.push({ id: r.id, outcome: 'unmatched' })
      }
      await store.settleOperatorCdrs(tenantId, operator.id, outcomes)
      if (pending.length < RECONCILE_BATCH) return
    }
  }

  /**
   * The fallback set at the operator for a trunk's lines, as a trunk event tells it (no number): read again first
   * when it was read over a minute ago (within FRESH_READ_MS: the platform is in trouble, the operator's API may be
   * too). Forwarded on unavailability when every line is, on no answer when every line is (the longest delay).
   * Undefined when the trunk has no line at an operator, or a line was never read.
   */
  async fallbackOf(tenantId: string, trunkId: string): Promise<WebhookTrunkFallback | undefined> {
    if (!this.serves(tenantId)) return undefined
    const trunk = (await this.options.store.listTrunks(tenantId)).find(t => t.id === trunkId)
    const lines = trunk?.config.operator?.lines ?? []
    if (!trunk || !lines.length) return undefined
    const states = () => lines.map(l => this.lines.get(key(tenantId, trunkId, l)))
    if (states().some(s => !s?.readAt || this.now() - Date.parse(s.readAt) > FRESH_FALLBACK_MS))
      await within(Promise.all(lines.map(l => this.line(tenantId, trunkId, l, trunk.config.operator?.fallback))), FRESH_READ_MS).catch(() => undefined)
    const reads = states().map(s => s?.fallback)
    if (reads.some(r => !r)) return undefined
    const all = reads as OperatorFallback[]
    const delays = all.map(r => r.noAnswerAfterSec)
    return { on_unavailable: all.every(r => r.onUnavailable), ...(delays.every(d => d !== undefined) ? { no_answer_after_sec: Math.max(...delays) } : {}) }
  }

  /** What the administration shows: each trunk's lines at the operator, and the records of calls of the last 7 days. */
  async status(tenantId: string): Promise<OperatorStatus | undefined> {
    const operator = this.options.operators.get(tenantId)
    if (!operator) return undefined
    const trunks = await this.options.store.listTrunks(tenantId)
    const since = this.iso(this.now() - OPERATOR_STATS_MS)
    return {
      operator: operator.id,
      trunks: trunks
        .filter(t => t.config.operator?.lines.length)
        .map(t => ({
          id: t.id,
          lines: t.config.operator!.lines.map(line => {
            const { asked: _asked, ...s } = this.lines.get(key(tenantId, t.id, line)) ?? { line, managed: !!t.config.operator?.fallback }
            return s
          })
        })),
      cdrs: { ...(this.cdrs.get(tenantId) ?? {}), stats: await this.options.store.operatorCdrStats(tenantId, operator.id, since), since }
    }
  }
}
