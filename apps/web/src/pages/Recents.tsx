import { useEffect, useState } from 'react'
import { formatNumber, type HistoryItem } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { Reloader } from '../reload.js'

/** How long the history waits for the event stream before it is read without it. */
const WITHOUT_STREAM_MS = 3_000

/**
 * Missed (the phone rang, nobody took it), declined (the user refused it), a conference (step 8b), a call a mailbox
 * took for the caller (step 11a), or simply in or out.
 */
const recentLabel = (it: HistoryItem, t: (key: Key) => string) =>
  it.missed
    ? t('recents.missed')
    : it.voicemail && it.direction === 'outbound'
      ? t('recents.voicemail')
    : it.direction === 'inbound' && it.state === 'rejected'
      ? t('recents.declined')
      : it.conference
        ? t('recents.conference')
        : it.direction === 'inbound'
          ? t('recents.inbound')
          : t('recents.outbound')

export const Recents = () => {
  const { t, lang } = useT()
  const { client, me, onEvent, onConnected } = useGateway()
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [error, setError] = useState(false)
  // Read when the event stream is established (at once when it already is: the ends told while it was closed were
  // not heard), each time one of the user's calls ends (the Gateway records it before telling), and after a few
  // seconds without a stream (the history reads without it). One read at a time; an outage is tried again.
  useEffect(() => {
    const reloader = new Reloader(
      () => client.getHistory({ limit: 50 }),
      page => {
        setItems(page.items)
        setError(false)
      },
      () => setError(true)
    )
    const fallback = setTimeout(() => reloader.request(), WITHOUT_STREAM_MS)
    const stopConnected = onConnected(() => {
      clearTimeout(fallback)
      reloader.request()
    })
    const stopEvents = onEvent(event => {
      if (event.type === 'call.ended' || event.type === 'call.failed') reloader.request()
    })
    return () => {
      clearTimeout(fallback)
      reloader.stop()
      stopConnected()
      stopEvents()
    }
  }, [client, onEvent, onConnected])

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
                {/* One's own conference: the room called oneself in it (its number is one's own). */}
                <strong>{it.conference && it.remoteNumber === me?.extension ? t('recents.conferenceMine') : it.remoteNumber === 'anonymous' ? t('call.hiddenNumber') : formatNumber(it.remoteNumber)}</strong>
                <br />
                <span className={`badge${it.missed ? ' missed' : ''}`}>{recentLabel(it, t)}</span>
                {/* Step 10b: a call the operator recorded, reconciled with ours, or that reached only it (the platform out). */}
                {it.sources?.includes('opensips') === false ? <span className="badge"> · {t('recents.operatorOnly')}</span> : it.sources && it.sources.length > 1 ? <span className="badge"> · {t('recents.reconciled')}</span> : null}
                {/* Forwarded there to the fallback number (second review 10b, n°4): missed here, taken there perhaps. */}
                {it.forwardedToFallback ? <span className="badge"> · {t('recents.forwardedToFallback')}</span> : null}
              </span>
              <time dateTime={it.startedAt}>{when.format(new Date(it.startedAt))}</time>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
