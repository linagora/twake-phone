import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  TRUNK_CODECS,
  TRUNK_OUTBOUND_CLASSES,
  formatNumber,
  type OperatorClosedRemoval,
  type OperatorForward,
  type OperatorLine,
  type OperatorLineForwards,
  type OperatorLineRead,
  type OperatorRemoval,
  type OperatorStatus,
  type Trunk,
  type TrunkNumberFormat,
  type TrunkStatus
} from '@twake/telephony-client'
import { TargetList } from '../../admin/TargetList.js'
import { targetLabel, useTargets } from '../../admin/targets.js'
import { CheckBox, CheckGroup, ConfirmDelete, NoteLine, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, useRefresh, type Note } from '../../admin/ui.js'
import { TRUNK_FIELDS, checkTrunk, droppedOperatorLines, emptyTrunk, newOperatorLines, refusalStatus, trunkForm, trunkRefusal, type Problems, type TrunkField, type TrunkForm } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

/**
 * How long after an answer the status of the trunks is read again while this screen is shown (a registration takes a
 * few seconds); never in a hidden tab (useRefresh).
 */
export const STATUS_POLL_MS = 5_000
/** How long after the lines of the form last changed what the operator has on them is read again. */
const PREVIEW_DELAY_MS = 300
const FORMATS: TrunkNumberFormat[] = ['e164', 'e164-no-plus', 'international-00', 'national']
const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/** The trunk those without a direct number call through: the one marked, else the first (as the Gateway). */
const defaultOf = (trunks: readonly Trunk[]) => trunks.find(t => t.default) ?? trunks[0]

const TrunkState = ({ status, available }: { status: TrunkStatus | undefined; available: boolean }) => {
  const { t } = useT()
  if (!available || !status) return <p className="badge">{t('admin.trunk.statusUnknown')}</p>
  return (
    <ul className="plain" aria-label={t('admin.trunk.status')}>
      {status.registration ? (
        <li>
          {t('admin.trunk.registration')} : <span className={`state state-${status.registration.state}`}>{t(`admin.trunk.reg.${status.registration.state}` as Key)}</span>
        </li>
      ) : null}
      {status.servers.map(s => (
        <li key={s.address}>
          {t('admin.trunk.server', { address: s.address })} : <span className={`state state-${s.state}`}>{t(`admin.trunk.srv.${s.state}` as Key)}</span>
        </li>
      ))}
    </ul>
  )
}

type T = ReturnType<typeof useT>['t']
/** Where a forward set at the operator sends the calls, in words: its number, the voicemail, a fax, elsewhere. */
const toOf = (fw: OperatorForward, t: T) => (fw.nature === 'number' && fw.number ? formatNumber(fw.number) : t(`admin.operator.to.${fw.nature === 'number' ? 'other' : fw.nature}` as Key))
/**
 * What the forwards set at the operator do, in words, each as it is (review 10b, n°4): on unavailability, on no
 * answer after a delay, or nothing.
 */
const forwardsOf = (f: OperatorLineForwards | undefined, t: T) => {
  const out: string[] = []
  if (f?.onUnavailable) out.push(t('admin.operator.forwardUnavailable', { to: toOf(f.onUnavailable, t) }))
  if (f?.onNoAnswer) out.push(t('admin.operator.forwardNoAnswer', { to: toOf(f.onNoAnswer, t), sec: f.onNoAnswer.afterSec }))
  return out.length ? out.join(' ; ') : t('admin.operator.noForward')
}

/** Whether the platform can write these forwards back (to a number, the voicemail or a fax). */
const writable = (f: OperatorLineForwards) => [f.onUnavailable, f.onNoAnswer].every(fw => !fw || (fw.nature === 'number' ? !!fw.number : fw.nature !== 'other'))
/**
 * What removing the fallback of a line puts back there, in words (third review 10b, n°8): the forwards of before the
 * platform took it; that they are not known, or go elsewhere than the platform can write, and stay gone; nothing when
 * there were none.
 */
const restoreOf = (line: string, original: OperatorLineForwards | undefined, t: T) => {
  if (!original) return t('admin.operator.restoreUnknown', { line })
  if (!original.onUnavailable && !original.onNoAnswer) return undefined
  return writable(original) ? t('admin.operator.restoreLine', { line, forwards: forwardsOf(original, t) }) : t('admin.operator.restoreOther', { line, forwards: forwardsOf(original, t) })
}

/** A trunk's lines at the operator (step 10b): the forwards set there and whether they are the ones asked. */
const OperatorLines = ({ lines }: { lines: OperatorLine[] }) => {
  const { t, lang } = useT()
  const at = new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' })
  return (
    <ul className="plain" aria-label={t('admin.operator.lines')}>
      {lines.map(l => (
        <li key={l.line}>
          {t('admin.operator.line', { line: l.line, forwards: l.readAt ? forwardsOf(l.forwards, t) : t('admin.operator.notRead') })}
          {' · '}
          {l.rejected ? (
            <span className="state state-error">{t('admin.operator.rejected')}</span>
          ) : l.error ? (
            <span className="state state-error">{t(`admin.operator.err.${l.error}` as Key)}</span>
          ) : !l.managed ? (
            <span>{t('admin.operator.notManaged')}</span>
          ) : l.inSync ? (
            <span className="state state-up">{t('admin.operator.inSync')}</span>
          ) : (
            <span>{t('admin.operator.pending')}</span>
          )}
          {l.restoredAt ? <> · {t('admin.operator.restored', { at: at.format(new Date(l.restoredAt)) })}</> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * The removals at the operator not done yet (second review 10b, n°1): kept by the Gateway, whatever became of their
 * trunk, and tried again at each round until done; each with what it puts back (third review n°8), and let go on the
 * administrator's word (n°4: a line the operator no longer has, keys without the right to write).
 */
const Removals = ({ removals, onAbandon, busy }: { removals: OperatorRemoval[]; onAbandon: (line: string) => void; busy: boolean }) => {
  const { t, lang } = useT()
  const at = new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' })
  return (
    <div className="field">
      <p>{t('admin.operator.removals')}</p>
      <ul className="plain" aria-label={t('admin.operator.removals')}>
        {removals.map(r => (
          <li key={r.line}>
            {t('admin.operator.removal', { line: r.line, since: at.format(new Date(r.since)) })}
            {r.error ? <span className="state state-error"> · {t(`admin.operator.err.${r.error}` as Key)}</span> : null}
            {restoreOf(r.line, r.original, t) ? <> · {restoreOf(r.line, r.original, t)}</> : null}{' '}
            <ConfirmDelete
              label={t('admin.operator.abandonOf', { line: r.line })}
              question={t('admin.operator.abandonConfirm', { line: r.line })}
              action="admin.operator.abandon"
              yes="admin.operator.abandonYes"
              tone="plain"
              onConfirm={() => onAbandon(r.line)}
              disabled={busy}
            />
          </li>
        ))}
      </ul>
      <p className="muted">{t('admin.operator.removalsHelp')}</p>
    </div>
  )
}

/** What became of the removals of the last days (third review 10b, n°2 and n°4): done, left as changed, let go. */
const ClosedRemovals = ({ removals }: { removals: OperatorClosedRemoval[] }) => {
  const { t, lang } = useT()
  const at = new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' })
  return (
    <div className="field">
      <p>{t('admin.operator.closedRemovals')}</p>
      <ul className="plain" aria-label={t('admin.operator.closedRemovals')}>
        {removals.map(r => (
          <li key={r.line} className={r.outcome === 'changed' || r.outcome === 'gone' ? 'state state-error' : undefined}>
            {t(`admin.operator.closed.${r.outcome === 'done' && r.restored ? 'restored' : r.outcome}` as Key, { line: r.line, at: at.format(new Date(r.at)) })}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The records of calls the operator keeps (step 10b): when last read, and what became of those of the last days. */
const OperatorRecords = ({ status, onSync, onAbandon, busy }: { status: OperatorStatus; onSync: () => void; onAbandon: (line: string) => void; busy: boolean }) => {
  const { t, lang } = useT()
  const at = new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' })
  const cdrs = status.cdrs
  const stats = cdrs?.stats
  // The share of the calls OVH recorded that the platform had too (FR-D4), over those it could have had (second review
  // 10b, n°5): those received while it was down (orphans), its forwards, those erased with a history, those not settled
  // yet and those it could not read aside.
  const reconcilable = stats ? stats.matched + stats.unmatchedInbound + stats.unmatchedOutbound : 0
  const rate = stats && reconcilable > 0 ? new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(stats.matched / reconcilable) : '–'
  const rows: [Key, number | string][] = stats
    ? [
        ['admin.operator.statRate', rate],
        ['admin.operator.statTotal', stats.total],
        ['admin.operator.statMatched', stats.matched],
        ['admin.operator.statOrphan', stats.orphan],
        ['admin.operator.statUnmatched', stats.unmatchedInbound + stats.unmatchedOutbound],
        ['admin.operator.statForwarded', stats.forwarded],
        ['admin.operator.statPending', stats.pending],
        ['admin.operator.statInvalid', stats.invalid],
        ['admin.operator.statErased', stats.erased]
      ]
    : []
  return (
    <>
      <p>{t('admin.operator.help')}</p>
      {status.removals?.length ? <Removals removals={status.removals} onAbandon={onAbandon} busy={busy} /> : null}
      {status.closedRemovals?.length ? <ClosedRemovals removals={status.closedRemovals} /> : null}
      <p>
        {cdrs?.readAt ? t('admin.operator.readAt', { at: at.format(new Date(cdrs.readAt)), count: cdrs.read ?? 0 }) : t('admin.operator.notYet')}
      </p>
      {cdrs?.lines?.length ? (
        <ul className="plain">
          {cdrs.lines.map(l => (
            <li key={l.line} className="state state-error">
              {t('admin.operator.cdrLine', { line: l.line, problem: t(`admin.operator.err.${l.error}` as Key) })}
            </li>
          ))}
        </ul>
      ) : null}
      {stats ? <p className="muted">{t('admin.operator.statRateHint')}</p> : null}
      {stats ? (
        <dl className="facts facts-compact" aria-label={t('admin.operator.stats', { since: at.format(new Date(cdrs.since)) })}>
          {rows.map(([key, n]) => (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p>
        <button type="button" className="btn" onClick={onSync} disabled={busy} aria-busy={busy}>
          {t('admin.operator.sync')}
        </button>
      </p>
    </>
  )
}

/**
 * The trunks to the operator (step 7, FR-D2; ADR 0016): listed with how they are doing (registration, servers),
 * created, changed and removed. The password is write-only: never shown, kept when left empty, removed on demand.
 */
export const Trunks = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const targets = useTargets(client)
  const [trunks, setTrunks] = useState<Trunk[] | null>(null)
  const [status, setStatus] = useState<{ available: boolean; items: TrunkStatus[] }>({ available: false, items: [] })
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<TrunkForm>(emptyTrunk)
  const [editing, setEditing] = useState<Trunk | null>(null)
  const [problems, setProblems] = useState<Problems<TrunkField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [operator, setOperator] = useState<OperatorStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [operatorNote, setOperatorNote] = useState<Note>(null)
  // What the operator has on the lines of the form now, shown before a first fallback replaces it (review 10b, n°13).
  // Kept with the lines it was read for: shown only while they are the lines asked (second review 10b, n°9).
  const [atOperator, setAtOperator] = useState<{ key: string; items: OperatorLineRead[] } | null>(null)
  const [reading, setReading] = useState(false)

  // Only the answer to the last read is shown: one asked by the button never comes after a later one.
  const asked = useRef(0)
  const readStatus = useCallback(() => {
    const n = ++asked.current
    const show = (s: { available: boolean; items: TrunkStatus[] }) => {
      if (n === asked.current) setStatus(s)
    }
    // Its operator (step 10b) with it: what is set at the lines, what became of the records (read from the Gateway's
    // memory and base, never from the operator).
    const operatorRead = client.getOperatorStatus().then(
      o => {
        if (n === asked.current) setOperator(o)
      },
      () => undefined
    )
    return Promise.all([client.getTrunkStatus().then(show, () => show({ available: false, items: [] })), operatorRead]).then(() => undefined)
  }, [client])
  const load = useCallback(() => {
    client.listTrunks().then(
      r => setTrunks(r.items),
      (err: unknown) => {
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: t('admin.loadError') })
      }
    )
  }, [client, t])
  useEffect(load, [load])
  // The state of the trunks: read at once, then again after each answer while shown.
  useRefresh(readStatus, STATUS_POLL_MS, !unavailable, true)

  const set = <K extends keyof TrunkForm>(key: K) => (value: TrunkForm[K]) => setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptyTrunk())
    setProblems({})
    setAtOperator(null)
  }
  // A fallback replaces what the operator's manager set on the lines it does not keep yet, all of them for a first one,
  // those added to the trunk otherwise (second review 10b, n°9): read first, shown, replaced on the administrator's word.
  const replaced = newOperatorLines(form, editing)
  const replacedKey = replaced.join(',')
  const dropped = droppedOperatorLines(form, editing)
  // Only the answer to the last read is shown, of the lines asked last.
  const previewed = useRef(0)
  const readAtOperator = useCallback(
    async (lines: string[]) => {
      const n = ++previewed.current
      if (!lines.length) return setAtOperator(null)
      setReading(true)
      try {
        const read = (await client.readOperatorLines(lines)).items
        if (n === previewed.current) setAtOperator({ key: lines.join(','), items: read })
      } catch (err) {
        if (n !== previewed.current) return
        setAtOperator(null)
        setNote({ kind: 'error', text: say(trunkRefusal(err).problem)! })
      } finally {
        if (n === previewed.current) setReading(false)
      }
    },
    [client, say]
  )
  const preview = atOperator?.key === replacedKey ? atOperator.items : null
  // Read again whenever those lines change (ticked, a line added or taken off), a moment after the typing stops.
  useEffect(() => {
    if (!replacedKey) return
    const timer = setTimeout(() => void readAtOperator(replacedKey.split(',')), PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [replacedKey, readAtOperator])
  // The lines or the fallback changed: the word given for other lines no longer holds.
  const setLines = <K extends 'operatorLines' | 'fallbackManaged'>(key: K) => (value: TrunkForm[K]) =>
    setForm(f => {
      const next = { ...f, [key]: value }
      return newOperatorLines(next, editing).join(',') === newOperatorLines(f, editing).join(',') ? next : { ...next, replaceConfirmed: false }
    })

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkTrunk(form, { ...(editing ? { current: editing } : {}), ids: (trunks ?? []).map(x => x.id) })
    setProblems(checked.problems)
    if (!checked.input) {
      focusLater(TRUNK_FIELDS, checked.problems, 'trunk')
      return
    }
    setBusy(true)
    try {
      const saved = await client.setTrunk(form.id.trim(), checked.input)
      // A line it no longer names whose fallback the operator did not remove yet is said so (third review 10b, n°11).
      setNote(
        saved.pending?.length
          ? { kind: 'error', text: t('admin.trunk.savedPending', { id: saved.id, lines: saved.pending.map(r => r.line).join(', ') }) }
          : { kind: 'ok', text: t('admin.trunk.saved', { id: saved.id }) }
      )
      reset()
      load()
      void readStatus()
    } catch (err) {
      const refusal = trunkRefusal(err)
      // Gone meanwhile (another administrator removed it): the list shown is read again.
      if (refusalStatus(err) === 404) load()
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(TRUNK_FIELDS, next, 'trunk')
      }
    } finally {
      setBusy(false)
    }
  }

  const syncOperator = async () => {
    setOperatorNote(null)
    setSyncing(true)
    try {
      ++asked.current
      setOperator(await client.syncOperator())
      setOperatorNote({ kind: 'ok', text: t('admin.operator.synced') })
    } catch (err) {
      // Not read (OPERATOR_ROUND, second review 10b, n°6), or a moment ago already: what is shown is the last round's.
      setOperatorNote({ kind: 'error', text: say(trunkRefusal(err).problem)! })
      void readStatus()
    } finally {
      setSyncing(false)
    }
  }

  const edit = (trunk: Trunk) => {
    setNote(null)
    setProblems({})
    setAtOperator(null)
    setEditing(trunk)
    setForm(trunkForm(trunk))
    // The form is below the list: the focus goes to its first field the administrator can change.
    setTimeout(() => document.getElementById('trunk-name')?.focus(), 0)
  }

  const remove = async (trunk: Trunk) => {
    setNote(null)
    setBusy(true)
    try {
      const pending = await client.deleteTrunk(trunk.id)
      // The row goes, its buttons with it: the focus goes to what is said. A forward the operator did not remove yet
      // is said so (second review 10b, n°1), never as removed.
      setNote(
        pending.length
          ? { kind: 'error', text: t('admin.trunk.deletedPending', { id: trunk.id, lines: pending.map(r => r.line).join(', ') }), focus: true }
          : { kind: 'ok', text: t('admin.trunk.deleted', { id: trunk.id }), focus: true }
      )
      if (editing?.id === trunk.id) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(trunkRefusal(err).problem)!, focus: true })
    } finally {
      setBusy(false)
      load()
      void readStatus()
    }
  }

  // The fallback no longer kept, and its forwards removed at the operator, on the administrator's word (review 10b, n°13).
  const removeFallback = async (trunk: Trunk) => {
    setNote(null)
    setBusy(true)
    try {
      const { pending } = await client.removeOperatorFallback(trunk.id)
      setNote(
        pending.length
          ? { kind: 'error', text: t('admin.operator.removedPending', { id: trunk.id, lines: pending.map(r => r.line).join(', ') }), focus: true }
          : { kind: 'ok', text: t('admin.operator.removed', { id: trunk.id }), focus: true }
      )
      if (editing?.id === trunk.id) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(trunkRefusal(err).problem)!, focus: true })
    } finally {
      setBusy(false)
      load()
      void readStatus()
    }
  }

  // A removal at the operator let go on the administrator's word (third review 10b, n°4).
  const abandon = async (line: string) => {
    setOperatorNote(null)
    setSyncing(true)
    try {
      await client.abandonOperatorRemoval(line)
      setOperatorNote({ kind: 'ok', text: t('admin.operator.abandoned', { line }), focus: true })
    } catch (err) {
      setOperatorNote({ kind: 'error', text: say(trunkRefusal(err).problem)!, focus: true })
    } finally {
      setSyncing(false)
      void readStatus()
    }
  }

  if (unavailable)
    return (
      <Section id="trunks" title={t('admin.nav.trunks')}>
        <p className="alert">{t('admin.trunk.unavailable')}</p>
      </Section>
    )

  const field = (key: TrunkField) => say(problems[key])
  const def = defaultOf(trunks ?? [])
  const isCurrentDefault = !!editing && def?.id === editing.id
  const count = Object.keys(problems).length
  const classLabel = (c: string) => t(`admin.class.${c}` as Key)
  /**
   * Whether there is something of the trunk to remove at the operator (second review 10b, n°8): the fallback it asks,
   * a forward its lines were last read with (one left there once unticked), or a removal of them not done yet.
   */
  const removable = (trunk: Trunk) => {
    if (!operator?.configured || !trunk.operator?.lines.length) return false
    if (trunk.operator.fallback) return true
    const lines = operator.trunks?.find(o => o.id === trunk.id)?.lines ?? []
    return lines.some(l => !!l.forwards?.onUnavailable || !!l.forwards?.onNoAnswer) || !!operator.removals?.some(r => trunk.operator!.lines.includes(r.line))
  }
  /** What removing the fallback of the trunk puts back on its lines, or that it cannot (third review 10b, n°8). */
  const restoring = (trunk: Trunk) =>
    (operator?.trunks?.find(o => o.id === trunk.id)?.lines ?? [])
      .filter(l => l.managed)
      .map(l => restoreOf(l.line, l.original, t))
      .filter(s => !!s)
      .join(' ')
  return (
    <>
      <Section id="trunks" title={t('admin.nav.trunks')}>
        <p>{t('admin.trunk.help')}</p>
        {trunks === null ? null : trunks.length ? (
          <ul className="list admin-list" aria-label={t('admin.trunk.list')}>
            {trunks.map(trunk => (
              <li key={trunk.id}>
                <div>
                  <h3>
                    {trunk.name ? `${trunk.name} (${trunk.id})` : trunk.id}
                    {def?.id === trunk.id ? <span className="badge"> · {t('admin.trunk.isDefault')}</span> : null}
                  </h3>
                  <dl className="facts facts-compact">
                    <div>
                      <dt>{t('admin.trunk.auth')}</dt>
                      <dd>{t(trunk.auth === 'register' ? 'admin.trunk.authRegister' : 'admin.trunk.authIp')}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.trunk.domain')}</dt>
                      <dd>{trunk.domain}</dd>
                    </div>
                    {trunk.proxies?.length ? (
                      <div>
                        <dt>{t('admin.trunk.proxies')}</dt>
                        <dd>{trunk.proxies.join(', ')}</dd>
                      </div>
                    ) : null}
                    {trunk.username ? (
                      <div>
                        <dt>{t('admin.trunk.username')}</dt>
                        <dd>{trunk.username}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>{t('admin.trunk.password')}</dt>
                      <dd>{t(trunk.hasPassword ? 'admin.trunk.passwordKept' : 'admin.trunk.passwordNone')}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.trunk.defaultNumber')}</dt>
                      <dd>{trunk.defaultNumber}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.trunk.allowed')}</dt>
                      <dd>
                        {(trunk.allowed ?? []).map(classLabel).join(', ') || t('admin.trunk.allowedDefault')}
                        {trunk.countries?.length ? ` (${trunk.countries.map(c => `+${c}`).join(', ')})` : ''}
                      </dd>
                    </div>
                    {trunk.fallbackTarget ? (
                      <div>
                        <dt>{t('admin.trunk.fallbackTarget')}</dt>
                        <dd>{targetLabel(targets, trunk.fallbackTarget)}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <TrunkState status={status.items.find(s => s.id === trunk.id)} available={status.available} />
                  {operator?.trunks?.find(o => o.id === trunk.id)?.lines.length ? <OperatorLines lines={operator.trunks.find(o => o.id === trunk.id)!.lines} /> : null}
                </div>
                <div className="actions actions-end">
                  <button type="button" className="btn" onClick={() => edit(trunk)} disabled={busy} aria-label={t('admin.trunk.edit', { id: trunk.id })}>
                    {t('admin.edit')}
                  </button>
                  {removable(trunk) ? (
                    <ConfirmDelete
                      label={t('admin.operator.removeOf', { id: trunk.id })}
                      question={[t(trunk.operator?.fallback ? 'admin.operator.removeConfirm' : 'admin.operator.removeConfirmSet', { id: trunk.id }), trunk.operator?.fallback ? restoring(trunk) : ''].filter(s => !!s).join(' ')}
                      action="admin.operator.remove"
                      yes="admin.operator.removeYes"
                      tone="plain"
                      onConfirm={() => void removeFallback(trunk)}
                      disabled={busy}
                    />
                  ) : null}
                  <ConfirmDelete
                    label={t('admin.trunk.delete', { id: trunk.id })}
                    question={[t(operator?.configured && trunk.operator?.fallback ? 'admin.trunk.deleteConfirmOperator' : 'admin.trunk.deleteConfirm', { id: trunk.id }), operator?.configured && trunk.operator?.fallback ? restoring(trunk) : ''].filter(s => !!s).join(' ')}
                    onConfirm={() => void remove(trunk)}
                    disabled={busy}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('admin.trunk.none')}</p>
        )}
        <p>
          <button type="button" className="btn" onClick={() => void readStatus()}>
            {t('admin.trunk.refresh')}
          </button>
        </p>
      </Section>
      <Section id="trunk-form" title={editing ? t('admin.trunk.edit', { id: editing.id }) : t('admin.trunk.new')}>
        <form onSubmit={e => void save(e)} noValidate aria-labelledby="trunk-form">
          <ProblemSummary count={count} />
          <TextField id="trunk-id" label={t('admin.trunk.id')} hint={t('admin.slugHint')} value={form.id} onChange={set('id')} error={field('id')} required disabled={busy || !!editing} maxLength={32} />
          <TextField id="trunk-name" label={t('admin.trunk.name')} value={form.name} onChange={set('name')} error={field('name')} disabled={busy} maxLength={64} />
          <fieldset className="field">
            <legend>{t('admin.trunk.auth')}</legend>
            {(['register', 'ip'] as const).map(a => (
              <label key={a} className="check">
                <input type="radio" name="trunk-auth" value={a} checked={form.auth === a} onChange={() => set('auth')(a)} disabled={busy} /> {t(a === 'register' ? 'admin.trunk.authRegister' : 'admin.trunk.authIp')}
              </label>
            ))}
          </fieldset>
          <TextField id="trunk-domain" label={t('admin.trunk.domain')} hint={t('admin.trunk.domainHint')} value={form.domain} onChange={set('domain')} error={field('domain')} required disabled={busy} maxLength={253} />
          <TextField id="trunk-proxies" label={t('admin.trunk.proxies')} hint={t('admin.trunk.proxiesHint')} value={form.proxies} onChange={set('proxies')} error={field('proxies')} disabled={busy} />
          <TextField id="trunk-sources" label={t('admin.trunk.sources')} hint={t('admin.trunk.sourcesHint')} value={form.sources} onChange={set('sources')} error={field('sources')} disabled={busy} />
          <TextField id="trunk-username" label={t('admin.trunk.username')} value={form.username} onChange={set('username')} error={field('username')} required={form.auth === 'register'} disabled={busy} maxLength={64} />
          <TextField
            id="trunk-password"
            type="password"
            autoComplete="new-password"
            label={t('admin.trunk.password')}
            hint={t(editing?.hasPassword ? 'admin.trunk.passwordKeepHint' : 'admin.trunk.passwordHint')}
            value={form.password}
            onChange={set('password')}
            error={field('password')}
            disabled={busy || form.removePassword}
            maxLength={64}
          />
          {editing?.hasPassword ? <CheckBox id="trunk-remove-password" label={t('admin.trunk.removePassword')} checked={form.removePassword} onChange={v => setForm(f => ({ ...f, removePassword: v, ...(v ? { password: '' } : {}) }))} disabled={busy} /> : null}
          <TextField id="trunk-realm" label={t('admin.trunk.realm')} hint={t('admin.trunk.realmHint')} value={form.realm} onChange={set('realm')} error={field('realm')} disabled={busy} maxLength={128} />
          <TextField id="trunk-registrar" label={t('admin.trunk.registrar')} hint={t('admin.trunk.registrarHint')} value={form.registrar} onChange={set('registrar')} error={field('registrar')} disabled={busy || form.auth !== 'register'} />
          <TextField id="trunk-registerExpires" label={t('admin.trunk.registerExpires')} hint={t('admin.trunk.registerExpiresHint')} inputMode="numeric" value={form.registerExpires} onChange={set('registerExpires')} error={field('registerExpires')} disabled={busy || form.auth !== 'register'} maxLength={4} />
          <CheckGroup id="trunk-codecs" legend={t('admin.trunk.codecs')} hint={t('admin.trunk.codecsHint')} values={TRUNK_CODECS} chosen={form.codecs} label={c => c} onChange={set('codecs')} error={field('codecs')} disabled={busy} />
          <SelectField id="trunk-numberFormat" label={t('admin.trunk.numberFormat')} value={form.numberFormat} onChange={v => set('numberFormat')(v as TrunkNumberFormat)} options={FORMATS.map(f => ({ value: f, label: t(`admin.trunk.format.${f}` as Key) }))} disabled={busy} />
          <CheckBox id="trunk-assertIdentity" label={t('admin.trunk.assertIdentity')} checked={form.assertIdentity} onChange={set('assertIdentity')} disabled={busy} />
          <TextField id="trunk-defaultNumber" label={t('admin.trunk.defaultNumber')} hint={t('admin.trunk.defaultNumberHint')} type="tel" inputMode="tel" value={form.defaultNumber} onChange={set('defaultNumber')} error={field('defaultNumber')} required disabled={busy} maxLength={24} />
          <CheckGroup id="trunk-allowed" legend={t('admin.trunk.allowed')} hint={t('admin.trunk.allowedHint')} values={TRUNK_OUTBOUND_CLASSES} chosen={form.allowed} label={classLabel} onChange={set('allowed')} error={field('allowed')} disabled={busy} />
          <TextField id="trunk-countries" label={t('admin.trunk.countries')} hint={t('admin.trunk.countriesHint')} inputMode="numeric" value={form.countries} onChange={set('countries')} error={field('countries')} disabled={busy} />
          <CheckBox
            id="trunk-default"
            label={t('admin.trunk.default')}
            hint={t(isCurrentDefault ? 'admin.trunk.defaultCurrentHint' : 'admin.trunk.defaultHint')}
            checked={form.isDefault || isCurrentDefault}
            onChange={set('isDefault')}
            disabled={busy || isCurrentDefault}
          />
          <TextField id="trunk-fallbackTarget" label={t('admin.trunk.fallbackTarget')} hint={t('admin.trunk.fallbackTargetHint')} inputMode="numeric" value={form.fallbackTarget} onChange={set('fallbackTarget')} error={field('fallbackTarget')} disabled={busy} maxLength={6} list="trunk-targets" />
          <TargetList id="trunk-targets" targets={targets} />
          <fieldset className="field">
            <legend>{t('admin.trunk.operator')}</legend>
            <TextField id="trunk-operatorLines" label={t('admin.trunk.operatorLines')} hint={t('admin.trunk.operatorLinesHint')} value={form.operatorLines} onChange={setLines('operatorLines')} error={field('operatorLines')} disabled={busy} />
            <CheckBox
              id="trunk-fallbackManaged"
              label={t('admin.trunk.fallbackManaged')}
              hint={t(operator?.configured ? 'admin.trunk.fallbackManagedHint' : 'admin.trunk.fallbackManagedNone')}
              checked={form.fallbackManaged}
              onChange={setLines('fallbackManaged')}
              // Without an operator the Gateway refuses it; one kept from before can still be let go.
              disabled={busy || (!operator?.configured && !form.fallbackManaged)}
            />
            {dropped.length ? <p className="badge">{t('admin.trunk.operatorDropped', { lines: dropped.join(', ') })}</p> : null}
            {editing?.operator?.fallback && !form.fallbackManaged && !dropped.length ? <p className="badge">{t('admin.trunk.fallbackLeft', { lines: editing.operator.lines.join(', ') })}</p> : null}
            {replaced.length ? (
              <div className="field">
                <p>{t(editing?.operator?.fallback ? 'admin.trunk.operatorNowNew' : 'admin.trunk.operatorNow')}</p>
                {/* Announced once read (n°17). */}
                <div role="status">
                  {preview ? (
                    <ul className="plain" aria-label={t('admin.trunk.operatorNow')}>
                      {preview.map(l => (
                        <li key={l.line} className={l.error ? 'state state-error' : undefined}>
                          {t('admin.operator.line', { line: l.line, forwards: l.error ? t(`admin.operator.err.${l.error}` as Key) : forwardsOf(l.forwards, t) })}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <button type="button" className="btn" onClick={() => void readAtOperator(replaced)} disabled={busy || reading} aria-busy={reading}>
                  {t('admin.trunk.readOperator')}
                </button>
                <CheckBox id="trunk-replaceConfirmed" label={t('admin.trunk.replaceConfirmed')} hint={t('admin.trunk.replaceHint')} checked={form.replaceConfirmed} onChange={set('replaceConfirmed')} error={field('replaceConfirmed')} disabled={busy} />
              </div>
            ) : null}
            {form.fallbackManaged ? (
              <>
                <TextField id="trunk-operatorNumber" label={t('admin.trunk.operatorNumber')} hint={t('admin.trunk.operatorNumberHint')} type="tel" inputMode="tel" value={form.operatorNumber} onChange={set('operatorNumber')} error={field('operatorNumber')} disabled={busy} maxLength={24} />
                <CheckBox id="trunk-onUnavailable" label={t('admin.trunk.onUnavailable')} hint={t('admin.trunk.onUnavailableHint')} checked={form.onUnavailable} onChange={set('onUnavailable')} disabled={busy} />
                <CheckBox id="trunk-onNoAnswer" label={t('admin.trunk.onNoAnswer')} checked={form.onNoAnswer} onChange={set('onNoAnswer')} disabled={busy} />
                <TextField id="trunk-noAnswerAfterSec" label={t('admin.trunk.noAnswerAfterSec')} hint={t('admin.trunk.noAnswerAfterSecHint')} inputMode="numeric" value={form.noAnswerAfterSec} onChange={set('noAnswerAfterSec')} error={field('noAnswerAfterSec')} disabled={busy || !form.onNoAnswer} maxLength={3} />
              </>
            ) : null}
          </fieldset>
          <div className="actions actions-start">
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
              {t('admin.trunk.save')}
            </button>
            {editing ? (
              <button type="button" className="btn" onClick={reset} disabled={busy}>
                {t('admin.cancel')}
              </button>
            ) : null}
          </div>
        </form>
        <NoteLine note={note} />
      </Section>
      {operator?.configured ? (
        <Section id="operator" title={t('admin.operator.title')}>
          <OperatorRecords status={operator} onSync={() => void syncOperator()} onAbandon={line => void abandon(line)} busy={syncing} />
          <NoteLine note={operatorNote} />
        </Section>
      ) : null}
    </>
  )
}
