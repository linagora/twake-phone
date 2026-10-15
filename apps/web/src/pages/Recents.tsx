import { useEffect, useState } from 'react'
import { formatNumber, type HistoryItem } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'

/** Missed (the phone rang, nobody took it), declined (the user refused it), or simply in or out. */
const recentLabel = (it: HistoryItem, t: (key: Key) => string) =>
  it.missed ? t('recents.missed') : it.direction === 'inbound' && it.state === 'rejected' ? t('recents.declined') : it.direction === 'inbound' ? t('recents.inbound') : t('recents.outbound')

export const Recents = () => {
  const { t, lang } = useT()
  const { client, onEvent, onConnected } = useGateway()
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [error, setError] = useState(false)
  // Loaded on arrival, again each time one of the user's calls ends (the Gateway records it before telling), and
  // each time the event stream reopens (the ends told while it was closed were not heard).
  const [generation, setGeneration] = useState(0)
  useEffect(() => onEvent(event => (event.type === 'call.ended' || event.type === 'call.failed') && setGeneration(g => g + 1)), [onEvent])
  useEffect(() => onConnected(() => setGeneration(g => g + 1)), [onConnected])

  useEffect(() => {
    let cancelled = false
    client
      .getHistory({ limit: 50 })
      .then(page => {
        if (cancelled) return
        setItems(page.items)
        setError(false)
      })
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [client, generation])

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
                <span className={`badge${it.missed ? ' missed' : ''}`}>{recentLabel(it, t)}</span>
              </span>
              <time dateTime={it.startedAt}>{when.format(new Date(it.startedAt))}</time>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
