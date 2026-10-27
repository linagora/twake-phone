import { Alert, Button, Card, CardContent, FormControl, FormLabel, Stack, TextField, Typography } from '@linagora/twake-mui'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { MyPresence } from '@twake/telephony-client'
import { chosenStatus, DEFAULT_DELAY_SEC, DELAY_SEC, delayValid, formFromRules, fromLocalInput, refusalKey, rulesFromForm, statusOptions, timedStatus, toLocalInput, type ChosenStatus, type ForwardingForm } from '../callRules.js'
import { formatNumber } from '../format.js'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'

type Note = { kind: 'ok' | 'error'; text: string } | null

/** 404: no telephony platform for this organisation (or no extension): nothing to set, nothing to say. */
const absent = (err: unknown) => (err as { status?: unknown } | null)?.status === 404

/** What the save said: a short confirmation (polite), or why it failed (an alert). */
const Outcome = ({ note }: { note: Note }) =>
  note?.kind === 'error' ? (
    <Alert severity="error" role="alert">
      {note.text}
    </Alert>
  ) : (
    <Typography variant="body2" color="textSecondary" component="p" role="status">
      {note?.text ?? ''}
    </Typography>
  )

const Hint = ({ id, children }: { id: string; children: ReactNode }) => (
  <Typography id={id} variant="body2" color="textSecondary" component="span" className="u-db u-mb-1">
    {children}
  </Typography>
)

/**
 * The person's own availability: available, absent or "do not disturb", the last two until a date if they want, with
 * a message for whoever calls. A "do not disturb" sends calls to the forward, or refuses them with that message.
 * The form shows once the current choice is read: nothing typed before it arrives is overwritten by it.
 */
export const PresenceSettings = () => {
  const { t, lang } = useT()
  const { client } = useGateway()
  const [status, setStatus] = useState<ChosenStatus>('available')
  const [until, setUntil] = useState('')
  const [message, setMessage] = useState('')
  const [current, setCurrent] = useState<MyPresence | null>(null)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const show = (p: MyPresence) => {
    setCurrent(p)
    setStatus(chosenStatus(p.choice))
    setUntil(toLocalInput(p.choice?.until))
    setMessage(p.choice?.message ?? '')
  }
  useEffect(() => {
    let cancelled = false
    client
      .getPresence()
      .then(p => !cancelled && show(p))
      .catch(err => {
        if (cancelled) return
        if (absent(err)) setHidden(true)
        else setNote({ kind: 'error', text: t('settings.presenceLoadError') })
      })
    return () => {
      cancelled = true
    }
  }, [client, t])
  if (hidden) return null
  const timed = timedStatus(status)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setNote(null)
    try {
      const end = timed ? fromLocalInput(until) : undefined
      const text = timed ? message.trim() : ''
      show(await client.setPresence(status, { ...(end ? { until: end } : {}), ...(text ? { message: text } : {}) }))
      setNote({ kind: 'ok', text: t('settings.presenceSaved') })
    } catch (err) {
      setNote({ kind: 'error', text: t(refusalKey(err) ?? 'settings.presenceSaveError') })
    } finally {
      setBusy(false)
    }
  }
  const choice = current?.choice
  const summary =
    choice && choice.status !== 'available'
      ? choice.until
        ? t('settings.presenceUntil', { status: t(`presence.${choice.status}`), date: new Date(choice.until).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) })
        : t(`presence.${choice.status}`)
      : t('presence.available')
  const form = (
    <form onSubmit={e => void save(e)}>
      <TextField
        select
        id="presence-status"
        label={t('settings.presenceStatus')}
        value={status}
        onChange={e => setStatus(e.target.value as ChosenStatus)}
        disabled={busy}
        fullWidth
        className="u-mb-1"
        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      >
        {statusOptions(chosenStatus(current?.choice)).map(s => (
          <option key={s} value={s}>
            {t(`presence.${s}`)}
          </option>
        ))}
      </TextField>
      {timed ? (
        <>
          <TextField
            id="presence-until"
            type="datetime-local"
            label={t('settings.presenceUntilLabel')}
            value={until}
            onChange={e => setUntil(e.target.value)}
            disabled={busy}
            fullWidth
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-describedby': 'presence-until-hint' } }}
          />
          <Hint id="presence-until-hint">{t('settings.presenceUntilHint')}</Hint>
          <TextField
            id="presence-message"
            type="text"
            label={t('settings.presenceMessage')}
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={busy}
            fullWidth
            slotProps={{ htmlInput: { maxLength: 140, 'aria-describedby': 'presence-message-hint' } }}
          />
          <Hint id="presence-message-hint">
            {t('settings.presenceMessageHint')} {status === 'dnd' ? t('settings.presenceMessageHintDnd') : null}
          </Hint>
        </>
      ) : null}
      <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-mb-1">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {t('settings.presenceSave')}
        </Button>
      </Stack>
    </form>
  )
  return (
    <Card component="section" variant="outlined" aria-labelledby="availability" className="u-mb-1">
      <CardContent>
        <Typography variant="h5" component="h2" id="availability" gutterBottom>
          {t('settings.availability')}
        </Typography>
        {current ? (
          <>
            <Typography component="p" data-testid="my-presence" className="u-mb-1">
              {t('settings.presenceNow', { summary })}
            </Typography>
            {form}
          </>
        ) : null}
        <Outcome note={note} />
      </CardContent>
    </Card>
  )
}

const EMPTY: ForwardingForm = { always: '', busy: '', noAnswer: '', delaySec: String(DEFAULT_DELAY_SEC) }

/**
 * Where the person's calls go instead of ringing them: always, when busy (or declined), when nobody answers. Only
 * with an extension, on a platform that forwards; the form shows once the current rules are read.
 */
export const ForwardingSettings = () => {
  const { t } = useT()
  const { client, me } = useGateway()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [form, setForm] = useState<ForwardingForm>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const extension = me?.extension
  useEffect(() => {
    if (!extension) return
    let cancelled = false
    client
      .getCapabilities()
      .then(async caps => {
        if (cancelled) return
        setAvailable(!!caps.forwarding)
        if (!caps.forwarding) return
        const rules = await client.getForwarding()
        if (cancelled) return
        setForm(formFromRules(rules))
        setLoaded(true)
      })
      .catch(err => {
        if (cancelled) return
        if (absent(err)) setAvailable(false)
        else setNote({ kind: 'error', text: t('settings.forwardingLoadError') })
      })
    return () => {
      cancelled = true
    }
  }, [client, extension, t])
  if (!extension || available === false) return null
  const set = (key: keyof ForwardingForm) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    if (!delayValid(form)) {
      setNote({ kind: 'error', text: t('settings.forwardDelayInvalid') })
      return
    }
    setBusy(true)
    try {
      setForm(formFromRules(await client.setForwarding(rulesFromForm(form))))
      setNote({ kind: 'ok', text: t('settings.forwardingSaved') })
    } catch (err) {
      setNote({ kind: 'error', text: t(refusalKey(err) ?? 'settings.forwardingSaveError') })
    } finally {
      setBusy(false)
    }
  }
  const field = (key: 'always' | 'busy' | 'noAnswer', label: 'settings.forwardAlways' | 'settings.forwardBusy' | 'settings.forwardNoAnswer') => (
    <TextField
      id={`forward-${key}`}
      type="text"
      label={t(label)}
      value={form[key]}
      onChange={set(key)}
      disabled={busy}
      fullWidth
      className="u-mb-1"
      slotProps={{ htmlInput: { inputMode: 'tel', autoComplete: 'off', maxLength: 64, 'aria-describedby': 'forward-hint' } }}
    />
  )
  return (
    <Card component="section" variant="outlined" aria-labelledby="forwarding" className="u-mb-1">
      <CardContent>
      <Typography variant="h5" component="h2" id="forwarding" gutterBottom>
        {t('settings.forwarding')}
      </Typography>
      <Typography id="forward-hint" variant="body2" color="textSecondary" component="p" className="u-mb-1">
        {t('settings.forwardingHint')}
      </Typography>
      {loaded ? (
        <form onSubmit={e => void save(e)}>
          {field('always', 'settings.forwardAlways')}
          {field('busy', 'settings.forwardBusy')}
          <FormControl component="fieldset" className="u-mb-1 u-w-100">
            <FormLabel component="legend">{t('settings.forwardNoAnswerGroup')}</FormLabel>
            {field('noAnswer', 'settings.forwardNoAnswer')}
            <TextField
              id="forward-delay"
              type="number"
              label={t('settings.forwardDelay')}
              value={form.delaySec}
              onChange={set('delaySec')}
              disabled={busy}
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'numeric', min: DELAY_SEC.min, max: DELAY_SEC.max, step: 1, 'aria-describedby': 'forward-delay-hint' } }}
            />
            <Hint id="forward-delay-hint">{t('settings.forwardDelayHint')}</Hint>
          </FormControl>
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-mb-1">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {t('settings.forwardingSave')}
            </Button>
          </Stack>
        </form>
      ) : null}
      <Outcome note={note} />
      </CardContent>
    </Card>
  )
}

/**
 * Where the person's emergency calls leave from (step 6c, ADR 0024): the site they are in, with its address and the
 * number it presents, or that none is attributed to them. Nothing without trunks (no public network, no emergency calls).
 */
export const EmergencySiteSettings = () => {
  const { t } = useT()
  const { client } = useGateway()
  const [state, setState] = useState<{ enabled: boolean; site?: { name: string; address: string; number: string } } | 'error' | null>(null)
  useEffect(() => {
    let cancelled = false
    client
      .getEmergencySite()
      .then(r => !cancelled && setState(r))
      .catch(err => !cancelled && setState(absent(err) ? { enabled: false } : 'error'))
    return () => {
      cancelled = true
    }
  }, [client])
  if (state === null || (state !== 'error' && !state.enabled)) return null
  return (
    <Card component="section" variant="outlined" aria-labelledby="emergency" className="u-mb-1">
      <CardContent>
        <Typography variant="h5" component="h2" id="emergency" gutterBottom>
          {t('settings.emergency.title')}
        </Typography>
        {state === 'error' ? (
          <Alert severity="error" role="alert">
            {t('settings.emergency.error')}
          </Alert>
        ) : (
          <Typography component="p">{state.site ? t('settings.emergency.site', { ...state.site, number: formatNumber(state.site.number) }) : t('settings.emergency.none')}</Typography>
        )}
      </CardContent>
    </Card>
  )
}
