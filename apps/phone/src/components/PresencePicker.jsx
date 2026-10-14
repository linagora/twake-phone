import React, { useState } from 'react'

import { useI18n } from 'twake-i18n'

import { ChevronDown } from '@/components/Icons'
import { usePhone } from '@/telephony/PhoneProvider'

// BUSY and OFFLINE are derived from telephony: they are shown but cannot be chosen.
const CHOICES = ['available', 'away', 'dnd']

const Menu = ({ onPick }) => {
  const { t } = useI18n()
  const { presence, capabilities } = usePhone()
  return (
    <div className="ph-menu" role="menu">
      {CHOICES.filter(c => capabilities.presence.statuses.includes(c)).map(
        status => (
          <button
            key={status}
            type="button"
            role="menuitem"
            className={presence.status === status ? 'is-active' : ''}
            onClick={() => onPick(status)}
          >
            <span className={`swatch ${status}`} />
            {t(`presence.${status}`)}
          </button>
        )
      )}
    </div>
  )
}

/** Presence as a pill (mobile header) or a user card (desktop sidebar). */
export const PresencePicker = ({ variant, name }) => {
  const { t } = useI18n()
  const { presence, capabilities, me, actions } = usePhone()
  const [open, setOpen] = useState(false)
  if (!presence) return null

  const writable = Boolean(capabilities?.presence.write)
  const pick = async status => {
    setOpen(false)
    await actions.setPresence(status)
  }
  const toggle = () => writable && setOpen(o => !o)
  const label = t(`presence.${presence.status}`)

  if (variant === 'pill')
    return (
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="ph-pill-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <span className={`sw ${presence.status}`} />
          {label}
          {writable && <ChevronDown size={14} strokeWidth={2.4} />}
        </button>
        {open && <Menu onPick={pick} />}
      </div>
    )

  return (
    <div className="ph-usercard">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="ph-avatar is-me">
          {(name ?? '?').slice(0, 2).toUpperCase()}
          <span className={`ph-dot ${presence.status}`} />
        </span>
        <span>
          <div className="name">{name}</div>
          <div className="sub">
            {label}
            {me?.extension ? ` · ${t('nav.extension')} ${me.extension}` : ''}
          </div>
        </span>
      </button>
      {open && <Menu onPick={pick} />}
    </div>
  )
}
