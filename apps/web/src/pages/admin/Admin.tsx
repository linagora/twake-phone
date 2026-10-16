import { NavLink, Outlet } from 'react-router-dom'
import { ADMIN_SECTIONS } from '../../admin/sections.js'
import { useGateway } from '../../gateway.js'
import { useT } from '../../i18n/useT.js'

/**
 * The administration (steps 2c, 4c and 7): its parts behind a navigation of their own, for administrators only. The
 * Gateway decides who is one, and refuses the others whatever they send (403); this screen only says so.
 */
export const Admin = () => {
  const { t } = useT()
  const { me, meError } = useGateway()
  if (!me) {
    return (
      <>
        <h1>{t('admin.title')}</h1>
        {meError ? (
          <p className="alert alert-error" role="alert">
            {t('admin.error', { reason: meError })}
          </p>
        ) : (
          <p role="status">{t('admin.loading')}</p>
        )}
      </>
    )
  }
  if (me.features?.admin !== true) {
    return (
      <>
        <h1>{t('admin.title')}</h1>
        <p className="alert" role="alert">
          {t('admin.forbidden')}
        </p>
      </>
    )
  }
  return (
    <>
      <h1>{t('admin.title')}</h1>
      <nav className="subnav" aria-label={t('admin.nav.label')}>
        <ul>
          {ADMIN_SECTIONS.map(([path, key]) => (
            <li key={path}>
              <NavLink to={path ? `/admin/${path}` : '/admin'} end>
                {t(key)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </>
  )
}
