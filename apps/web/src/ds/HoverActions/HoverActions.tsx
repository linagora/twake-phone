// Upstream candidate: twake-mui's ListItem has no "actions shown on hover" variant, which every list of people needs
// (Contacts, Mail, Chat). Until then, this wraps the actions of a ListItem's secondaryAction.
import { styled } from '@linagora/twake-mui'

/**
 * The actions of a row: with a mouse, they appear as the row is hovered or holds the focus (keyboard), in a short fade;
 * on a touch screen (no hover), they are always there. Only their opacity changes: they keep their place and stay in
 * the tab order, so a keyboard or a screen reader reaches them as any button.
 */
export const HoverActions = styled('span')(({ theme }) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: theme.spacing(0.5),
  '@media (hover: hover) and (pointer: fine)': {
    opacity: 0,
    transition: theme.transitions.create('opacity', { duration: theme.transitions.duration.shorter, easing: theme.transitions.easing.easeOut }),
    '.MuiListItem-root:hover &, .MuiListItem-root:focus-within &': { opacity: 1 }
  },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
}))
