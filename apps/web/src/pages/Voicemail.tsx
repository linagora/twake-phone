import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatNumber, toDialTarget, type Voicemail } from '@twake/telephony-client'
import type { TelephonyEvent } from '@twake/telephony-types'
import { describeCallError } from '../components/callErrors.js'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { Reloader } from '../reload.js'
import { usePhone } from '../softphone.js'

/** How long the mailbox waits for the event stream before it is read without it. */
const WITHOUT_STREAM_MS = 3_000

/** 7 → "0:07", 75 → "1:15". */
export const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec)) % 60).padStart(2, '0')}`

/** The list after an event of the mailbox: a new message first, one read or deleted in place. Ids are unique. */
export const applyVoicemailEvent = (items: Voicemail[], event: TelephonyEvent): Voicemail[] => {
  if (event.type === 'voicemail.created') {
    const v = event.payload.voicemail
    return [v, ...items.filter(i => i.id !== v.id)].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  }
  if (event.type === 'voicemail.updated') return items.map(i => (i.id === event.payload.voicemail.id ? event.payload.voicemail : i))
  if (event.type === 'voicemail.deleted') return items.filter(i => i.id !== event.payload.id)
  return items
}

/**
 * The person's mailbox (step 11a): the messages left when they could not answer, newest first, as they arrive. Each is
 * listened to in the page, marked as read, deleted, or its caller called back.
 */
export const VoicemailPage = () => {
  const { t, lang } = useT()
  const { client, onEvent, onConnected } = useGateway()
  const phone = usePhone()
  const navigate = useNavigate()
  const [items, setItems] = useState<Voicemail[] | null>(null)
  const [error, setError] = useState<'load' | 'unavailable' | null>(null)
  /** What an action said (a recording that would not load, the server down a moment). */
  const [notice, setNotice] = useState<string | null>(null)
  /** Said to assistive tech as a message arrives (the list changes without the page being reloaded). */
  const [arrived, setArrived] = useState('')
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null)
  const urls = useRef<string[]>([])

  /** Who left a message: their name and number, the number alone, or that they hid it. */
  const whoOf = useCallback((v: Voicemail) => (v.fromName ? (v.from ? `${v.fromName} (${formatNumber(v.from)})` : v.fromName) : v.from ? formatNumber(v.from) : t('call.hiddenNumber')), [t])

  useEffect(() => {
    const reloader = new Reloader(
      () => client.listVoicemails(),
      page => {
        setItems(page.items)
        setError(null)
      },
      err => setError((err as { status?: number }).status === 501 ? 'unavailable' : 'load')
    )
    const fallback = setTimeout(() => reloader.request(), WITHOUT_STREAM_MS)
    const stopConnected = onConnected(() => {
      clearTimeout(fallback)
      reloader.request()
    })
    const stopEvents = onEvent(event => {
      if (event.type !== 'voicemail.created' && event.type !== 'voicemail.updated' && event.type !== 'voicemail.deleted') return
      setItems(current => (current ? applyVoicemailEvent(current, event) : current))
      if (event.type === 'voicemail.created') setArrived(t('voicemail.arrived', { who: whoOf(event.payload.voicemail) }))
    })
    return () => {
      clearTimeout(fallback)
      reloader.stop()
      stopConnected()
      stopEvents()
    }
  }, [client, onEvent, onConnected, t, whoOf])

  // The recordings fetched (blob: URLs) go with the page.
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url)
    },
    []
  )

  const listen = async (v: Voicemail) => {
    setNotice(null)
    try {
      const blob = await client.getVoicemailAudio(v.id)
      const url = URL.createObjectURL(blob)
      urls.current.push(url)
      setPlaying({ id: v.id, url })
    } catch {
      setNotice(t('voicemail.audioFailed'))
    }
  }
  const act = async (run: () => Promise<void>, failed: string) => {
    setNotice(null)
    try {
      await run()
    } catch (err) {
      setNotice((err as { status?: number }).status === 404 ? t('voicemail.gone') : failed)
    }
  }
  // Marked or deleted here: the list follows at once, the event that follows (for the other screens) changes nothing.
  const markRead = (v: Voicemail) =>
    act(async () => {
      await client.markVoicemailRead(v.id)
      setItems(current => current?.map(i => (i.id === v.id ? { ...i, unread: false } : i)) ?? current)
    }, t('voicemail.actionFailed'))
  const remove = (v: Voicemail) =>
    act(async () => {
      await client.deleteVoicemail(v.id)
      setItems(current => current?.filter(i => i.id !== v.id) ?? current)
      if (playing?.id === v.id) setPlaying(null)
    }, t('voicemail.actionFailed'))
  // Called back from the browser when its softphone can (the call panel takes over), else from the dialer, filled in.
  const callBack = async (v: Voicemail) => {
    const target = v.from ? toDialTarget(v.from) : null
    if (!target) return
    setNotice(null)
    if (phone.state !== 'registered' || phone.calls.length) {
      void navigate(`/?number=${encodeURIComponent(v.from!)}`)
      return
    }
    try {
      await phone.call(target)
    } catch (err) {
      setNotice(t('dialer.failed', { reason: describeCallError(err, t) }))
    }
  }

  const title = <h1>{t('voicemail.title')}</h1>
  if (error === 'unavailable') return <>{title}<p className="alert">{t('voicemail.unavailable')}</p></>
  if (error) return <>{title}<p className="alert alert-error" role="alert">{t('voicemail.error')}</p></>
  if (!items) return title
  const when = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
  const unread = items.filter(i => i.unread).length
  return (
    <>
      {title}
      <p className="sr-only" role="status" aria-live="polite">
        {arrived}
      </p>
      {notice ? (
        <p className="alert alert-error" role="alert">
          {notice}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p>{t('voicemail.empty')}</p>
      ) : (
        <>
          <p className="badge">{unread ? t('voicemail.unreadCount', { count: String(unread) }) : t('voicemail.allRead')}</p>
          <ul className="list voicemails">
            {items.map(v => {
              const who = whoOf(v)
              return (
                <li key={v.id} data-testid="voicemail" data-id={v.id} data-unread={v.unread ? '1' : '0'}>
                  <div>
                    <strong>{who}</strong>
                    {v.unread ? <span className="badge missed"> · {t('voicemail.new')}</span> : null}
                    <br />
                    <span className="badge">
                      <time dateTime={v.receivedAt}>{when.format(new Date(v.receivedAt))}</time> · <span aria-label={t('voicemail.durationLabel', { duration: clock(v.durationSec) })}>{clock(v.durationSec)}</span>
                    </span>
                    {playing?.id === v.id ? (
                      <div>
                        <audio controls autoPlay src={playing.url} aria-label={t('voicemail.player', { who })} data-testid="voicemail-audio" />
                      </div>
                    ) : null}
                  </div>
                  <div className="actions actions-end">
                    <button type="button" className="btn" onClick={() => void listen(v)} aria-label={t('voicemail.listenTo', { who })}>
                      {t('voicemail.listen')}
                    </button>
                    {v.from && toDialTarget(v.from) ? (
                      <button type="button" className="btn btn-primary" onClick={() => void callBack(v)} aria-label={t('voicemail.callBackWho', { who })}>
                        {t('voicemail.callBack')}
                      </button>
                    ) : null}
                    {v.unread ? (
                      <button type="button" className="btn" onClick={() => void markRead(v)} aria-label={t('voicemail.markReadWho', { who })}>
                        {t('voicemail.markRead')}
                      </button>
                    ) : null}
                    <button type="button" className="btn" onClick={() => void remove(v)} aria-label={t('voicemail.deleteWho', { who })}>
                      {t('voicemail.delete')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </>
  )
}
