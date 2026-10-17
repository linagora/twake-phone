import type { DidRange } from '@twake/telephony-types'
import type { HistoryEntry, OperatorCdrRecord } from './store/types.js'

/**
 * How the operator's records of calls are matched with the calls of the history (step 10b, ADR 0021): the start the
 * operator wrote (taken for the start of the call) falls from RECONCILE_EARLY_MS before the start of ours to
 * RECONCILE_LATE_MS after its end; and their durations are close when both were answered.
 */
export const RECONCILE_EARLY_MS = 60_000
export const RECONCILE_LATE_MS = 60_000
/** Seconds apart two durations of one call may be (or a tenth of the longer). */
export const RECONCILE_DURATION_SEC = 5

/** A number in E.164 when it is one: `+…`, `00…`, or a French national number. As written otherwise. */
export const e164Of = (n: string): string => {
  const v = n.replace(/[\s.()-]/g, '')
  if (/^\+[1-9][0-9]{6,14}$/.test(v)) return v
  const intl = /^00([1-9][0-9]{6,14})$/.exec(v)
  if (intl) return `+${intl[1]}`
  const national = /^0([1-9][0-9]{8})$/.exec(v)
  return national ? `+33${national[1]}` : v
}

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

/**
 * Pairs the records with the calls of the history, one record for a call and one call for a record: of all the
 * pairs that may be (same way, same number on the other side, the start within the window, durations close), the
 * closest in time first. The records left: unmatched (the caller decides what they become).
 */
export const matchCdrs = (cdrs: readonly OperatorCdrRecord[], history: readonly HistoryEntry[]): Map<string, string> => {
  const calls = callsOf(history)
  const pairs: { cdr: string; call: string; score: number }[] = []
  for (const r of cdrs) {
    if (r.forwarded) continue
    const remote = r.direction === 'inbound' ? r.calling : r.called
    if (!remote) continue
    const at = Date.parse(r.startedAt)
    for (const c of calls) {
      if (c.direction !== r.direction || c.remote !== e164Of(remote)) continue
      if (at < c.start - RECONCILE_EARLY_MS || at > c.end + RECONCILE_LATE_MS) continue
      if (!durationsClose(r.durationSec, c.durationSec)) continue
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
