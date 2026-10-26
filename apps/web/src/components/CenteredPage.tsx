import { Container } from '@linagora/twake-mui'
import type { ReactNode } from 'react'

/** A page of its own before the app (loading, sign-in, an error): its text centered, its focus target the main. */
export const CenteredPage = ({ children }: { children: ReactNode }) => (
  <Container component="main" id="main" maxWidth="sm" className="u-ta-center u-pv-3">
    {children}
  </Container>
)
