import { formatNumber, toDialTarget } from '@twake/telephony-client'

import React, { useEffect, useRef, useState } from 'react'

import { generateWebLink, useClient } from 'cozy-client'
import { useI18n } from 'twake-i18n'

import { Avatar } from '@/components/Avatar'
import { Hangup, MicOff, Pause, Phone } from '@/components/Icons'
import { usePhone } from '@/telephony/PhoneProvider'
import { formatTimer } from '@/telephony/format'
import { isSameInstanceOrigin } from '@/telephony/origin'
import { useContact } from '@/telephony/useContactName'
import { useNow } from '@/telephony/useNow'

const WIDTH = 360

// The iframe starts with no height at all, so the root's own box can be squashed to 0 by ancestors: measure its content.
const contentHeight = el =>
  Math.ceil(Math.max(el.scrollHeight, el.getBoundingClientRect().height))

const Round = ({ label, on, tone, onClick, children }) => (
  <button
    type="button"
    className={`ph-w-btn ${tone ?? ''} ${on ? 'is-on' : ''}`}
    aria-label={label}
    aria-pressed={on}
    onClick={onClick}
  >
    {children}
  </button>
)

const Incoming = ({ call, canAnswer, actions }) => {
  const { t } = useI18n()
  const contact = useContact(call.remoteNumber)
  const name = contact?.displayName ?? formatNumber(call.remoteNumber, 'FR')
  return (
    <div
      className="ph-w-card is-incoming"
      role="alertdialog"
      aria-label={t('call.incoming')}
    >
      <Avatar
        label={contact?.displayName ?? call.remoteNumber}
        known={Boolean(contact)}
        className="ph-w-avatar"
      />
      <div className="ph-w-who">
        <div className="ph-w-name">{name}</div>
        <div className="ph-w-sub">
          {[t('call.incoming'), contact?.company].filter(Boolean).join(' · ')}
        </div>
      </div>
      <Round
        label={t('call.reject')}
        tone="is-danger"
        onClick={() => actions.reject(call.id)}
      >
        <Hangup size={22} />
      </Round>
      {canAnswer && (
        <Round
          label={t('call.answer')}
          tone="is-accept"
          onClick={() => actions.answer(call.id)}
        >
          <Phone size={22} />
        </Round>
      )}
    </div>
  )
}

const Ongoing = ({ call, capabilities, actions }) => {
  const { t } = useI18n()
  const client = useClient()
  const now = useNow()
  const contact = useContact(call.remoteNumber)
  const [muted, setMuted] = useState(false)
  const held = call.state === 'held'
  const connected = call.state === 'connected' || held
  const name = contact?.displayName ?? formatNumber(call.remoteNumber, 'FR')
  const { calling, media } = capabilities

  let phoneUrl = null
  try {
    phoneUrl = generateWebLink({
      cozyUrl: client.getStackClient().uri,
      slug: 'phone',
      subDomainType: client.getInstanceOptions().subdomain,
      pathname: '/',
      hash: ''
    })
  } catch {
    // no link to the Phone app: the card still works on its own
  }

  return (
    <div className="ph-w-card" data-testid="widget-call">
      <Avatar
        label={contact?.displayName ?? call.remoteNumber}
        known={Boolean(contact)}
        className="ph-w-avatar"
      />
      <div className="ph-w-who">
        <div className="ph-w-name">{name}</div>
        <div className="ph-w-sub">
          {held
            ? t('call.held')
            : connected
              ? formatTimer(now - call.connectedAt)
              : t('call.calling')}
          {phoneUrl && (
            <>
              {' · '}
              <a href={phoneUrl} target="_blank" rel="noreferrer">
                {t('widget.open')}
              </a>
            </>
          )}
        </div>
      </div>
      {connected && media.browserAudio && (
        <Round
          label={t(muted ? 'call.unmute' : 'call.mute')}
          on={muted}
          onClick={() => {
            actions.mute(call.id, !muted)
            setMuted(!muted)
          }}
        >
          <MicOff size={20} />
        </Round>
      )}
      {connected && calling.hold && (
        <Round
          label={t(held ? 'call.resume' : 'call.hold')}
          on={held}
          onClick={() =>
            held ? actions.resume(call.id) : actions.hold(call.id)
          }
        >
          <Pause size={20} strokeWidth={2.2} />
        </Round>
      )}
      <Round
        label={t('call.hangup')}
        tone="is-danger"
        onClick={() => actions.hangup(call.id)}
      >
        <Hangup size={22} />
      </Round>
    </div>
  )
}

/**
 * Compact call card shown in a corner of the host application. It lives in an iframe that the host keeps
 * mounted, so the softphone stays registered and a call can be taken without leaving the current app.
 * `onSize` tells the host how much room the card needs (0 when there is nothing to show).
 */
export const Widget = ({ onSize, instanceDomain }) => {
  const { calls, capabilities, actions, status, registration } = usePhone()
  const root = useRef(null)

  const active = calls.find(
    c =>
      c.state === 'connected' ||
      c.state === 'held' ||
      c.direction === 'outbound'
  )
  const incoming = calls.filter(
    c =>
      c.direction === 'inbound' &&
      c.id !== active?.id &&
      (c.state === 'new' || c.state === 'ringing')
  )
  const canAnswer = Boolean(
    capabilities?.media.browserAudio || capabilities?.calling.answer
  )
  const hasCard = Boolean(capabilities && (active || incoming.length))

  useEffect(() => {
    if (!root.current) return
    const report = () =>
      onSize?.({
        width: hasCard ? WIDTH : 0,
        height: hasCard ? contentHeight(root.current) : 0
      })
    report()
    const observer = new ResizeObserver(report)
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [hasCard, onSize, calls.length])

  // The host app asks us to dial (PhoneLink). Only a page of the same instance may, and only a real number is dialled.
  const dialRef = useRef(null)
  useEffect(() => {
    dialRef.current = {
      ready:
        status === 'ready' &&
        (!capabilities?.media.browserAudio || registration === 'registered'),
      dial: actions.dial
    }
  })
  useEffect(() => {
    const onMessage = async event => {
      if (
        event.data?.type !== 'twake-phone:dial' ||
        event.source !== window.parent
      )
        return
      const port = event.ports[0]
      const reply = result => port?.postMessage(result)
      if (
        !instanceDomain ||
        !isSameInstanceOrigin(event.origin, instanceDomain)
      )
        return reply({ handled: false, error: 'origin-refused' })
      const target =
        typeof event.data.number === 'string'
          ? toDialTarget(event.data.number)
          : null
      if (!target) return reply({ handled: false, error: 'invalid-number' })
      if (!dialRef.current.ready)
        return reply({ handled: false, error: 'not-ready' })
      try {
        await dialRef.current.dial(target)
        reply({ handled: true })
      } catch (error) {
        reply({ handled: false, error: error.message })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [instanceDomain])

  return (
    <div ref={root} className="ph-w-root">
      {capabilities && active && (
        <Ongoing call={active} capabilities={capabilities} actions={actions} />
      )}
      {capabilities &&
        incoming.map(call => (
          <Incoming
            key={call.id}
            call={call}
            canAnswer={canAnswer}
            actions={actions}
          />
        ))}
    </div>
  )
}
