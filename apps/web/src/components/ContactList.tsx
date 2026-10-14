import { Link } from 'react-router-dom'
import { formatNumber, type Contact } from '@twake/telephony-client'
import type { Favorites } from '../favorites.js'
import { useT } from '../i18n/useT.js'

/** A star that says what it does and what state it is in (aria-pressed), not just a glyph. */
export const FavoriteButton = ({ contact, favorites }: { contact: Contact; favorites: Favorites }) => {
  const { t } = useT()
  const on = favorites.has(contact.id)
  return (
    <button type="button" className={`btn star${on ? ' star-on' : ''}`} aria-pressed={on} aria-label={t(on ? 'directory.unfavorite' : 'directory.favorite', { name: contact.displayName })} onClick={() => void favorites.toggle(contact)}>
      <span aria-hidden="true">{on ? '★' : '☆'}</span>
    </button>
  )
}

export const ContactList = ({ contacts, favorites }: { contacts: Contact[]; favorites: Favorites }) => {
  const { t } = useT()
  const main = (c: Contact) => c.numbers.find(n => n.type === 'extension') ?? c.numbers[0]
  return (
    <ul className="list contacts">
      {contacts.map(c => {
        const n = main(c)
        return (
          <li key={c.id}>
            <span>
              <Link to={`/directory/${encodeURIComponent(c.id)}`}>
                <strong>{c.displayName}</strong>
              </Link>
              <br />
              <span className="badge">{[c.department, n ? formatNumber(n.number) : t('contact.noNumber')].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="actions">
              <FavoriteButton contact={c} favorites={favorites} />
              {n ? (
                <Link className="btn btn-primary" to={`/?number=${encodeURIComponent(n.number)}`} aria-label={t('contact.callName', { name: c.displayName })}>
                  {t('contact.call')}
                </Link>
              ) : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
