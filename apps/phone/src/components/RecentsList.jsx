import React, { useMemo, useState } from 'react'

import { useQuery } from 'cozy-client'
import { useI18n } from 'twake-i18n'

import { Avatar } from '@/components/Avatar'
import {
  ArrowIn,
  ArrowMissed,
  ArrowOut,
  Phone,
  Search
} from '@/components/Icons'
import { buildContactsQuery } from '@/queries/queries'
import { usePhone } from '@/telephony/PhoneProvider'
import { findContactByNumber, getPhoneKind } from '@/telephony/contacts'
import { formatDuration, formatWhen } from '@/telephony/format'

const TABS = ['all', 'missed', 'inbound', 'outbound']

const matches = (entry, tab) =>
  tab === 'all' ||
  (tab === 'missed' ? entry.missed : entry.direction === tab && !entry.missed)

const Row = ({ entry, contact, onRecall }) => {
  const { t, lang } = useI18n()
  const name = contact?.displayName
  const kind = getPhoneKind(contact, entry.remoteNumber)
  const Arrow = entry.missed
    ? ArrowMissed
    : entry.direction === 'inbound'
      ? ArrowIn
      : ArrowOut
  const color = entry.missed
    ? '#C4321C'
    : entry.direction === 'inbound'
      ? '#1C7A4A'
      : '#2448D8'
  const detail = entry.missed
    ? t('recents.noAnswer')
    : formatDuration(entry.durationSec) || t('recents.noAnswer')
  const meta = [
    kind && t(`recents.kind.${kind}`),
    contact?.company,
    detail
  ].filter(Boolean)

  return (
    <div
      className={`ph-row ${entry.missed ? 'is-missed' : ''}`}
      data-testid="recent-call"
    >
      <Avatar label={name ?? entry.remoteNumber} known={Boolean(contact)} />
      <div className="who">
        <div className="nm">{name ?? entry.remoteNumber}</div>
        <div className="meta">
          <Arrow
            size={14}
            stroke={color}
            strokeWidth={2.4}
            aria-label={t(
              `recents.${entry.missed ? 'missed' : entry.direction}`
            )}
            role="img"
          />
          <span>{meta.join(' · ')}</span>
        </div>
      </div>
      <div className="when">
        {formatWhen(entry.startedAt, {
          lang,
          yesterday: t('recents.yesterday')
        })}
      </div>
      <button
        type="button"
        className="ph-recall"
        aria-label={`${t('recents.recall')} ${name ?? entry.remoteNumber}`}
        onClick={() => onRecall(entry.remoteNumber)}
      >
        <Phone size={18} />
      </button>
    </div>
  )
}

/** History of finished calls: filters, search, one-tap recall. */
export const RecentsList = ({ limit, onRecall }) => {
  const { t } = useI18n()
  const { history } = usePhone()
  const { definition, options } = buildContactsQuery()
  const { data: contacts } = useQuery(definition, options)
  const [tab, setTab] = useState('all')
  const [term, setTerm] = useState('')

  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase()
    return history
      .map(entry => ({
        entry,
        contact: findContactByNumber(contacts, entry.remoteNumber)
      }))
      .filter(({ entry }) => matches(entry, tab))
      .filter(
        ({ entry, contact }) =>
          !needle ||
          entry.remoteNumber.toLowerCase().includes(needle) ||
          (contact?.displayName ?? '').toLowerCase().includes(needle)
      )
      .slice(0, limit)
  }, [history, contacts, tab, term, limit])

  return (
    <>
      <div className="head">
        <h2>{t('recents.title')}</h2>
        <div className="ph-tabs" role="group" aria-label={t('recents.filter')}>
          {TABS.map(key => (
            <button
              key={key}
              type="button"
              className={tab === key ? 'is-active' : ''}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {t(`recents.tabs.${key}`)}
            </button>
          ))}
        </div>
      </div>
      <label className="ph-search">
        <Search size={18} />
        <input
          type="search"
          aria-label={t('recents.search')}
          placeholder={t('recents.searchPlaceholder')}
          value={term}
          onChange={e => setTerm(e.target.value)}
        />
      </label>
      <div className="ph-list">
        {rows.length === 0 && (
          <div className="ph-empty">{t('recents.empty')}</div>
        )}
        {rows.map(({ entry, contact }) => (
          <Row
            key={entry.id}
            entry={entry}
            contact={contact}
            onRecall={onRecall}
          />
        ))}
      </div>
    </>
  )
}
