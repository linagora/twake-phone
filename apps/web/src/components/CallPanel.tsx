import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import type { SoftCall } from '@twake/softphone'
import { formatNumber, toDialTarget } from '@twake/telephony-client'
import type { ConferenceParticipant } from '@twake/telephony-types'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { usePhone } from '../softphone.js'
import { describeCallError, describeConferenceError } from './callErrors.js'

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
  dnd: 'call.endedDnd',
  'answered-elsewhere': 'call.endedAnsweredElsewhere',
  refused: 'call.endedRefusedNotAllowed',
  conference: 'call.endedConference'
}

/** Why the SIP server did not put a number through to the public network (step 6): an emergency number first. */
const REFUSAL_KEY: Record<NonNullable<SoftCall['endRefusal']>, Key> = {
  emergency: 'call.endedRefusedEmergency',
  premium: 'call.endedRefusedPremium',
  international: 'call.endedRefusedInternational',
  overseas: 'call.endedRefusedOverseas',
  invalid: 'call.endedRefusedInvalid',
  'no-trunk': 'call.endedRefusedNoTrunk',
  rights: 'call.endedRefusedRights',
  limit: 'call.endedRefusedLimit',
  fraud: 'call.endedRefusedFraud',
  'policy-unavailable': 'call.endedRefusedPolicyUnavailable',
  'not-allowed': 'call.endedRefusedNotAllowed'
}

/** The far end, by name and number; a caller from the public network who hides their number (step 6) said so. */
const who = (call: SoftCall, t: (key: Key) => string) => {
  const number = call.remoteNumber === 'anonymous' ? t('call.hiddenNumber') : formatNumber(call.remoteNumber)
  return call.remoteName && call.remoteName.toLowerCase() !== 'anonymous' ? `${call.remoteName} (${number})` : number
}

/**
 * How a call ended, for the person: a ringing call of theirs cancelled was answered elsewhere, or given up; one
 * refused by a "do not disturb" says the message the person called left, when they left one; a number the platform
 * does not call says why (an emergency number: to call from another phone).
 */
const reasonKey = (call: SoftCall): Key => {
  // A conference's call (step 8b) names whoever the room called at: not who the person was with.
  if (call.room === 'conference' && (call.endReason ?? 'hangup') === 'hangup') return 'call.endedConferenceOver'
  if (call.direction === 'inbound' && call.endReason === 'cancelled') return 'call.endedCancelledInbound'
  if (call.endReason === 'dnd' && call.endMessage) return 'call.endedDndMessage'
  if (call.endReason === 'refused') return REFUSAL_KEY[call.endRefusal ?? 'not-allowed']
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
  const act = (fn: () => Promise<void>) => () => {
    void (async () => {
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
    })()
  }
  // A live region, not a dialog: nothing traps the focus, the person keeps typing where they were.
  return (
    <section className="call call-incoming" role="region" aria-labelledby={`call-${call.id}`} aria-live="assertive" data-testid="incoming-call">
      <p id={`call-${call.id}`} className="call-title">
        {t('call.incoming', { who: who(call, t) })}
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

/** How often the participants of a conference are read again (the Gateway's reads are limited to 60 a minute). */
const PARTICIPANTS_EVERY_MS = 5_000

/**
 * Whom to add to a conference (step 8b): typed once, then called by the room. `run` makes the conference first when
 * the call is not one yet. The form closes as soon as it is sent: the call shows the progress, the panel any error.
 */
const AddParticipantForm = ({ id, run, onClose, onError, making }: { id: string; run: (number: string) => Promise<void>; onClose: () => void; onError: (message: string | null) => void; making: boolean }) => {
  const { t } = useT()
  const [target, setTarget] = useState('')
  const dialable = toDialTarget(target)
  const submit = (e: SyntheticEvent) => {
    e.preventDefault()
    if (!dialable) return
    onError(null)
    onClose()
    run(dialable).catch((err: unknown) => onError(describeConferenceError(err, t, { making, who: formatNumber(dialable) })))
  }
  return (
    <form id={id} className="transfer" onSubmit={submit} data-testid="add-participant-form">
      <div className="field">
        <label htmlFor={`${id}-target`}>{t('call.addParticipantTarget')}</label>
        <input id={`${id}-target`} type="tel" inputMode="tel" autoComplete="off" value={target} onChange={e => setTarget(e.target.value)} />
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!dialable}>
          {t('call.addParticipantSubmit')}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t('call.addParticipantClose')}
        </button>
      </div>
    </form>
  )
}

/** A participant of a conference, as the room has them: their number (or name), for the person. */
const participantLabel = (p: ConferenceParticipant) => (p.number ? formatNumber(p.number) : (p.displayName ?? p.id))

/**
 * Who a conference's panel takes as already there at its first read: the two of us when it came out of our call and
 * its far end (`party`) is found (the others came after, and are told), else everyone then in it.
 */
const firstKnown = (participants: ConferenceParticipant[], us: { party?: string; me?: string }) => {
  const all = new Map(participants.map(p => [p.id, participantLabel(p)] as const))
  if (!us.party || !participants.some(p => p.number === us.party)) return all
  return new Map(participants.filter(p => p.number === us.party || (!!us.me && p.number === us.me)).map(p => [p.id, participantLabel(p)] as const))
}

/**
 * A short chime when someone joins a conference (review 8b, n°2): the room plays none, and a participant nobody sees
 * coming must at least be heard. Nothing when the browser has no sound for the page (it says so elsewhere).
 */
const chime = () => {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const tone = ctx.createOscillator()
    const gain = ctx.createGain()
    tone.frequency.value = 880
    gain.gain.value = 0.08
    tone.connect(gain).connect(ctx.destination)
    tone.start()
    tone.stop(ctx.currentTime + 0.15)
    tone.onended = () => void ctx.close().catch(() => undefined)
  } catch {
    // No sound: the notice is written all the same.
  }
}

/**
 * The participants of a conference, read every few seconds and after each action on one. Every participant of the
 * conference sees them (review 8b, n°2); the one who made it (`manage`) also mutes or removes one. Who comes in or
 * leaves is told (`onNotice`, the panel's status region) with a chime for an arrival. Who is already there at the first
 * read the panel gets is news too when the conference came out of our call (`party`, the far end of that call): all
 * but the two of us, however late that read comes (a read refused, slow, or after a quick answer). Without it (a third
 * participant's panel), or when the far end is not found by its number, the first read is who was there. After an
 * action whose button goes (a participant muted or removed), the focus goes to the list, not to the top of the page.
 */
export const Participants = ({ meetingId, manage, party, onError, onNotice }: { meetingId: string; manage: boolean; party?: string; onError: (message: string | null) => void; onNotice: (message: string) => void }) => {
  const { t } = useT()
  const { client, me } = useGateway()
  const [people, setPeople] = useState<ConferenceParticipant[] | null>(null)
  const [version, setVersion] = useState(0)
  const known = useRef<Map<string, string> | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const acted = useRef(false)
  const notice = useRef(onNotice)
  // eslint-disable-next-line react-hooks/refs -- the latest callback, read by the reads without restarting them
  notice.current = onNotice
  const us = useRef<{ party?: string; me?: string }>({})
  // eslint-disable-next-line react-hooks/refs -- read at the first answer only, without restarting the reads
  us.current = { ...(party ? { party } : {}), ...(me?.extension ? { me: me.extension } : {}) }
  useEffect(() => {
    let cancelled = false
    const read = () =>
      client.getCallConference(meetingId).then(
        c => {
          if (cancelled) return
          const now = new Map(c.participants.map(p => [p.id, participantLabel(p)] as const))
          const before = known.current ?? firstKnown(c.participants, us.current)
          known.current = now
          const joined = [...now].filter(([id]) => !before.has(id)).map(([, label]) => label)
          const left = [...before].filter(([id]) => !now.has(id)).map(([, label]) => label)
          for (const who of joined) notice.current(t('conference.joined', { who }))
          for (const who of left) notice.current(t('conference.left', { who }))
          if (joined.length) chime()
          setPeople(c.participants)
        },
        () => undefined
      )
    void read()
    const timer = setInterval(() => void read(), PARTICIPANTS_EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, meetingId, version, t])
  useEffect(() => {
    if (!acted.current) return
    acted.current = false
    if (!document.activeElement || document.activeElement === document.body) list.current?.focus()
  }, [people])
  const act = (fn: () => Promise<void>) => () => {
    void (async () => {
      onError(null)
      try {
        await fn()
      } catch (err) {
        onError(describeConferenceError(err, t))
      } finally {
        acted.current = true
        setVersion(v => v + 1)
      }
    })()
  }
  if (!people) return <p className="badge">{t('conference.loading')}</p>
  return (
    <ul ref={list} tabIndex={-1} className="list participants" aria-label={t('conference.participants')} data-testid="conference-participants">
      {people.map(p => {
        const label = participantLabel(p)
        const self = !!me?.extension && p.number === me.extension
        return (
          <li key={p.id} data-testid="conference-participant">
            <span>
              {label}
              {self ? ` ${t('conference.you')}` : ''}
              {p.muted ? (
                <>
                  {' '}
                  <span className="badge">{t('conference.muted')}</span>
                </>
              ) : null}
            </span>
            {manage && !self ? (
              <span className="actions">
                {!p.muted ? (
                  <button type="button" className="btn" aria-label={t('conference.muteWho', { who: label })} onClick={act(() => client.muteParticipant(meetingId, p.id))}>
                    {t('conference.mute')}
                  </button>
                ) : null}
                <button type="button" className="btn" aria-label={t('conference.removeWho', { who: label })} onClick={act(() => client.removeParticipant(meetingId, p.id))}>
                  {t('conference.remove')}
                </button>
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A question asked in place (« Terminer pour tous », leaving a conference one made: review 8b, n°7 and n°11): the focus
 * goes to it when it opens, and back to the button that opened it when it is answered "no".
 */
const Confirm = ({ id, question, children }: { id: string; question: string; children: ReactNode }) => {
  const text = useRef<HTMLParagraphElement>(null)
  useEffect(() => text.current?.focus(), [])
  return (
    <div className="confirm" role="group" aria-labelledby={id} data-testid="conference-confirm">
      <p id={id} ref={text} tabIndex={-1}>
        {question}
      </p>
      <div className="actions">{children}</div>
    </div>
  )
}

/**
 * A call of a conference (step 8b). Everyone in it sees who is there (the room its SIP server named: `conferenceRoom`,
 * or the one this window made); the window that made it (`conferenceOf`) also adds more, removes or mutes one, and
 * ends it for everyone; anyone else mutes their microphone or leaves. Leaving is hanging up one's own call: the others
 * go on. The one who made it is asked first (the others go on at their name), and ending it for all asks too. When the
 * conference shows in place of the call (the call panel changed under the person), the focus goes to its title.
 */
const ConferenceCall = ({ call, tones, onError, onNotice }: { call: SoftCall; tones: string; onError: (message: string | null) => void; onNotice: (message: string) => void }) => {
  const { t } = useT()
  const phone = usePhone()
  const { client } = useGateway()
  const [adding, setAdding] = useState(false)
  const [asking, setAsking] = useState<'leave' | 'end' | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const leaveButton = useRef<HTMLButtonElement>(null)
  const endButton = useRef<HTMLButtonElement>(null)
  const title = useRef<HTMLParagraphElement>(null)
  const mine = !!call.conferenceOf
  const meetingId = call.conferenceOf ? phone.rooms[call.conferenceOf] : call.conferenceRoom
  const inviting = mine && meetingId ? (phone.inviting[meetingId] ?? []) : []
  const connected = call.state === 'connected' || call.state === 'held'
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) title.current?.focus()
  }, [])
  const guard = (fn: () => Promise<void> | void) => () => {
    void (async () => {
      onError(null)
      try {
        await fn()
      } catch (err) {
        onError(describeConferenceError(err, t))
      }
    })()
  }
  const closeAdd = () => {
    setAdding(false)
    addButton.current?.focus()
  }
  const closeAsk = () => {
    const back = asking === 'end' ? endButton : leaveButton
    setAsking(null)
    back.current?.focus()
  }
  const endForAll = guard(async () => {
    setAsking(null)
    if (meetingId) await client.endCallConference(meetingId)
  })
  return (
    <section className="call call-conference" aria-labelledby={`call-${call.id}`} data-testid="conference">
      <p id={`call-${call.id}`} ref={title} tabIndex={-1} className="call-title">
        {mine ? t('conference.title') : t('conference.titleWith', { who: who(call, t) })}
      </p>
      {connected && call.connectedAt ? <Timer since={call.connectedAt} /> : null}
      {mine && !meetingId ? <p className="badge">{t('conference.starting')}</p> : null}
      {inviting.map(n => (
        <p key={n} className="badge">
          {t('conference.inviting', { who: formatNumber(n) })}
        </p>
      ))}
      {tones ? <p className="badge">{t('call.tonesReceived', { tones })}</p> : null}
      {meetingId ? <Participants meetingId={meetingId} manage={mine} {...(call.conferenceWith ? { party: call.conferenceWith } : {})} onError={onError} onNotice={onNotice} /> : null}
      <div className="actions">
        {connected ? (
          <button type="button" className="btn" aria-pressed={call.muted} onClick={guard(() => call.setMuted(!call.muted))}>
            {call.muted ? t('call.unmute') : t('call.mute')}
          </button>
        ) : null}
        {mine && meetingId ? (
          <button ref={addButton} type="button" className="btn" aria-pressed={adding} aria-controls={`add-${call.id}`} onClick={() => (adding ? closeAdd() : setAdding(true))}>
            {t('call.addParticipant')}
          </button>
        ) : null}
        <button ref={leaveButton} type="button" className="btn btn-danger" aria-expanded={mine && meetingId ? asking === 'leave' : undefined} onClick={mine && meetingId ? () => setAsking('leave') : guard(() => call.hangup())}>
          {t('conference.leave')}
        </button>
        {mine && meetingId ? (
          <button ref={endButton} type="button" className="btn btn-danger" aria-expanded={asking === 'end'} onClick={() => setAsking('end')}>
            {t('conference.end')}
          </button>
        ) : null}
      </div>
      {asking === 'leave' ? (
        <Confirm id={`ask-${call.id}`} question={t('conference.leaveConfirm')}>
          <button type="button" className="btn btn-danger" onClick={endForAll}>
            {t('conference.end')}
          </button>
          <button type="button" className="btn" onClick={guard(() => call.hangup())}>
            {t('conference.leaveOnly')}
          </button>
          <button type="button" className="btn" onClick={closeAsk}>
            {t('conference.cancel')}
          </button>
        </Confirm>
      ) : null}
      {asking === 'end' ? (
        <Confirm id={`ask-${call.id}`} question={t('conference.endConfirm')}>
          <button type="button" className="btn btn-danger" onClick={endForAll}>
            {t('conference.endConfirmYes')}
          </button>
          <button type="button" className="btn" onClick={closeAsk}>
            {t('conference.cancel')}
          </button>
        </Confirm>
      ) : null}
      {adding && mine && meetingId ? <AddParticipantForm id={`add-${call.id}`} making={false} run={n => phone.inviteToConference(meetingId, n)} onClose={closeAdd} onError={onError} /> : null}
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
  const run = (fn: (target: string) => Promise<unknown>) => (e: SyntheticEvent) => {
    e.preventDefault()
    if (!dialable) return
    void (async () => {
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
    })()
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
        <button type="button" className="btn" disabled={busy || !dialable} onClick={run(to => phone.call(to))}>
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
  const phone = usePhone()
  const [keypad, setKeypad] = useState(false)
  const [transfer, setTransfer] = useState(false)
  const [adding, setAdding] = useState(false)
  const [sent, setSent] = useState('')
  const transferButton = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const connected = call.state === 'connected' || call.state === 'held'
  const guard = (fn: () => Promise<void> | void) => () => {
    void (async () => {
      onError(null)
      try {
        await fn()
      } catch (err) {
        onError(describeCallError(err, t))
      }
    })()
  }
  // The form goes, the focus comes back to the button that opened it (not to the top of the page).
  const closeTransfer = () => {
    setTransfer(false)
    transferButton.current?.focus()
  }
  const closeAdd = () => {
    setAdding(false)
    addButton.current?.focus()
  }
  // A call a room places (step 8) is neither held nor transferred; a call between two people can become a
  // conference (step 8b), once nothing else is going on and both are on line: never a call either side holds (the
  // room would bring the other back unheld, review 8b, n°1). While it becomes one, the form stays (it says so), and
  // the call is neither held nor transferred (second review 8b, n°2).
  const room = !!call.room
  const canAdd = phone.conferenceAvailable && !room && !hasOther && !original && (call.conferencing || (call.state === 'connected' && !call.remoteHold))
  const title = call.transferring
    ? t('call.transferringWho', { who: who(call, t) })
    : !connected
      ? t('call.dialing', { who: who(call, t) })
      : call.state === 'held'
        ? t('call.held', { who: who(call, t) })
        : t('call.inProgress', { who: who(call, t) })
  const originalReady = original && (original.state === 'connected' || original.state === 'held')
  // While the transfer of the original is on its way, the consultation must stay: its dialog is what the far end
  // takes over (Replaces); hanging it up first would make the transfer fail.
  const busy = call.renegotiating || call.transferring || call.conferencing || (original?.transferring ?? false)
  return (
    <section className="call" aria-labelledby={`call-${call.id}`} data-testid={original ? 'consultation' : undefined}>
      <p id={`call-${call.id}`} className="call-title" role="status">
        {title}
      </p>
      {connected && call.connectedAt ? <Timer since={call.connectedAt} /> : null}
      {original ? <p className="badge">{t('call.consulting', { who: who(original, t) })}</p> : null}
      {call.remoteHold ? <p className="badge">{t('call.remoteHold')}</p> : null}
      {original?.transferring ? <p className="badge">{t('call.transferring')}</p> : null}
      {tones ? <p className="badge">{t('call.tonesReceived', { tones })}</p> : null}
      <div className="actions">
        {original && originalReady && connected ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={guard(() => original.transferTo(call))}>
            {t('call.transferComplete', { from: who(original, t), to: who(call, t) })}
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
            {!room ? (
              <button type="button" className="btn" aria-pressed={call.state === 'held'} disabled={busy || hasOther} onClick={guard(() => (call.state === 'held' ? call.resume() : call.hold()))}>
                {call.state === 'held' ? t('call.resume') : t('call.hold')}
              </button>
            ) : null}
            <button type="button" className="btn" aria-pressed={call.muted} onClick={guard(() => call.setMuted(!call.muted))}>
              {call.muted ? t('call.unmute') : t('call.mute')}
            </button>
            <button type="button" className="btn" aria-pressed={keypad} aria-controls={`dtmf-${call.id}`} onClick={() => setKeypad(k => !k)}>
              {t('call.keypad')}
            </button>
            {!hasOther && !room ? (
              <button ref={transferButton} type="button" className="btn" aria-pressed={transfer} aria-controls={`transfer-form-${call.id}`} disabled={busy} onClick={() => (transfer ? closeTransfer() : setTransfer(true))}>
                {t('call.transfer')}
              </button>
            ) : null}
            {canAdd ? (
              <button ref={addButton} type="button" className="btn" aria-pressed={adding} aria-controls={`add-${call.id}`} disabled={busy} onClick={() => (adding ? closeAdd() : setAdding(true))}>
                {t('call.addParticipant')}
              </button>
            ) : null}
          </>
        ) : null}
        {/* Hanging up during a transfer of this call is allowed: the far end goes on to its new call without us. */}
        <button type="button" className="btn btn-danger" disabled={original?.transferring ?? false} onClick={guard(() => call.hangup())}>
          {t('call.hangup')}
        </button>
      </div>
      {transfer && connected && !hasOther && !room ? <TransferForm call={call} onClose={closeTransfer} onError={onError} /> : null}
      {adding && connected && canAdd ? <AddParticipantForm id={`add-${call.id}`} making run={n => phone.addParticipant(call, n)} onClose={closeAdd} onError={onError} /> : null}
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
  // Who came into or left a conference (review 8b, n°2 and n°11): written in a region always there, so it is read out.
  // Shown while the conference call it came from goes on only: never read again at the next one (second review 8b, n°7).
  const [notice, setNotice] = useState<{ callId: string; text: string } | null>(null)
  const shownNotice = notice && calls.some(c => c.id === notice.callId && c.room === 'conference' && c.state !== 'ended') ? notice.text : null
  if (!calls.length && !lastEnded) return null
  // A call answered at once (it takes the place of one of ours, or joins the conference we make) never rings here.
  const ringing = (c: SoftCall) => c.direction === 'inbound' && c.state === 'ringing' && !c.replacedCallId && !c.conferenceOf
  // The call that becomes a conference goes quiet, then ends: the conference shows in its place.
  const moved = new Set(calls.flatMap(c => (c.conferenceOf ? [c.conferenceOf] : c.room === 'conference' && c.replacedCallId ? [c.replacedCallId] : [])))
  const shown = calls.filter(c => !moved.has(c.id))
  const ours = shown.filter(c => !ringing(c))
  return (
    <div className="calls" data-testid="calls">
      {shown.map(call => {
        if (ringing(call)) return <Incoming key={call.id} call={call} />
        if (call.room === 'conference') return <ConferenceCall key={call.id} call={call} tones={tones[call.id] ?? ''} onError={setError} onNotice={text => setNotice({ callId: call.id, text })} />
        const original = call.consultationOf ? ours.find(c => c.id === call.consultationOf) : undefined
        return <Active key={call.id} call={call} tones={tones[call.id] ?? ''} hasOther={ours.length > 1} onError={setError} {...(original ? { original } : {})} />
      })}
      <div role="status" className="call-status" data-testid="call-status">
        {lastEnded ? <p className="call call-ended">{t(reasonKey(lastEnded), { who: who(lastEnded, t), message: lastEnded.endMessage ?? '' })}</p> : null}
        {shownNotice ? <p className="badge">{shownNotice}</p> : null}
      </div>
      {error && calls.length ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
