import { Telephone } from '@linagora/twake-icons'
import { Avatar, Button, IconButton, Link, List, ListItem, SvgIcon, Typography, getInitials } from '@linagora/twake-mui'
import { Link as RouterLink } from 'react-router-dom'
import { formatNumber, type Contact } from '@twake/telephony-client'
import type { Favorites } from '../favorites.js'
import { useT } from '../i18n/useT.js'
import { PresenceBadge } from '../presence.js'

/** A toggle: one stable name ("Favourite: Jean Dupont") and aria-pressed for the state, as the ARIA pattern asks. */
export const FavoriteButton = ({ contact, favorites }: { contact: Contact; favorites: Favorites }) => {
  const { t } = useT()
  const on = favorites.has(contact.id)
  const busy = favorites.pending(contact.id)
  return (
    <Button type="button" variant={on ? 'contained' : 'outlined'} aria-pressed={on} aria-busy={busy || undefined} disabled={busy || favorites.items === null} aria-label={t('directory.favoriteToggle', { name: contact.displayName })} onClick={() => void favorites.toggle(contact)}>
      <span aria-hidden="true">{on ? '★' : '☆'}</span>
    </Button>
  )
}

/** The directory photo, or the initials when there is none (or it does not load). Decorative: the name is always next to it. */
export const ContactAvatar = ({ contact, size, className }: { contact: Contact; size?: 's' | 'm' | 'l' | 'xl'; className?: string }) => (
  <Avatar src={contact.photo} alt="" aria-hidden="true" size={size} className={className}>
    {getInitials(contact.displayName, '')}
  </Avatar>
)

/** The people to call, each with a phone button. */
export const ContactList = ({ contacts }: { contacts: Contact[] }) => {
  const { t } = useT()
  const main = (c: Contact) => c.numbers.find(n => n.type === 'extension') ?? c.numbers[0]
  return (
    <List data-testid="contacts">
      {contacts.map(c => {
        const n = main(c)
        return (
          <ListItem
            key={c.id}
            divider
            secondaryAction={
              n ? (
                <IconButton component={RouterLink} to={`/?number=${encodeURIComponent(n.number)}`} color="primary" aria-label={t('contact.callName', { name: c.displayName })}>
                  <SvgIcon component={Telephone} inheritViewBox />
                </IconButton>
              ) : null
            }
          >
            <ContactAvatar contact={c} className="u-mr-1" />
            <span className="u-flex-grow-1">
              <Link component={RouterLink} to={`/directory/${encodeURIComponent(c.id)}`}>
                <strong>{c.displayName}</strong>
              </Link>
              <br />
              <Typography variant="body2" color="textSecondary" component="span">{[c.department, n ? formatNumber(n.number) : t('contact.noNumber')].filter(Boolean).join(' · ')}</Typography>
              {n?.type === 'extension' ? (
                <>
                  {' '}
                  <PresenceBadge extension={n.number} />
                </>
              ) : null}
            </span>
          </ListItem>
        )
      })}
    </List>
  )
}
