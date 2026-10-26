// Upstream candidate: one entrance shared by the Twake apps (what shows up after an action fades in, quickly, and
// goes at once). twake-mui gives Fade, not this preset.
import { Fade, useTheme } from '@linagora/twake-mui'
import type { ReactElement } from 'react'

/**
 * Fades its child in as it mounts (opacity only, ease-out), and lets it go without delay: a call ended, a panel
 * closed must look immediate. `prefers-reduced-motion` is honoured by the theme (`motion.reducedMotion: 'system'`).
 * The child takes a ref and a style (an element or a MUI component, not a fragment).
 */
export const Appear = ({ children, ms }: { children: ReactElement; ms?: number }) => {
  const theme = useTheme()
  return (
    <Fade in appear timeout={{ enter: ms ?? theme.transitions.duration.shortest, exit: 0 }} easing={{ enter: theme.transitions.easing.easeOut }}>
      {children}
    </Fade>
  )
}
