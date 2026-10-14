import { useEffect, useState, type FormEvent } from 'react'
import { formatNumber, toDialTarget } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']]

export const Dialer = () => {
  const { t } = useT()
  const { client } = useGateway()
  const [number, setNumber] = useState('')
  const [canCall, setCanCall] = useState<boolean | null>(null)
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .getCapabilities()
      .then(caps => !cancelled && setCanCall(!!caps.calling?.outbound))
      .catch(() => !cancelled && setCanCall(false))
    return () => {
      cancelled = true
    }
  }, [client])

  const press = (k: string) => setNumber(n => (n.length < 32 ? n + k : n))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const target = toDialTarget(number)
    if (!target) return
    setStatus({ kind: 'info', text: t('dialer.placing', { number: formatNumber(number) }) })
    try {
      await client.originate(target, crypto.randomUUID())
    } catch (err) {
      setStatus({ kind: 'error', text: t('dialer.failed', { reason: err instanceof Error ? err.message : String(err) }) })
    }
  }

  return (
    <>
      <h1>{t('dialer.title')}</h1>
      {canCall === false ? <p className="alert">{t('dialer.unavailable')}</p> : null}
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
        <p className={`alert${status.kind === 'error' ? ' alert-error' : ''}`} role="status">
          {status.text}
        </p>
      ) : null}
    </>
  )
}
