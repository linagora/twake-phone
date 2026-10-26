// Upstream candidate: the twake-mui theme draws no keyboard focus a person can see on buttons and links (only MUI's
// faint ripple halo), which RGAA 10.7 requires of every Twake app. Belongs in the theme; this goes once it is there.
import { GlobalStyles } from '@linagora/twake-mui'

/** A 3 px ring around whatever has the keyboard focus, in the theme's primary colour (3:1 at least on white). */
export const FocusRing = () => (
  <GlobalStyles
    styles={theme => ({
      ':focus-visible': {
        outline: `3px solid ${theme.vars?.palette.primary.dark ?? theme.palette.primary.dark}`,
        outlineOffset: 2
      }
    })}
  />
)
