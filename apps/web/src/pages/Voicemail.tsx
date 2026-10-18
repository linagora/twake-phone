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

const isVoicemailEvent = (event: TelephonyEvent) => event.type === 'voicemail.created' || event.type === 'voicemail.updated' || event.type === 'voicemail.deleted'

/** Where the focus goes after an action took a button away: a message's « Écouter », or the page's title. */
type FocusTarget = { listen: string } | 'title'

/**
 * The person's mailbox (step 11a): the messages left when they could not answer, newest first, as they arrive. Each is
 * listened to in the page, marked as read, deleted, or its caller called back.
 *
 * Accessibility (review 11a, n°19 and 25): a message's duration is said with its word (a visually hidden text, the
 * clock hidden from assistive tech); what changes without the person (a message arriving) and what an action did
 * (deleted, marked as read) is said in the status region, each time, even with the same words; an action that takes
 * its button away gives the focus to the next message, or the previous one, or the title. The recordings have no
 * transcription before step 11b (RGAA 4.1: a derogation, ADR 0022).
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
  /**
   * Said to assistive tech (the list changes without the page being reloaded): a message arrived, one was deleted or
   * marked. The same words twice are told twice: every other one ends with a no-break space, a change of the region.
   */
  const [said, setSaid] = useState({ text: '', n: 0 })
  const say = useCallback((text: string) => setSaid(s => ({ text, n: s.n + 1 })), [])
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null)
  /** The recording fetched last (a blob: URL): the one before goes as another is listened to, this one with the page. */
  const url = useRef<string | null>(null)
  /** The list as rendered, for what an event or an action says (how many unread, which message is next). */
  const shown = useRef<Voicemail[] | null>(null)
  useEffect(() => {
    shown.current = items
  }, [items])
  const title = useRef<HTMLHeadingElement>(null)
  const listenButtons = useRef(new Map<string, HTMLButtonElement>())
  const focusAfter = useRef<FocusTarget | null>(null)

  /** Who left a message: their name and number, the number alone, or that they hid it. */
  const whoOf = useCallback((v: Voicemail) => (v.fromName ? (v.from ? `${v.fromName} (${formatNumber(v.from)})` : v.fromName) : v.from ? formatNumber(v.from) : t('call.hiddenNumber')), [t])

  useEffect(() => {
    const time = new Intl.DateTimeFormat(lang, { timeStyle: 'short' })
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
      if (!isVoicemailEvent(event)) return
      const current = shown.current
      // Before the first list (on its way, or not asked yet): it is read (again), the event in it.
      if (!current) return reloader.request()
      setItems(list => (list ? applyVoicemailEvent(list, event) : list))
      if (event.type === 'voicemail.created') {
        const v = event.payload.voicemail
        const count = applyVoicemailEvent(current, event).filter(i => i.unread).length
        say(t('voicemail.arrived', { who: whoOf(v), time: time.format(new Date(v.receivedAt)), count: String(count) }))
      }
    })
    return () => {
      clearTimeout(fallback)
      reloader.stop()
      stopConnected()
      stopEvents()
    }
  }, [client, onEvent, onConnected, t, lang, whoOf, say])

  // The recording fetched last goes with the page.
  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current)
    },
    []
  )

  // The focus an action asked for, once the list without its button is on the page.
  useEffect(() => {
    const target = focusAfter.current
    if (!target) return
    focusAfter.current = null
    if (target !== 'title') {
      const button = listenButtons.current.get(target.listen)
      if (button) return button.focus()
    }
    title.current?.focus()
  }, [items])

  const listen = async (v: Voicemail) => {
    setNotice(null)
    try {
      const blob = await client.getVoicemailAudio(v.id)
      const next = URL.createObjectURL(blob)
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = next
      setPlaying({ id: v.id, url: next })
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
      focusAfter.current = { listen: v.id }
      setItems(current => current?.map(i => (i.id === v.id ? { ...i, unread: false } : i)) ?? current)
      say(t('voicemail.markedRead', { who: whoOf(v) }))
    }, t('voicemail.actionFailed'))
  const remove = (v: Voicemail) =>
    act(async () => {
      await client.deleteVoicemail(v.id)
      const list = shown.current ?? []
      const at = list.findIndex(i => i.id === v.id)
      const next = at < 0 ? undefined : (list[at + 1] ?? list[at - 1])
      focusAfter.current = next ? { listen: next.id } : 'title'
      setItems(current => current?.filter(i => i.id !== v.id) ?? current)
      if (playing?.id === v.id) {
        setPlaying(null)
        if (url.current === playing.url) {
          URL.revokeObjectURL(playing.url)
          url.current = null
        }
      }
      say(t('voicemail.deleted', { who: whoOf(v) }))
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

  const heading = (
    <h1 ref={title} tabIndex={-1}>
      {t('voicemail.title')}
    </h1>
  )
  if (error === 'unavailable') return <>{heading}<p className="alert">{t('voicemail.unavailable')}</p></>
  if (error) return <>{heading}<p className="alert alert-error" role="alert">{t('voicemail.error')}</p></>
  if (!items) return heading
  const when = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
  const unread = items.filter(i => i.unread).length
  return (
    <>
      {heading}
      <p className="sr-only" role="status" aria-live="polite" data-testid="voicemail-status">
        {said.n % 2 ? said.text : said.text && `${said.text}\u00a0`}
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
                      <time dateTime={v.receivedAt}>{when.format(new Date(v.receivedAt))}</time> · <span className="sr-only">{t('voicemail.durationLabel', { duration: clock(v.durationSec) })}</span>
                      <span aria-hidden="true">{clock(v.durationSec)}</span>
                    </span>
                    {playing?.id === v.id ? (
                      <div>
                        <audio controls autoPlay src={playing.url} aria-label={t('voicemail.player', { who })} data-testid="voicemail-audio" />
                      </div>
                    ) : null}
                  </div>
                  <div className="actions actions-end">
                    <button
                      type="button"
                      className="btn"
                      ref={el => {
                        if (el) listenButtons.current.set(v.id, el)
                        else listenButtons.current.delete(v.id)
                      }}
                      onClick={() => void listen(v)}
                      aria-label={t('voicemail.listenTo', { who })}
                    >
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
