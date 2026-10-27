import { Alert, Button, Card, CardContent, Stack, Typography } from '@linagora/twake-mui'
import { useEffect, useMemo, useState } from 'react'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { browserPush, disablePush, enablePush, pushStatus, type PushStatus } from '../push.js'

const SAYS: Record<PushStatus, Key> = {
  unsupported: 'settings.notificationsUnsupported',
  unavailable: 'settings.notificationsUnavailable',
  denied: 'settings.notificationsDenied',
  off: 'settings.notificationsOff',
  on: 'settings.notificationsOn'
}

/**
 * Notifications of calls while no window of the app is open (Web Push): the browser asks its permission when the
 * person turns them on here, never before. Hidden where the platform does not offer them.
 */
export const NotificationSettings = ({ userId }: { userId: string }) => {
  const { t } = useT()
  const { client } = useGateway()
  const browser = useMemo(() => browserPush(), [])
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    pushStatus(client, browser, userId)
      .then(s => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus('unavailable'))
    return () => {
      cancelled = true
    }
  }, [client, browser, userId])
  if (status === null || status === 'unavailable') return null
  const change = async (on: boolean) => {
    setBusy(true)
    setError(false)
    try {
      setStatus(await (on ? enablePush : disablePush)(client, browser, userId))
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card component="section" variant="outlined" aria-labelledby="notifications" className="u-mb-1">
      <CardContent>
        <Typography variant="h5" component="h2" id="notifications" gutterBottom>
          {t('settings.notifications')}
        </Typography>
        <Typography component="p">{t('settings.notificationsHint')}</Typography>
        {status === 'denied' ? (
          <Alert severity="error" role="status" className="u-mb-1">
            {t(SAYS[status])}
          </Alert>
        ) : (
          <Typography variant="body2" color="textSecondary" component="p" role="status" className="u-mb-1">
            {t(SAYS[status])}
          </Typography>
        )}
        {status === 'off' || status === 'denied' ? (
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
            <Button onClick={() => void change(true)} disabled={busy} aria-busy={busy}>
              {t('settings.notificationsEnable')}
            </Button>
          </Stack>
        ) : null}
        {status === 'on' ? (
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
            <Button variant="outlined" onClick={() => void change(false)} disabled={busy} aria-busy={busy}>
              {t('settings.notificationsDisable')}
            </Button>
          </Stack>
        ) : null}
        {error ? (
          <Alert severity="error" role="alert" className="u-mt-1">
            {t('settings.notificationsError')}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}
