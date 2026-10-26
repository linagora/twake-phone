import { Avatar, Link, List, ListItem, ListItemAvatar, ListItemText, getInitials } from '@linagora/twake-mui'
import { Link as RouterLink } from 'react-router-dom'
import { formatNumber, type Contact } from '@twake/telephony-client'
import { HoverActions } from '../ds/HoverActions/HoverActions.js'
import { useT } from '../i18n/useT.js'
import { PresenceBadge } from '../presence.js'
import { CallAction, CopyAction } from './RowActions.js'

/** The directory photo, or the initials when there is none (or it does not load). Decorative: the name is always next to it. */
export const ContactAvatar = ({ contact, size, className }: { contact: Contact; size?: 's' | 'm' | 'l' | 'xl'; className?: string }) => (
  <Avatar src={contact.photo} alt="" aria-hidden="true" size={size} className={className}>
    {getInitials(contact.displayName, '')}
  </Avatar>
)

/** The number a person is called on from a list: their extension, else their first number. */
export const mainNumber = (c: Contact) => c.numbers.find(n => n.type === 'extension') ?? c.numbers[0]

/** The people to call: the name opens the card, the phone (on hover, or always on a touch screen) calls. */
export const ContactList = ({ contacts }: { contacts: Contact[] }) => {
  const { t } = useT()
  return (
    <List data-testid="contacts">
      {contacts.map(c => {
        const n = mainNumber(c)
        return (
          <ListItem
            key={c.id}
            divider
            secondaryAction={
              n ? (
                <HoverActions>
                  <CopyAction number={n.number} label={t('actions.copyNumber', { number: formatNumber(n.number) })} />
                  <CallAction number={n.number} label={t('contact.callName', { name: c.displayName })} />
                </HoverActions>
              ) : null
            }
          >
            <ListItemAvatar>
              <ContactAvatar contact={c} />
            </ListItemAvatar>
            <ListItemText
              primary={
                <Link component={RouterLink} to={`/directory/${encodeURIComponent(c.id)}`} underline="hover" color="textPrimary">
                  <strong>{c.displayName}</strong>
                </Link>
              }
              secondary={[c.department, n ? formatNumber(n.number) : t('contact.noNumber')].filter(Boolean).join(' · ')}
            />
            {n?.type === 'extension' ? <PresenceBadge extension={n.number} /> : null}
          </ListItem>
        )
      })}
    </List>
  )
}
