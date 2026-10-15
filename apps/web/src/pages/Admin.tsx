import { useCallback, useEffect, useState } from 'react'
import type { DirectoryAdmin, SyncReport } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { RingGroups } from './RingGroups.js'

type T = (key: Key, params?: Record<string, string | number>) => string

const describeInterval = (t: T, ms: number) => (ms >= 7_200_000 && ms % 3_600_000 === 0 ? t('admin.interval.hours', { hours: ms / 3_600_000 }) : t('admin.interval.minutes', { minutes: Math.max(1, Math.round(ms / 60_000)) }))
const describeDuration = (t: T, ms: number) => (ms < 1000 ? t('admin.duration.ms', { ms }) : t('admin.duration.seconds', { seconds: Math.round(ms / 1000) }))
/** While a run is in progress, the status is read again this often. */
const POLL_MS = 1500

const gatewayStatus = (err: unknown) => (err instanceof Error ? /Gateway (\d{3}) /.exec(err.message)?.[1] : undefined)

const Report = ({ report }: { report: SyncReport }) => {
  const { t } = useT()
  const rows: [Key, number][] = [
    ['admin.reportSeen', report.seen],
    ['admin.reportWithExtension', report.withExtension],
    ['admin.reportCreated', report.created],
    ['admin.reportUpdated', report.updated],
    ['admin.reportUnchanged', report.unchanged],
    ['admin.reportRemoved', report.removed]
  ]
  return (
    <>
      {report.error ? <p className="alert alert-error">{t('admin.syncFailed', { reason: report.error })}</p> : null}
      <dl className="facts">
        {rows.map(([key, value]) => (
          <div key={key}>
            <dt>{t(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>{t('admin.reportConflicts')}</dt>
          <dd>{report.conflicts.length}</dd>
        </div>
      </dl>
      {report.conflicts.length ? (
        <ul className="list">
          {report.conflicts.map(c => (
            <li key={`${c.userId}:${c.extension}`}>{t(c.group ? 'admin.conflictGroup' : 'admin.conflict', { userId: c.userId, extension: c.extension, heldBy: c.heldBy })}</li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/** The directory source and its synchronisation into the extensions, and the ring groups. Administrators only; the Gateway decides who. */
export const Admin = () => {
  const { t, lang } = useT()
  const { client, me, meError, refreshMe } = useGateway()
  const admin = me?.features?.admin === true
  const [data, setData] = useState<DirectoryAdmin | null>(null)
  const [error, setError] = useState<{ status?: string; reason: string } | null>(null)
  // The run this screen started: its outcome is announced once it is over.
  const [started, setStarted] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: true } | { ok: false; reason: Key; detail: string } | null>(null)
  const running = data?.sync.running === true

  const load = useCallback(() => {
    if (!admin) return
    client
      .getDirectoryAdmin()
      .then(d => {
        setData(d)
        setError(null)
      })
      .catch((err: unknown) => setError({ status: gatewayStatus(err), reason: err instanceof Error ? err.message : String(err) }))
  }, [admin, client])
  useEffect(load, [load])
  // A run in progress (this screen's, another administrator's, or the scheduled one) is followed until it ends.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [running, load])
  useEffect(() => {
    if (!started || running) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the run this screen started has ended: its outcome shows once
    setStarted(false)
    setOutcome({ ok: true })
    // The administrator may be among the synchronised accounts: their own extension in the header follows.
    refreshMe()
  }, [started, running, refreshMe])

  const sync = async () => {
    setOutcome(null)
    try {
      const status = await client.syncDirectory()
      setStarted(true)
      setData(d => (d ? { ...d, sync: status } : d))
    } catch (err) {
      setOutcome({ ok: false, reason: gatewayStatus(err) === '409' ? 'admin.syncBusy' : 'admin.syncFailed', detail: err instanceof Error ? err.message : String(err) })
      load()
    }
  }

  if (!me) {
    return (
      <>
        <h1>{t('admin.title')}</h1>
        {meError ? <p className="alert alert-error" role="alert">{t('admin.error', { reason: meError })}</p> : <p role="status">{t('admin.loading')}</p>}
      </>
    )
  }
  if (!admin) {
    return (
      <>
        <h1>{t('admin.title')}</h1>
        <p className="alert" role="alert">{t('admin.forbidden')}</p>
      </>
    )
  }
  const source = data?.source
  const attributes = Object.entries(source?.attributes ?? {})
  const last = data?.sync.last
  const formatDate = (iso: string) => new Date(iso).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB')
  return (
    <>
      <h1>{t('admin.title')}</h1>
      {error ? <p className="alert alert-error" role="alert">{error.status === '501' ? t('admin.noDirectory') : t('admin.error', { reason: error.reason })}</p> : null}
      {source ? (
        <section className="card" aria-labelledby="source">
          <h2 id="source">{t('admin.source')}</h2>
          <dl className="facts">
            <div>
              <dt>{t('admin.sourceType')}</dt>
              <dd>{source.type.toUpperCase()}</dd>
            </div>
            {source.url ? (
              <div>
                <dt>{t('admin.sourceUrl')}</dt>
                <dd>
                  <code>{source.url}</code>
                </dd>
              </div>
            ) : null}
            {source.tenantId ? (
              <div>
                <dt>{t('admin.sourceTenant')}</dt>
                <dd>{source.tenantId}</dd>
              </div>
            ) : null}
            {source.baseDn ? (
              <div>
                <dt>{t('admin.sourceBase')}</dt>
                <dd>
                  <code>{source.baseDn}</code>
                </dd>
              </div>
            ) : null}
            {source.userFilter ? (
              <div>
                <dt>{t('admin.sourceFilter')}</dt>
                <dd>
                  <code>{source.userFilter}</code>
                </dd>
              </div>
            ) : null}
          </dl>
          {attributes.length ? (
            <>
              <h3>{t('admin.sourceAttributes')}</h3>
              <dl className="facts facts-compact">
                {attributes.map(([name, attr]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{attr ? <code>{attr}</code> : <span className="muted">{t('admin.sourceAttributeNone')}</span>}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
        </section>
      ) : null}
      {data ? (
        <section className="card" aria-labelledby="sync">
          <h2 id="sync">{t('admin.sync')}</h2>
          <p>{t('admin.syncHelp')}</p>
          {data.sync.available ? (
            <>
              <p>{data.sync.intervalMs ? t('admin.syncSchedule', { interval: describeInterval(t, data.sync.intervalMs) }) : t('admin.syncNoSchedule')}</p>
              <p>{last ? t('admin.syncLast', { date: formatDate(last.finishedAt), duration: describeDuration(t, last.durationMs) }) : t('admin.syncNever')}</p>
              <p>
                <button type="button" className="btn btn-primary" onClick={() => void sync()} disabled={running} aria-busy={running}>
                  {t('admin.syncNow')}
                </button>
              </p>
              <div role="status">{running ? t('admin.syncRunning') : outcome ? (outcome.ok ? t('admin.syncDone') : t(outcome.reason, { reason: outcome.detail })) : ''}</div>
              {last ? <Report report={last} /> : null}
            </>
          ) : (
            <p className="alert">{t('admin.syncUnavailable')}</p>
          )}
        </section>
      ) : null}
      <RingGroups />
    </>
  )
}
