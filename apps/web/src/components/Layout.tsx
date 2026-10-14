import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider.js'
import { displayNameFor } from '../auth/oidc.js'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'

export const Layout = () => {
  const { t } = useT()
  const { state, signOut } = useAuth()
  const { me } = useGateway()
  const name = displayNameFor(me, state.status === 'signed-in' ? state.user : null)
  const links: [string, Parameters<typeof t>[0]][] = [
    ['/', 'nav.dialer'],
    ['/recents', 'nav.recents'],
    ['/directory', 'nav.directory'],
    ['/settings', 'nav.settings']
  ]
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
            {links.map(([to, key]) => (
              <li key={to}>
                <NavLink to={to} end={to === '/'}>
                  {t(key)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
