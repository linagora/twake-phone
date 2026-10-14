import React, { useState } from 'react'
import { Outlet } from 'react-router-dom'

import { BarComponent, BarCenter } from 'cozy-bar'
import { useI18n } from 'twake-i18n'

import { CallView, IncomingOverlay } from '@/components/CallView'
import { Phone } from '@/components/Icons'
import { BottomNav, Sidebar } from '@/components/Sidebar'
import { usePhone } from '@/telephony/PhoneProvider'
import { formatTimer } from '@/telephony/format'
import { useContactName } from '@/telephony/useContactName'
import { useNow } from '@/telephony/useNow'

const Notice = () => {
  const { t } = useI18n()
  const { status, error, registration, capabilities } = usePhone()

  // Says why calling is (not) possible instead of leaving the keypad silently inert.
  if (status === 'connecting')
    return <div className="ph-notice is-info">{t('status.connecting')}</div>
  if (status === 'error')
    return (
      <div className="ph-notice is-error" role="alert">
        {t('status.error')}
        {error ? ` (${error})` : ''}
      </div>
    )
  if (capabilities?.media.browserAudio && registration !== 'registered')
    return <div className="ph-notice">{t('status.notRegistered')}</div>
  return null
}

const ResumeBar = ({ call, onResume }) => {
  const { t } = useI18n()
  const name = useContactName(call.remoteNumber)
  const now = useNow()
  return (
    <button type="button" className="ph-resume" onClick={onResume}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Phone size={18} />
        {t('call.ongoing')} · {name ?? call.remoteNumber}
      </span>
      <span>
        {call.connectedAt
          ? formatTimer(now - call.connectedAt)
          : t('call.calling')}
      </span>
    </button>
  )
}

const AppLayout = () => {
  const { t } = useI18n()
  const { calls, capabilities, actions } = usePhone()
  // Id of the call the user stepped out of; any other call brings the call view back.
  const [minimizedFor, setMinimizedFor] = useState(null)

  const active = calls.find(
    c =>
      c.state === 'connected' ||
      c.state === 'held' ||
      c.direction === 'outbound'
  )
  const ringing = calls.filter(
    c =>
      c.direction === 'inbound' &&
      c.id !== active?.id &&
      (c.state === 'new' || c.state === 'ringing')
  )

  const minimized = !!active && minimizedFor === active.id

  const showCall = capabilities && active && !minimized

  return (
    <>
      <BarCenter>
        <span>{t('app.name')}</span>
      </BarCenter>
      <BarComponent searchOptions={{ enabled: false }} />
      {capabilities && !active && ringing[0] && (
        <IncomingOverlay
          call={ringing[0]}
          capabilities={capabilities}
          actions={actions}
        />
      )}
      {showCall ? (
        <div className="ph-app">
          <CallView
            call={active}
            second={ringing[0]}
            capabilities={capabilities}
            actions={actions}
            onBack={() => setMinimizedFor(active.id)}
          />
        </div>
      ) : (
        <div className="ph-app">
          <Sidebar />
          <main className="ph-main">
            <Notice />
            {capabilities && active && minimized && (
              <ResumeBar call={active} onResume={() => setMinimizedFor(null)} />
            )}
            <Outlet />
          </main>
          <BottomNav />
        </div>
      )}
    </>
  )
}

export default AppLayout
