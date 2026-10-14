import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider.js'
import { displayNameFor } from '../auth/oidc.js'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { usePhone } from '../softphone.js'
import { CallPanel } from './CallPanel.js'

const LINKS: [string, Key][] = [
  ['/', 'nav.dialer'],
  ['/recents', 'nav.recents'],
  ['/directory', 'nav.directory'],
  ['/settings', 'nav.settings'],
  ['/admin', 'nav.admin']
]

export const Layout = () => {
  const { t } = useT()
  const { state, signOut } = useAuth()
  const { me } = useGateway()
  const phone = usePhone()
  const name = displayNameFor(me, state.status === 'signed-in' ? state.user : null)
  // The administration link shows only to administrators; the Gateway refuses the others anyway.
  const links = LINKS.filter(([to]) => to !== '/admin' || me?.features?.admin)
  const { pathname } = useLocation()
  const main = useRef<HTMLElement>(null)
  const firstRender = useRef(true)
  // A route change in a SPA is a page change for assistive tech: the title says where we are, the focus follows (RGAA 8.5, 12.7).
  useEffect(() => {
    const current = LINKS.find(([to]) => (to === '/' ? pathname === '/' : pathname.startsWith(to)))
    document.title = current ? `${t(current[1])} – ${t('app.name')}` : t('app.name')
    if (firstRender.current) firstRender.current = false
    else main.current?.focus()
  }, [pathname, t])
  return (
    <div className="shell">
      <a className="skip" href="#main">
        {t('app.skip')}
      </a>
      <header className="topbar">
        <NavLink to="/" className="brand">
          {t('app.name')}
        </NavLink>
        <div className="who">
          <span data-testid="who">
            <strong>{name}</strong>
            {me ? <span className="badge"> · {me.extension ? t('auth.extension', { extension: me.extension }) : t('auth.noExtension')}</span> : null}
          </span>
          {phone.state !== 'off' ? (
            <span className={`phone-state phone-state-${phone.state}`} role="status" data-testid="phone-state" title={phone.detail ?? undefined}>
              {t(`phone.${phone.state}`)}
            </span>
          ) : null}
          <button type="button" className="btn" onClick={() => void phone.shutdown().then(signOut)}>
            {t('auth.signout')}
          </button>
        </div>
      </header>
      <CallPanel />
      <div className="layout">
        <nav className="sidenav" aria-label={t('nav.label')}>
          <ul>
            {links.map(([to, key]) => (
              <li key={to}>
                <NavLink to={to} end={to === '/'}>
                  {t(key)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1} ref={main}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
