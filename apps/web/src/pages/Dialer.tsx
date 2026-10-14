import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { formatNumber, toDialTarget } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { describeCallError } from '../components/callErrors.js'
import { usePhone } from '../softphone.js'

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']]

export const Dialer = () => {
  const { t } = useT()
  const { client } = useGateway()
  const phone = usePhone()
  // The directory sends a number to call as ?number=: taken once, then the address bar is cleaned.
  const [params, setParams] = useSearchParams()
  const [number, setNumber] = useState(() => (params.get('number') ?? '').slice(0, 32))
  useEffect(() => {
    if (params.has('number')) setParams({}, { replace: true })
  }, [params, setParams])
  // The Gateway can place the call for us (click-to-call) or the browser does it itself (softphone registered).
  const [gatewayCalls, setGatewayCalls] = useState<boolean | null>(null)
  // The dialer places the first call; a second one (a consultation before a transfer) is placed from the call panel.
  const canCall = (phone.state === 'registered' && !phone.calls.length) || (phone.state !== 'registered' && !!gatewayCalls)
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    client
      .getCapabilities()
      .then(caps => !cancelled && setGatewayCalls(!!caps.calling?.outbound))
      .catch((err: unknown) => {
        if (cancelled) return
        // 404 is the Gateway saying "no telephony provider on this platform": calling is not configured, which is not an error.
        // Anything else (401, network) is reported as such, and calling stays possible to retry.
        if (err instanceof Error && /Gateway 404 /.test(err.message)) setGatewayCalls(false)
        else setStatus({ kind: 'error', text: t('dialer.capabilitiesFailed', { reason: err instanceof Error ? err.message : String(err) }) })
      })
    return () => {
      cancelled = true
    }
  }, [client, t])

  const press = (k: string) => setNumber(n => (n.length < 32 ? n + k : n))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const target = toDialTarget(number)
    if (!target) return
    setStatus({ kind: 'info', text: t('dialer.placing', { number: formatNumber(number) }) })
    try {
      if (phone.state === 'registered') {
        // The call panel takes over from here: the status line has nothing more to say.
        await phone.call(target)
        setStatus(null)
        setNumber('')
      } else if (gatewayCalls) {
        await client.originate(target, crypto.randomUUID())
        setStatus({ kind: 'info', text: t('dialer.placed', { number: formatNumber(number) }) })
      } else {
        setStatus({ kind: 'error', text: t('dialer.notRegistered') })
      }
    } catch (err) {
      setStatus({ kind: 'error', text: t('dialer.failed', { reason: describeCallError(err, t) }) })
    }
  }

  return (
    <>
      <h1>{t('dialer.title')}</h1>
      {gatewayCalls === false && phone.state === 'off' ? <p className="alert">{t('dialer.unavailable')}</p> : null}
      {phone.state === 'failed' || phone.state === 'unregistered' ? <p className="alert">{t('dialer.notRegistered')}</p> : null}
      <form onSubmit={e => void submit(e)}>
        <div className="field">
          <label htmlFor="number">{t('dialer.number')}</label>
          <input id="number" className="number" type="tel" inputMode="tel" autoComplete="off" value={number} onChange={e => setNumber(e.target.value)} />
        </div>
        <div className="keypad" role="group" aria-label={t('dialer.title')}>
          {KEYS.map(([k, letters]) => (
            <button key={k} type="button" className="btn key" onClick={() => press(k)} aria-label={k}>
              {k}
              {letters ? <small aria-hidden="true">{letters}</small> : null}
            </button>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setNumber(n => n.slice(0, -1))} aria-label={t('dialer.backspace')} disabled={!number}>
            ⌫
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canCall || !toDialTarget(number)}>
            {t('dialer.call')}
          </button>
        </div>
      </form>
      {status ? (
        <p className={`alert${status.kind === 'error' ? ' alert-error' : ''}`} role={status.kind === 'error' ? 'alert' : 'status'}>
          {status.text}
        </p>
      ) : null}
    </>
  )
}
