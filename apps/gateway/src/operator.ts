import { randomUUID } from 'node:crypto'
import type { OperatorFallback, OperatorForward, OperatorLineForwards, WebhookForwardTarget, WebhookTrunkFallback } from '@twake/telephony-types'
import { OperatorError, type OperatorErrorCode, type OperatorProvider } from '@twake/telephony-provider-sdk'
import { e164Of } from './e164.js'
import { RECONCILE_EARLY_MS, RECONCILE_LATE_MS, directNumbersOf, extensionOfDid, localOf, matchCdrs, remoteOf } from './reconcile.js'
import type { ErasedCallsKept, HistoryEntry, HistoryNearQuery, OperatorCdrOutcome, OperatorCdrRecord, OperatorCdrStats, Store, TrunkRecord, UserMapping } from './store/types.js'

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
/**
 * FR-D4: 99 % of the records of calls reconciled, of those the platform should have had a call for (matched or
 * unmatched: the forwards, the unreadable, the erased and those received while it could not be reached apart, second
 * review 10b, n°5); under it, an alert when it falls there, once that many count.
 */
export const OPERATOR_RECONCILED_PERCENT = 99
export const OPERATOR_RECONCILED_FLOOR = 20
/**
 * What erasures and changes of hands are kept for (erasedCalls, numberChangedAt, historyErasedAt): a record is asked
 * over 48 hours. Purged by the Gateway every hour with the alerts, whether the organisation has an operator or not
 * (third review 10b, n°3: Store.purgeErasures).
 */
export const OPERATOR_KEPT_MS = 4 * 86_400_000
/**
 * The records of calls started longer ago than that (fourth review 10b, n°1) are past what the erasures kept tell
 * apart: purged meanwhile (OPERATOR_KEPT_MS, an hour of margin for the clocks of the Gateways and the purge), an
 * erasure of their call would be gone. One no entry of the history takes is entered in nobody's history, its numbers
 * gone (`erased`).
 */
export const ERASURES_TOLD_MS = OPERATOR_KEPT_MS - 3_600_000
/** A removal the operator has no line for that many rounds in a row is let go, and said (third review 10b, n°4). */
export const REMOVAL_GONE_ROUNDS = 3
/** A removal owed longer than that raises an alert, once (third review 10b, n°4). */
export const REMOVAL_LATE_MS = 86_400_000
/** What became of a removal is shown that long (third review 10b, n°2 and n°4). */
const REMOVAL_SHOWN_MS = 7 * 86_400_000
/** A forward of the operator is of an inbound call it started that long after it at most (the delay of no answer, 600 s, and a minute). */
const FORWARD_AFTER_MS = 660_000
/** Records read per tenant and round at most (one request each), 4 at a time, the lines in turn (review 10b, n°2). */
const READ_PER_ROUND = 500
const READ_PARALLEL = 4
/** Records reconciled per batch, batches per round. */
const RECONCILE_BATCH = 500
const RECONCILE_BATCHES = 4
/** The calls of the history a record may be of: started at most that long before it (no call lasts longer). */
const HISTORY_SPAN_MS = 4 * 3_600_000
/** The erased calls a record read later may be of (third review 10b, n°3): those of its window, the longest call before. */
export const ERASED_CALLS_MS = OPERATOR_CDR_WINDOW_MS + HISTORY_SPAN_MS
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
  /** The entries of one number or one person read by pages of `nearPage`, `nearPages` pages at most (1 000 and 20 by default). */
  nearPage?: number
  nearPages?: number
  /**
   * The keyed print of a number on the other side of an erased call (third review 10b, n°5: HMAC with a key of the
   * Gateway, never the number), the same for one number of one tenant. Without it, an erased call is told by its way
   * and time alone.
   */
  remoteKey?: (tenantId: string, number: string) => string
  /**
   * Why the forward of before to `number` of a line of trunk `trunkId` may not be put back (fourth review 10b, n°3):
   * `loop`, the platform's own (a direct number, a line or the number of a trunk: the call would come back to the trunk
   * that cannot be reached, as OPERATOR_FALLBACK_LOOP refuses it); `outbound`, a number its trunk may not call (step
   * 6). Undefined when it may. Without it, put back as it was.
   */
  restorable?: (tenantId: string, number: string, trunkId?: string) => Promise<OperatorRestoreRefusal | undefined>
  logger?: OperatorLogger
  now?: () => number
}

/** Why the forwards of before are not put back (fourth review 10b, n°3): they would loop, or go where the trunk may not call. */
export type OperatorRestoreRefusal = 'loop' | 'outbound'

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
  /**
   * The fallback the platform set there and read back (third review 10b, n°2): kept while the line is read with it.
   * A removal takes away that, never what someone set in the manager since.
   */
  set?: OperatorFallback
  /** What was there before the platform first wrote (third review 10b, n°8): put back when its fallback is removed. */
  original?: OperatorLineForwards
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
  /** What was there before the platform first wrote (third review 10b, n°8): put back when its fallback is removed. */
  original?: OperatorLineForwards
  /** Why that will not be put back (fourth review 10b, n°3). */
  originalRefused?: OperatorRestoreRefusal
}

/**
 * A removal of the forwards of a line at the operator still owed (operator_state `remove:<line>`, second review 10b,
 * n°1): asked when, by which trunk, last tried when, and why it failed. Kept, whatever becomes of the trunk, until the
 * line is read as it should be; replayed at each round meanwhile. Third review: each write of it its own (`id`), let go
 * only as it was read (n°1); what the platform set there (`expect`), the line read with anything else left as it is
 * (n°2); what was there before (`original`), put back (n°8); the rounds the operator had no such line (`gone`), and
 * whether it was said late (`late`, n°4).
 */
interface RemovalState {
  id: string
  since: string
  trunkId?: string
  triedAt?: string
  error?: OperatorErrorCode
  expect?: OperatorLineForwards
  original?: OperatorLineForwards
  gone?: number
  late?: true
  /** Why the forwards of before were not put back (fourth review 10b, n°3 and n°4): refused by the rules, or not kept by the operator. */
  unrestored?: OperatorRestoreRefusal | 'refused'
}

/** A removal at the operator not done yet, as the administration is shown it, and what it puts back (`original`). */
export interface OperatorRemoval {
  line: string
  since: string
  trunkId?: string
  triedAt?: string
  error?: OperatorErrorCode
  original?: OperatorLineForwards
  /** Why `original` will not be put back (fourth review 10b, n°3). */
  originalRefused?: OperatorRestoreRefusal
}

/**
 * What became of a removal (operator_state `removed:<line>`, third review 10b, n°2 and n°4), shown REMOVAL_SHOWN_MS:
 * `done` (the forwards of before put back, `restored`), `changed` (changed in the manager since it was asked: left as
 * it is), `gone` (the operator has no such line), `abandoned` (an administrator let it go).
 */
export interface OperatorClosedRemoval {
  line: string
  at: string
  outcome: 'done' | 'changed' | 'gone' | 'abandoned'
  trunkId?: string
  restored?: true
  /** Done without the forwards of before (fourth review 10b, n°3 and n°4): they would loop or go where the trunk may not call, or the operator did not keep them. */
  unrestored?: OperatorRestoreRefusal | 'refused'
}

/** A round that could not be run (second review 10b, n°6): `timeout`, not ended in time; the operator not read at all. */
export class OperatorRoundError extends Error {
  constructor(
    message: string,
    readonly timeout = false
  ) {
    super(message)
  }
}

/** The last read of the records of calls (operator_state `cdrs`), written by the Gateway that leads only. */
interface CdrsState {
  readAt?: string
  read?: number
  /** The lines whose records could not be read, and why (review 10b, n°2). */
  lines?: { line: string; error: OperatorErrorCode }[]
  /** Rounds in a row the operator refused the keys or their rights (review 10b, n°12). */
  refusedRounds?: number
  /** When the last round ended, and the round asked it answered (review 10b, n°8), and why it failed (second review, n°11). */
  roundAt?: string
  answered?: string
  answerError?: string
  /** The rate of reconciliation under FR-D4's at the last round (second review, n°5: an alert when it falls there). */
  low?: boolean
}

export interface OperatorStatus {
  operator: string
  trunks: { id: string; lines: OperatorLineStatus[] }[]
  /** The removals at the operator not done yet (second review 10b, n°1), whatever became of their trunk. */
  removals?: OperatorRemoval[]
  /** What became of the removals of the last days (third review 10b, n°2 and n°4), the latest first. */
  closedRemovals?: OperatorClosedRemoval[]
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
const removeKey = (line: string) => `remove:${line}`
const closedKey = (line: string) => `removed:${line}`
const hasForward = (f: OperatorLineForwards) => !!(f.onUnavailable || f.onNoAnswer)

const sameForward = (a: (OperatorForward & { afterSec?: number }) | undefined, b: (OperatorForward & { afterSec?: number }) | undefined) =>
  !a || !b ? !a && !b : a.nature === b.nature && a.afterSec === b.afterSec && (a.nature !== 'number' || (a.number ? e164Of(a.number) : '') === (b.number ? e164Of(b.number) : ''))
/** Whether two reads of a line's forwards are the same, forward by forward: nature, number, delay (third review 10b, n°2). */
export const sameForwards = (a: OperatorLineForwards, b: OperatorLineForwards) => sameForward(a.onUnavailable, b.onUnavailable) && sameForward(a.onNoAnswer, b.onNoAnswer)
/** Forwards the platform can write back (OperatorProvider.setForwards): to a number, the voicemail or a fax. */
const writable = (f: OperatorLineForwards) => [f.onUnavailable, f.onNoAnswer].every(fw => !fw || (fw.nature === 'number' ? !!fw.number : fw.nature !== 'other'))
/** The forwards a fallback sets, as they read back. */
const forwardsOfFallback = (f: OperatorFallback): OperatorLineForwards => ({
  ...(f.onUnavailable && f.number ? { onUnavailable: { nature: 'number' as const, number: f.number } } : {}),
  ...(f.noAnswerAfterSec !== undefined && f.number ? { onNoAnswer: { nature: 'number' as const, number: f.number, afterSec: f.noAnswerAfterSec } } : {})
})
const shownRemoval = (line: string, r: RemovalState): OperatorRemoval => ({
  line,
  since: r.since,
  ...(r.trunkId ? { trunkId: r.trunkId } : {}),
  ...(r.triedAt ? { triedAt: r.triedAt } : {}),
  ...(r.error ? { error: r.error } : {}),
  ...(r.original ? { original: r.original } : {})
})

const within = <T>(p: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperatorRoundError('operator: no answer in time', true)), ms)
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
  /** What writes to the operator, one at a time per tenant on this Gateway (second review 10b, n°1). */
  private readonly writing = new Map<string, Promise<unknown>>()
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
    await Promise.all([...this.rounds.values(), ...this.writing.values()].map(r => r.catch(() => undefined)))
  }

  /**
   * `run` once what writes to the tenant's operator before it on this Gateway is done (second review 10b, n°1: a
   * round, a trunk saved, a removal). Between Gateways, each write reads the trunks again just before and after it.
   */
  private exclusive<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.writing.get(tenantId) ?? Promise.resolve()).catch(() => undefined).then(run)
    const tail = next.catch(() => undefined)
    this.writing.set(tenantId, tail)
    void tail.then(() => {
      if (this.writing.get(tenantId) === tail) this.writing.delete(tenantId)
    })
    return next
  }

  /** What the tenant's trunks ask of a line now: one fallback (its askKey), several (`conflict`), or none. */
  private async askedNow(tenantId: string, line: string) {
    const l = linesOf(await this.options.store.listTrunks(tenantId)).get(line)
    return !l?.asks.size ? undefined : l.asks.size > 1 ? 'conflict' : askKey([...l.asks.values()][0]!)
  }

  /** One round over the tenants (the schedule runs it; tests call it), and the purge of the old records. */
  tick(): Promise<void> {
    if (this.stopped || !this.leads) return Promise.resolve()
    this.ticking ??= (async () => {
      for (const tenantId of this.options.operators.keys()) {
        if (this.stopped) return
        await this.round(tenantId).catch((err: unknown) => this.options.logger?.warn({ err, tenantId }, 'operator: round not done'))
      }
      // The erasures and changes of hands are purged with the alerts, operator or not (third review 10b, n°3).
      await this.options.store
        .purgeOperatorCdrs(this.iso(this.now() - OPERATOR_CDR_RETENTION_MS))
        .catch((err: unknown) => this.options.logger?.warn({ err }, 'operator: old records of calls not purged'))
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
      if (cdrs?.answered === asked.id) continue
      // Answered by the round itself, done or not (run): neither asked again every 2 s, nor waited for.
      await this.round(tenantId, asked.id).catch((err: unknown) => this.options.logger?.warn({ err, tenantId }, 'operator: round asked not done'))
    }
  }

  /**
   * A round now, asked by an administrator: run here when this Gateway leads; asked of the one that leads otherwise
   * (operator_state `sync`), waited for `timeoutMs` at most (review 10b, n°8: one Gateway reads for all).
   */
  async roundNow(tenantId: string, timeoutMs: number) {
    if (this.leads) return within(this.round(tenantId), timeoutMs)
    const id = randomUUID()
    await this.options.store.putOperatorState(tenantId, 'sync', { id })
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, ANSWER_POLL_MS))
      const cdrs = (await this.options.store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined
      // Answered once the round asked ended, with why it failed if it did (third review 10b, n°9): never before.
      if (cdrs?.answered === id && cdrs.answerError) throw new OperatorRoundError(cdrs.answerError)
      if (cdrs?.answered === id) return
    }
    throw new OperatorRoundError('operator: the Gateway that leads did not run the round in time', true)
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
    let failure: unknown
    try {
      await this.runRound(tenantId)
    } catch (err) {
      failure = err
      throw err
    } finally {
      // A round asked is answered once, as it ended (third review 10b, n°9: done, or why not), whatever failed.
      if (answering) await this.answer(tenantId, answering, failure)
    }
  }

  private async answer(tenantId: string, answering: string, failure: unknown) {
    const store = this.options.store
    try {
      const { answerError: _was, ...cdrs } = ((await store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined) ?? {}
      await store.putOperatorState(tenantId, 'cdrs', {
        ...cdrs,
        answered: answering,
        ...(failure !== undefined ? { answerError: failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : 'round failed' } : {})
      } satisfies CdrsState)
    } catch (err) {
      this.options.logger?.warn({ err, tenantId }, 'operator: a round asked not answered')
    }
  }

  private async runRound(tenantId: string) {
    const store = this.options.store
    const codes: OperatorLineError[] = []
    let read = 0
    const names = await this.exclusive(tenantId, async () => {
      const lines = linesOf(await store.listTrunks(tenantId))
      // What was seen of lines no trunk names any more is forgotten, and what became of removals long ago.
      await this.forgetLines(tenantId, lines)
      const shownSince = this.iso(this.now() - REMOVAL_SHOWN_MS)
      for (const { key, value } of await store.listOperatorState(tenantId, 'removed:')) if ((value as OperatorClosedRemoval).at < shownSince) await store.deleteOperatorState(tenantId, key)
      // The removals still owed first (second review 10b, n°1), until the operator has them.
      for (const { key } of await store.listOperatorState(tenantId, 'remove:')) {
        const left = await this.removeLine(tenantId, key.slice(7))
        if (left?.error) codes.push(left.error)
      }
      for (const [line, l] of lines) {
        const state = await this.line(tenantId, line, [...l.asks.values()], false)
        if (state.error) codes.push(state.error)
        else read++
      }
      return [...lines.keys()]
    })
    const failed = await this.importCdrs(tenantId, names)
    await this.reconcile(tenantId)
    await this.alerts(tenantId, [...codes, ...failed])
    // Nothing could be read at the operator (second review 10b, n°6): said to whom asked the round.
    if (names.length && !read && failed.length === names.length) throw new OperatorRoundError(`operator: not read (${failed[0]})`)
  }

  /**
   * The fallback of one trunk's lines now (an administrator saved it): set where asked, even where it was refused
   * before; read everywhere. The lines it no longer names that kept its fallback (`dropped`, second review 10b, n°8)
   * lose it there, as with the trunk deleted. What is still owed: OperatorRemoval.
   */
  async applyTrunk(tenantId: string, trunkId: string, dropped: readonly string[] = []): Promise<OperatorRemoval[]> {
    if (!this.serves(tenantId)) return []
    const left = dropped.length ? await this.removeForwards(tenantId, dropped, trunkId) : []
    await this.exclusive(tenantId, async () => {
      const lines = linesOf(await this.options.store.listTrunks(tenantId))
      for (const [line, l] of lines) if (l.trunks.includes(trunkId)) await this.line(tenantId, line, [...l.asks.values()], true)
      await this.forgetLines(tenantId, lines)
    })
    return left
  }

  /**
   * Removes the forwards of these lines at the operator (review 10b, n°13: on an administrator's word, or the trunk
   * deleted), those no trunk asks a fallback for still, and reads them back: what the platform set there goes, and what
   * was there before it is put back (third review n°8); what someone set in the manager since is left as it is (n°2).
   * Kept as owed first (second review n°1: operator_state `remove:<line>`), whatever comes next, and replayed at each
   * round until done. Written before the turn of the tenant (a route that times out behind a round still lists it):
   * nothing lets it go but a read of the trunks made after it, and only as it was written (third review n°1). Returns
   * the removals not done yet.
   */
  async removeForwards(tenantId: string, names: readonly string[], trunkId?: string): Promise<OperatorRemoval[]> {
    if (!this.serves(tenantId)) return []
    const store = this.options.store
    const lines = linesOf(await store.listTrunks(tenantId))
    const owed = [...new Set(names)].filter(line => !lines.get(line)?.asks.size)
    for (const line of owed) await this.owe(tenantId, line, trunkId)
    return this.exclusive(tenantId, async () => {
      const left: OperatorRemoval[] = []
      for (const line of owed) {
        const r = await this.removeLine(tenantId, line)
        if (r) left.push(r)
      }
      await this.forgetLines(tenantId, linesOf(await store.listTrunks(tenantId)))
      return left
    })
  }

  /** The removals at the operator not done yet (second review 10b, n°1). */
  async removals(tenantId: string): Promise<OperatorRemoval[]> {
    const out: OperatorRemoval[] = []
    for (const { key, value } of await this.options.store.listOperatorState(tenantId, 'remove:')) {
      const r = value as RemovalState
      const refused = r.original && (await this.restoreRefusal(tenantId, r.original, r.trunkId))
      out.push({ ...shownRemoval(key.slice(7), r), ...(refused ? { originalRefused: refused } : {}) })
    }
    return out
  }

  /** What became of the removals of the last days (third review 10b, n°2 and n°4), the latest first. */
  async closedRemovals(tenantId: string): Promise<OperatorClosedRemoval[]> {
    const since = this.iso(this.now() - REMOVAL_SHOWN_MS)
    return (await this.options.store.listOperatorState(tenantId, 'removed:'))
      .map(({ key, value }) => ({ ...(value as Omit<OperatorClosedRemoval, 'line'>), line: key.slice(8) }))
      .filter(r => r.at >= since)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.line < b.line ? -1 : 1))
  }

  /**
   * A removal let go by an administrator (third review 10b, n°4: a line the operator no longer has, keys without the
   * right to write): nothing more is written there, what is there stays. False when none was owed.
   */
  async abandonRemoval(tenantId: string, line: string): Promise<boolean> {
    if (!this.serves(tenantId)) return false
    const store = this.options.store
    const owed = (await store.getOperatorState(tenantId, removeKey(line))) as RemovalState | undefined
    if (!owed || !(await store.deleteOperatorState(tenantId, removeKey(line)))) return false
    this.options.logger?.info({ tenantId, line }, 'operator: a removal let go by an administrator, the forwards of the line left as they are')
    await this.closeRemoval(tenantId, line, owed, 'abandoned')
    return true
  }

  /**
   * What an erasure of the tenant keeps of the calls erased (third review 10b, n°3 and n°5; Store.deleteHistory): with
   * an operator only, those a record read later may be of, each with the keyed print of its number on the other side.
   */
  keptOfErasure(tenantId: string): ErasedCallsKept | undefined {
    if (!this.serves(tenantId)) return undefined
    const keyOf = this.options.remoteKey
    return { since: this.iso(this.now() - ERASED_CALLS_MS), ...(keyOf ? { keyOf: (n: string) => keyOf(tenantId, n) } : {}) }
  }

  /**
   * The removal owed on a line, written (a new `id` at each write: third review 10b, n°1), with what the platform set
   * there to take away (n°2: its fallback, or the forwards last read there) and what was there before it (n°8), those
   * of a removal owed already kept.
   */
  private async owe(tenantId: string, line: string, trunkId?: string) {
    const store = this.options.store
    const before = (await store.getOperatorState(tenantId, removeKey(line))) as RemovalState | undefined
    const state = (await store.getOperatorState(tenantId, lineKey(line))) as LineState | undefined
    const expect = before ? before.expect : state?.set ? forwardsOfFallback(state.set) : state?.readAt ? (state.forwards ?? {}) : undefined
    const original = before ? before.original : state?.original
    const by = trunkId ?? before?.trunkId
    await store.putOperatorState(tenantId, removeKey(line), {
      id: randomUUID(),
      since: before?.since ?? this.iso(),
      ...(by ? { trunkId: by } : {}),
      ...(expect ? { expect } : {}),
      ...(original ? { original } : {}),
      ...(before?.late ? { late: true as const } : {}),
      ...(before?.unrestored ? { unrestored: before.unrestored } : {})
    } satisfies RemovalState)
  }

  private async closeRemoval(tenantId: string, line: string, owed: RemovalState, outcome: OperatorClosedRemoval['outcome'], restored = false, unrestored?: OperatorClosedRemoval['unrestored']) {
    await this.options.store.putOperatorState(tenantId, closedKey(line), {
      at: this.iso(),
      outcome,
      ...(owed.trunkId ? { trunkId: owed.trunkId } : {}),
      ...(restored ? { restored: true as const } : {}),
      ...(unrestored && outcome === 'done' ? { unrestored } : {})
    } satisfies Omit<OperatorClosedRemoval, 'line'>)
  }

  /** Why these forwards of before may not be put back on a line of trunk `trunkId` (fourth review 10b, n°3): each number they go to checked. */
  private async restoreRefusal(tenantId: string, f: OperatorLineForwards, trunkId?: string): Promise<OperatorRestoreRefusal | undefined> {
    const check = this.options.restorable
    if (!check || !writable(f)) return undefined
    for (const fw of [f.onUnavailable, f.onNoAnswer]) {
      const refused = fw?.nature === 'number' && fw.number ? await check(tenantId, fw.number, trunkId) : undefined
      if (refused) return refused
    }
    return undefined
  }

  private async removalAlert(tenantId: string, line: string, param: 'removal-changed' | 'removal-gone' | 'removal-late') {
    await this.options.store.addAlert({ tenantId, at: this.iso(), alert: { kind: 'operator', param, scope: 'tenant', number: e164Of(line) } })
  }

  /**
   * The removal owed on a line, tried (within `exclusive`), with the trunks read now. A trunk asks a fallback there
   * again: let go, that one kept. Otherwise its forwards read: done when they are what should be left (the forwards of
   * before, when the platform can write them back, none otherwise); left as they are, and said, when they are no longer
   * what the platform set (third review 10b, n°2: changed in the manager since); written otherwise, read back, and the
   * trunks read again (n°10: a fallback asked again meanwhile is set again, never said changed at the operator). Let
   * go once the operator has had no such line REMOVAL_GONE_ROUNDS times in a row, and said (n°4); said when owed past
   * REMOVAL_LATE_MS. Each removal let go only as it was read (n°1). Undefined once done or let go; kept with why otherwise.
   */
  private async removeLine(tenantId: string, line: string): Promise<OperatorRemoval | undefined> {
    const operator = this.options.operators.get(tenantId)!
    const store = this.options.store
    const owed = (await store.getOperatorState(tenantId, removeKey(line))) as RemovalState | undefined
    if (!owed) return undefined
    const lines = linesOf(await store.listTrunks(tenantId))
    if (lines.get(line)?.asks.size) {
      await store.deleteOperatorState(tenantId, removeKey(line), owed)
      return undefined
    }
    // The forwards of before, when the platform can write them and its rules let it (fourth review 10b, n°3).
    const refusal = owed.original && writable(owed.original) && hasForward(owed.original) ? await this.restoreRefusal(tenantId, owed.original, owed.trunkId) : undefined
    const target = owed.original && writable(owed.original) && !refusal ? owed.original : {}
    const restoring = hasForward(target)
    const unrestored = refusal ?? owed.unrestored
    const at = this.iso()
    let forwards: OperatorLineForwards | undefined
    let error: OperatorErrorCode | undefined
    let outcome: 'done' | 'changed' | undefined
    let wrote = false
    let askedAgain = false
    try {
      forwards = await operator.getForwards(line)
      if (sameForwards(forwards, target)) outcome = 'done'
      else if (owed.expect && !sameForwards(forwards, owed.expect)) outcome = 'changed'
      else {
        if (restoring) await operator.setForwards(line, target)
        else await operator.setFallback(line, { onUnavailable: false })
        wrote = true
        forwards = await operator.getForwards(line)
        if (sameForwards(forwards, target)) outcome = 'done'
        else error = 'refused'
        askedAgain = (await this.askedNow(tenantId, line)) !== undefined
      }
    } catch (err) {
      this.options.logger?.warn({ err, tenantId, line }, 'operator: the forwards of a line not removed, tried again at the next round')
      error = codeOf(err)
    }
    // A line a trunk names still: what was read of it, what the platform set and found there forgotten once done.
    if (lines.has(line)) {
      const before = ((await store.getOperatorState(tenantId, lineKey(line))) as LineState | undefined) ?? {}
      const carried: Partial<LineState> = outcome ? {} : { ...(before.set ? { set: before.set } : {}), ...(before.original ? { original: before.original } : {}) }
      await store.putOperatorState(
        tenantId,
        lineKey(line),
        (forwards
          ? { forwards, readAt: at, ...(error ? { error } : wrote ? { appliedAt: at } : {}), ...carried }
          : { ...(before.forwards ? { forwards: before.forwards } : {}), ...(before.readAt ? { readAt: before.readAt } : {}), ...(error ? { error } : {}), ...carried }) satisfies LineState
      )
    }
    if (outcome) {
      await store.deleteOperatorState(tenantId, removeKey(line), owed)
      if (outcome === 'changed') {
        this.options.logger?.warn({ tenantId, line }, 'operator: the forwards of a line were changed at the operator since their removal was asked, left as they are')
        await this.removalAlert(tenantId, line, 'removal-changed')
      } else if (restoring) this.options.logger?.info({ tenantId, line }, 'operator: the fallback of a line removed at the operator, the forwards of before put back')
      else this.options.logger?.info({ tenantId, line }, 'operator: the forwards of a line removed at the operator')
      if (outcome === 'done' && refusal) this.options.logger?.warn({ tenantId, line, why: refusal }, 'operator: the forwards of before not put back on a line: they would loop to the platform, or go where its trunk may not call')
      await this.closeRemoval(tenantId, line, owed, outcome, outcome === 'done' && restoring, unrestored)
      if (askedAgain) {
        // Asked again as it was removed (another Gateway): set again as a first write, not a change in the manager.
        const asks = linesOf(await store.listTrunks(tenantId)).get(line)?.asks
        if (asks?.size) {
          this.options.logger?.info({ tenantId, line }, 'operator: a fallback asked again as it was removed, set again')
          await this.line(tenantId, line, [...asks.values()], true)
        }
      }
      return undefined
    }
    const gone = error === 'not-found' ? (owed.gone ?? 0) + 1 : 0
    if (gone >= REMOVAL_GONE_ROUNDS) {
      if (await store.deleteOperatorState(tenantId, removeKey(line), owed)) {
        this.options.logger?.warn({ tenantId, line, rounds: gone }, 'operator: the operator has no such line, its removal let go')
        await this.removalAlert(tenantId, line, 'removal-gone')
        await this.closeRemoval(tenantId, line, owed, 'gone')
      }
      return undefined
    }
    const late = !owed.late && this.now() - Date.parse(owed.since) > REMOVAL_LATE_MS
    if (late) {
      this.options.logger?.warn({ tenantId, line, since: owed.since }, 'operator: the forwards of a line owed to be removed for over a day')
      await this.removalAlert(tenantId, line, 'removal-late')
    }
    if (error === 'refused')
      this.options.logger?.warn({ tenantId, line }, restoring ? 'operator: the operator did not keep the forwards of before, the fallback removed without them at the next round' : 'operator: the operator kept the forwards of a line, tried again at the next round')
    const { gone: _gone, original, ...rest } = owed
    // The forwards of before refused (or not kept): the next round removes the fallback without them. What the operator
    // kept of a write of the platform (fourth review 10b, n°4: a delay rounded) is the platform's, never the manager's:
    // what the next round expects there.
    const notKept = restoring && error === 'refused'
    const kept: RemovalState = {
      ...rest,
      ...(wrote && forwards ? { expect: forwards } : {}),
      ...(original && !notKept ? { original } : {}),
      ...(notKept ? { unrestored: 'refused' as const } : {}),
      triedAt: at,
      error: error!,
      ...(gone ? { gone } : {}),
      ...(late ? { late: true as const } : {})
    }
    // Written again only as it was read: let go meanwhile (an administrator), or written again, it stays so.
    const now = (await store.getOperatorState(tenantId, removeKey(line))) as RemovalState | undefined
    if (now?.id === owed.id) await store.putOperatorState(tenantId, removeKey(line), kept)
    return shownRemoval(line, kept)
  }

  private async forgetLines(tenantId: string, lines: ReadonlyMap<string, unknown>) {
    for (const { key } of await this.options.store.listOperatorState(tenantId, 'line:')) if (!lines.has(key.slice(5))) await this.options.store.deleteOperatorState(tenantId, key)
  }

  /**
   * One line (within `exclusive`): read; when a fallback is asked and what is there is not it, set, then read back
   * (review 10b, n°7): what the operator did not keep is said (`refused`) and not written again until a trunk is saved
   * (`retry`). Two fallbacks asked (two trunks, review n°5): read only, said (`conflict`). The trunks are read again
   * just before writing, and just after (second review n°1): a fallback no longer asked is not written, and one
   * written while its trunk stopped asking it (another Gateway) is removed again. What the platform set is kept while
   * the line is read with it (third review n°2), and what was there before its first write (n°8).
   */
  private async line(tenantId: string, line: string, asks: OperatorFallback[], retry: boolean): Promise<LineState> {
    const operator = this.options.operators.get(tenantId)!
    const store = this.options.store
    // A removal owed there while these trunks ask a fallback: tried, the trunks read again (third review 10b, n°1:
    // those of a round may be from before the removal was asked), never let go on what this pass read.
    if (asks.length && (await store.getOperatorState(tenantId, removeKey(line)))) await this.removeLine(tenantId, line)
    const before = ((await store.getOperatorState(tenantId, lineKey(line))) as LineState | undefined) ?? {}
    const asked = asks.length === 1 ? asks[0] : undefined
    const wanted = asked && askKey(asked)
    let unasked = false
    const next: LineState = {
      ...(before.appliedAt ? { appliedAt: before.appliedAt } : {}),
      ...(before.restoredAt ? { restoredAt: before.restoredAt } : {}),
      ...(wanted ? { asked: wanted } : {}),
      ...(wanted && !retry && before.rejected === wanted ? { rejected: wanted } : {}),
      ...(before.original ? { original: before.original } : {})
    }
    let forwards = before.forwards
    let readAt = before.readAt
    let read = false
    try {
      forwards = await operator.getForwards(line)
      readAt = this.iso()
      read = true
      if (before.set && matchesFallback(before.set, forwards)) next.set = before.set
      if (asks.length > 1) Object.assign(next, { inSync: false, error: 'conflict' })
      else if (!asked || matchesFallback(asked, forwards)) {
        if (asked) next.inSync = true
        delete next.rejected
      } else if (next.rejected) Object.assign(next, { inSync: false, error: 'refused' })
      else if ((await this.askedNow(tenantId, line)) !== wanted) {
        // No longer what the trunks ask (saved meanwhile, perhaps on another Gateway): the next pass, or the removal.
        next.inSync = false
      } else {
        // It was there as asked, and is no longer: someone changed it at the operator (its manager). Put back.
        const restored = before.inSync === true && before.asked === wanted
        const prior = forwards
        try {
          await operator.setFallback(line, asked)
        } catch (err) {
          if (codeOf(err) === 'refused') next.rejected = wanted
          throw err
        }
        // What was there before the platform first wrote (third review 10b, n°8), put back when its fallback goes.
        if (!before.set && !before.original && !restored) next.original = prior
        forwards = await operator.getForwards(line)
        readAt = this.iso()
        next.appliedAt = readAt
        unasked = (await this.askedNow(tenantId, line)) === undefined
        if (!matchesFallback(asked, forwards)) {
          this.options.logger?.warn({ tenantId, line }, 'operator: the operator did not keep the fallback asked, not written again until the trunk is saved')
          Object.assign(next, { inSync: false, error: 'refused', rejected: wanted })
        } else {
          if (restored) this.options.logger?.warn({ tenantId, line }, 'operator: the fallback was changed at the operator, put back as asked')
          else this.options.logger?.info({ tenantId, line }, 'operator: fallback set at the operator')
          Object.assign(next, { inSync: true, set: asked, ...(restored ? { restoredAt: readAt } : {}) })
        }
      }
    } catch (err) {
      this.options.logger?.warn({ err, tenantId, line }, 'operator: the forwards of a line not read or not set')
      Object.assign(next, { ...(asked ? { inSync: false } : {}), error: codeOf(err), ...(!read && before.set ? { set: before.set } : {}) })
    }
    const state: LineState = { ...(forwards ? { forwards } : {}), ...(readAt ? { readAt } : {}), ...next }
    await store.putOperatorState(tenantId, lineKey(line), state)
    if (unasked) {
      // Written while its trunk stopped asking it: owed to be removed, now and at each round until it is.
      this.options.logger?.warn({ tenantId, line }, 'operator: a fallback written as its trunk stopped asking it, removed again')
      await this.owe(tenantId, line)
      await this.removeLine(tenantId, line)
      return ((await store.getOperatorState(tenantId, lineKey(line))) as LineState | undefined) ?? state
    }
    return state
  }

  /** What is set on a line, read again (a trunk event): its forwards and when, nothing written. */
  private async reread(tenantId: string, line: string) {
    const forwards = await this.options.operators.get(tenantId)!.getForwards(line)
    await this.exclusive(tenantId, async () => {
      const before = ((await this.options.store.getOperatorState(tenantId, lineKey(line))) as LineState | undefined) ?? {}
      await this.options.store.putOperatorState(tenantId, lineKey(line), { ...before, forwards, readAt: this.iso() } satisfies LineState)
    })
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
    const size = this.options.nearPage ?? NEAR_PAGE
    for (let page = 0; page < (this.options.nearPages ?? NEAR_PAGES); page++) {
      const got = await this.options.store.historyNear(tenantId, { ...query, limit: size, ...(after ? { after } : {}) })
      out.push(...got)
      if (got.length < size) return { entries: out, complete: true }
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
    // Whether the number of a record changed hands since its call (second review 10b, n°3): not of whom it rings now.
    const handedOver = async (r: OperatorCdrRecord, holder: UserMapping) => {
      const changed = await store.numberChangedAt(tenantId, holder.extension, e164Of(localOf(r)!))
      return !!changed && changed > r.startedAt
    }
    const erasedAt = async (userId: string) => {
      if (!erasures.has(userId)) erasures.set(userId, await store.historyErasedAt(tenantId, userId))
      return erasures.get(userId)
    }
    // Started before what the erasures kept tell apart (fourth review 10b, n°1): an erasure of that call may be purged.
    const told = this.iso(this.now() - ERASURES_TOLD_MS)
    for (let batch = 0; batch < RECONCILE_BATCHES; batch++) {
      const pending = await store.pendingOperatorCdrs(tenantId, operator.id, readBefore, RECONCILE_BATCH)
      if (!pending.length) return
      const outcomes: OperatorCdrOutcome[] = []
      const live: { r: OperatorCdrRecord; holder: UserMapping | null }[] = []
      // The direct numbers erased with someone's history (second review 10b, n°3), whoever holds them now.
      const locals = [...new Set(pending.flatMap(r => (localOf(r) ? [e164Of(localOf(r)!)] : [])))]
      const numberErased = await store.numbersErasedAt(tenantId, locals)
      for (const r of pending) {
        if (r.invalid) outcomes.push({ id: r.id, outcome: 'invalid' })
        else if (r.forwarded) outcomes.push({ id: r.id, outcome: 'forwarded' })
        else {
          const holder = await holderOf(r)
          const erased = [holder ? await erasedAt(holder.userId) : undefined, localOf(r) ? numberErased.get(e164Of(localOf(r)!)) : undefined].filter(e => !!e).sort().at(-1)
          // A call of a person who erased their history since: in nobody's history, its numbers gone (review 10b, n°1).
          if (erased && erased >= r.startedAt) outcomes.push({ id: r.id, outcome: 'erased' })
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
      // When erased entries were (second review 10b, n°2): a record no entry takes, then, was of one of them.
      const erasedCalls = records.length ? await store.erasedCalls(tenantId, span(records).from, span(records).to) : []
      // Of the same number on the other side, by its keyed print (third review 10b, n°5): never the call of another
      // person then. One kept without a print (no key) is told by its way and time alone.
      const keyOf = this.options.remoteKey
      const ofErased = (r: OperatorCdrRecord) => {
        const at = Date.parse(r.startedAt)
        const remote = remoteOf(r)
        const key = remote && keyOf ? keyOf(tenantId, e164Of(remote)) : undefined
        return erasedCalls.some(
          c => c.direction === r.direction && (c.remoteKey === undefined || c.remoteKey === key) && at >= Date.parse(c.startedAt) - RECONCILE_EARLY_MS && at <= Date.parse(c.endedAt) + RECONCILE_LATE_MS
        )
      }
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
        if (r.startedAt < told) {
          outcomes.push({ id: r.id, outcome: 'erased' })
          continue
        }
        const at = Date.parse(r.startedAt)
        // A call of the holder then, whatever its number (anonymous here, a call forwarded there): no second entry.
        const busy = holder && (holderEntries.get(holder.userId) ?? []).some(e => at >= Date.parse(e.startedAt) - RECONCILE_EARLY_MS && at <= Date.parse(e.endedAt ?? e.startedAt) + RECONCILE_LATE_MS)
        if (r.direction !== 'inbound' || !r.calling || !r.called || !holder || busy || partial.has(r.id) || (await handedOver(r, holder))) {
          outcomes.push({ id: r.id, outcome: ofErased(r) ? 'erased' : 'unmatched' })
          continue
        }
        // A call the platform never had (received while it could not be reached, or an event lost): in the
        // history of whom its direct number rings, when that is one person (an extension, not a group). Forwarded by
        // the operator to the fallback (its forward recorded after it, from the number called, second review 10b,
        // n°4): missed here, whoever answered there.
        const called = e164Of(r.called)
        const forwards = await store.operatorForwardsNear(tenantId, operator.id, r.line, this.iso(at - RECONCILE_EARLY_MS), this.iso(at + Math.max(r.durationSec * 1000, FORWARD_AFTER_MS)))
        const forwarded = forwards.some(f => !!f.calling && e164Of(f.calling) === called)
        const answered = !forwarded && r.durationSec > 0
        const entry: HistoryEntry = {
          tenantId,
          userId: holder.userId,
          callId: `${operator.id}:${r.id}`,
          direction: 'inbound',
          remoteNumber: r.calling,
          startedAt: r.startedAt,
          endedAt: this.iso(answered ? at + r.durationSec * 1000 : at),
          durationSec: answered ? r.durationSec : 0,
          state: answered ? 'ended' : 'missed',
          answered,
          ...(forwarded ? { operatorForwarded: true } : {})
        }
        outcomes.push({ id: r.id, outcome: 'orphan', entry })
      }
      await store.settleOperatorCdrs(tenantId, operator.id, outcomes)
      if (pending.length < RECONCILE_BATCH) return
    }
  }

  /**
   * The end of a round (review 10b, n°12): an alert when the operator has refused the keys or their rights
   * OPERATOR_ALERT_ROUNDS rounds in a row, or when the rate of reconciliation of these 7 days falls under
   * OPERATOR_RECONCILED_PERCENT % (FR-D4: of the records the platform should have had a call for, OPERATOR_RECONCILED_FLOOR
   * at least). Each once, as it happens (second review n°5): acknowledged, not raised again until it happens again.
   */
  private async alerts(tenantId: string, codes: readonly OperatorLineError[]) {
    const store = this.options.store
    const operator = this.options.operators.get(tenantId)!
    const cdrs = ((await store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined) ?? {}
    const refused = codes.includes('unauthorized') ? 'unauthorized' : codes.includes('forbidden') ? 'forbidden' : undefined
    const refusedRounds = refused ? (cdrs.refusedRounds ?? 0) + 1 : 0
    const at = this.iso()
    if (refused) this.options.logger?.warn({ tenantId, rounds: refusedRounds }, `operator: the operator refuses the keys (${refused}), round after round`)
    if (refused && refusedRounds === OPERATOR_ALERT_ROUNDS) await store.addAlert({ tenantId, at, alert: { kind: 'operator', param: refused, scope: 'tenant', value: refusedRounds } })
    const stats = await store.operatorCdrStats(tenantId, operator.id, this.iso(this.now() - OPERATOR_STATS_MS))
    const owed = reconcilable(stats)
    const low = owed >= OPERATOR_RECONCILED_FLOOR && stats.matched * 100 < owed * OPERATOR_RECONCILED_PERCENT
    if (low && !cdrs.low) {
      const percent = Math.floor((stats.matched * 1000) / owed) / 10
      await store.addAlert({ tenantId, at, alert: { kind: 'operator', param: 'reconciliation', scope: 'tenant', value: percent, threshold: OPERATOR_RECONCILED_PERCENT } })
    }
    // The round asked is answered once it ends (run), never here (third review 10b, n°9).
    await store.putOperatorState(tenantId, 'cdrs', { ...cdrs, refusedRounds, low, roundAt: at } satisfies CdrsState)
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
    const states = async () => Promise.all(names.map(async l => (await this.options.store.getOperatorState(tenantId, lineKey(l))) as LineState | undefined))
    let read = await states()
    if (read.some(s => !s?.readAt || this.now() - Date.parse(s.readAt) > FRESH_FALLBACK_MS)) {
      // Read only: what the trunk event tells, never a write meanwhile (second review 10b, n°1).
      await within(Promise.all(names.map(l => this.reread(tenantId, l))), FRESH_READ_MS).catch(() => undefined)
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
    const refusals = new Map<string, OperatorRestoreRefusal>()
    for (const [line, st] of states) {
      const refused = st.original && (await this.restoreRefusal(tenantId, st.original, trunks.find(t => t.config.operator?.lines.includes(line))?.id))
      if (refused) refusals.set(line, refused)
    }
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
        ...(wanted && s.rejected === wanted ? { rejected: true as const } : {}),
        ...(s.original ? { original: s.original } : {}),
        ...(refusals.has(line) ? { originalRefused: refusals.get(line)! } : {})
      }
    }
    const cdrs = ((await store.getOperatorState(tenantId, 'cdrs')) as CdrsState | undefined) ?? {}
    const removals = await this.removals(tenantId)
    const closedRemovals = await this.closedRemovals(tenantId)
    return {
      operator: operator.id,
      trunks: trunks.filter(t => t.config.operator?.lines.length).map(t => ({ id: t.id, lines: t.config.operator!.lines.map(lineStatus) })),
      ...(removals.length ? { removals } : {}),
      ...(closedRemovals.length ? { closedRemovals } : {}),
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
 * The direct numbers of a person (E.164), as their history is erased (review 10b, n°1; Store.deleteHistory): the
 * operator's records to or from them lose their numbers, and those read later never enter anybody's history.
 */
export const erasedNumbersOf = async (store: Store, tenantId: string, userId: string) => {
  const mapping = await store.getMappingByUser(tenantId, userId)
  return mapping ? directNumbersOf(await store.listDids(tenantId), mapping.extension) : []
}

/** The records the platform should have had a call for (FR-D4): reconciled, or not; the rest apart (second review 10b, n°5). */
export const reconcilable = (s: OperatorCdrStats) => s.matched + s.unmatchedInbound + s.unmatchedOutbound
