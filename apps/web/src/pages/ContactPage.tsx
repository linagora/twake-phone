import { Alert, Button, Card, CardContent, List, ListItem, Link, Typography } from '@linagora/twake-mui'
import { useEffect, useState } from 'react'
import { Link as RouterLink, useParams } from 'react-router-dom'
import { formatNumber, type Contact } from '@twake/telephony-client'
import { ContactAvatar, FavoriteButton } from '../components/ContactList.js'
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
  const heading = (text: string) => (
    <Typography variant="h4" component="h1" gutterBottom>
      {text}
    </Typography>
  )
  if (contact === undefined) return heading(t('directory.title'))
  if (contact === null) {
    return (
      <>
        {heading(t('directory.title'))}
        <Alert severity="error" role="alert" className="u-mb-1">
          {t('directory.notFound')}
        </Alert>
        <Link component={RouterLink} to="/">
          {t('directory.back')}
        </Link>
      </>
    )
  }
  return (
    <>
      <Typography component="p">
        <Link component={RouterLink} to="/">
          {t('directory.back')}
        </Link>
      </Typography>
      <ContactAvatar contact={contact} size="xl" />
      {heading(contact.displayName)}
      {contact.title || contact.department ? (
        <Typography variant="body2" color="textSecondary" component="p">
          {[contact.title, contact.department].filter(Boolean).join(' · ')}
        </Typography>
      ) : null}
      {extension ? (
        <Typography component="p">
          <PresenceBadge extension={extension.number} />
        </Typography>
      ) : null}
      <FavoriteButton contact={contact} favorites={favorites} />
      <Card component="section" variant="outlined" aria-labelledby="numbers" className="u-mb-1">
        <CardContent>
          <Typography variant="h5" component="h2" id="numbers" gutterBottom>
            {t('contact.numbers')}
          </Typography>
          {contact.numbers.length === 0 ? (
            <Typography component="p">{t('contact.noNumber')}</Typography>
          ) : (
            <List disablePadding>
              {contact.numbers.map(n => (
                <ListItem
                  key={`${n.type}-${n.number}`}
                  divider
                  secondaryAction={
                    <Button component={RouterLink} to={`/?number=${encodeURIComponent(n.number)}`} aria-label={t('contact.callNumber', { number: formatNumber(n.number) })}>
                      {t('contact.call')}
                    </Button>
                  }
                >
                  <span>
                    <strong>{formatNumber(n.number)}</strong>
                    <br />
                    <Typography variant="body2" color="textSecondary" component="span">
                      {t(`contact.${n.type}`)}
                    </Typography>
                  </span>
                </ListItem>
              ))}
            </List>
          )}
        </CardContent>
      </Card>
      {contact.email ? (
        <Card component="section" variant="outlined" aria-labelledby="email" className="u-mb-1">
          <CardContent>
            <Typography variant="h5" component="h2" id="email" gutterBottom>
              {t('contact.email')}
            </Typography>
            <Typography component="p">
              <Link href={`mailto:${contact.email}`}>{contact.email}</Link>
            </Typography>
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
