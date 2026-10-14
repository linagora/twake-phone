import React from 'react'
import { NavLink } from 'react-router-dom'

import { generateWebLink, useClient } from 'cozy-client'
import { useI18n } from 'twake-i18n'

import { Clock, Contacts, Keypad, Phone, Video } from '@/components/Icons'
import { PresencePicker } from '@/components/PresencePicker'
import { usePhone } from '@/telephony/PhoneProvider'

/** Link to the Contacts app of the same Twake instance. */
export const useContactsLink = () => {
  const client = useClient()
  try {
    return generateWebLink({
      cozyUrl: client.getStackClient().uri,
      slug: 'contacts',
      subDomainType: client.getInstanceOptions().subdomain,
      pathname: '/',
      hash: ''
    })
  } catch {
    return null
  }
}

const Badge = ({ count }) =>
  count > 0 ? <span className="ph-badge">{count}</span> : null

export const Sidebar = () => {
  const { t } = useI18n()
  const { me, missedCount, capabilities } = usePhone()
  const contacts = useContactsLink()
  const meetings = capabilities?.conference?.dialIn

  return (
    <nav className="ph-side" aria-label={t('nav.main')}>
      <div className="ph-brand">
        <div className="ph-logo">
          <Phone size={20} />
        </div>
        Twake Phone
      </div>
      <PresencePicker variant="card" name={me?.displayName} />
      <div className="ph-nav">
        <NavLink to="/dialer">
          <Keypad />
          {t('nav.dialer')}
        </NavLink>
        <NavLink to="/recents">
          <Clock />
          {t('nav.recents')}
          <Badge count={missedCount} />
        </NavLink>
        {meetings && (
          <NavLink to="/meetings">
            <Video />
            {t('nav.meetings')}
          </NavLink>
        )}
        {contacts && (
          <a href={contacts}>
            <Contacts />
            {t('nav.contacts')}
          </a>
        )}
      </div>
    </nav>
  )
}

export const BottomNav = () => {
  const { t } = useI18n()
  const { missedCount, capabilities } = usePhone()
  const contacts = useContactsLink()
  const meetings = capabilities?.conference?.dialIn

  return (
    <nav className="ph-bottom" aria-label={t('nav.main')}>
      <NavLink to="/recents">
        <Clock size={24} />
        {t('nav.recents')}
        <Badge count={missedCount} />
      </NavLink>
      {meetings && (
        <NavLink to="/meetings">
          <Video size={24} />
          {t('nav.meetings')}
        </NavLink>
      )}
      {contacts ? (
        <a href={contacts}>
          <Contacts size={24} />
          {t('nav.contacts')}
        </a>
      ) : (
        <span />
      )}
      <NavLink to="/dialer">
        <Keypad size={24} />
        {t('nav.dialer')}
      </NavLink>
    </nav>
  )
}
