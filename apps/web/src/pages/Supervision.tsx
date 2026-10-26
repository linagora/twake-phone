import { Alert, Button, Chip, List, ListItem, ListItemText, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@linagora/twake-mui'
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

  /** The last reading of the calls and of the recordings asked, and whether a round of readings is under way: a slow answer neither doubles the round nor replaces a newer one. */
  const callsSeq = useRef(0)
  const recordingsSeq = useRef(0)
  const polling = useRef(false)
  const readCalls = useCallback(() => {
    const mine = ++callsSeq.current
    return client.listSupervisedCalls().then(
      page => {
        if (mine !== callsSeq.current) return
        setCalls(page.items)
        setError(null)
        setStale(false)
      },
      (err: { status?: number; message?: string }) => {
        if (mine !== callsSeq.current) return
        setStale(true)
        setError(err.status === 501 ? 'unavailable' : err.status === 403 ? 'forbidden' : (err.message ?? 'load'))
      }
    )
  }, [client])
  const readRecordings = useCallback(() => {
    const mine = ++recordingsSeq.current
    return client.listRecordings().then(
      page => {
        if (mine === recordingsSeq.current) setRecordings(page.items)
      },
      () => undefined
    )
  }, [client])
  const readLog = useCallback(() => client.getSupervisionLog().then(page => setLog(page.items), () => undefined), [client])

  useEffect(() => {
    if (!allowed) return
    void Promise.all([readCalls(), readRecordings(), readLog()])
    // A tab nobody looks at asks nothing of the telephony server.
    const timer = setInterval(() => {
      if (polling.current || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
      polling.current = true
      void Promise.all([readCalls(), readRecordings()]).finally(() => {
        polling.current = false
      })
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
      // Given up (the deletion fails), the focus is back on « Supprimer »; deleted, the button is gone and the title has it.
      focusAfter.current = { remove: r.id }
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
    <Typography variant="h4" component="h1" gutterBottom ref={title} tabIndex={-1}>
      {t('supervision.title')}
    </Typography>
  )
  const h2 = (text: string) => (
    <Typography variant="h5" component="h2" className="u-mt-2" gutterBottom>
      {text}
    </Typography>
  )
  const empty = (text: string) => (
    <Typography component="p" variant="body2" color="textSecondary">
      {text}
    </Typography>
  )
  const loading = <Typography role="status">{t('supervision.loading')}</Typography>
  if (!me)
    return (
      <>
        {heading}
        {meError ? (
          <Alert severity="error" role="alert">
            {t('supervision.error', { reason: meError })}
          </Alert>
        ) : (
          loading
        )}
      </>
    )
  if (!allowed || error === 'forbidden')
    return (
      <>
        {heading}
        <Alert severity="warning" role="alert">
          {t('supervision.forbidden')}
        </Alert>
      </>
    )
  if (error === 'unavailable')
    return (
      <>
        {heading}
        <Alert severity="info">{t('supervision.unavailable')}</Alert>
      </>
    )
  if (error && !calls)
    return (
      <>
        {heading}
        <Alert severity="error" role="alert">
          {t('supervision.error', { reason: error })}
        </Alert>
      </>
    )
  const day = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' })
  const time = new Intl.DateTimeFormat(lang, { timeStyle: 'medium' })
  const recordingOf = (r: Recording) => (r.displayName ? `${r.displayName} (${r.extension})` : t('auth.extension', { extension: r.extension }))
  return (
    <>
      {heading}
      <Typography component="p" gutterBottom>
        {t('supervision.intro')}
      </Typography>
      <Alert severity="info" className="u-mb-1">
        {t('supervision.notice')}
      </Alert>
      <p className="u-visuallyhidden" role="status" aria-live="polite" data-testid="supervision-status">
        {said.n % 2 ? said.text : said.text && `${said.text}\u00a0`}
      </p>
      {problem ? (
        <Alert severity="error" role="alert" className="u-mb-1" data-testid="supervision-problem">
          {problem}
        </Alert>
      ) : null}

      {stale && calls ? (
        <Alert severity="warning" role="status" className="u-mb-1">
          {t('supervision.stale')}
        </Alert>
      ) : null}

      {h2(t('supervision.calls'))}
      {!calls ? (
        loading
      ) : calls.length === 0 ? (
        empty(t('supervision.noCalls'))
      ) : (
        <TableContainer role="region" tabIndex={0} aria-label={t('supervision.calls')}>
          <Table size="small" data-testid="supervision-calls">
            <caption className="u-visuallyhidden">{t('supervision.calls')}</caption>
            <TableHead>
              <TableRow>
                {(['supervision.line', 'supervision.peer', 'supervision.state', 'supervision.since', 'supervision.actions'] as const).map(k => (
                  <TableCell key={k} component="th" scope="col">
                    {t(k)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {calls.map(c => {
                const who = whoOf(c)
                return (
                  <TableRow key={c.id} data-testid="supervision-call" data-id={c.id}>
                    <TableCell component="th" scope="row">
                      {who}
                    </TableCell>
                    <TableCell>{peerOf(c)}</TableCell>
                    <TableCell>
                      {t(c.state === 'up' ? 'supervision.stateUp' : 'supervision.stateRinging')}
                      {c.recording ? <Chip size="small" color="error" variant="outlined" className="u-ml-half" label={t('supervision.recordingOn')} /> : null}
                    </TableCell>
                    <TableCell>
                      <time dateTime={c.startedAt}>{time.format(new Date(c.startedAt))}</time>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
                        {c.recording ? (
                          <Button variant="outlined" size="small" aria-label={t('supervision.stopFor', { who })} aria-disabled={busy.has(c.id) || undefined} onClick={() => void stop(c)}>
                            {t('supervision.stopRecord')}
                          </Button>
                        ) : (
                          <Button size="small" aria-label={t('supervision.recordFor', { who })} aria-disabled={busy.has(c.id) || undefined} onClick={() => void record(c)}>
                            {t('supervision.record')}
                          </Button>
                        )}
                        {MODES.map(m => (
                          <Button key={m.mode} variant="outlined" size="small" aria-label={t(m.named, { who })} aria-disabled={busy.has(c.id) || undefined} onClick={() => void join(c, m.mode)}>
                            {t(m.label)}
                          </Button>
                        ))}
                      </Stack>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {h2(t('supervision.recordings'))}
      {!recordings ? (
        loading
      ) : recordings.length === 0 ? (
        empty(t('supervision.noRecordings'))
      ) : (
        <List data-testid="supervision-recordings">
          {recordings.map(r => {
            const named = { who: recordingOf(r), when: day.format(new Date(r.startedAt)) }
            return (
              <ListItem key={r.id} divider data-testid="supervision-recording" data-id={r.id} data-state={r.state} className="u-flex-wrap">
                <ListItemText
                  primary={named.who}
                  secondary={
                    <>
                      <time dateTime={r.startedAt}>{named.when}</time> · {t(REC_STATE[r.state])}
                      {r.durationSec !== undefined ? ` · ${t('supervision.recDuration')} ${clock(r.durationSec)}` : ''}
                    </>
                  }
                />
                <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-flex-items-center">
                  {r.state === 'ready' ? (
                    <Button variant="outlined" size="small" aria-label={t('supervision.playFor', named)} onClick={() => void play(r)}>
                      {t('supervision.play')}
                    </Button>
                  ) : null}
                  {admin && r.state !== 'recording' && r.state !== 'purged' ? (
                    confirming === r.id ? (
                      <Stack
                        direction="row"
                        spacing={1}
                        useFlexGap
                        className="u-flex-wrap u-flex-items-center"
                        onKeyDown={e => {
                          if (e.key === 'Escape') keep(r)
                        }}
                      >
                        <Typography variant="body2" role="alert">
                          {t('supervision.confirmDelete', named)}
                        </Typography>
                        <Button size="small" color="error" ref={el => void (el ? confirmButtons.current.set(r.id, el) : confirmButtons.current.delete(r.id))} onClick={() => void remove(r)}>
                          {t('supervision.confirm')}
                        </Button>
                        <Button size="small" variant="outlined" onClick={() => keep(r)}>
                          {t('supervision.keep')}
                        </Button>
                      </Stack>
                    ) : (
                      <Button size="small" variant="outlined" ref={el => void (el ? removeButtons.current.set(r.id, el) : removeButtons.current.delete(r.id))} aria-label={t('supervision.deleteFor', named)} onClick={() => askRemove(r)}>
                        {t('supervision.delete')}
                      </Button>
                    )
                  ) : null}
                </Stack>
                {playing?.id === r.id ? <audio controls autoPlay src={playing.url} aria-label={t('supervision.player', named)} data-testid="supervision-audio" className="u-w-100" /> : null}
              </ListItem>
            )
          })}
        </List>
      )}

      {h2(t('supervision.log'))}
      {!log ? (
        loading
      ) : log.length === 0 ? (
        empty(t('supervision.noLog'))
      ) : (
        <TableContainer role="region" tabIndex={0} aria-label={t('supervision.log')}>
          <Table size="small" data-testid="supervision-log">
            <caption className="u-visuallyhidden">{t('supervision.log')}</caption>
            <TableHead>
              <TableRow>
                {(['supervision.logWhen', 'supervision.logWho', 'supervision.logWhat', 'supervision.logLine'] as const).map(k => (
                  <TableCell key={k} component="th" scope="col">
                    {t(k)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {log.map((e, i) => (
                <TableRow key={`${e.at}-${i}`}>
                  <TableCell>
                    <time dateTime={e.at}>{day.format(new Date(e.at))}</time>
                  </TableCell>
                  <TableCell>{e.actor === 'system' ? t('supervision.logSystem') : (e.actorName ?? e.actor)}</TableCell>
                  <TableCell>{t(LOG_ACTION[e.action])}</TableCell>
                  <TableCell>{e.extension ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  )
}
