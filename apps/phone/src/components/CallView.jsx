import { formatNumber } from '@twake/telephony-client'

import React, { useState } from 'react'

import { useI18n } from 'twake-i18n'

import { Avatar } from '@/components/Avatar'
import {
  ChevronLeft,
  Hangup,
  Keypad,
  MicOff,
  Pause,
  Phone,
  Transfer
} from '@/components/Icons'
import { formatTimer, initials, avatarColors } from '@/telephony/format'
import { useContact } from '@/telephony/useContactName'
import { useNow } from '@/telephony/useNow'

const DTMF = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

const Action = ({ label, icon, on, onClick }) => (
  <button
    type="button"
    className={`ph-act ${on ? 'is-on' : ''}`}
    aria-pressed={on}
    onClick={onClick}
  >
    <span className="c">{icon}</span>
    <span className="t">{label}</span>
  </button>
)

/** Second call while talking: park the current one and answer. */
const DoubleCall = ({ call, onAnswer, onReject }) => {
  const { t } = useI18n()
  const contact = useContact(call.remoteNumber)
  const name = contact?.displayName ?? call.remoteNumber
  return (
    <div className="ph-double" role="alert" data-testid="double-call">
      <h3>{t('call.doubleCall')}</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar label={name} known={Boolean(contact)} className="" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{name}</div>
          <div style={{ fontSize: 12, color: '#4F566B' }}>
            {t('call.ringing')}
          </div>
        </div>
      </div>
      <div className="btns">
        <button type="button" className="go" onClick={onAnswer}>
          {t('call.holdAnswer')}
        </button>
        <button
          type="button"
          className="no"
          aria-label={t('call.reject')}
          onClick={onReject}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/** The ongoing call: dark stage with controls, and the caller's context on the side. */
export const CallView = ({ call, second, capabilities, actions, onBack }) => {
  const { t } = useI18n()
  const now = useNow()
  const contact = useContact(call.remoteNumber)
  const [muted, setMuted] = useState(false)
  const [showKeypad, setShowKeypad] = useState(false)
  const name = contact?.displayName
  const held = call.state === 'held'
  const connected = call.state === 'connected' || held
  const { calling, media } = capabilities
  const [bg, fg] = avatarColors(name ?? call.remoteNumber, Boolean(contact))
  const hasContext = Boolean(second || contact?.company || contact?.jobTitle)

  const stateLabel = held
    ? t('call.held')
    : connected
      ? `${t('call.inCall')} · ${formatTimer(now - call.connectedAt)}`
      : call.direction === 'outbound' && call.state === 'ringing'
        ? t('call.ringing')
        : t('call.calling')

  // Only controls the provider supports are shown (cahier §24, §87).
  return (
    <div className="ph-call-wrap">
      <section
        className="ph-incall"
        aria-label={t('call.ongoing')}
        data-testid="active-call"
      >
        <div className="ph-top">
          <button type="button" className="ph-back" onClick={onBack}>
            <ChevronLeft size={18} />
            {t('call.back')}
          </button>
        </div>
        <div className="ph-hero">
          <div
            className="ph-bigavatar"
            style={{ background: bg, color: fg }}
            aria-hidden="true"
          >
            {initials(name ?? call.remoteNumber)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h1>{name ?? formatNumber(call.remoteNumber, 'FR')}</h1>
            <div className="sub">
              {[
                contact?.company,
                name ? formatNumber(call.remoteNumber, 'FR') : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <div
            className={`ph-state ${connected ? '' : 'is-wait'} ${held ? 'is-held' : ''}`}
          >
            {stateLabel}
          </div>
        </div>

        {showKeypad && (
          <div className="ph-dtmf">
            {DTMF.map(k => (
              <button
                key={k}
                type="button"
                onClick={() => actions.dtmf(call.id, k)}
              >
                {k}
              </button>
            ))}
          </div>
        )}

        <div className="ph-actions">
          {connected && media.browserAudio && (
            <Action
              label={t(muted ? 'call.unmute' : 'call.mute')}
              icon={<MicOff size={24} />}
              on={muted}
              onClick={() => {
                actions.mute(call.id, !muted)
                setMuted(!muted)
              }}
            />
          )}
          {connected && calling.dtmf && media.browserAudio && (
            <Action
              label={t('call.keypad')}
              icon={<Keypad size={24} />}
              on={showKeypad}
              onClick={() => setShowKeypad(!showKeypad)}
            />
          )}
          {connected && calling.hold && (
            <Action
              label={t(held ? 'call.resume' : 'call.hold')}
              icon={<Pause size={24} strokeWidth={2.2} />}
              on={held}
              onClick={() =>
                held ? actions.resume(call.id) : actions.hold(call.id)
              }
            />
          )}
          {connected && calling.transfer && (
            <Action label={t('call.transfer')} icon={<Transfer size={24} />} />
          )}
        </div>

        <div className="ph-hang">
          <button
            type="button"
            className="ph-hangbtn"
            onClick={() => actions.hangup(call.id)}
          >
            <Hangup size={24} />
            {t('call.hangup')}
          </button>
        </div>
      </section>

      {hasContext && (
        <aside className="ph-aside" aria-label={t('call.context')}>
          {second && (
            <DoubleCall
              call={second}
              onAnswer={() => actions.answerHolding(second.id, call.id)}
              onReject={() => actions.reject(second.id)}
            />
          )}
          {(contact?.company || contact?.jobTitle) && (
            <div>
              <h2 style={{ marginBottom: 10 }}>{t('call.contactCard')}</h2>
              <dl>
                {contact.company && (
                  <div>
                    <dt>{t('call.company')}</dt>
                    <dd>{contact.company}</dd>
                  </div>
                )}
                {contact.jobTitle && (
                  <div>
                    <dt>{t('call.jobTitle')}</dt>
                    <dd>{contact.jobTitle}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </aside>
      )}
    </div>
  )
}

/** Full-screen incoming call (no call in progress). */
export const IncomingOverlay = ({ call, capabilities, actions }) => {
  const { t } = useI18n()
  const contact = useContact(call.remoteNumber)
  const name = contact?.displayName
  const [bg, fg] = avatarColors(name ?? call.remoteNumber, Boolean(contact))
  // Browser audio is what lets this page answer; otherwise the call is answered on the phone.
  const canAnswer =
    capabilities.media.browserAudio || capabilities.calling.answer

  return (
    <div
      className="ph-incoming"
      role="alertdialog"
      aria-label={t('call.incoming')}
      data-testid="incoming-call"
    >
      <div className="ph-pill">
        <Phone size={14} />
        {t('call.incoming')}
      </div>
      <div className="ph-hero">
        <div
          className="ph-bigavatar"
          style={{ background: bg, color: fg }}
          aria-hidden="true"
        >
          {initials(name ?? call.remoteNumber)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1>{name ?? formatNumber(call.remoteNumber, 'FR')}</h1>
          {name && (
            <div className="sub">
              {[contact?.company, formatNumber(call.remoteNumber, 'FR')]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
      </div>
      <div
        className="ph-answerrow"
        style={canAnswer ? undefined : { justifyContent: 'center' }}
      >
        <button
          type="button"
          className="ph-big"
          onClick={() => actions.reject(call.id)}
        >
          <span className="c">
            <Hangup size={32} />
          </span>
          {t('call.reject')}
        </button>
        {canAnswer && (
          <button
            type="button"
            className="ph-big is-accept"
            onClick={() => actions.answer(call.id)}
          >
            <span className="c">
              <Phone size={32} />
            </span>
            {t('call.answer')}
          </button>
        )}
      </div>
    </div>
  )
}
