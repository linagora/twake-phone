import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatNumber, toDialTarget, type Voicemail } from '@twake/telephony-client'
import type { TelephonyEvent } from '@twake/telephony-types'
import { describeCallError } from '../components/callErrors.js'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { Reloader } from '../reload.js'
import { usePhone } from '../softphone.js'

/** What a message says (step 11b): its text, that it is on its way, or why there is none. */
const Transcript = ({ id, transcript }: { id: string; transcript: NonNullable<Voicemail['transcript']> }) => {
  const { t } = useT()
  const text =
    transcript.status === 'done'
      ? transcript.text
        ? `« ${transcript.text} »`
        : t('voicemail.transcriptEmpty')
      : transcript.status === 'pending'
        ? t('voicemail.transcriptPending')
        : t(transcript.reason === 'too-long' ? 'voicemail.transcriptTooLong' : transcript.reason === 'busy' ? 'voicemail.transcriptBusy' : 'voicemail.transcriptFailed')
  return (
    <p className={`transcript transcript-${transcript.status}`} id={id} data-testid="voicemail-transcript" data-status={transcript.status}>
      <span className="transcript-label">{t('voicemail.transcriptLabel')}</span> {text}
    </p>
  )
}

/** How long the mailbox waits for the event stream before it is read without it. */
const WITHOUT_STREAM_MS = 3_000

/** 7 → "0:07", 75 → "1:15". */
export const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec)) % 60).padStart(2, '0')}`

/** A message as an event says it, its transcription kept when the event says none (the voicemail server knows none). */
const withTranscript = (v: Voicemail, before: Voicemail | undefined): Voicemail => (v.transcript || !before?.transcript ? v : { ...v, transcript: before.transcript })

/**
 * The list after an event of the mailbox: a new message first, one read, deleted or transcribed (step 11b) in place.
 * Ids are unique.
 */
export const applyVoicemailEvent = (items: Voicemail[], event: TelephonyEvent): Voicemail[] => {
  if (event.type === 'voicemail.created') {
    const v = withTranscript(event.payload.voicemail, items.find(i => i.id === event.payload.voicemail.id))
    return [v, ...items.filter(i => i.id !== v.id)].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  }
  if (event.type === 'voicemail.updated') return items.map(i => (i.id === event.payload.voicemail.id ? withTranscript(event.payload.voicemail, i) : i))
  if (event.type === 'voicemail.deleted') return items.filter(i => i.id !== event.payload.id)
  if (event.type === 'voicemail.transcribed') return items.map(i => (i.id === event.payload.id ? { ...i, transcript: event.payload.transcript } : i))
  return items
}

const isVoicemailEvent = (event: TelephonyEvent) => event.type === 'voicemail.created' || event.type === 'voicemail.updated' || event.type === 'voicemail.deleted' || event.type === 'voicemail.transcribed'

/**
 * Where the focus goes after an action took a button away: a message's « Écouter », its « Supprimer » (a deletion
 * given up), the confirmation asked, or the page's title.
 */
type FocusTarget = { listen: string } | { remove: string } | { confirm: string } | 'title'

/**
 * The person's mailbox (step 11a): the messages left when they could not answer, newest first, as they arrive. Each is
 * listened to in the page, marked as read, deleted, or its caller called back; its transcription (step 11b, ADR 0023)
 * is shown with it when the platform transcribes the messages, on its way, its text, or why there is none.
 *
 * Accessibility: a message's duration is said with its word (a visually hidden text, the
 * clock hidden from assistive tech); what changes without the person (a message arriving, its transcription done) and
 * what an action did (deleted, marked as read) is said in the status region, each time, even with the same words; an
 * action that takes its button away gives the focus to the next message, or the previous one, or the title. The
 * transcription is the recording's text alternative (RGAA 4.1), read before it and named by its player
 * (aria-describedby); a message the platform did not transcribe says why. Each button names its message with who left
 * it and when (two messages of the same caller are two); a deletion, for good, is confirmed first;
 * a recording asked before the one asked last is not played.
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
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  const confirmButtons = useRef(new Map<string, HTMLButtonElement>())
  const focusAfter = useRef<FocusTarget | null>(null)
  /** The message whose deletion waits for its confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Which listening is the last asked: an answer to one before it is dropped. */
  const listening = useRef(0)

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
        say(t(count === 1 ? 'voicemail.arrivedOne' : 'voicemail.arrived', { who: whoOf(v), time: time.format(new Date(v.receivedAt)), count: String(count) }))
      }
      // Its transcription done (step 11b): said once, the text itself is in the list.
      if (event.type === 'voicemail.transcribed' && event.payload.transcript.status === 'done') {
        const v = current.find(i => i.id === event.payload.id)
        if (v && v.transcript?.status !== 'done') say(t('voicemail.transcribedSaid', { who: whoOf(v) }))
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

  // The focus an action asked for, once the list without its button (or with the confirmation) is on the page.
  useEffect(() => {
    const target = focusAfter.current
    if (!target) return
    focusAfter.current = null
    if (target !== 'title') {
      const button = 'listen' in target ? listenButtons.current.get(target.listen) : 'remove' in target ? removeButtons.current.get(target.remove) : confirmButtons.current.get(target.confirm)
      if (button) return button.focus()
    }
    title.current?.focus()
  }, [items, confirming])

  const listen = async (v: Voicemail) => {
    setNotice(null)
    const ticket = ++listening.current
    try {
      const blob = await client.getVoicemailAudio(v.id)
      // Another message was asked meanwhile: this one is not played.
      if (ticket !== listening.current) return
      const next = URL.createObjectURL(blob)
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = next
      setPlaying({ id: v.id, url: next })
    } catch {
      if (ticket === listening.current) setNotice(t('voicemail.audioFailed'))
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
  // A deletion is for good: asked first, then confirmed (the focus on the confirmation), or given up (back on its
  // « Supprimer »).
  const askRemove = (v: Voicemail) => {
    focusAfter.current = { confirm: v.id }
    setConfirming(v.id)
  }
  const keep = (v: Voicemail) => {
    focusAfter.current = { remove: v.id }
    setConfirming(null)
  }
  const remove = (v: Voicemail) =>
    act(async () => {
      setConfirming(null)
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
              const at = when.format(new Date(v.receivedAt))
              const named = { who, when: at }
              return (
                <li key={v.id} data-testid="voicemail" data-id={v.id} data-unread={v.unread ? '1' : '0'}>
                  <div>
                    <strong>{who}</strong>
                    {v.unread ? <span className="badge missed"> · {t('voicemail.new')}</span> : null}
                    <br />
                    <span className="badge">
                      <time dateTime={v.receivedAt}>{at}</time> · <span className="sr-only">{t('voicemail.durationLabel', { duration: clock(v.durationSec) })}</span>
                      <span aria-hidden="true">{clock(v.durationSec)}</span>
                    </span>
                    {v.transcript ? <Transcript id={`transcript-${v.id}`} transcript={v.transcript} /> : null}
                    {playing?.id === v.id ? (
                      <div>
                        <audio
                          controls
                          autoPlay
                          src={playing.url}
                          aria-label={t('voicemail.player', named)}
                          {...(v.transcript ? { 'aria-describedby': `transcript-${v.id}` } : {})}
                          data-testid="voicemail-audio"
                        />
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
                      aria-label={t('voicemail.listenTo', named)}
                    >
                      {t('voicemail.listen')}
                    </button>
                    {v.from && toDialTarget(v.from) ? (
                      <button type="button" className="btn btn-primary" onClick={() => void callBack(v)} aria-label={t('voicemail.callBackWho', named)}>
                        {t('voicemail.callBack')}
                      </button>
                    ) : null}
                    {v.unread ? (
                      <button type="button" className="btn" onClick={() => void markRead(v)} aria-label={t('voicemail.markReadWho', named)}>
                        {t('voicemail.markRead')}
                      </button>
                    ) : null}
                    {confirming === v.id ? (
                      <span role="group" aria-label={t('voicemail.confirmDeleteWho', named)} className="actions">
                        <button
                          type="button"
                          className="btn btn-danger"
                          ref={el => {
                            if (el) confirmButtons.current.set(v.id, el)
                            else confirmButtons.current.delete(v.id)
                          }}
                          onClick={() => void remove(v)}
                          aria-label={t('voicemail.confirmDelete', named)}
                        >
                          {t('voicemail.confirmDeleteShort')}
                        </button>
                        <button type="button" className="btn" onClick={() => keep(v)} aria-label={t('voicemail.keepWho', named)}>
                          {t('voicemail.keep')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        ref={el => {
                          if (el) removeButtons.current.set(v.id, el)
                          else removeButtons.current.delete(v.id)
                        }}
                        onClick={() => askRemove(v)}
                        aria-label={t('voicemail.deleteWho', named)}
                      >
                        {t('voicemail.delete')}
                      </button>
                    )}
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
