import { randomUUID } from 'node:crypto'
import type { OperatorFallback, OperatorForward, OperatorLineForwards, WebhookForwardTarget, WebhookTrunkFallback } from '@twake/telephony-types'
import { OperatorError, type OperatorErrorCode, type OperatorProvider } from '@twake/telephony-provider-sdk'
import { e164Of } from './e164.js'
import { RECONCILE_EARLY_MS, RECONCILE_LATE_MS, directNumbersOf, extensionOfDid, localOf, matchCdrs, remoteOf } from './reconcile.js'
import type { HistoryEntry, HistoryNearQuery, OperatorCdrOutcome, OperatorCdrRecord, OperatorCdrStats, Store, TrunkRecord, UserMapping } from './store/types.js'

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
/** The operator refusing the keys (or their rights) that many rounds in a row raises an alert (review 10b, n°12). */
export const OPERATOR_ALERT_ROUNDS = 2
/** FR-D4: 99 % of the records of calls reconciled; under it, an alert, once that many are settled. */
export const OPERATOR_RECONCILED_PERCENT = 99
export const OPERATOR_RECONCILED_FLOOR = 20
/** Records read per tenant and round at most (one request each), 4 at a time, the lines in turn (review 10b, n°2). */
const READ_PER_ROUND = 500
const READ_PARALLEL = 4
/** Records reconciled per batch, batches per round. */
const RECONCILE_BATCH = 500
const RECONCILE_BATCHES = 4
/** The calls of the history a record may be of: started at most that long before it (no call lasts longer). */
const HISTORY_SPAN_MS = 4 * 3_600_000
/** The entries of one number or one person read by pages of that many, that many pages at most (review 10b, n°3). */
const NEAR_PAGE = 1_000
const NEAR_PAGES = 20
/** A fallback read longer ago is read again when a trunk event tells it (within FRESH_READ_MS, else what was read). */
const FRESH_FALLBACK_MS = 60_000
const FRESH_READ_MS = 3_000
/** How often the Gateway that leads looks for a round another one was asked (review 10b, n°8), and how often that one looks for its end. */
const ASKED_POLL_MS = 2_000
const ANSWER_POLL_MS = 250

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
  /** How often the Gateway that leads looks for a round asked (2 s by default). */
  askedPollMs?: number
  /** Records read per tenant and round at most (500 by default). */
  readPerRound?: number
  logger?: OperatorLogger
  now?: () => number
}

/** Why a line could not be kept as asked: the operator's refusal, or two trunks asking two fallbacks of it (`conflict`, review 10b, n°5). */
export type OperatorLineError = OperatorErrorCode | 'conflict'

/**
 * One line at the operator as the platform keeps it (operator_state `line:<line>`, review 10b, n°8): the same for
 * every Gateway, kept across a restart.
 */
interface LineState {
  /** The forwards set there, as last read. */
  forwards?: OperatorLineForwards
  readAt?: string
  /** When the platform last set them there; when it found them changed there (the manager) and put them back. */
  appliedAt?: string
  restoredAt?: string
  /** What was asked when it was last read (askKey), and whether what was read was it. */
  asked?: string
  inSync?: boolean
  error?: OperatorLineError
  /** What the operator did not keep (askKey, review 10b, n°7): not written again until a trunk is saved. */
  rejected?: string
}

/** One line of the trunks at the operator, as the administration is shown it. */
export interface OperatorLineStatus {
  line: string
  /** The forwards set there, each as it is (review 10b, n°4), as last read. */
  forwards?: OperatorLineForwards
  /** A trunk asks the Gateway to keep its fallback there (TrunkOperator.fallback). */
  managed: boolean
  /** What is there is what is asked (managed only; absent: not read since it was asked). */
  inSync?: boolean
  readAt?: string
  appliedAt?: string
  restoredAt?: string
  error?: OperatorLineError
  /** The operator did not keep what was asked (read back otherwise, or refused): not written again until the trunk is saved. */
  rejected?: true
}

/** The last read of the records of calls (operator_state `cdrs`), written by the Gateway that leads only. */
interface CdrsState {
  readAt?: string
  read?: number
  /** The lines whose records could not be read, and why (review 10b, n°2). */
  lines?: { line: string; error: OperatorErrorCode }[]
  /** Rounds in a row the operator refused the keys or their rights (review 10b, n°12). */
  refusedRounds?: number
  /** When the last round ended, and the round asked it answered (review 10b, n°8). */
  roundAt?: string
  answered?: string
}

export interface OperatorStatus {
  operator: string
  trunks: { id: string; lines: OperatorLineStatus[] }[]
  cdrs: { readAt?: string; read?: number; lines?: { line: string; error: OperatorErrorCode }[]; stats: OperatorCdrStats; since: string }
}

const isOn = (f: OperatorFallback) => f.onUnavailable || f.noAnswerAfterSec !== undefined
/** A fallback as written to the operator: both off is no forward, whatever number. */
const plain = (f: OperatorFallback): OperatorFallback =>
  isOn(f) ? { ...(f.number ? { number: f.number } : {}), onUnavailable: f.onUnavailable, ...(f.noAnswerAfterSec !== undefined ? { noAnswerAfterSec: f.noAnswerAfterSec } : {}) } : { onUnavailable: false }
/** What makes two fallbacks asked the same one. */
export const askKey = (f: OperatorFallback) => (isOn(f) ? `${f.number ?? ''}|${f.onUnavailable}|${f.noAnswerAfterSec ?? ''}` : 'off')

const toNumber = (fw: OperatorForward | undefined, number: string | undefined) => fw?.nature === 'number' && !!fw.number && !!number && e164Of(fw.number) === e164Of(number)
/**
 * Whether the forwards read at the operator are the fallback asked, field by field (review 10b, n°4): on
 * unavailability to its number when asked, none otherwise; on no answer to its number after its delay when asked,
 * none otherwise. A forward to the voicemail, to another number or after another delay is not it.
 */
export const matchesFallback = (asked: OperatorFallback, f: OperatorLineForwards) =>
  (asked.onUnavailable ? toNumber(f.onUnavailable, asked.number) : !f.onUnavailable) &&
  (asked.noAnswerAfterSec !== undefined ? toNumber(f.onNoAnswer, asked.number) && f.onNoAnswer!.afterSec === asked.noAnswerAfterSec : !f.onNoAnswer)

const codeOf = (err: unknown): OperatorErrorCode => (err instanceof OperatorError ? err.code : 'unreachable')
const lineKey = (line: string) => `line:${line}`

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

/** The lines of a tenant's trunks, each once: the trunks that name it, and the fallbacks they ask there (by askKey). */
const linesOf = (trunks: readonly TrunkRecord[]) => {
  const lines = new Map<string, { trunks: string[]; asks: Map<string, OperatorFallback> }>()
  for (const t of trunks)
    for (const line of t.config.operator?.lines ?? []) {
      const l = lines.get(line) ?? { trunks: [], asks: new Map<string, OperatorFallback>() }
      l.trunks.push(t.id)
      const fb = t.config.operator?.fallback
      if (fb) l.asks.set(askKey(fb), plain(fb))
      lines.set(line, l)
    }
  return lines
}

/** The first `n` of each list in turn (review 10b, n°2: a line with many records leaves the others their share). */
const inTurn = <T>(lists: readonly T[][], n: number): T[] => {
  const out: T[] = []
  for (let i = 0; out.length < n && lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]!)
  return out
}

/** The way a trunk event tells where a forward sends the calls: the same on every line, or `mixed`. */
const targetOf = (natures: WebhookForwardTarget[]): WebhookForwardTarget => (natures.every(n => n === natures[0]) ? natures[0]! : 'mixed')

/**
 * What the platform keeps in step with the operator of its trunks (step 10b, ADR 0021), every OPERATOR_SYNC_MS by
 * the Gateway that leads, and on demand (through it, review 10b, n°8):
 * - the fallback forwards of each line a trunk asks one for, set there, read back (review n°7), and put back when
 *   someone changed them in the operator's manager (said in the log); the other lines are read only; each line once
 *   whatever trunks name it (review n°5);
 * - the records of calls of those lines over the last 48 hours, each read once and kept, line by line (review n°2);
 * - those records reconciled with the history once read OPERATOR_SETTLE_MS ago (matchCdrs), with the entries of their
 *   own number and time (review n°3); one inbound that matches no call entered in the history of whom its direct
 *   number rings, unless they erased their history since (review n°1) or the platform had a call of theirs then
 *   (review n°17); the others counted;
 * - an alert when the operator refuses the keys round after round, or when fewer than 99 % are reconciled (n°12).
 * What it knows lives in the store (operator_state), the same for every Gateway.
 */
export class OperatorSync {
  private readonly rounds = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private first: ReturnType<typeof setTimeout> | undefined
  private asked: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | undefined
  private stopped = false
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

  private get leads() {
    return !this.options.leading || this.options.leading()
  }

  start() {
    if (this.timer) return
    this.stopped = false
    this.first = setTimeout(() => void this.tick(), this.options.firstMs ?? 5_000)
    this.first.unref()
    this.timer = setInterval(() => void this.tick(), this.options.everyMs ?? OPERATOR_SYNC_MS)
    this.timer.unref()
    this.asked = setInterval(() => void this.answerAsked(), this.options.askedPollMs ?? ASKED_POLL_MS)
    this.asked.unref()
  }

  /** Stops the schedule, and waits for the rounds under way (review 10b, n°25: the store is closed after). */
  async stop() {
    this.stopped = true
    clearTimeout(this.first)
    clearInterval(this.timer)
    clearInterval(this.asked)
    this.timer = undefined
    await this.ticking?.catch(() => undefined)
    await Promise.all([...this.rounds.values()].map(r => r.catch(() => undefined)))
  }

  /** One round over the tenants (the schedule runs it; tests call it), and the purge of the old records. */
  tick(): Promise<void> {
    if (this.stopped || !this.leads) return Promise.resolve()
    this.ticking ??= (async () => {
      for (const tenantId of this.options.operators.keys()) {
        if (this.stopped) return
        await this.round(tenantId).catch((err: unknown) => this.options.logger?.warn({ err, tenantId }, 'operator: round not done'))
      }
      await this.options.store.purgeOperatorCdrs(this.iso(this.now() - OPERATOR_CDR_RETENTION_MS)).catch((err: unknown) => this.options.logger?.warn({ err }, 'operator: old records of calls not purged'))
    })().finally(() => (this.ticking = undefined))
    return this.ticking
  }

  /** The rounds other Gateways were asked (review 10b, n°8), run by the one that leads. */
  async answerAsked() {
    if (this.stopped || !this.leads) return
    for (const tenantId of this.options.operators.keys()) {
      const asked = (await this.options.store.getOperatorState(tenantId, 'sync').catch(() => undefined)) as { id?: string } | undefined
      if (!asked?.id) continue
      const cdrs = (await this.options.store.getOperatorState(tenantId, 'cdrs').catch(() => undefined)) as CdrsState | undefined
      if (cdrs?.answered !== asked.id) await this.round(tenantId, asked.id).catch((err: unknown) => this.options.logger?.warn({ err, tenantId }, 'operator: round asked not done'))
    }
  }

  /**
   * A round now, asked by an administrator: run here when this Gateway leads; asked of the one that leads otherwise
   * (operator_state `sync`), waited for `timeoutMs` at most (review 10b, n°8: one Gateway reads for all).
   */
  async roundNow(tenantId: string, timeoutMs: number) {
    if (this.leads) return within(this.round(tenantId), timeoutMs)
    const id = randomUUID()
    const before = ((await this.options.store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined)?.roundAt
    await this.options.store.putOperatorState(tenantId, 'sync', { id })
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, ANSWER_POLL_MS))
      const cdrs = (await this.options.store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined
      if (cdrs?.answered === id || (cdrs?.roundAt && cdrs.roundAt !== before)) return
    }
    throw new Error('operator: the Gateway that leads did not run the round in time')
  }

  /** A round for one tenant: one at a time (asked again meanwhile: the one under way). */
  round(tenantId: string, answering?: string): Promise<void> {
    let r = this.rounds.get(tenantId)
    if (!r) {
      r = this.run(tenantId, answering).finally(() => this.rounds.delete(tenantId))
      this.rounds.set(tenantId, r)
    }
    return r
  }

  private async run(tenantId: string, answering: string | undefined) {
    if (!this.serves(tenantId)) return
    const store = this.options.store
    const trunks = await store.listTrunks(tenantId)
    const lines = linesOf(trunks)
    // What was seen of lines no trunk names any more is forgotten.
    for (const { key } of await store.listOperatorState(tenantId, 'line:')) if (!lines.has(key.slice(5))) await store.deleteOperatorState(tenantId, key)
    const codes: OperatorLineError[] = []
    for (const [line, l] of lines) {
      const state = await this.line(tenantId, line, [...l.asks.values()], false)
      if (state.error) codes.push(state.error)
    }
    const failed = await this.importCdrs(tenantId, [...lines.keys()])
    await this.reconcile(tenantId)
    await this.alerts(tenantId, [...codes, ...failed], answering)
  }

  /** The fallback of one trunk's lines now (an administrator saved it): set where asked, even where it was refused before; read everywhere. */
  async applyTrunk(tenantId: string, trunkId: string) {
    if (!this.serves(tenantId)) return
    const lines = linesOf(await this.options.store.listTrunks(tenantId))
    for (const [line, l] of lines) if (l.trunks.includes(trunkId)) await this.line(tenantId, line, [...l.asks.values()], true)
    await this.forgetLines(tenantId, lines)
  }

  /**
   * Removes the forwards of these lines at the operator (review 10b, n°13: a trunk that no longer asks one, or is
   * deleted, on an administrator's word), those no trunk asks a fallback for still; reads them back.
   */
  async removeForwards(tenantId: string, names: readonly string[]) {
    const operator = this.options.operators.get(tenantId)
    if (!operator) return
    const lines = linesOf(await this.options.store.listTrunks(tenantId))
    for (const line of names) {
      if (lines.get(line)?.asks.size) continue
      const before = ((await this.options.store.getOperatorState(tenantId, lineKey(line))) as LineState | undefined) ?? {}
      let state: LineState
      try {
        await operator.setFallback(line, { onUnavailable: false })
        const forwards = await operator.getForwards(line)
        const at = this.iso()
        this.options.logger?.info({ tenantId, line }, 'operator: the forwards of a line removed at the operator')
        state = { forwards, readAt: at, appliedAt: at }
      } catch (err) {
        this.options.logger?.warn({ err, tenantId, line }, 'operator: the forwards of a line not removed')
        state = { ...(before.forwards ? { forwards: before.forwards } : {}), ...(before.readAt ? { readAt: before.readAt } : {}), error: codeOf(err) }
      }
      if (lines.has(line)) await this.options.store.putOperatorState(tenantId, lineKey(line), state)
    }
    await this.forgetLines(tenantId, lines)
  }

  private async forgetLines(tenantId: string, lines: ReadonlyMap<string, unknown>) {
    for (const { key } of await this.options.store.listOperatorState(tenantId, 'line:')) if (!lines.has(key.slice(5))) await this.options.store.deleteOperatorState(tenantId, key)
  }

  /**
   * One line: read; when a fallback is asked and what is there is not it, set, then read back (review 10b, n°7):
   * what the operator did not keep is said (`refused`) and not written again until a trunk is saved (`retry`). Two
   * fallbacks asked (two trunks, review n°5): read only, said (`conflict`).
   */
  private async line(tenantId: string, line: string, asks: OperatorFallback[], retry: boolean): Promise<LineState> {
    const operator = this.options.operators.get(tenantId)!
    const store = this.options.store
    const before = ((await store.getOperatorState(tenantId, lineKey(line))) as LineState | undefined) ?? {}
    const asked = asks.length === 1 ? asks[0] : undefined
    const wanted = asked && askKey(asked)
    const next: LineState = {
      ...(before.appliedAt ? { appliedAt: before.appliedAt } : {}),
      ...(before.restoredAt ? { restoredAt: before.restoredAt } : {}),
      ...(wanted ? { asked: wanted } : {}),
      ...(wanted && !retry && before.rejected === wanted ? { rejected: wanted } : {})
    }
    let forwards = before.forwards
    let readAt = before.readAt
    try {
      forwards = await operator.getForwards(line)
      readAt = this.iso()
      if (asks.length > 1) Object.assign(next, { inSync: false, error: 'conflict' })
      else if (!asked || matchesFallback(asked, forwards)) {
        if (asked) next.inSync = true
        delete next.rejected
      } else if (next.rejected) Object.assign(next, { inSync: false, error: 'refused' })
      else {
        // It was there as asked, and is no longer: someone changed it at the operator (its manager). Put back.
        const restored = before.inSync === true && before.asked === wanted
        try {
          await operator.setFallback(line, asked)
        } catch (err) {
          if (codeOf(err) === 'refused') next.rejected = wanted
          throw err
        }
        forwards = await operator.getForwards(line)
        readAt = this.iso()
        next.appliedAt = readAt
        if (!matchesFallback(asked, forwards)) {
          this.options.logger?.warn({ tenantId, line }, 'operator: the operator did not keep the fallback asked, not written again until the trunk is saved')
          Object.assign(next, { inSync: false, error: 'refused', rejected: wanted })
        } else {
          if (restored) this.options.logger?.warn({ tenantId, line }, 'operator: the fallback was changed at the operator, put back as asked')
          else this.options.logger?.info({ tenantId, line }, 'operator: fallback set at the operator')
          Object.assign(next, { inSync: true, ...(restored ? { restoredAt: readAt } : {}) })
        }
      }
    } catch (err) {
      this.options.logger?.warn({ err, tenantId, line }, 'operator: the forwards of a line not read or not set')
      Object.assign(next, { ...(asked ? { inSync: false } : {}), error: codeOf(err) })
    }
    const state: LineState = { ...(forwards ? { forwards } : {}), ...(readAt ? { readAt } : {}), ...next }
    await store.putOperatorState(tenantId, lineKey(line), state)
    return state
  }

  /** The records of calls of the lines, line by line (one failing leaves the others read), the reads in turn. Returns why lines failed. */
  private async importCdrs(tenantId: string, lines: readonly string[]): Promise<OperatorErrorCode[]> {
    const operator = this.options.operators.get(tenantId)!
    const store = this.options.store
    const before = ((await store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined) ?? {}
    if (!lines.length) {
      await store.putOperatorState(tenantId, 'cdrs', { ...before, lines: [] })
      return []
    }
    const from = this.iso(this.now() - OPERATOR_CDR_WINDOW_MS)
    const to = this.iso()
    const failed = new Map<string, OperatorErrorCode>()
    const fresh: { line: string; id: string; kept: string }[][] = []
    for (const line of lines) {
      try {
        // Kept by line and id: two lines may number their records alike.
        const ids = (await operator.listCdrIds(line, from, to)).map(id => ({ line, id, kept: `${line}:${id}` }))
        const known = new Set(await store.knownOperatorCdrs(tenantId, operator.id, ids.map(i => i.kept)))
        fresh.push(ids.filter(i => !known.has(i.kept)))
      } catch (err) {
        this.options.logger?.warn({ err, tenantId, line }, 'operator: records of calls of a line not listed')
        failed.set(line, codeOf(err))
      }
    }
    const cdrs = (
      await mapLimit(inTurn(fresh, this.options.readPerRound ?? READ_PER_ROUND), READ_PARALLEL, async i => {
        if (failed.has(i.line)) return undefined
        try {
          const cdr = await operator.getCdr(i.line, i.id)
          return cdr && { ...cdr, id: i.kept, line: i.line }
        } catch (err) {
          // That line is read again at the next round; the others go on.
          this.options.logger?.warn({ err, tenantId, line: i.line }, 'operator: a record of calls not read')
          failed.set(i.line, codeOf(err))
          return undefined
        }
      })
    ).filter(c => !!c)
    await store.addOperatorCdrs(tenantId, operator.id, cdrs)
    const someRead = failed.size < lines.length
    await store.putOperatorState(tenantId, 'cdrs', {
      ...before,
      ...(someRead ? { readAt: to, read: cdrs.length } : {}),
      lines: [...failed].map(([line, error]) => ({ line, error }))
    } satisfies CdrsState)
    return [...failed.values()]
  }

  /** The entries of a query, every page (review 10b, n°3); `complete` false past NEAR_PAGES pages. */
  private async near(tenantId: string, query: Omit<HistoryNearQuery, 'limit' | 'after'>) {
    const out: HistoryEntry[] = []
    let after: HistoryNearQuery['after']
    for (let page = 0; page < NEAR_PAGES; page++) {
      const got = await this.options.store.historyNear(tenantId, { ...query, limit: NEAR_PAGE, ...(after ? { after } : {}) })
      out.push(...got)
      if (got.length < NEAR_PAGE) return { entries: out, complete: true }
      const last = got.at(-1)!
      after = { startedAt: last.startedAt, callId: last.callId, userId: last.userId }
    }
    return { entries: out, complete: false }
  }

  private async reconcile(tenantId: string) {
    const operator = this.options.operators.get(tenantId)!
    const store = this.options.store
    const readBefore = this.iso(this.now() - (this.options.settleMs ?? OPERATOR_SETTLE_MS))
    let dids: Awaited<ReturnType<Store['listDids']>> | undefined
    const holders = new Map<string, UserMapping | null>()
    const erasures = new Map<string, string | undefined>()
    const holderOf = async (r: OperatorCdrRecord) => {
      const local = localOf(r)
      if (!local) return null
      dids ??= await store.listDids(tenantId)
      const extension = extensionOfDid(dids, local)
      if (!extension) return null
      if (!holders.has(extension)) holders.set(extension, await store.getMappingByExtension(tenantId, extension))
      return holders.get(extension) ?? null
    }
    const erasedAt = async (userId: string) => {
      if (!erasures.has(userId)) erasures.set(userId, await store.historyErasedAt(tenantId, userId))
      return erasures.get(userId)
    }
    for (let batch = 0; batch < RECONCILE_BATCHES; batch++) {
      const pending = await store.pendingOperatorCdrs(tenantId, operator.id, readBefore, RECONCILE_BATCH)
      if (!pending.length) return
      const outcomes: OperatorCdrOutcome[] = []
      const live: { r: OperatorCdrRecord; holder: UserMapping | null }[] = []
      for (const r of pending) {
        if (r.invalid) outcomes.push({ id: r.id, outcome: 'invalid' })
        else if (r.forwarded) outcomes.push({ id: r.id, outcome: 'forwarded' })
        else {
          const holder = await holderOf(r)
          const erased = holder ? await erasedAt(holder.userId) : undefined
          // A call of a person who erased their history since: in nobody's history, its numbers gone (review 10b, n°1).
          if (erased && erased >= r.startedAt) outcomes.push({ id: r.id, outcome: 'unmatched', erase: true })
          else live.push({ r, holder })
        }
      }
      // The entries each record may be of: those of its number (by way), and those of whom its number rings.
      const history = new Map<string, HistoryEntry>()
      const holderEntries = new Map<string, HistoryEntry[]>()
      const partial = new Set<string>()
      const span = (rs: readonly OperatorCdrRecord[]) => {
        const at = rs.map(r => Date.parse(r.startedAt))
        return { from: this.iso(Math.min(...at) - HISTORY_SPAN_MS), to: this.iso(Math.max(...at) + RECONCILE_LATE_MS) }
      }
      const byRemote = new Map<string, OperatorCdrRecord[]>()
      for (const { r } of live) {
        const remote = remoteOf(r)
        if (!remote) continue
        const k = `${r.direction}|${e164Of(remote)}`
        byRemote.set(k, [...(byRemote.get(k) ?? []), r])
      }
      for (const [k, rs] of byRemote) {
        const [direction, remote] = k.split('|') as [HistoryEntry['direction'], string]
        const got = await this.near(tenantId, { direction, remotes: [remote], ...span(rs) })
        for (const e of got.entries) history.set(`${e.userId}\u0000${e.callId}`, e)
        if (!got.complete) for (const r of rs) partial.add(r.id)
      }
      const byHolder = new Map<string, OperatorCdrRecord[]>()
      for (const { r, holder } of live) if (holder && r.direction === 'inbound') byHolder.set(holder.userId, [...(byHolder.get(holder.userId) ?? []), r])
      for (const [userId, rs] of byHolder) {
        const got = await this.near(tenantId, { direction: 'inbound', userId, reconciled: true, ...span(rs) })
        holderEntries.set(userId, got.entries)
        for (const e of got.entries) if (!e.operatorCdr) history.set(`${e.userId}\u0000${e.callId}`, e)
        if (!got.complete) for (const r of rs) partial.add(r.id)
      }
      const records = live.map(l => l.r)
      const entries = [...history.values()]
      const strict = matchCdrs(records, entries)
      // The records left, durations apart or a caller the platform did not see (review 10b, n°17).
      const loose = matchCdrs(
        records.filter(r => !strict.has(r.id)),
        entries,
        { loose: true, taken: new Set(strict.values()) }
      )
      for (const { r, holder } of live) {
        const callId = strict.get(r.id) ?? loose.get(r.id)
        if (callId) {
          outcomes.push({ id: r.id, outcome: 'matched', callId })
          continue
        }
        const at = Date.parse(r.startedAt)
        // A call of the holder then, whatever its number (anonymous here, a call forwarded there): no second entry.
        const busy = holder && (holderEntries.get(holder.userId) ?? []).some(e => at >= Date.parse(e.startedAt) - RECONCILE_EARLY_MS && at <= Date.parse(e.endedAt ?? e.startedAt) + RECONCILE_LATE_MS)
        if (r.direction !== 'inbound' || !r.calling || !r.called || !holder || busy || partial.has(r.id)) {
          outcomes.push({ id: r.id, outcome: 'unmatched' })
          continue
        }
        // A call the platform never had (received while it could not be reached, or an event lost): in the
        // history of whom its direct number rings, when that is one person (an extension, not a group).
        const answered = r.durationSec > 0
        const entry: HistoryEntry = {
          tenantId,
          userId: holder.userId,
          callId: `${operator.id}:${r.id}`,
          direction: 'inbound',
          remoteNumber: r.calling,
          startedAt: r.startedAt,
          endedAt: this.iso(at + r.durationSec * 1000),
          durationSec: r.durationSec,
          state: answered ? 'ended' : 'missed',
          answered
        }
        outcomes.push({ id: r.id, outcome: 'orphan', entry })
      }
      await store.settleOperatorCdrs(tenantId, operator.id, outcomes)
      if (pending.length < RECONCILE_BATCH) return
    }
  }

  /**
   * The end of a round (review 10b, n°12): an alert when the operator refused the keys or their rights
   * OPERATOR_ALERT_ROUNDS rounds in a row, or when fewer than OPERATOR_RECONCILED_PERCENT % of the records settled
   * these 7 days were reconciled (FR-D4). Repeated, an alert counts in the open one.
   */
  private async alerts(tenantId: string, codes: readonly OperatorLineError[], answering: string | undefined) {
    const store = this.options.store
    const operator = this.options.operators.get(tenantId)!
    const cdrs = ((await store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined) ?? {}
    const refused = codes.includes('unauthorized') ? 'unauthorized' : codes.includes('forbidden') ? 'forbidden' : undefined
    const refusedRounds = refused ? (cdrs.refusedRounds ?? 0) + 1 : 0
    const at = this.iso()
    if (refused && refusedRounds >= OPERATOR_ALERT_ROUNDS) {
      this.options.logger?.warn({ tenantId, rounds: refusedRounds }, `operator: the operator refuses the keys (${refused}), round after round`)
      await store.addAlert({ tenantId, at, alert: { kind: 'operator', param: refused, scope: 'tenant', value: refusedRounds } })
    }
    const stats = await store.operatorCdrStats(tenantId, operator.id, this.iso(this.now() - OPERATOR_STATS_MS))
    const settled = stats.total - stats.forwarded - stats.pending - stats.invalid
    if (settled >= OPERATOR_RECONCILED_FLOOR && stats.matched * 100 < settled * OPERATOR_RECONCILED_PERCENT) {
      const percent = Math.floor((stats.matched * 1000) / settled) / 10
      await store.addAlert({ tenantId, at, alert: { kind: 'operator', param: 'reconciliation', scope: 'tenant', value: percent, threshold: OPERATOR_RECONCILED_PERCENT } })
    }
    await store.putOperatorState(tenantId, 'cdrs', { ...cdrs, refusedRounds, roundAt: at, ...(answering ? { answered: answering } : {}) } satisfies CdrsState)
  }

  /**
   * The fallback forwards set at the operator for a trunk's lines, as a trunk event tells it (no number): read again
   * first when read over a minute ago (within FRESH_READ_MS: the platform is in trouble, the operator's API may be
   * too). Where each forward sends the calls, the same on every line or `mixed` (review 10b, n°4), and the longest
   * delay on no answer. Undefined when the trunk has no line at an operator, or a line was never read.
   */
  async fallbackOf(tenantId: string, trunkId: string): Promise<WebhookTrunkFallback | undefined> {
    if (!this.serves(tenantId)) return undefined
    const trunks = await this.options.store.listTrunks(tenantId)
    const trunk = trunks.find(t => t.id === trunkId)
    const names = trunk?.config.operator?.lines ?? []
    if (!trunk || !names.length) return undefined
    const lines = linesOf(trunks)
    const states = async () => Promise.all(names.map(async l => (await this.options.store.getOperatorState(tenantId, lineKey(l))) as LineState | undefined))
    let read = await states()
    if (read.some(s => !s?.readAt || this.now() - Date.parse(s.readAt) > FRESH_FALLBACK_MS)) {
      await within(Promise.all(names.map(l => this.line(tenantId, l, [...(lines.get(l)?.asks.values() ?? [])], false))), FRESH_READ_MS).catch(() => undefined)
      read = await states()
    }
    if (read.some(s => !s?.forwards)) return undefined
    const forwards = read.map(s => s!.forwards!)
    const onNoAnswer = targetOf(forwards.map(f => f.onNoAnswer?.nature ?? 'none'))
    const delays = forwards.flatMap(f => (f.onNoAnswer ? [f.onNoAnswer.afterSec] : []))
    return {
      on_unavailable: targetOf(forwards.map(f => f.onUnavailable?.nature ?? 'none')),
      on_no_answer: onNoAnswer,
      ...(onNoAnswer !== 'none' && delays.length ? { no_answer_after_sec: Math.max(...delays) } : {})
    }
  }

  /** What the administration shows: each trunk's lines at the operator, and the records of calls of the last 7 days. */
  async status(tenantId: string): Promise<OperatorStatus | undefined> {
    const operator = this.options.operators.get(tenantId)
    if (!operator) return undefined
    const store = this.options.store
    const trunks = await store.listTrunks(tenantId)
    const lines = linesOf(trunks)
    const states = new Map((await store.listOperatorState(tenantId, 'line:')).map(s => [s.key.slice(5), s.value as LineState]))
    const since = this.iso(this.now() - OPERATOR_STATS_MS)
    const lineStatus = (line: string): OperatorLineStatus => {
      const asks = [...(lines.get(line)?.asks.keys() ?? [])]
      const wanted = asks.length === 1 ? asks[0] : undefined
      const s = states.get(line) ?? {}
      const current = s.asked === wanted
      const error = asks.length > 1 ? 'conflict' : current || !s.error || !wanted ? s.error : undefined
      return {
        line,
        ...(s.forwards ? { forwards: s.forwards } : {}),
        managed: asks.length > 0,
        ...(wanted && current && s.inSync !== undefined ? { inSync: s.inSync } : {}),
        ...(s.readAt ? { readAt: s.readAt } : {}),
        ...(s.appliedAt ? { appliedAt: s.appliedAt } : {}),
        ...(s.restoredAt ? { restoredAt: s.restoredAt } : {}),
        ...(error ? { error } : {}),
        ...(wanted && s.rejected === wanted ? { rejected: true as const } : {})
      }
    }
    const cdrs = ((await store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined) ?? {}
    return {
      operator: operator.id,
      trunks: trunks.filter(t => t.config.operator?.lines.length).map(t => ({ id: t.id, lines: t.config.operator!.lines.map(lineStatus) })),
      cdrs: {
        ...(cdrs.readAt ? { readAt: cdrs.readAt, read: cdrs.read ?? 0 } : {}),
        ...(cdrs.lines?.length ? { lines: cdrs.lines } : {}),
        stats: await store.operatorCdrStats(tenantId, operator.id, since),
        since
      }
    }
  }

  /** What the operator has set on lines now, read only (review 10b, n°13: shown before a first fallback replaces it). */
  async readLines(tenantId: string, names: readonly string[]) {
    const operator = this.options.operators.get(tenantId)
    if (!operator) return []
    return mapLimit(names, READ_PARALLEL, async line => {
      try {
        return { line, forwards: await operator.getForwards(line) }
      } catch (err) {
        return { line, error: codeOf(err) }
      }
    })
  }
}

/**
 * The numbers of the operator's records of a person's calls erased with their history (review 10b, n°1): those to or
 * from their direct numbers that started before now, the pending ones settled (never entered in their history again).
 */
export const eraseOperatorNumbers = async (store: Store, tenantId: string, userId: string, at: string) => {
  const mapping = await store.getMappingByUser(tenantId, userId)
  if (!mapping) return 0
  const numbers = directNumbersOf(await store.listDids(tenantId), mapping.extension)
  return numbers.length ? store.eraseOperatorCdrNumbers(tenantId, numbers, at) : 0
}
