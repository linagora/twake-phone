import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { SoftCall } from '@twake/softphone'
import { formatNumber, toDialTarget } from '@twake/telephony-client'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { usePhone } from '../softphone.js'
import { describeCallError } from './callErrors.js'

const TONES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

const REASON_KEY: Record<NonNullable<SoftCall['endReason']>, Key> = {
  hangup: 'call.ended',
  rejected: 'call.endedRejected',
  busy: 'call.endedBusy',
  'no-answer': 'call.endedNoAnswer',
  unavailable: 'call.endedUnavailable',
  cancelled: 'call.endedCancelled',
  failed: 'call.endedFailed',
  transferred: 'call.endedTransferred',
  dnd: 'call.endedDnd'
}

const who = (call: SoftCall) => (call.remoteName ? `${call.remoteName} (${formatNumber(call.remoteNumber)})` : formatNumber(call.remoteNumber))

/**
 * How a call ended, for the person: a ringing call of theirs cancelled was answered elsewhere, or given up; one
 * refused by a "do not disturb" says the message the person called left, when they left one.
 */
const reasonKey = (call: SoftCall): Key => {
  if (call.direction === 'inbound' && call.endReason === 'cancelled') return 'call.endedCancelledInbound'
  if (call.endReason === 'dnd' && call.endMessage) return 'call.endedDndMessage'
  return REASON_KEY[call.endReason ?? 'hangup']
}

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
      setError(describeCallError(err, t))
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
      onError(describeCallError(err, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form id={`transfer-form-${call.id}`} className="transfer" onSubmit={run(to => call.transfer(to))} data-testid="transfer-form">
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
 * A call of ours that is not ringing in. A consultation (placed during `original`, which waits on hold) offers to
 * hand `original` over to the person it is with, or to drop it and go back. Errors go to the panel, under every
 * call: the one that ends (a consultation hung up) does not take the explanation with it.
 */
const Active = ({ call, tones, original, hasOther, onError }: { call: SoftCall; tones: string; original?: SoftCall; hasOther: boolean; onError: (message: string | null) => void }) => {
  const { t } = useT()
  const [keypad, setKeypad] = useState(false)
  const [transfer, setTransfer] = useState(false)
  const [sent, setSent] = useState('')
  const transferButton = useRef<HTMLButtonElement>(null)
  const connected = call.state === 'connected' || call.state === 'held'
  const guard = (fn: () => Promise<void> | void) => async () => {
    onError(null)
    try {
      await fn()
    } catch (err) {
      onError(describeCallError(err, t))
    }
  }
  // The form goes, the focus comes back to the button that opened it (not to the top of the page).
  const closeTransfer = () => {
    setTransfer(false)
    transferButton.current?.focus()
  }
  const title = call.transferring
    ? t('call.transferringWho', { who: who(call) })
    : !connected
      ? t('call.dialing', { who: who(call) })
      : call.state === 'held'
        ? t('call.held', { who: who(call) })
        : t('call.inProgress', { who: who(call) })
  const originalReady = original && (original.state === 'connected' || original.state === 'held')
  // While the transfer of the original is on its way, the consultation must stay: its dialog is what the far end
  // takes over (Replaces); hanging it up first would make the transfer fail.
  const busy = call.renegotiating || call.transferring || (original?.transferring ?? false)
  return (
    <section className="call" aria-labelledby={`call-${call.id}`} data-testid={original ? 'consultation' : undefined}>
      <p id={`call-${call.id}`} className="call-title" role="status">
        {title}
      </p>
      {connected && call.connectedAt ? <Timer since={call.connectedAt} /> : null}
      {original ? <p className="badge">{t('call.consulting', { who: who(original) })}</p> : null}
      {call.remoteHold ? <p className="badge">{t('call.remoteHold')}</p> : null}
      {original?.transferring ? <p className="badge">{t('call.transferring')}</p> : null}
      {tones ? <p className="badge">{t('call.tonesReceived', { tones })}</p> : null}
      <div className="actions">
        {original && originalReady && connected ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={guard(() => original.transferTo(call))}>
            {t('call.transferComplete', { from: who(original), to: who(call) })}
          </button>
        ) : null}
        {original ? (
          // Hanging the consultation up is enough: the softphone takes the person on hold back by itself.
          <button type="button" className="btn" disabled={busy} onClick={guard(() => call.hangup())}>
            {t('call.transferCancel')}
          </button>
        ) : null}
        {connected ? (
          <>
            {/* With two calls, hold and resume belong to the consultation (automatic): no switching between the two. */}
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
              <button ref={transferButton} type="button" className="btn" aria-pressed={transfer} aria-controls={`transfer-form-${call.id}`} disabled={busy} onClick={() => (transfer ? closeTransfer() : setTransfer(true))}>
                {t('call.transfer')}
              </button>
            ) : null}
          </>
        ) : null}
        {/* Hanging up during a transfer of this call is allowed: the far end goes on to its new call without us. */}
        <button type="button" className="btn btn-danger" disabled={original?.transferring ?? false} onClick={guard(() => call.hangup())}>
          {t('call.hangup')}
        </button>
      </div>
      {transfer && connected && !hasOther ? <TransferForm call={call} onClose={closeTransfer} onError={onError} /> : null}
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
    </section>
  )
}

/**
 * Every call of the page, above the routed content: a ringing banner, the controls of the calls in progress, how
 * the last call ended (even when another goes on: a consultation that failed says so), and the last error.
 */
export const CallPanel = () => {
  const { t } = useT()
  const { calls, lastEnded, tones } = usePhone()
  const [error, setError] = useState<string | null>(null)
  if (!calls.length && !lastEnded) return null
  const ours = calls.filter(c => !(c.direction === 'inbound' && c.state === 'ringing'))
  return (
    <div className="calls" data-testid="calls">
      {calls.map(call => {
        if (call.direction === 'inbound' && call.state === 'ringing') return <Incoming key={call.id} call={call} />
        const original = call.consultationOf ? ours.find(c => c.id === call.consultationOf) : undefined
        return <Active key={call.id} call={call} tones={tones[call.id] ?? ''} hasOther={ours.length > 1} onError={setError} {...(original ? { original } : {})} />
      })}
      {lastEnded ? (
        <p className="call call-ended" role="status">
          {t(reasonKey(lastEnded), { who: who(lastEnded), message: lastEnded.endMessage ?? '' })}
        </p>
      ) : null}
      {error && calls.length ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
