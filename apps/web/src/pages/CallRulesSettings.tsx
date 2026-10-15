import { useEffect, useState, type FormEvent } from 'react'
import type { MyPresence } from '@twake/telephony-client'
import { CHOSEN_STATUSES, chosenStatus, DEFAULT_DELAY_SEC, formFromRules, fromLocalInput, refusalKey, rulesFromForm, toLocalInput, type ChosenStatus, type ForwardingForm } from '../callRules.js'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'

type Note = { kind: 'ok' | 'error'; text: string } | null

/** 404: no telephony platform for this organisation (or no extension): nothing to set, nothing to say. */
const absent = (err: unknown) => (err as { status?: unknown } | null)?.status === 404

/** What the save said: a short confirmation (polite), or why it failed (an alert). */
const Outcome = ({ note }: { note: Note }) =>
  note?.kind === 'error' ? (
    <p className="alert alert-error" role="alert">
      {note.text}
    </p>
  ) : (
    <p className="badge" role="status">
      {note?.text ?? ''}
    </p>
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
  const timed = status !== 'available'
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
      <div className="field">
        <label htmlFor="presence-status">{t('settings.presenceStatus')}</label>
        <select id="presence-status" value={status} onChange={e => setStatus(e.target.value as ChosenStatus)} disabled={busy}>
          {CHOSEN_STATUSES.map(s => (
            <option key={s} value={s}>
              {t(`presence.${s}`)}
            </option>
          ))}
        </select>
      </div>
      {timed ? (
        <>
          <div className="field">
            <label htmlFor="presence-until">{t('settings.presenceUntilLabel')}</label>
            <input id="presence-until" type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} disabled={busy} aria-describedby="presence-until-hint" />
            <span id="presence-until-hint" className="badge">
              {t('settings.presenceUntilHint')}
            </span>
          </div>
          <div className="field">
            <label htmlFor="presence-message">{t('settings.presenceMessage')}</label>
            <input id="presence-message" type="text" maxLength={140} value={message} onChange={e => setMessage(e.target.value)} disabled={busy} aria-describedby="presence-message-hint" />
            <span id="presence-message-hint" className="badge">
              {t(status === 'dnd' ? 'settings.presenceMessageHintDnd' : 'settings.presenceMessageHint')}
            </span>
          </div>
        </>
      ) : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {t('settings.presenceSave')}
        </button>
      </div>
    </form>
  )
  return (
    <section className="card" aria-labelledby="availability">
      <h2 id="availability">{t('settings.availability')}</h2>
      {current ? (
        <>
          <p data-testid="my-presence">{t('settings.presenceNow', { summary })}</p>
          {form}
        </>
      ) : null}
      <Outcome note={note} />
    </section>
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
    setBusy(true)
    setNote(null)
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
    <div className="field">
      <label htmlFor={`forward-${key}`}>{t(label)}</label>
      <input id={`forward-${key}`} type="text" inputMode="tel" autoComplete="off" maxLength={64} value={form[key]} onChange={set(key)} disabled={busy} aria-describedby="forward-hint" />
    </div>
  )
  return (
    <section className="card" aria-labelledby="forwarding">
      <h2 id="forwarding">{t('settings.forwarding')}</h2>
      <p id="forward-hint" className="badge">
        {t('settings.forwardingHint')}
      </p>
      {loaded ? (
        <form onSubmit={e => void save(e)}>
          {field('always', 'settings.forwardAlways')}
          {field('busy', 'settings.forwardBusy')}
          <fieldset className="field">
            <legend>{t('settings.forwardNoAnswerGroup')}</legend>
            {field('noAnswer', 'settings.forwardNoAnswer')}
            <div className="field">
              <label htmlFor="forward-delay">{t('settings.forwardDelay')}</label>
              <input id="forward-delay" type="number" inputMode="numeric" min={2} max={120} step={1} value={form.delaySec} onChange={set('delaySec')} disabled={busy} />
            </div>
          </fieldset>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
              {t('settings.forwardingSave')}
            </button>
          </div>
        </form>
      ) : null}
      <Outcome note={note} />
    </section>
  )
}
