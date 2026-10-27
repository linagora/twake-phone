// Upstream candidate: twake-mui's NavLink is a div with role="button", moved by onClick, and its styled root drops
// Emotion's `as`. A link of the router must stay a link (its address, a new tab, aria-current on the page shown).
// These are NavLinkRoot's styles (twake-mui 18.4) on the router's NavLink; NavLink taking a `component` prop, the way
// MUI's own components do, would make this file go away. NavItem highlights the item through its `.active` class.
import { styled } from '@linagora/twake-mui'
import { NavLink } from 'react-router-dom'

/** A link of twake-mui's sidebar (inside a NavItem, with NavIcon and NavText) that the router renders. */
export const NavRouteLink = styled(NavLink)(({ theme }) => ({
  padding: 8,
  width: '100%',
  height: '100%',
  minHeight: 0,
  borderRadius: 8,
  lineHeight: 1.375,
  color: theme.vars?.palette.text.primary,
  textDecoration: 'none',
  display: 'flex',
  alignItems: 'center',
  '&.active': {
    color: theme.vars?.palette.primary.main,
    '& svg, & span': { color: theme.vars?.palette.primary.main }
  },
  [theme.breakpoints.down('lg')]: {
    display: 'block',
    height: 'auto',
    margin: 0,
    padding: 0,
    textAlign: 'center',
    fontSize: theme.typography.pxToRem(11),
    lineHeight: '12px',
    '&.active': {
      color: theme.vars?.palette.text.primary,
      '& svg, & span': { color: theme.vars?.palette.text.primary }
    }
  }
}))
