import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { FRAUD_PARAMS, OUTBOUND_CAPS, TRUNK_OUTBOUND_CLASSES, type AdminAlert, type AdminUser, type AlertFilter } from '@twake/telephony-client'
import { CheckBox, NoteLine, Section, SelectField, useLatest, useProblem, useRefresh, type Note } from '../../admin/ui.js'
import { refusalCode, refusalOf, refusalStatus } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

const KINDS: NonNullable<AlertFilter['kind']>[] = ['fraud-warning', 'fraud-critical', 'limit', 'rights', 'emergency', 'meet']
const PARAMS = [...FRAUD_PARAMS, ...OUTBOUND_CAPS, ...TRUNK_OUTBOUND_CLASSES, 'premium', 'burst', 'pin-tries', 'meet-calls', 'call-diverted', 'trunk-changed']
const PAGE = 25
/** How long after an answer the first page is read again while shown: a repeat counted meanwhile is seen (review 7 n°2). */
export const ALERTS_REFRESH_MS = 30_000
const ALL = ''
/** What the screen shows first: the alerts not yet looked at. */
const INITIAL = { kind: ALL, param: ALL, state: 'open' }

/**
 * What an alert's `param` names, in words: a threshold, a cap, a class of numbers, a burst of emergency calls, the
 * tries of a room's PIN by phone, the calls to the rooms at the same time, or a room's call that did not go where the
 * Gateway sent it (review 8b, n°3: its grant taken by another call, or LiveKit's trunk pointed elsewhere).
 */
const paramKey = (alert: Pick<AdminAlert, 'kind' | 'param'>): Key | undefined => {
  if ((FRAUD_PARAMS as readonly string[]).includes(alert.param)) return `admin.fraud.${alert.param}` as Key
  if ((OUTBOUND_CAPS as readonly string[]).includes(alert.param)) return `admin.cap.${alert.param}` as Key
  if (alert.param === 'burst') return 'admin.alert.burst'
  if (alert.param === 'pin-tries') return 'admin.alert.pinTries'
  if (alert.param === 'meet-calls') return 'admin.alert.meetCalls'
  if (alert.param === 'call-diverted') return 'admin.alert.callDiverted'
  if (alert.param === 'trunk-changed') return 'admin.alert.trunkChanged'
  if ((TRUNK_OUTBOUND_CLASSES as readonly string[]).includes(alert.param) || alert.param === 'premium') return `admin.class.${alert.param}` as Key
  return undefined
}

/**
 * The alerts the SIP server raised (step 7, FR-D6): the latest repeated first, a page at a time, of one kind, one
 * cause or one state if asked; each one acknowledged once looked at (a repeat afterwards opens a new one).
 */
export const Alerts = () => {
  const { t, lang } = useT()
  const say = useProblem()
  const { client } = useGateway()
  const [filter, setFilter] = useState<{ kind: string; param: string; state: string }>(INITIAL)
  const [shown, setShown] = useState(filter)
  const [items, setItems] = useState<AdminAlert[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const firstNew = useRef<HTMLTableRowElement | null>(null)
  // The row to take the focus once shown: given once, when asked (a new page), never again as the rows change
  // (review 7 ter, n°7). An object, so that the same index asked again is asked.
  const [focusAt, setFocusAt] = useState<{ at: number } | null>(null)
  // More than the first page shown: not read again on its own (the rows would move under the reader).
  const [extended, setExtended] = useState(false)
  // Read again on its own unless asked not to (RGAA 13.8, review 7 bis n°5).
  const [auto, setAuto] = useState(true)
  const words = useLatest(say)
  // Each read is numbered: only the answer of the last one asked is shown, a page, a filter or a read of the screen
  // answered late never replaces what was asked after it (review 7 bis, n°4).
  const reads = useRef(0)
  // A read, a page or an acknowledgement asked by the administrator going on: the screen reads nothing on its own.
  const asked = useRef(0)
  // The list and its buttons: while the focus is there, nothing moves under it.
  const list = useRef<HTMLDivElement | null>(null)

  const query = useCallback(
    (f: typeof filter, before?: string): AlertFilter => ({
      limit: PAGE,
      ...(f.kind ? { kind: f.kind as AlertFilter['kind'] } : {}),
      ...(f.param ? { param: f.param } : {}),
      ...(f.state ? { state: f.state as AlertFilter['state'] } : {}),
      ...(before ? { before } : {})
    }),
    []
  )
  // The first page of `f`. It depends on nothing the language changes: a change of language reads nothing again, and
  // never puts back the first filter while the lists show another one (review 7 n°13).
  const read = useCallback(
    (f: typeof filter, onItsOwn = false) => {
      const mine = ++reads.current
      return client.listAlerts(query(f)).then(
        r => {
          if (mine !== reads.current) return
          // Read on its own, and the focus went into the list meanwhile: nothing moves under it (review 7 ter, n°8).
          if (onItsOwn && list.current?.contains(document.activeElement)) return
          setItems(r.items)
          setNext(r.next)
          setShown(f)
          setExtended(false)
        },
        (err: unknown) => {
          if (mine === reads.current) setNote({ kind: 'error', text: words.current(refusalOf(err, () => undefined).problem)! })
        }
      )
    },
    [client, query, words]
  )
  useEffect(() => {
    void read(INITIAL)
  }, [read])
  const again = () => read(shown)
  /** What the administrator asked: the screen reads nothing on its own meanwhile, and its answer comes first. */
  const asking = <T,>(run: () => Promise<T>) => {
    asked.current++
    setBusy(true)
    return run().finally(() => {
      asked.current--
      setBusy(false)
    })
  }
  // On its own: not while something asked goes on, nor while the focus is in the list (a row, its button), which
  // would move or go under it (review 7 bis, n°5).
  const onItsOwn = () => (asked.current > 0 || list.current?.contains(document.activeElement) ? Promise.resolve() : read(shown, true))
  useRefresh(onItsOwn, ALERTS_REFRESH_MS, auto && items !== null && !extended)
  useEffect(() => {
    client.listAdminUsers().then(
      r => setUsers(r.items),
      () => setUsers([])
    )
  }, [client])
  useEffect(() => {
    if (focusAt !== null) firstNew.current?.focus()
  }, [focusAt])

  const apply = (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    void asking(() => read(filter))
  }

  const refresh = () => {
    setNote(null)
    void asking(again)
  }

  const more = () => {
    if (!next || !items) return
    const from = items.length
    const mine = ++reads.current
    void asking(() =>
      client.listAlerts(query(shown, next)).then(
        r => {
          // Another read asked since (a filter, the first page again): this page is not of what is shown.
          if (mine !== reads.current) return
          setItems(list => [...(list ?? []), ...r.items])
          setNext(r.next)
          setExtended(true)
          // The focus goes to the first alert of the new page (the button may disappear with the last one).
          setFocusAt({ at: from })
        },
        (err: unknown) => {
          if (mine === reads.current) setNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)! })
        }
      )
    )
  }

  const acknowledge = (alert: AdminAlert) => {
    setNote(null)
    return asking(() => acknowledging(alert))
  }
  const acknowledging = async (alert: AdminAlert) => {
    // A read of the screen going on was asked before: its answer would put the row back.
    reads.current++
    try {
      // As it was seen, its last time and how many times: refused when it repeated since (the repeat is shown, to be
      // looked at first), even within the same millisecond (review 7 bis, n°3).
      const done = await client.acknowledgeAlert(alert.id, alert.lastAt, alert.count)
      setItems(list => (list ?? []).flatMap(a => (a.id !== alert.id ? [a] : shown.state === 'open' ? [] : [done])))
      // The row may go, its button with it: the focus goes to what is said.
      setNote({ kind: 'ok', text: t('admin.alert.acknowledged'), focus: true })
    } catch (err) {
      const changed = refusalCode(err) === 'ALERT_CHANGED'
      // Gone: removed after its retention (or never this organisation's), not a platform that cannot.
      const gone = refusalStatus(err) === 404
      if (changed || gone) await read(shown)
      setNote({ kind: 'error', text: gone ? t('admin.alert.gone') : say(refusalOf(err, () => undefined).problem)!, focus: true })
    }
  }

  const when = new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'medium' })
  const who = (a: AdminAlert) => {
    if (!a.extension) return a.scope === 'tenant' ? t('admin.alert.tenant') : '—'
    const user = users.find(u => u.extension === a.extension)
    return user ? `${a.extension} (${user.displayName ?? user.userId})` : a.extension
  }
  const byName = (id: string | undefined) => {
    const user = id ? users.find(u => u.userId === id) : undefined
    return user?.displayName ?? id ?? '—'
  }
  const cause = (a: AdminAlert) => {
    const key = paramKey(a)
    const name = key ? t(key) : a.param
    const scope = a.kind === 'limit' && a.scope ? ` (${t(a.scope === 'tenant' ? 'admin.alert.scopeTenant' : 'admin.alert.scopeUser')})` : ''
    const value = a.value !== undefined && a.threshold !== undefined ? ` : ${t('admin.alert.valueOf', { value: a.value, threshold: a.threshold })}` : ''
    return `${name}${scope}${value}`
  }
  const opt = (value: string, label: string) => ({ value, label })
  return (
    <Section id="alerts" title={t('admin.nav.alerts')}>
      <p>{t('admin.alert.help')}</p>
      <form onSubmit={apply} className="filters">
        <SelectField id="alerts-state" label={t('admin.alert.state')} value={filter.state} onChange={v => setFilter(f => ({ ...f, state: v }))} options={[opt('open', t('admin.alert.stateOpen')), opt('acknowledged', t('admin.alert.stateAcknowledged')), opt(ALL, t('admin.alert.all'))]} />
        <SelectField id="alerts-kind" label={t('admin.alert.kind')} value={filter.kind} onChange={v => setFilter(f => ({ ...f, kind: v }))} options={[opt(ALL, t('admin.alert.all')), ...KINDS.map(k => opt(k, t(`admin.alert.kind.${k}` as Key)))]} />
        <SelectField id="alerts-param" label={t('admin.alert.param')} value={filter.param} onChange={v => setFilter(f => ({ ...f, param: v }))} options={[opt(ALL, t('admin.alert.all')), ...PARAMS.map(p => opt(p, t(paramKey({ kind: 'limit', param: p })!)))]} />
        <div className="actions actions-start">
          <button type="submit" className="btn" disabled={busy}>
            {t('admin.alert.filter')}
          </button>
        </div>
      </form>
      {items === null ? null : items.length ? (
        <div className="table-scroll" role="region" tabIndex={0} aria-label={t('admin.alert.list')} ref={list}>
          <table className="admin-table">
            <caption className="sr-only">{t('admin.alert.list')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.alert.when')}</th>
                <th scope="col">{t('admin.alert.kind')}</th>
                <th scope="col">{t('admin.alert.param')}</th>
                <th scope="col">{t('admin.alert.who')}</th>
                <th scope="col">{t('admin.alert.number')}</th>
                <th scope="col">{t('admin.alert.count')}</th>
                <th scope="col">{t('admin.alert.state')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a, i) => (
                <tr key={a.id} ref={i === focusAt?.at ? firstNew : undefined} tabIndex={i === focusAt?.at ? -1 : undefined}>
                  <td>
                    <time dateTime={a.lastAt}>{when.format(new Date(a.lastAt))}</time>
                  </td>
                  <td>
                    <span className={`state state-${a.kind}`}>{t(`admin.alert.kind.${a.kind}` as Key)}</span>
                  </td>
                  <td>{cause(a)}</td>
                  <td>{who(a)}</td>
                  <td>{a.number ?? '—'}</td>
                  <td>{a.count > 1 ? t('admin.alert.repeated', { count: a.count, first: when.format(new Date(a.at)) }) : '1'}</td>
                  <td>
                    {a.acknowledgedAt ? (
                      t('admin.alert.acknowledgedBy', { date: when.format(new Date(a.acknowledgedAt)), by: byName(a.acknowledgedBy) })
                    ) : (
                      <button type="button" className="btn" onClick={() => void acknowledge(a)} disabled={busy} aria-label={t('admin.alert.acknowledgeOf', { cause: cause(a), when: when.format(new Date(a.lastAt)) })}>
                        {t('admin.alert.acknowledge')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{t('admin.alert.none')}</p>
      )}
      <p className="actions actions-start">
        {next ? (
          <button type="button" className="btn" onClick={more} disabled={busy}>
            {t('admin.alert.more')}
          </button>
        ) : null}
        <button type="button" className="btn" onClick={refresh} disabled={busy}>
          {t('admin.alert.refresh')}
        </button>
      </p>
      <CheckBox id="alerts-auto" label={t('admin.alert.auto', { seconds: ALERTS_REFRESH_MS / 1000 })} hint={t('admin.alert.autoHint')} checked={auto} onChange={setAuto} />
      <NoteLine note={note} />
    </Section>
  )
}
