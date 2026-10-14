import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatNumber, type Contact } from '@twake/telephony-client'
import { FavoriteButton } from '../components/ContactList.js'
import { useFavorites } from '../favorites.js'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { PresenceBadge } from '../presence.js'

/** One person of the directory: every number is a call away, each with a visible label (RGAA 11.1). */
export const ContactPage = () => {
  const { t } = useT()
  const { id = '' } = useParams()
  const { client } = useGateway()
  const favorites = useFavorites()
  const [contact, setContact] = useState<Contact | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    client
      .getContact(id)
      .then(c => !cancelled && setContact(c))
      .catch(() => !cancelled && setContact(null))
    return () => {
      cancelled = true
    }
  }, [client, id])

  // The card is a page of its own: its title says who (RGAA 8.6); the layout set the directory's title on navigation.
  useEffect(() => {
    if (contact) document.title = `${contact.displayName} – ${t('app.name')}`
  }, [contact, t])

  const extension = contact?.numbers.find(n => n.type === 'extension')
  if (contact === undefined) return <h1>{t('directory.title')}</h1>
  if (contact === null) {
    return (
      <>
        <h1>{t('directory.title')}</h1>
        <p className="alert alert-error" role="alert">{t('directory.notFound')}</p>
        <Link to="/directory">{t('directory.back')}</Link>
      </>
    )
  }
  return (
    <>
      <p>
        <Link to="/directory">{t('directory.back')}</Link>
      </p>
      <h1>{contact.displayName}</h1>
      {contact.title || contact.department ? <p className="muted">{[contact.title, contact.department].filter(Boolean).join(' · ')}</p> : null}
      {extension ? (
        <p>
          <PresenceBadge extension={extension.number} />
        </p>
      ) : null}
      <FavoriteButton contact={contact} favorites={favorites} />
      <section className="card" aria-labelledby="numbers">
        <h2 id="numbers">{t('contact.numbers')}</h2>
        {contact.numbers.length === 0 ? (
          <p>{t('contact.noNumber')}</p>
        ) : (
          <ul className="list">
            {contact.numbers.map(n => (
              <li key={`${n.type}-${n.number}`}>
                <span>
                  <strong>{formatNumber(n.number)}</strong>
                  <br />
                  <span className="badge">{t(`contact.${n.type}`)}</span>
                </span>
                <Link className="btn btn-primary" to={`/?number=${encodeURIComponent(n.number)}`} aria-label={t('contact.callNumber', { number: formatNumber(n.number) })}>
                  {t('contact.call')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {contact.email ? (
        <section className="card" aria-labelledby="email">
          <h2 id="email">{t('contact.email')}</h2>
          <p>
            <a href={`mailto:${contact.email}`}>{contact.email}</a>
          </p>
        </section>
      ) : null}
    </>
  )
}
