import { parseMeetingId, toDialTarget } from '@twake/telephony-client'

import React, { useCallback, useEffect, useState } from 'react'

import { useI18n } from 'twake-i18n'

import { Phone, Video } from '@/components/Icons'
import { usePhone } from '@/telephony/PhoneProvider'

const POLL_MS = 10_000

const messageFor = (error, t) => {
  if (/ 409 /.test(error?.message)) return t('meetings.taken')
  if (/ 404 /.test(error?.message)) return t('meetings.notFound')
  return t('meetings.error')
}

export const Meetings = () => {
  const { t } = useI18n()
  const { actions } = usePhone()
  const { conference } = actions
  const [input, setInput] = useState('')
  const [meeting, setMeeting] = useState(null)
  const [participants, setParticipants] = useState([])
  const [invite, setInvite] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const meetingId = meeting?.meetingId

  const refresh = useCallback(async () => {
    if (!meetingId) return
    try {
      setParticipants((await conference.get(meetingId)).participants ?? [])
    } catch {
      // the next event or poll tries again
    }
  }, [conference, meetingId])

  // Participants come from the event stream; a slow poll covers missed events (e.g. after a reconnection).
  useEffect(() => {
    if (!meetingId) return undefined
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    const off = conference.subscribe(event => {
      if (event.payload?.participant?.meetingId === meetingId) refresh()
    })
    return () => {
      clearInterval(timer)
      off()
    }
  }, [conference, meetingId, refresh])

  const run = async fn => {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError(messageFor(e, t))
    } finally {
      setBusy(false)
    }
  }

  const enable = event => {
    event.preventDefault()
    const id = parseMeetingId(input)
    if (!id) return setError(t('meetings.invalid'))
    run(async () => setMeeting(await conference.open(id)))
  }

  const createRoom = () =>
    run(async () => setMeeting(await conference.create()))

  const sendInvite = event => {
    event.preventDefault()
    const target = toDialTarget(invite.trim())
    if (!target) return setError(t('meetings.invalidNumber'))
    run(async () => {
      await conference.invite(meetingId, target)
      setInvite('')
      refresh()
    })
  }

  const stop = () =>
    run(async () => {
      await conference.close(meetingId)
      setMeeting(null)
      setParticipants([])
    })

  return (
    <section className="ph-panel ph-meetings" aria-label={t('meetings.title')}>
      <h2>{t('meetings.title')}</h2>
      {!meeting ? (
        <form onSubmit={enable} className="ph-form">
          <p className="ph-hint">{t('meetings.intro')}</p>
          <input
            aria-label={t('meetings.room')}
            placeholder={t('meetings.room')}
            value={input}
            onChange={e => setInput(e.target.value)}
          />
          <button type="submit" className="ph-primary" disabled={busy}>
            <Video size={18} /> {t('meetings.enable')}
          </button>
          <button type="button" disabled={busy} onClick={createRoom}>
            {t('meetings.create')}
          </button>
        </form>
      ) : (
        <>
          {meeting.url && (
            <p className="ph-hint">
              <a href={meeting.url} target="_blank" rel="noreferrer">
                {meeting.url}
              </a>
            </p>
          )}
          <div className="ph-dialin" aria-label={t('meetings.dialin')}>
            <h3>{t('meetings.dialin')}</h3>
            {meeting.dialIn.numbers.map(n => (
              <div key={n.e164}>
                {t('meetings.number')} <strong>{n.e164}</strong>
              </div>
            ))}
            {meeting.dialIn.pin && (
              <div>
                {t('meetings.pin')} <strong>{meeting.dialIn.pin}</strong>
              </div>
            )}
          </div>

          <h3>{t('meetings.participants')}</h3>
          <ul className="ph-participants">
            {participants.length === 0 && (
              <li className="ph-hint">{t('meetings.none')}</li>
            )}
            {participants.map(p => (
              <li key={p.id}>
                {p.kind === 'phone' ? <Phone size={16} /> : <Video size={16} />}
                <span className="name">
                  {p.displayName ?? p.number ?? p.id}
                </span>
                <span className="ph-hint">
                  {p.kind === 'phone' ? t('meetings.phone') : t('meetings.web')}
                  {p.muted ? ` · ${t('meetings.muted')}` : ''}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await conference.mute(meetingId, p.id)
                      refresh()
                    })
                  }
                >
                  {t('meetings.mute')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await conference.remove(meetingId, p.id)
                      refresh()
                    })
                  }
                >
                  {t('meetings.remove')}
                </button>
              </li>
            ))}
          </ul>

          <form onSubmit={sendInvite} className="ph-form">
            <label>{t('meetings.invite')}</label>
            <input
              aria-label={t('meetings.invitePlaceholder')}
              placeholder={t('meetings.invitePlaceholder')}
              value={invite}
              onChange={e => setInvite(e.target.value)}
            />
            <button type="submit" className="ph-primary" disabled={busy}>
              {t('meetings.inviteButton')}
            </button>
          </form>
          <button
            type="button"
            className="ph-link"
            disabled={busy}
            onClick={stop}
          >
            {t('meetings.stop')}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="ph-error">
          {error}
        </p>
      )}
    </section>
  )
}
