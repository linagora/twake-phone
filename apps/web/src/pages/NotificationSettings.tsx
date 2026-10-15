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
    <section className="card" aria-labelledby="notifications">
      <h2 id="notifications">{t('settings.notifications')}</h2>
      <p>{t('settings.notificationsHint')}</p>
      <p className={status === 'denied' ? 'alert alert-error' : 'badge'} role="status">
        {t(SAYS[status])}
      </p>
      {status === 'off' || status === 'denied' ? (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void change(true)} disabled={busy} aria-busy={busy}>
            {t('settings.notificationsEnable')}
          </button>
        </div>
      ) : null}
      {status === 'on' ? (
        <div className="actions">
          <button type="button" className="btn" onClick={() => void change(false)} disabled={busy} aria-busy={busy}>
            {t('settings.notificationsDisable')}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {t('settings.notificationsError')}
        </p>
      ) : null}
    </section>
  )
}
