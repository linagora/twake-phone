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
import { CallPanel } from './CallPanel.js'

const LINKS: [string, Key][] = [
  ['/', 'nav.dialer'],
  ['/recents', 'nav.recents'],
  ['/voicemail', 'nav.voicemail'],
  ['/directory', 'nav.directory'],
  ['/settings', 'nav.settings'],
  ['/admin', 'nav.admin']
]

export const Layout = () => {
  const { t } = useT()
  const { state, signOut } = useAuth()
  const { me, client, onConnected, onEvent } = useGateway()
  const phone = usePhone()
  const push = useMemo(() => browserPush(), [])
  const navigate = useNavigate()
  const name = displayNameFor(me, state.status === 'signed-in' ? state.user : null)
  // The mailbox (step 11a) shows only where the platform has one for this person (capability `voicemail`), with the
  // number of messages not listened to (second review 11a, n°14), said in the link's name.
  const voicemail = useVoicemailTab(client, me?.extension, onConnected, onEvent)
  // The administration link shows only to administrators; the Gateway refuses the others anyway.
  const links = LINKS.filter(([to]) => (to !== '/admin' || me?.features?.admin) && (to !== '/voicemail' || (voicemail.on && me?.extension)))
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
  const main = useRef<HTMLElement>(null)
  const firstRender = useRef(true)
  // A route change in a SPA is a page change for assistive tech: the title says where we are, the focus follows (RGAA 8.5, 12.7).
  useEffect(() => {
    const current = LINKS.find(([to]) => (to === '/' ? pathname === '/' : pathname.startsWith(to)))
    // A part of the administration (step 7) is named before it: "Trunks – Administration – TwakePhone".
    const section = adminSectionOf(pathname)
    document.title = current ? `${section ? `${t(section)} – ` : ''}${t(current[1])} – ${t('app.name')}` : t('app.name')
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
          {phone.soundBlocked ? (
            // The browser wants a gesture before any sound (ringtone, voice): this click is one.
            <span role="status" className="sound-blocked">
              {t('phone.soundBlocked')}{' '}
              <button type="button" className="btn btn-primary" onClick={() => void phone.unblockAudio()}>
                {t('phone.enableSound')}
              </button>
            </span>
          ) : null}
          <button type="button" className="btn" onClick={() => void signOutHere()}>
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
                <NavLink to={to} end={to === '/'} {...(to === '/voicemail' && voicemail.unread ? { 'aria-label': t(voicemail.unread === 1 ? 'nav.voicemailUnreadOne' : 'nav.voicemailUnread', { count: voicemail.unread }) } : {})}>
                  {t(key)}
                  {to === '/voicemail' && voicemail.unread ? (
                    <span className="nav-count" aria-hidden="true" data-testid="voicemail-unread">
                      {voicemail.unread}
                    </span>
                  ) : null}
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
