import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider.js'
import { displayNameFor } from '../auth/oidc.js'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'

const LINKS: [string, Key][] = [
  ['/', 'nav.dialer'],
  ['/recents', 'nav.recents'],
  ['/directory', 'nav.directory'],
  ['/settings', 'nav.settings']
]

export const Layout = () => {
  const { t } = useT()
  const { state, signOut } = useAuth()
  const { me } = useGateway()
  const name = displayNameFor(me, state.status === 'signed-in' ? state.user : null)
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
          <button type="button" className="btn" onClick={() => void signOut()}>
            {t('auth.signout')}
          </button>
        </div>
      </header>
      <div className="layout">
        <nav className="sidenav" aria-label={t('nav.label')}>
          <ul>
            {LINKS.map(([to, key]) => (
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
