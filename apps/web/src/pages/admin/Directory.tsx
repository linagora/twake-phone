import { Alert, Button, Card, CardContent, List, ListItem, Stack, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useState } from 'react'
import type { DirectoryAdmin, SyncReport } from '@twake/telephony-client'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

type T = (key: Key, params?: Record<string, string | number>) => string

const describeInterval = (t: T, ms: number) =>
  ms >= 7_200_000 && ms % 3_600_000 === 0
    ? t('admin.interval.hours', { hours: ms / 3_600_000 })
    : t('admin.interval.minutes', {
        minutes: Math.max(1, Math.round(ms / 60_000))
      })
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
      {report.error ? <Alert severity="error">{t('admin.syncFailed', { reason: report.error })}</Alert> : null}
      <Typography component="dl" className="u-m-0">
        {rows.map(([key, value]) => (
          <Stack key={key} direction="row" spacing={1} useFlexGap>
            <Typography component="dt" color="textSecondary">
              {t(key)}
            </Typography>
            <Typography component="dd" className="u-m-0">
              {value}
            </Typography>
          </Stack>
        ))}
        <Stack direction="row" spacing={1} useFlexGap>
          <Typography component="dt" color="textSecondary">
            {t('admin.reportConflicts')}
          </Typography>
          <Typography component="dd" className="u-m-0">
            {report.conflicts.length}
          </Typography>
        </Stack>
      </Typography>
      {report.conflicts.length ? (
        <List>
          {report.conflicts.map(c => (
            <ListItem key={`${c.userId}:${c.extension}`} divider>
              {t(c.reserved ? 'admin.conflictReserved' : c.invalid ? 'admin.conflictInvalid' : c.group ? 'admin.conflictGroup' : 'admin.conflict', {
                userId: c.userId,
                extension: c.extension,
                heldBy: c.heldBy
              })}
            </ListItem>
          ))}
        </List>
      ) : null}
    </>
  )
}

/** The directory source and its synchronisation into the extensions. Administrators only (Admin); the Gateway decides who. */
export const Accounts = () => {
  const { t, lang } = useT()
  const { client, me, refreshMe } = useGateway()
  const admin = me?.features?.admin === true
  const [data, setData] = useState<DirectoryAdmin | null>(null)
  const [error, setError] = useState<{
    status?: string
    reason: string
  } | null>(null)
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
      .catch((err: unknown) =>
        setError({
          status: gatewayStatus(err),
          reason: err instanceof Error ? err.message : String(err)
        })
      )
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
      setOutcome({
        ok: false,
        reason: gatewayStatus(err) === '409' ? 'admin.syncBusy' : 'admin.syncFailed',
        detail: err instanceof Error ? err.message : String(err)
      })
      load()
    }
  }

  const source = data?.source
  const attributes = Object.entries(source?.attributes ?? {})
  const last = data?.sync.last
  const formatDate = (iso: string) => new Date(iso).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB')
  return (
    <>
      {error ? (
        <Alert severity="error" role="alert">
          {error.status === '501' ? t('admin.noDirectory') : t('admin.error', { reason: error.reason })}
        </Alert>
      ) : null}
      {source ? (
        <Card component="section" variant="outlined" aria-labelledby="source" className="u-mb-1">
          <CardContent>
            <Typography variant="h5" component="h2" id="source" gutterBottom>
              {t('admin.source')}
            </Typography>
            <Typography component="dl" className="u-m-0">
              <Stack direction="row" spacing={1} useFlexGap>
                <Typography component="dt" color="textSecondary">
                  {t('admin.sourceType')}
                </Typography>
                <Typography component="dd" className="u-m-0">
                  {source.type.toUpperCase()}
                </Typography>
              </Stack>
              {source.url ? (
                <Stack direction="row" spacing={1} useFlexGap>
                  <Typography component="dt" color="textSecondary">
                    {t('admin.sourceUrl')}
                  </Typography>
                  <Typography component="dd" className="u-m-0">
                    <code>{source.url}</code>
                  </Typography>
                </Stack>
              ) : null}
              {source.tenantId ? (
                <Stack direction="row" spacing={1} useFlexGap>
                  <Typography component="dt" color="textSecondary">
                    {t('admin.sourceTenant')}
                  </Typography>
                  <Typography component="dd" className="u-m-0">
                    {source.tenantId}
                  </Typography>
                </Stack>
              ) : null}
              {source.baseDn ? (
                <Stack direction="row" spacing={1} useFlexGap>
                  <Typography component="dt" color="textSecondary">
                    {t('admin.sourceBase')}
                  </Typography>
                  <Typography component="dd" className="u-m-0">
                    <code>{source.baseDn}</code>
                  </Typography>
                </Stack>
              ) : null}
              {source.userFilter ? (
                <Stack direction="row" spacing={1} useFlexGap>
                  <Typography component="dt" color="textSecondary">
                    {t('admin.sourceFilter')}
                  </Typography>
                  <Typography component="dd" className="u-m-0">
                    <code>{source.userFilter}</code>
                  </Typography>
                </Stack>
              ) : null}
            </Typography>
            {attributes.length ? (
              <>
                <Typography variant="h6" component="h3">
                  {t('admin.sourceAttributes')}
                </Typography>
                <Typography component="dl" className="u-m-0">
                  {attributes.map(([name, attr]) => (
                    <Stack key={name} direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {name}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {attr ? (
                          <code>{attr}</code>
                        ) : (
                          <Typography component="span" variant="body2" color="textSecondary">
                            {t('admin.sourceAttributeNone')}
                          </Typography>
                        )}
                      </Typography>
                    </Stack>
                  ))}
                </Typography>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {data ? (
        <Card component="section" variant="outlined" aria-labelledby="sync" className="u-mb-1">
          <CardContent>
            <Typography variant="h5" component="h2" id="sync" gutterBottom>
              {t('admin.sync')}
            </Typography>
            <Typography component="p" gutterBottom>
              {t('admin.syncHelp')}
            </Typography>
            {data.sync.available ? (
              <>
                <Typography component="p" gutterBottom>
                  {data.sync.intervalMs
                    ? t('admin.syncSchedule', {
                        interval: describeInterval(t, data.sync.intervalMs)
                      })
                    : t('admin.syncNoSchedule')}
                </Typography>
                <Typography component="p" gutterBottom>
                  {last
                    ? t('admin.syncLast', {
                        date: formatDate(last.finishedAt),
                        duration: describeDuration(t, last.durationMs)
                      })
                    : t('admin.syncNever')}
                </Typography>
                <Button onClick={() => void sync()} disabled={running} aria-busy={running}>
                  {t('admin.syncNow')}
                </Button>
                <Typography component="div" role="status" className="u-mt-1 u-mb-1">
                  {running ? t('admin.syncRunning') : outcome ? (outcome.ok ? t('admin.syncDone') : t(outcome.reason, { reason: outcome.detail })) : ''}
                </Typography>
                {last ? <Report report={last} /> : null}
              </>
            ) : (
              <Alert severity="info">{t('admin.syncUnavailable')}</Alert>
            )}
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
