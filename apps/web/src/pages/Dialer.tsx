import { Alert, Button, Grid, Stack, TextField, Typography } from '@linagora/twake-mui'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { formatNumber, toDialTarget } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { describeCallError } from '../components/callErrors.js'
import { usePhone } from '../softphone.js'

/** How long 0 is held down to type + (the international prefix), as on a phone. */
const PLUS_HOLD_MS = 600

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']]

export const Dialer = () => {
  const { t } = useT()
  const { client } = useGateway()
  const phone = usePhone()
  // The directory (beside the keypad, or a contact card) sends a number to call as ?number=: taken, then the address
  // bar is cleaned.
  const [params, setParams] = useSearchParams()
  const [number, setNumber] = useState(() => (params.get('number') ?? '').slice(0, 32))
  useEffect(() => {
    const sent = params.get('number')
    if (sent === null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the keypad is already on screen when the list beside it sends a number
    setNumber(sent.slice(0, 32))
    setParams({}, { replace: true })
  }, [params, setParams])
  // The Gateway can place the call for us (click-to-call) or the browser does it itself (softphone registered).
  const [gatewayCalls, setGatewayCalls] = useState<boolean | null>(null)
  // The dialer places the first call; a second one (a consultation before a transfer) is placed from the call panel.
  const canCall = (phone.state === 'registered' && !phone.calls.length) || (phone.state !== 'registered' && !!gatewayCalls)
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- an older message goes as the capabilities are asked again
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
  // 0 held down types + (a number abroad: + then the country code; 00 works too).
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; plus: boolean }>({ plus: false })
  const startHold = (k: string) => {
    if (k !== '0') return
    clearTimeout(hold.current.timer)
    hold.current.plus = false
    hold.current.timer = setTimeout(() => {
      hold.current.plus = true
      press('+')
    }, PLUS_HOLD_MS)
  }
  const endHold = () => clearTimeout(hold.current.timer)
  const click = (k: string) => {
    endHold()
    // The + was typed while the key was held: the click that ends it types nothing more.
    if (k === '0' && hold.current.plus) hold.current.plus = false
    else press(k)
  }
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
      <Typography variant="h5" component="h2" id="dialer-title" gutterBottom>
        {t('dialer.title')}
      </Typography>
      {gatewayCalls === false && phone.state === 'off' ? <Alert severity="info" className="u-mb-1">{t('dialer.unavailable')}</Alert> : null}
      {phone.state === 'failed' || phone.state === 'unregistered' ? <Alert severity="info" className="u-mb-1">{t('dialer.notRegistered')}</Alert> : null}
      <form onSubmit={e => void submit(e)}>
        <TextField id="number" label={t('dialer.number')} type="tel" fullWidth className="u-mb-1" slotProps={{ htmlInput: { inputMode: 'tel', autoComplete: 'off' } }} value={number} onChange={e => setNumber(e.target.value)} />
        <Grid container spacing={1} className="u-mb-1" role="group" aria-label={t('dialer.title')}>
          {KEYS.map(([k, letters]) => (
            <Grid key={k} size={4}>
            <Button
              type="button"
              variant="outlined"
              fullWidth
              onClick={() => click(k)}
              onPointerDown={() => startHold(k)}
              onPointerUp={endHold}
              onPointerLeave={endHold}
              onContextMenu={e => k === '0' && e.preventDefault()}
              aria-label={k === '0' ? t('dialer.zeroPlus') : k}
            >
              {k}
              {letters ? <Typography variant="caption" component="small" aria-hidden="true">{letters}</Typography> : null}
            </Button>
            </Grid>
          ))}
        </Grid>
        <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
          <Button type="button" variant="outlined" onClick={() => setNumber(n => n.slice(0, -1))} aria-label={t('dialer.backspace')} disabled={!number}>
            ⌫
          </Button>
          <Button type="submit" disabled={!canCall || !toDialTarget(number)}>
            {t('dialer.call')}
          </Button>
        </Stack>
      </form>
      {status ? (
        <Alert severity={status.kind} className="u-mt-1" role={status.kind === 'error' ? 'alert' : 'status'}>
          {status.text}
        </Alert>
      ) : null}
    </>
  )
}
