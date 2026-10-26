import { Eye, Gear, History, Logout, Shield, Sound, Telephone } from '@linagora/twake-icons'
import { AppBar, Button, Chip, Container, IconButton, Link, SvgIcon, Content, Layout as TwakeLayout, Main, Nav, NavIcon, NavItem, NavText, Sidebar, Stack, Toolbar, Typography, type ChipProps } from '@linagora/twake-mui'
import { useEffect, useMemo, useRef } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { adminSectionOf } from '../admin/sections.js'
import { useAuth } from '../auth/AuthProvider.js'
import { displayNameFor } from '../auth/oidc.js'
import { useGateway } from '../gateway.js'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import { answerRingQueries, browserPush, calledFor, forgetPushAtSignOut, resyncPush, ringsHere, tellRinging } from '../push.js'
import { usePhone } from '../softphone.js'
import { useVoicemailTab } from '../voicemailTab.js'
import { NavRouteLink } from '../ds/NavRouteLink/NavRouteLink.js'
import { SkipLink } from '../ds/SkipLink/SkipLink.js'
import { CallPanel } from './CallPanel.js'

const LINKS: [string, Key, typeof Telephone][] = [
  ['/', 'nav.dialer', Telephone],
  ['/recents', 'nav.recents', History],
  ['/voicemail', 'nav.voicemail', Sound],
  ['/supervision', 'nav.supervision', Eye],
  ['/settings', 'nav.settings', Gear],
  ['/admin', 'nav.admin', Shield]
]

/** The softphone's registration, coloured by what it means for calls. */
const PHONE_STATE_COLOR: Record<string, ChipProps['color']> = { registered: 'success', failed: 'error', unregistered: 'error' }

export const Layout = () => {
  const { t } = useT()
  const { state, signOut } = useAuth()
  const { me, client, onConnected, onEvent } = useGateway()
  const phone = usePhone()
  const push = useMemo(() => browserPush(), [])
  const navigate = useNavigate()
  const name = displayNameFor(me, state.status === 'signed-in' ? state.user : null)
  // The mailbox (step 11a) shows only where the platform has one for this person (capability `voicemail`), with the
  // number of messages not listened to, said in the link's name.
  const voicemail = useVoicemailTab(client, me?.extension, onConnected, onEvent)
  // The administration link shows only to administrators; the Gateway refuses the others anyway.
  // The supervision (step 11d) shows to supervisors, whom the Gateway says in /me (and refuses the others anyway).
  const links = LINKS.filter(([to]) => (to !== '/admin' || me?.features?.admin) && (to !== '/supervision' || me?.features?.supervision) && (to !== '/voicemail' || (voicemail.on && me?.extension)))
  const { pathname, search } = useLocation()
  // Opened by the notification of a call: signed in, the softphone registers and the call rings here. The address
  // keeps no trace of it (a reload is no reason to do anything about that call).
  useEffect(() => {
    if (calledFor(search) !== null) void navigate(pathname, { replace: true })
  }, [search, pathname, navigate])
  // The subscription to notifications this person made on this browser, handed to the Gateway again at each start.
  useEffect(() => {
    if (me?.extension) resyncPush(client, push, me.id).catch(() => undefined)
  }, [client, push, me?.id, me?.extension])
  // The service worker asks the windows on screen before it shows the notification of a call: this one rings it
  // (registered), or may (its softphone on its way back: a quiet notification meanwhile).
  const phoneState = useRef(phone.state)
  // eslint-disable-next-line react-hooks/refs -- the latest value, read by an effect without restarting it
  phoneState.current = phone.state
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
    return answerRingQueries(navigator.serviceWorker, () => ringsHere(phoneState.current, document.visibilityState))
  }, [])
  // The calls this window rings: the quiet notification the service worker showed for one of them goes.
  const ringing = phone.calls
    .filter(c => c.direction === 'inbound' && c.state === 'ringing')
    .map(c => c.id)
    .join('\n')
  useEffect(() => {
    if (!ringing || typeof navigator === 'undefined' || !navigator.serviceWorker) return
    navigator.serviceWorker.ready.then(r => tellRinging(r.active, ringing.split('\n'))).catch(() => undefined)
  }, [ringing])
  const signOutHere = async () => {
    await phone.shutdown()
    // The next person on this browser does not get this one's calls.
    if (me) await forgetPushAtSignOut(client, push, me.id)
    await signOut()
  }
  const firstRender = useRef(true)
  // A route change in a SPA is a page change for assistive tech: the title says where we are, the focus follows (RGAA 8.5, 12.7).
  useEffect(() => {
    const current = LINKS.find(([to]) => (to === '/' ? pathname === '/' : pathname.startsWith(to)))
    // A part of the administration (step 7) is named before it: "Trunks – Administration – TwakePhone".
    const section = adminSectionOf(pathname)
    document.title = current ? `${section ? `${t(section)} – ` : ''}${t(current[1])} – ${t('app.name')}` : t('app.name')
    if (firstRender.current) firstRender.current = false
    else document.getElementById('main')?.focus()
  }, [pathname, t])
  return (
    <Stack className="u-h-100">
      <SkipLink href="#main">{t('app.skip')}</SkipLink>
      <AppBar position="static" color="inherit" elevation={0}>
        <Toolbar className="u-flex-wrap" variant="dense">
          <Link component={NavLink} to="/" variant="h6" color="textPrimary" underline="none" className="u-flex-grow-1">
            {t('app.name')}
          </Link>
          <Stack direction="row" spacing={1.5} useFlexGap className="u-flex-items-center u-flex-wrap">
            <Typography variant="body2" color="textSecondary" data-testid="who">
              <strong>{name}</strong>
              {me ? <span> · {me.extension ? t('auth.extension', { extension: me.extension }) : t('auth.noExtension')}</span> : null}
            </Typography>
            {phone.state !== 'off' ? (
              <Chip
                size="small"
                variant="outlined"
                color={PHONE_STATE_COLOR[phone.state]}
                role="status"
                data-testid="phone-state"
                title={phone.detail ?? undefined}
                label={t(`phone.${phone.state}`)}
              />
            ) : null}
            {phone.soundBlocked ? (
              // The browser wants a gesture before any sound (ringtone, voice): this click is one.
              <Stack role="status" direction="row" spacing={1} className="u-flex-items-center">
                <Typography variant="body2">{t('phone.soundBlocked')} </Typography>
                <Button size="small" onClick={() => void phone.unblockAudio()}>
                  {t('phone.enableSound')}
                </Button>
              </Stack>
            ) : null}
            <IconButton onClick={() => void signOutHere()} aria-label={t('auth.signout')} title={t('auth.signout')}>
              <SvgIcon component={Logout} inheritViewBox />
            </IconButton>
          </Stack>
        </Toolbar>
      </AppBar>
      <CallPanel />
      <TwakeLayout withTopBar={false} className="u-flex-grow-1 u-mih-0">
        <Sidebar aria-label={t('nav.label')}>
          <Nav>
            {links.map(([to, key, icon]) => (
              <NavItem
                key={to}
                {...(to === '/voicemail' && voicemail.unread ? { badge: <span aria-hidden="true" data-testid="voicemail-unread">{voicemail.unread}</span> } : {})}
              >
                <NavRouteLink to={to} end={to === '/'} {...(to === '/voicemail' && voicemail.unread ? { 'aria-label': t(voicemail.unread === 1 ? 'nav.voicemailUnreadOne' : 'nav.voicemailUnread', { count: voicemail.unread }) } : {})}>
                  <NavIcon icon={icon} />
                  <NavText>{t(key)}</NavText>
                </NavRouteLink>
              </NavItem>
            ))}
          </Nav>
        </Sidebar>
        <Main id="main" tabIndex={-1}>
          <Content role={undefined}>
            <Container maxWidth={pathname === '/' ? 'lg' : 'md'} className="u-ml-0 u-pv-1-half">
              <Outlet />
            </Container>
          </Content>
        </Main>
      </TwakeLayout>
    </Stack>
  )
}
