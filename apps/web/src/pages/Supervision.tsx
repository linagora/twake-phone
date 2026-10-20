import { useCallback, useEffect, useRef, useState } from 'react'
import { formatNumber, type Recording, type SupervisedCall, type SupervisionLogEntry, type SupervisionMode } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'

type Call = SupervisedCall & { displayName?: string; recording?: { id: string; startedAt: string } }
type LogLine = SupervisionLogEntry & { actorName?: string }

/** How often the calls in progress are read again. */
export const CALLS_EVERY_MS = 5_000

const REC_STATE = { recording: 'supervision.rec.recording', ready: 'supervision.rec.ready', failed: 'supervision.rec.failed', erasing: 'supervision.rec.erasing', purged: 'supervision.rec.purged' } as const
const LOG_ACTION = {
  'record-start': 'supervision.action.record-start',
  'record-stop': 'supervision.action.record-stop',
  'listen-recording': 'supervision.action.listen-recording',
  'delete-recording': 'supervision.action.delete-recording',
  'spy-listen': 'supervision.action.spy-listen',
  'spy-whisper': 'supervision.action.spy-whisper',
  'spy-barge': 'supervision.action.spy-barge',
  purge: 'supervision.action.purge',
  erase: 'supervision.action.erase'
} as const
/** What the Gateway says of a refusal (`code`), in words. */
const ERRORS: Record<string, Key> = {
  CALL_GONE: 'supervision.errGone',
  RECORDING_UNDER_WAY: 'supervision.errUnderWay',
  NO_RECORDING: 'supervision.errNoRecording',
  SUPERVISION_FAILED: 'supervision.errFailed',
  NO_EXTENSION: 'supervision.errNoExtension',
  OWN_CALL: 'supervision.errOwn',
  SPY_REFUSED: 'supervision.errSpyRefused',
  NOTICE_MISSING: 'supervision.errNotice'
}
const MODES: { mode: SupervisionMode; label: Key; named: Key }[] = [
  { mode: 'listen', label: 'supervision.listen', named: 'supervision.listenFor' },
  { mode: 'whisper', label: 'supervision.whisper', named: 'supervision.whisperFor' },
  { mode: 'barge', label: 'supervision.barge', named: 'supervision.bargeFor' }
]

/** 65 → "1:05". */
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.round(sec)) % 60).padStart(2, '0')}`

/**
 * The supervision (step 11d, ADR 0029), for supervisors: the calls in progress that have a channel at the telephony
 * server, which they record (announced to both parties) or join (listen, whisper, barge in: their own phone rings and they
 * pick up), the recordings kept (listened to here, each listening journalled; deleted by administrators), and the journal.
 * The Gateway decides who may and refuses the others whatever they send (403); this screen only says so. What changes
 * without the person (a call that ends, a recording closed) is read again every few seconds; what an action did is said in
 * the status region.
 */
export const SupervisionPage = () => {
  const { t, lang } = useT()
  const { client, me, meError } = useGateway()
  const [calls, setCalls] = useState<Call[] | null>(null)
  const [recordings, setRecordings] = useState<Recording[] | null>(null)
  const [log, setLog] = useState<LogLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState({ text: '', n: 0 })
  const [problem, setProblem] = useState<string | null>(null)
  const say = useCallback((text: string) => setSaid(s => ({ text, n: s.n + 1 })), [])
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null)
  const url = useRef<string | null>(null)
  const listening = useRef(0)
  const mounted = useRef(true)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** What the last read could not do: the list shown is then the one before. */
  const [stale, setStale] = useState(false)
  /** The calls whose action is under way: asked once, not twice by a second click. */
  const asking = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const title = useRef<HTMLHeadingElement>(null)
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  const confirmButtons = useRef(new Map<string, HTMLButtonElement>())
  /** Where the focus goes once an action took its button away: the confirmation, the button it replaced, or the title. */
  const focusAfter = useRef<{ confirm: string } | { remove: string } | 'title' | null>(null)
  const allowed = me?.features?.supervision === true
  const admin = me?.features?.admin === true

  const readCalls = useCallback(
    () =>
      client.listSupervisedCalls().then(
        page => {
          setCalls(page.items)
          setError(null)
          setStale(false)
        },
        (err: { status?: number; message?: string }) => {
          setStale(true)
          setError(err.status === 501 ? 'unavailable' : err.status === 403 ? 'forbidden' : (err.message ?? 'load'))
        }
      ),
    [client]
  )
  const readRecordings = useCallback(() => client.listRecordings().then(page => setRecordings(page.items), () => undefined), [client])
  const readLog = useCallback(() => client.getSupervisionLog().then(page => setLog(page.items), () => undefined), [client])

  useEffect(() => {
    if (!allowed) return
    void Promise.all([readCalls(), readRecordings(), readLog()])
    // A tab nobody looks at asks nothing of the telephony server.
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void Promise.all([readCalls(), readRecordings()])
    }, CALLS_EVERY_MS)
    return () => clearInterval(timer)
  }, [allowed, readCalls, readRecordings, readLog])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (url.current) URL.revokeObjectURL(url.current)
    }
  }, [])
  // The focus an action asked for, once the page is without its button (or with the confirmation).
  useEffect(() => {
    const target = focusAfter.current
    if (!target) return
    focusAfter.current = null
    const button = target === 'title' ? undefined : 'confirm' in target ? confirmButtons.current.get(target.confirm) : removeButtons.current.get(target.remove)
    if (button) return button.focus()
    title.current?.focus()
  }, [recordings, confirming])

  const whoOf = (c: { extension: string; displayName?: string }) => (c.displayName ? `${c.displayName} (${c.extension})` : t('auth.extension', { extension: c.extension }))
  const peerOf = (c: Call) => (c.peerName ? `${c.peerName} (${formatNumber(c.peer ?? '')})` : c.peer ? formatNumber(c.peer) : t('call.hiddenNumber'))
  const act = async (key: string | null, run: () => Promise<void>) => {
    // The buttons of a call whose action is under way are told so (aria-disabled, the focus stays) and ignore a click.
    if (key !== null) {
      if (asking.current.has(key)) return
      asking.current.add(key)
      setBusy(new Set(asking.current))
    }
    setProblem(null)
    try {
      await run()
    } catch (err) {
      const code = (err as { code?: string }).code
      setProblem(t(code && ERRORS[code] ? ERRORS[code] : 'supervision.errOther'))
    } finally {
      if (key !== null) {
        asking.current.delete(key)
        setBusy(new Set(asking.current))
      }
    }
    void Promise.all([readCalls(), readRecordings(), readLog()])
  }
  const record = (c: Call) => act(c.id, async () => (await client.startRecording(c.id), say(t('supervision.recordingStarted', { who: whoOf(c) }))))
  const stop = (c: Call) => act(c.id, async () => (await client.stopRecording(c.id), say(t('supervision.recordingStopped', { who: whoOf(c) }))))
  const join = (c: Call, mode: SupervisionMode) =>
    act(c.id, async () => {
      say(t('supervision.spyRinging', { who: whoOf(c) }))
      const r = await client.superviseCall(c.id, mode)
      if (r.state === 'answered') say(t('supervision.spyAnswered', { who: whoOf(c) }))
    })
  const play = async (r: Recording) => {
    setProblem(null)
    const ticket = ++listening.current
    try {
      const blob = await client.getRecordingAudio(r.id)
      // Another recording was asked meanwhile, or the page went: this one is not played.
      if (ticket !== listening.current || !mounted.current) return
      const next = URL.createObjectURL(blob)
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = next
      setPlaying({ id: r.id, url: next })
      void readLog()
    } catch {
      if (ticket === listening.current) setProblem(t('supervision.audioFailed'))
    }
  }
  // A deletion is for good: asked first, then confirmed (the focus on the confirmation), or given up (back on « Supprimer »).
  const askRemove = (r: Recording) => {
    focusAfter.current = { confirm: r.id }
    setConfirming(r.id)
  }
  const keep = (r: Recording) => {
    focusAfter.current = { remove: r.id }
    setConfirming(null)
  }
  const remove = (r: Recording) =>
    act(null, async () => {
      setConfirming(null)
      await client.deleteRecording(r.id)
      if (playing?.id === r.id) {
        setPlaying(null)
        if (url.current === playing.url) {
          URL.revokeObjectURL(playing.url)
          url.current = null
        }
      }
      focusAfter.current = 'title'
      say(t('supervision.deleted'))
    })

  const heading = (
    <h1 ref={title} tabIndex={-1}>
      {t('supervision.title')}
    </h1>
  )
  if (!me) return <>{heading}{meError ? <p className="alert alert-error" role="alert">{t('supervision.error', { reason: meError })}</p> : <p role="status">{t('supervision.loading')}</p>}</>
  if (!allowed) return <>{heading}<p className="alert" role="alert">{t('supervision.forbidden')}</p></>
  if (error === 'unavailable') return <>{heading}<p className="alert">{t('supervision.unavailable')}</p></>
  if (error === 'forbidden') return <>{heading}<p className="alert" role="alert">{t('supervision.forbidden')}</p></>
  if (error && !calls) return <>{heading}<p className="alert alert-error" role="alert">{t('supervision.error', { reason: error })}</p></>
  const day = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
  const time = new Intl.DateTimeFormat(lang, { timeStyle: 'medium' })
  const recordingOf = (r: Recording) => (r.displayName ? `${r.displayName} (${r.extension})` : t('auth.extension', { extension: r.extension }))
  return (
    <>
      {heading}
      <p>{t('supervision.intro')}</p>
      <p className="alert">{t('supervision.notice')}</p>
      <p className="sr-only" role="status" aria-live="polite" data-testid="supervision-status">
        {said.n % 2 ? said.text : said.text && `${said.text}\u00a0`}
      </p>
      {problem ? (
        <p className="alert alert-error" role="alert">
          {problem}
        </p>
      ) : null}

      {stale && calls ? (
        <p className="alert" role="status">
          {t('supervision.stale')}
        </p>
      ) : null}

      <h2>{t('supervision.calls')}</h2>
      {!calls ? (
        <p role="status">{t('supervision.loading')}</p>
      ) : calls.length === 0 ? (
        <p>{t('supervision.noCalls')}</p>
      ) : (
        <table data-testid="supervision-calls">
          <caption className="sr-only">{t('supervision.calls')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('supervision.line')}</th>
              <th scope="col">{t('supervision.peer')}</th>
              <th scope="col">{t('supervision.state')}</th>
              <th scope="col">{t('supervision.since')}</th>
              <th scope="col">{t('supervision.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {calls.map(c => {
              const who = whoOf(c)
              return (
                <tr key={c.id} data-testid="supervision-call" data-id={c.id}>
                  <th scope="row">{who}</th>
                  <td>{peerOf(c)}</td>
                  <td>
                    {t(c.state === 'up' ? 'supervision.stateUp' : 'supervision.stateRinging')}
                    {c.recording ? <span className="badge missed"> · {t('supervision.recordingOn')}</span> : null}
                  </td>
                  <td>
                    <time dateTime={c.startedAt}>{time.format(new Date(c.startedAt))}</time>
                  </td>
                  <td className="actions">
                    {c.recording ? (
                      <button type="button" className="btn" aria-label={t('supervision.stopFor', { who })} aria-disabled={busy.has(c.id) || undefined} onClick={() => void stop(c)}>
                        {t('supervision.stopRecord')}
                      </button>
                    ) : (
                      <button type="button" className="btn btn-primary" aria-label={t('supervision.recordFor', { who })} aria-disabled={busy.has(c.id) || undefined} onClick={() => void record(c)}>
                        {t('supervision.record')}
                      </button>
                    )}
                    {MODES.map(m => (
                      <button key={m.mode} type="button" className="btn" aria-label={t(m.named, { who })} aria-disabled={busy.has(c.id) || undefined} onClick={() => void join(c, m.mode)}>
                        {t(m.label)}
                      </button>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h2>{t('supervision.recordings')}</h2>
      {!recordings ? (
        <p role="status">{t('supervision.loading')}</p>
      ) : recordings.length === 0 ? (
        <p>{t('supervision.noRecordings')}</p>
      ) : (
        <ul className="list" data-testid="supervision-recordings">
          {recordings.map(r => {
            const named = { who: recordingOf(r), when: day.format(new Date(r.startedAt)) }
            return (
              <li key={r.id} data-testid="supervision-recording" data-id={r.id} data-state={r.state}>
                <div>
                  <strong>{named.who}</strong>
                  <br />
                  <span className="badge">
                    <time dateTime={r.startedAt}>{named.when}</time> · {t(REC_STATE[r.state])}
                    {r.durationSec !== undefined ? ` · ${t('supervision.recDuration')} ${clock(r.durationSec)}` : ''}
                  </span>
                  {playing?.id === r.id ? <div><audio controls autoPlay src={playing.url} aria-label={t('supervision.player', named)} data-testid="supervision-audio" /></div> : null}
                </div>
                <div className="actions actions-end">
                  {r.state === 'ready' ? (
                    <button type="button" className="btn" aria-label={t('supervision.playFor', named)} onClick={() => void play(r)}>
                      {t('supervision.play')}
                    </button>
                  ) : null}
                  {admin && r.state !== 'recording' && r.state !== 'purged' ? (
                    confirming === r.id ? (
                      <span
                        onKeyDown={e => {
                          if (e.key === 'Escape') keep(r)
                        }}
                      >
                        <span role="alert">{t('supervision.confirmDelete', named)}</span>
                        <button type="button" className="btn btn-danger" ref={el => void (el ? confirmButtons.current.set(r.id, el) : confirmButtons.current.delete(r.id))} onClick={() => void remove(r)}>
                          {t('supervision.confirm')}
                        </button>
                        <button type="button" className="btn" onClick={() => keep(r)}>
                          {t('supervision.keep')}
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn" ref={el => void (el ? removeButtons.current.set(r.id, el) : removeButtons.current.delete(r.id))} aria-label={t('supervision.deleteFor', named)} onClick={() => askRemove(r)}>
                        {t('supervision.delete')}
                      </button>
                    )
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <h2>{t('supervision.log')}</h2>
      {!log ? (
        <p role="status">{t('supervision.loading')}</p>
      ) : log.length === 0 ? (
        <p>{t('supervision.noLog')}</p>
      ) : (
        <table data-testid="supervision-log">
          <caption className="sr-only">{t('supervision.log')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('supervision.logWhen')}</th>
              <th scope="col">{t('supervision.logWho')}</th>
              <th scope="col">{t('supervision.logWhat')}</th>
              <th scope="col">{t('supervision.logLine')}</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td>
                  <time dateTime={e.at}>{day.format(new Date(e.at))}</time>
                </td>
                <td>{e.actor === 'system' ? t('supervision.logSystem') : (e.actorName ?? e.actor)}</td>
                <td>{t(LOG_ACTION[e.action])}</td>
                <td>{e.extension ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
