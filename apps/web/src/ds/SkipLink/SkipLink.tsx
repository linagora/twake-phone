// Upstream candidate: twake-mui has no skip link (RGAA 12.7), which every Twake app needs.
import { Link } from '@linagora/twake-mui'
import type { ReactNode } from 'react'

/** The first link of the page: hidden until it has the focus, then shown above everything. */
export const SkipLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link
    href={href}
    sx={theme => ({
      position: 'absolute',
      left: -9999,
      top: theme.spacing(1),
      zIndex: theme.zIndex.tooltip,
      padding: theme.spacing(1, 1.5),
      borderRadius: 1,
      backgroundColor: theme.vars?.palette.background.paper,
      '&:focus': { left: theme.spacing(1) }
    })}
  >
    {children}
  </Link>
)
