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
  // Twake Chat sends a number to call as ?dial= (ADR 0031): validated and normalised here, never dialled from the link
  // itself (a page cannot make the app place a call), only put in the field with the Call button focused once calling is possible.
  const [dialed, setDialed] = useState(() => (params.has('dial') ? toDialTarget(params.get('dial') ?? '') : undefined))
  // Set when a link brings a number, cleared once Call got the focus: a later change of state does not move the focus.
  const focusCall = useRef(!!dialed)
  const [number, setNumber] = useState(() => dialed ?? (params.get('number') ?? '').slice(0, 32))
  useEffect(() => {
    const sent = params.get('number')
    if (params.has('dial')) {
      const target = toDialTarget(params.get('dial') ?? '')
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the keypad may already be on screen when a link sends a number
      setDialed(target)
      if (target) {
        setNumber(target)
        focusCall.current = true
      }
    } else if (sent !== null) {
      setNumber(sent.slice(0, 32))
    } else return
    setParams({}, { replace: true })
  }, [params, setParams])
  // The Gateway can place the call for us (click-to-call) or the browser does it itself (softphone registered).
  const [gatewayCalls, setGatewayCalls] = useState<boolean | null>(null)
  // Click-to-call (ADR 0033): the Gateway can also ring the person's own phone (desk phone, Linphone) and have it call.
  const [onPhone, setOnPhone] = useState(false)
  // One click-to-call at a time: a second click would ring the phone twice.
  const [ringing, setRinging] = useState(false)
  // The dialer places the first call; a second one (a consultation before a transfer) is placed from the call panel.
  // The Gateway places the call (click-to-call, ADR 0033) when this browser has no phone at all; a browser whose phone is
  // connecting or failed waits for it (its own button rings the person's phone instead).
  const canCall = (phone.state === 'registered' && !phone.calls.length) || (phone.state === 'off' && !!gatewayCalls)
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const callButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!focusCall.current || !canCall) return
    focusCall.current = false
    callButton.current?.focus()
  }, [number, canCall])

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- an older message goes as the capabilities are asked again
    setStatus(null)
    client
      .getCapabilities()
      .then(caps => {
        if (cancelled) return
        setGatewayCalls(!!caps.calling?.outbound)
        setOnPhone(!!caps.clickToCall)
      })
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
  const callOnPhone = async (target: string) => {
    await client.originate(target, crypto.randomUUID())
    setStatus({ kind: 'info', text: t('dialer.placed', { number: formatNumber(number) }) })
  }
  const submitOnPhone = async () => {
    const target = toDialTarget(number)
    if (!target || ringing) return
    setRinging(true)
    setStatus({ kind: 'info', text: t('dialer.placing', { number: formatNumber(number) }) })
    try {
      await callOnPhone(target)
    } catch (err) {
      setStatus({ kind: 'error', text: t('dialer.failed', { reason: describeCallError(err, t) }) })
    } finally {
      setRinging(false)
    }
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
      } else if (phone.state === 'off' && gatewayCalls) {
        await callOnPhone(target)
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
      {gatewayCalls === false && phone.state === 'off' ? <Alert severity="info" role="status" className="u-mb-1">{t('dialer.unavailable')}</Alert> : null}
      {dialed === null && !number ? <Alert severity="error" role="alert" className="u-mb-1">{t('dialer.invalidDial')}</Alert> : null}
      {phone.state === 'failed' || phone.state === 'unregistered' ? <Alert severity="info" role="status" className="u-mb-1">{t('dialer.notRegistered')}</Alert> : null}
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
          <Button ref={callButton} type="submit" disabled={!canCall || !toDialTarget(number)}>
            {t('dialer.call')}
          </Button>
          {/* This browser has a phone: the person may still ring their own phone instead. Never from a link alone (ADR 0031). */}
          {onPhone && phone.state !== 'off' ? (
            <Button type="button" variant="outlined" onClick={() => void submitOnPhone()} disabled={ringing || !toDialTarget(number)}>
              {t('dialer.callOnPhone')}
            </Button>
          ) : null}
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
