import { useEffect, useState, type FormEvent } from 'react'
import type { SoftCall } from '@twake/softphone'
import { formatNumber, toDialTarget } from '@twake/telephony-client'
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
  failed: 'call.endedFailed',
  transferred: 'call.endedTransferred'
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

/** Where to send the person: typed once, then transferred at once or called first (consultation). */
const TransferForm = ({ call, onClose, onError }: { call: SoftCall; onClose: () => void; onError: (message: string | null) => void }) => {
  const { t } = useT()
  const phone = usePhone()
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const dialable = toDialTarget(target)
  const run = (fn: (target: string) => Promise<unknown>) => async (e: FormEvent) => {
    e.preventDefault()
    if (!dialable) return
    setBusy(true)
    onError(null)
    try {
      await fn(dialable)
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="transfer" onSubmit={run(to => call.transfer(to))} data-testid="transfer-form">
      <div className="field">
        <label htmlFor={`transfer-${call.id}`}>{t('call.transferTarget')}</label>
        <input id={`transfer-${call.id}`} type="tel" inputMode="tel" autoComplete="off" value={target} onChange={e => setTarget(e.target.value)} disabled={busy} />
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !dialable}>
          {t('call.transferBlind')}
        </button>
        <button type="button" className="btn" disabled={busy || !dialable} onClick={e => void run(to => phone.call(to))(e)}>
          {t('call.transferConsult')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {t('call.transferClose')}
        </button>
      </div>
    </form>
  )
}

/**
 * A call of ours that is not ringing in. With two calls, `original` is given to the newer one: the person it is
 * with is the one we consult before transferring `original` to them, or we drop the consultation and go back.
 */
const Active = ({ call, tones, original, hasOther }: { call: SoftCall; tones: string; original?: SoftCall; hasOther: boolean }) => {
  const { t } = useT()
  const [keypad, setKeypad] = useState(false)
  const [transfer, setTransfer] = useState(false)
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
  // Our consultation: the original call waits on hold while this one is set up.
  const consultation = original && original.state === 'held'
  const busy = call.renegotiating || call.transferring || (original?.transferring ?? false)
  return (
    <section className="call" aria-labelledby={`call-${call.id}`} data-testid={consultation ? 'consultation' : undefined}>
      <p id={`call-${call.id}`} className="call-title" role="status">
        {title}
      </p>
      {connected && call.connectedAt ? <Timer since={call.connectedAt} /> : null}
      {consultation ? <p className="badge">{t('call.consulting', { who: who(original) })}</p> : null}
      {call.remoteHold ? <p className="badge">{t('call.remoteHold')}</p> : null}
      {call.transferring || original?.transferring ? <p className="badge">{t('call.transferring')}</p> : null}
      {tones ? <p className="badge">{t('call.tonesReceived', { tones })}</p> : null}
      <div className="actions">
        {consultation && connected ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={guard(() => original.transferTo(call))}>
            {t('call.transferComplete', { from: who(original), to: who(call) })}
          </button>
        ) : null}
        {consultation ? (
          <button type="button" className="btn" disabled={busy} onClick={guard(async () => {
            await call.hangup()
            await original.resume()
          })}>
            {t('call.transferCancel')}
          </button>
        ) : null}
        {connected ? (
          <>
            <button type="button" className="btn" aria-pressed={call.state === 'held'} disabled={busy || hasOther} onClick={guard(() => (call.state === 'held' ? call.resume() : call.hold()))}>
              {call.state === 'held' ? t('call.resume') : t('call.hold')}
            </button>
            <button type="button" className="btn" aria-pressed={call.muted} onClick={guard(() => call.setMuted(!call.muted))}>
              {call.muted ? t('call.unmute') : t('call.mute')}
            </button>
            <button type="button" className="btn" aria-pressed={keypad} aria-controls={`dtmf-${call.id}`} onClick={() => setKeypad(k => !k)}>
              {t('call.keypad')}
            </button>
            {!hasOther ? (
              <button type="button" className="btn" aria-pressed={transfer} aria-controls={`transfer-${call.id}`} disabled={busy} onClick={() => setTransfer(v => !v)}>
                {t('call.transfer')}
              </button>
            ) : null}
          </>
        ) : null}
        <button type="button" className="btn btn-danger" disabled={call.transferring} onClick={guard(() => call.hangup())}>
          {t('call.hangup')}
        </button>
      </div>
      {transfer && connected && !hasOther ? <TransferForm call={call} onClose={() => setTransfer(false)} onError={setError} /> : null}
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

/** Every call of the page, above the routed content: a ringing banner, then the controls of the calls in progress. */
export const CallPanel = () => {
  const { t } = useT()
  const { calls, lastEnded, tones } = usePhone()
  if (!calls.length && !lastEnded) return null
  const ours = calls.filter(c => !(c.direction === 'inbound' && c.state === 'ringing'))
  const byAge = [...ours].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  const original = byAge.length > 1 ? byAge[0] : undefined
  return (
    <div className="calls" data-testid="calls">
      {calls.map(call =>
        call.direction === 'inbound' && call.state === 'ringing' ? (
          <Incoming key={call.id} call={call} />
        ) : (
          <Active key={call.id} call={call} tones={tones[call.id] ?? ''} hasOther={ours.length > 1} {...(original && call !== original ? { original } : {})} />
        )
      )}
      {!calls.length && lastEnded ? (
        <p className="call call-ended" role="status">
          {t(REASON_KEY[lastEnded.endReason ?? 'hangup'], { who: who(lastEnded) })}
        </p>
      ) : null}
    </div>
  )
}
