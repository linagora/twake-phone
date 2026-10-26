import { Alert, Button, Stack, Typography } from '@linagora/twake-mui'
import { NavLink, Outlet, useMatch } from 'react-router-dom'
import { ADMIN_SECTIONS } from '../../admin/sections.js'
import { useGateway } from '../../gateway.js'
import { useT } from '../../i18n/useT.js'

/**
 * The administration (steps 2c, 4c and 7): its parts behind a navigation of their own, for administrators only. The
 * Gateway decides who is one, and refuses the others whatever they send (403); this screen only says so.
 */
const SectionLink = ({ to, children }: { to: string; children: string }) => (
  <Button component={NavLink} to={to} end size="small" variant={useMatch({ path: to, end: true }) ? 'contained' : 'outlined'}>
    {children}
  </Button>
)

const Title = ({ children }: { children: string }) => (
  <Typography variant="h4" component="h1" gutterBottom>
    {children}
  </Typography>
)

export const Admin = () => {
  const { t } = useT()
  const { me, meError } = useGateway()
  if (!me) {
    return (
      <>
        <Title>{t('admin.title')}</Title>
        {meError ? (
          <Alert severity="error" role="alert">
            {t('admin.error', { reason: meError })}
          </Alert>
        ) : (
          <Typography component="p" role="status">
            {t('admin.loading')}
          </Typography>
        )}
      </>
    )
  }
  if (me.features?.admin !== true) {
    return (
      <>
        <Title>{t('admin.title')}</Title>
        <Alert severity="info" role="alert">
          {t('admin.forbidden')}
        </Alert>
      </>
    )
  }
  return (
    <>
      <Title>{t('admin.title')}</Title>
      <nav aria-label={t('admin.nav.label')} className="u-mb-1">
        <Stack component="ul" direction="row" spacing={1} useFlexGap className="u-flex-wrap u-m-0 u-p-0">
          {ADMIN_SECTIONS.map(([path, key]) => (
            <li key={path} className="u-dib">
              <SectionLink to={path ? `/admin/${path}` : '/admin'}>{t(key)}</SectionLink>
            </li>
          ))}
        </Stack>
      </nav>
      <Outlet />
    </>
  )
}
