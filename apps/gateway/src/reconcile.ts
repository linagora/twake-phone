import type { DidRange } from '@twake/telephony-types'
import { e164Of } from './e164.js'
import type { HistoryEntry, OperatorCdrRecord } from './store/types.js'

export { e164Of }

/**
 * How the operator's records of calls are matched with the calls of the history (step 10b, ADR 0021): the start the
 * operator wrote (taken for the start of the call) falls from RECONCILE_EARLY_MS before the start of ours to
 * RECONCILE_LATE_MS after its end; and their durations are close when both were answered.
 */
export const RECONCILE_EARLY_MS = 60_000
export const RECONCILE_LATE_MS = 60_000
/** Seconds apart two durations of one call may be (or a tenth of the longer). */
export const RECONCILE_DURATION_SEC = 5

/** A caller the platform did not see the number of (the SIP server writes `anonymous`). */
export const isHidden = (remote: string) => remote === '' || remote === 'anonymous'

/** A call of the history, as every entry of it says (the people it rang): one call, whoever's entry. */
interface HistoryCall {
  callId: string
  direction: HistoryEntry['direction']
  remote: string
  start: number
  end: number
  durationSec: number
}

const callsOf = (history: readonly HistoryEntry[]): HistoryCall[] => {
  const calls = new Map<string, HistoryCall>()
  for (const e of history) {
    const start = Date.parse(e.startedAt)
    const end = Date.parse(e.endedAt ?? e.startedAt)
    const c = calls.get(e.callId)
    if (!c) calls.set(e.callId, { callId: e.callId, direction: e.direction, remote: e164Of(e.remoteNumber), start, end, durationSec: e.durationSec })
    else Object.assign(c, { start: Math.min(c.start, start), end: Math.max(c.end, end), durationSec: Math.max(c.durationSec, e.durationSec) })
  }
  return [...calls.values()]
}

/** Seconds in communication the operator and the platform counted for one call: a few apart at most (one answered, the other not, is two calls). */
const durationsClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(RECONCILE_DURATION_SEC, Math.max(a, b) / 10)

/** The number on the other side of a record: who called in, whom the platform called out. */
export const remoteOf = (r: Pick<OperatorCdrRecord, 'direction' | 'calling' | 'called'>) => (r.direction === 'inbound' ? r.calling : r.called)
/** The platform's own number in a record: the direct number called in, the one presented out. */
export const localOf = (r: Pick<OperatorCdrRecord, 'direction' | 'calling' | 'called'>) => (r.direction === 'inbound' ? r.called : r.calling)

/**
 * Pairs the records with the calls of the history, one record for a call and one call for a record: of all the
 * pairs that may be (same way, same number on the other side, the start within the window, durations close), the
 * closest in time first. The records left: unmatched (the caller decides what they become).
 *
 * `loose` (review 10b, n°17), for the records left by a first pass: durations apart too (a call the operator forwarded
 * on no answer: missed here, answered there), and an inbound call whose caller the platform did not see (`anonymous`
 * here, a number there). `taken`: calls already paired.
 */
export const matchCdrs = (cdrs: readonly OperatorCdrRecord[], history: readonly HistoryEntry[], options: { loose?: boolean; taken?: ReadonlySet<string> } = {}): Map<string, string> => {
  const calls = callsOf(history)
  const pairs: { cdr: string; call: string; score: number }[] = []
  for (const r of cdrs) {
    if (r.forwarded || r.invalid) continue
    const remote = remoteOf(r)
    if (!remote) continue
    const at = Date.parse(r.startedAt)
    for (const c of calls) {
      if (options.taken?.has(c.callId) || c.direction !== r.direction) continue
      if (c.remote !== e164Of(remote) && !(options.loose && r.direction === 'inbound' && isHidden(c.remote))) continue
      if (at < c.start - RECONCILE_EARLY_MS || at > c.end + RECONCILE_LATE_MS) continue
      if (!options.loose && !durationsClose(r.durationSec, c.durationSec)) continue
      pairs.push({ cdr: r.id, call: c.callId, score: Math.abs(at - c.start) + 1_000 * Math.abs(r.durationSec - c.durationSec) })
    }
  }
  pairs.sort((a, b) => a.score - b.score || (a.cdr < b.cdr ? -1 : 1))
  const out = new Map<string, string>()
  const taken = new Set<string>()
  for (const p of pairs) {
    if (out.has(p.cdr) || taken.has(p.call)) continue
    out.set(p.cdr, p.call)
    taken.add(p.call)
  }
  return out
}

/**
 * The extension a call to `number` rings (step 6): the target of the range of direct numbers it is in, or the
 * extension its last digits make; undefined when no range has it.
 */
export const extensionOfDid = (dids: readonly DidRange[], number: string): string | undefined => {
  const n = e164Of(number)
  const range = dids.find(d => d.first.length === n.length && d.first <= n && n <= d.last)
  if (!range) return undefined
  return range.target ?? (range.suffixDigits ? n.slice(-range.suffixDigits) : undefined)
}

/** Direct numbers of one extension that directNumbersOf gives at most (a range whose last digits repeat it). */
export const DIRECT_NUMBERS_MAX = 1_000

/**
 * The direct numbers that ring `extension` (extensionOfDid the other way round): the ranges aimed at it, and the
 * numbers of a range by last digits that end with it. DIRECT_NUMBERS_MAX at most.
 */
export const directNumbersOf = (dids: readonly DidRange[], extension: string): string[] => {
  const out = new Set<string>()
  for (const d of dids) {
    if (d.target !== undefined) {
      if (d.target !== extension) continue
      // A range aimed at one extension: its numbers, as many as allowed.
      const first = BigInt(d.first.slice(1))
      const last = BigInt(d.last.slice(1))
      for (let n = first; n <= last && out.size < DIRECT_NUMBERS_MAX; n++) out.add(`+${n.toString().padStart(d.first.length - 1, '0')}`)
    } else if (d.suffixDigits && extension.length === d.suffixDigits && /^[0-9]+$/.test(extension)) {
      const k = d.suffixDigits
      const step = 10n ** BigInt(k)
      const head = (v: string) => BigInt(v.slice(1)) / step
      for (let h = head(d.first); h <= head(d.last) && out.size < DIRECT_NUMBERS_MAX; h++) {
        const n = `+${(h * step + BigInt(extension)).toString().padStart(d.first.length - 1, '0')}`
        if (d.first <= n && n <= d.last) out.add(n)
      }
    }
  }
  return [...out]
}
