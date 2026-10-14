import { useEffect, useState } from 'react'
import type { SoftCall } from '@twake/softphone'
import { formatNumber } from '@twake/telephony-client'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { usePhone } from '../softphone.js'

const TONES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

const REASON_KEY: Record<NonNullable<SoftCall['endReason']>, Key> = {
  hangup: 'call.ended',
  rejected: 'call.endedRejected',
  busy: 'call.endedBusy',
  'no-answer': 'call.endedNoAnswer',
  unavailable: 'call.endedUnavailable',
  cancelled: 'call.endedCancelled',
  failed: 'call.endedFailed'
}

const who = (call: SoftCall) => (call.remoteName ? `${call.remoteName} (${formatNumber(call.remoteNumber)})` : formatNumber(call.remoteNumber))

/** Elapsed time of a connected call, as m:ss, refreshed every second; outside any live region, so never read aloud each second. */
const Timer = ({ since }: { since: Date }) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - since.getTime()) / 1000))
  return (
    <span className="timer">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  )
}

const Incoming = ({ call }: { call: SoftCall }) => {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      // The caller gave up, or another window answered first: the banner goes when the call does; say why meanwhile.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  // A live region, not a dialog: nothing traps the focus, the person keeps typing where they were.
  return (
    <section className="call call-incoming" role="region" aria-labelledby={`call-${call.id}`} aria-live="assertive" data-testid="incoming-call">
      <p id={`call-${call.id}`} className="call-title">
        {t('call.incoming', { who: who(call) })}
      </p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={act(() => call.answer())} disabled={busy}>
          {t('call.answer')}
        </button>
        <button type="button" className="btn btn-danger" onClick={act(() => call.reject())} disabled={busy}>
          {t('call.reject')}
        </button>
      </div>
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

const Active = ({ call, tones }: { call: SoftCall; tones: string }) => {
  const { t } = useT()
  const [keypad, setKeypad] = useState(false)
  const [sent, setSent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const connected = call.state === 'connected' || call.state === 'held'
  const guard = (fn: () => Promise<void> | void) => async () => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const title = !connected ? t('call.dialing', { who: who(call) }) : call.state === 'held' ? t('call.held', { who: who(call) }) : t('call.inProgress', { who: who(call) })
  return (
    <section className="call" aria-labelledby={`call-${call.id}`}>
      <p id={`call-${call.id}`} className="call-title" role="status">
        {title}
      </p>
      {connected && call.connectedAt ? <Timer since={call.connectedAt} /> : null}
      {call.remoteHold ? <p className="badge">{t('call.remoteHold')}</p> : null}
      {tones ? <p className="badge">{t('call.tonesReceived', { tones })}</p> : null}
      <div className="actions">
        {connected ? (
          <>
            <button type="button" className="btn" aria-pressed={call.state === 'held'} disabled={call.renegotiating} onClick={guard(() => (call.state === 'held' ? call.resume() : call.hold()))}>
              {call.state === 'held' ? t('call.resume') : t('call.hold')}
            </button>
            <button type="button" className="btn" aria-pressed={call.muted} onClick={guard(() => call.setMuted(!call.muted))}>
              {call.muted ? t('call.unmute') : t('call.mute')}
            </button>
            <button type="button" className="btn" aria-pressed={keypad} aria-controls={`dtmf-${call.id}`} onClick={() => setKeypad(k => !k)}>
              {t('call.keypad')}
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-danger" onClick={guard(() => call.hangup())}>
          {t('call.hangup')}
        </button>
      </div>
      {keypad && connected ? (
        <div id={`dtmf-${call.id}`} className="dtmf">
          <div className="keypad" role="group" aria-label={t('call.keypad')}>
            {TONES.map(k => (
              <button key={k} type="button" className="btn key" onClick={guard(() => {
                call.sendDtmf(k)
                setSent(s => s + k)
              })} aria-label={t('call.sendTone', { tone: k })}>
                {k}
              </button>
            ))}
          </div>
          {sent ? <p className="badge">{t('call.tonesSent', { tones: sent })}</p> : null}
        </div>
      ) : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/** Every call of the page, above the routed content: a ringing banner, then the controls of the call in progress. */
export const CallPanel = () => {
  const { t } = useT()
  const { calls, lastEnded, tones } = usePhone()
  if (!calls.length && !lastEnded) return null
  return (
    <div className="calls" data-testid="calls">
      {calls.map(call => (call.direction === 'inbound' && call.state === 'ringing' ? <Incoming key={call.id} call={call} /> : <Active key={call.id} call={call} tones={tones[call.id] ?? ''} />))}
      {!calls.length && lastEnded ? (
        <p className="call call-ended" role="status">
          {t(REASON_KEY[lastEnded.endReason ?? 'hangup'], { who: who(lastEnded) })}
        </p>
      ) : null}
    </div>
  )
}
