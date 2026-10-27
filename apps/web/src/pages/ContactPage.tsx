import { Alert, Card, CardContent, List, ListItem, ListItemText, Link, Stack, Typography } from '@linagora/twake-mui'
import { useEffect, useState } from 'react'
import { Link as RouterLink, useParams } from 'react-router-dom'
import { formatNumber, type Contact } from '@twake/telephony-client'
import { ContactAvatar } from '../components/ContactList.js'
import { CallAction, CopyAction } from '../components/RowActions.js'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { PresenceBadge } from '../presence.js'

/** One person of the directory: every number is a call away, each with a visible label (RGAA 11.1). */
export const ContactPage = () => {
  const { t } = useT()
  const { id = '' } = useParams()
  const { client } = useGateway()
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
>
                  <ListItemText primary={<strong>{formatNumber(n.number)}</strong>} secondary={t(`contact.${n.type}`)} />
                  <Stack direction="row" spacing={0.5}>
                    <CopyAction number={n.number} label={t('actions.copyNumber', { number: formatNumber(n.number) })} />
                    <CallAction number={n.number} label={t('contact.callNumber', { number: formatNumber(n.number) })} />
                  </Stack>
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
