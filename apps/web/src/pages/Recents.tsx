import { Alert, List, ListItem, Typography } from '@linagora/twake-mui'
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

  const heading = (
    <Typography variant="h4" component="h1" gutterBottom>
      {t('recents.title')}
    </Typography>
  )
  if (error) return <>{heading}<Alert severity="error" role="alert">{t('recents.error')}</Alert></>
  if (!items) return heading
  const when = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <>
      {heading}
      {items.length === 0 ? (
        <Typography component="p">{t('recents.empty')}</Typography>
      ) : (
        <List data-testid="recents">
          {items.map(it => (
            <ListItem key={it.id} divider className="u-flex-justify-between">
              <span>
                {/* One's own conference: the room called oneself in it (its number is one's own). */}
                <Typography component="strong" className="u-fw-bold">{it.conference && it.remoteNumber === me?.extension ? t('recents.conferenceMine') : it.remoteNumber === 'anonymous' ? t('call.hiddenNumber') : formatNumber(it.remoteNumber)}</Typography>
                <br />
                <Typography data-testid="recent-label" variant="body2" component="span" color={it.missed ? 'error' : 'textSecondary'} className={it.missed ? 'u-fw-bold' : undefined}>{recentLabel(it, t)}</Typography>
                {/* Step 10b: a call the operator recorded, reconciled with ours, or that reached only it (the platform out). */}
                {it.sources?.includes('opensips') === false ? <Typography variant="body2" color="textSecondary" component="span"> · {t('recents.operatorOnly')}</Typography> : it.sources && it.sources.length > 1 ? <Typography variant="body2" color="textSecondary" component="span"> · {t('recents.reconciled')}</Typography> : null}
                {/* Forwarded there to the fallback number (second review 10b, n°4): missed here, taken there perhaps. */}
                {it.forwardedToFallback ? <Typography variant="body2" color="textSecondary" component="span"> · {t('recents.forwardedToFallback')}</Typography> : null}
              </span>
              <time dateTime={it.startedAt}>{when.format(new Date(it.startedAt))}</time>
            </ListItem>
          ))}
        </List>
      )}
    </>
  )
}
