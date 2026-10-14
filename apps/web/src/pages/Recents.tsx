import { useEffect, useState } from 'react'
import { formatNumber, type HistoryItem } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'

export const Recents = () => {
  const { t, lang } = useT()
  const { client } = useGateway()
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    client
      .getHistory({ limit: 50 })
      .then(page => !cancelled && setItems(page.items))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [client])

  if (error) return <><h1>{t('recents.title')}</h1><p className="alert alert-error" role="alert">{t('recents.error')}</p></>
  if (!items) return <h1>{t('recents.title')}</h1>
  const when = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <>
      <h1>{t('recents.title')}</h1>
      {items.length === 0 ? (
        <p>{t('recents.empty')}</p>
      ) : (
        <ul className="list">
          {items.map(it => (
            <li key={it.id}>
              <span>
                <strong>{formatNumber(it.remoteNumber)}</strong>
                <br />
                <span className={`badge${it.missed ? ' missed' : ''}`}>{it.missed ? t('recents.missed') : it.direction === 'inbound' ? t('recents.inbound') : t('recents.outbound')}</span>
              </span>
              <time dateTime={it.startedAt}>{when.format(new Date(it.startedAt))}</time>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
