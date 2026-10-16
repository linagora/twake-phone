import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { FRAUD_PARAMS, OUTBOUND_CAPS, TRUNK_OUTBOUND_CLASSES, type AdminAlert, type AdminUser, type AlertFilter } from '@twake/telephony-client'
import { NoteLine, Section, SelectField, useProblem, type Note } from '../../admin/ui.js'
import { refusalOf } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

const KINDS: NonNullable<AlertFilter['kind']>[] = ['fraud-warning', 'fraud-critical', 'limit', 'rights', 'emergency']
const PARAMS = [...FRAUD_PARAMS, ...OUTBOUND_CAPS, ...TRUNK_OUTBOUND_CLASSES, 'premium', 'burst']
const PAGE = 25
const ALL = ''
/** What the screen shows first: the alerts not yet looked at. */
const INITIAL = { kind: ALL, param: ALL, state: 'open' }

/** What an alert's `param` names, in words: a threshold, a cap, a class of numbers, or a burst of emergency calls. */
const paramKey = (alert: Pick<AdminAlert, 'kind' | 'param'>): Key | undefined => {
  if ((FRAUD_PARAMS as readonly string[]).includes(alert.param)) return `admin.fraud.${alert.param}` as Key
  if ((OUTBOUND_CAPS as readonly string[]).includes(alert.param)) return `admin.cap.${alert.param}` as Key
  if (alert.param === 'burst') return 'admin.alert.burst'
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
  const [focusAt, setFocusAt] = useState<number | null>(null)

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
  const read = useCallback(
    (f: typeof filter) =>
      client
        .listAlerts(query(f))
        .then(
          r => {
            setItems(r.items)
            setNext(r.next)
            setShown(f)
          },
          (err: unknown) => setNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)! })
        )
        .finally(() => setBusy(false)),
    [client, query, say]
  )
  useEffect(() => void read(INITIAL), [read])
  useEffect(() => {
    client.listAdminUsers().then(
      r => setUsers(r.items),
      () => setUsers([])
    )
  }, [client])
  useEffect(() => {
    if (focusAt !== null) firstNew.current?.focus()
  }, [focusAt, items])

  const apply = (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    setBusy(true)
    void read(filter)
  }

  const more = () => {
    if (!next || !items) return
    setBusy(true)
    const from = items.length
    client
      .listAlerts(query(shown, next))
      .then(
        r => {
          setItems([...items, ...r.items])
          setNext(r.next)
          // The focus goes to the first alert of the new page (the button may disappear with the last one).
          setFocusAt(from)
        },
        (err: unknown) => setNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)! })
      )
      .finally(() => setBusy(false))
  }

  const acknowledge = async (alert: AdminAlert) => {
    setNote(null)
    setBusy(true)
    try {
      const done = await client.acknowledgeAlert(alert.id)
      setItems(list => (list ?? []).flatMap(a => (a.id !== alert.id ? [a] : shown.state === 'open' ? [] : [done])))
      setNote({ kind: 'ok', text: t('admin.alert.acknowledged') })
    } catch (err) {
      setNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)! })
    } finally {
      setBusy(false)
    }
  }

  const when = new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'medium' })
  const who = (a: AdminAlert) => {
    if (!a.extension) return a.scope === 'tenant' ? t('admin.alert.tenant') : '—'
    const user = users.find(u => u.extension === a.extension)
    return user ? `${a.extension} (${user.displayName ?? user.userId})` : a.extension
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
        <div className="table-scroll" role="region" tabIndex={0} aria-label={t('admin.alert.list')}>
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
                <tr key={a.id} ref={i === focusAt ? firstNew : undefined} tabIndex={i === focusAt ? -1 : undefined}>
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
                      t('admin.alert.acknowledgedBy', { date: when.format(new Date(a.acknowledgedAt)), by: a.acknowledgedBy ?? '—' })
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
      {next ? (
        <p>
          <button type="button" className="btn" onClick={more} disabled={busy}>
            {t('admin.alert.more')}
          </button>
        </p>
      ) : null}
      <NoteLine note={note} />
    </Section>
  )
}
