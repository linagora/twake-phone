import { Alert, Button, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider.js'
import { CenteredPage } from '../components/CenteredPage.js'
import { useT } from '../i18n/useT.js'
import { calledFor } from '../push.js'

const TRIED = 'twakephone.signinForCall'
const triedFor = () => {
  try {
    return sessionStorage.getItem(TRIED)
  } catch {
    return null
  }
}
const rememberTried = (call: string) => {
  try {
    sessionStorage.setItem(TRIED, call)
  } catch {
    // Storage blocked: at worst, back from the identity provider, the tab asks again.
  }
}

export const SignIn = () => {
  const { t } = useT()
  const { state, signIn } = useAuth()
  // Why the redirect to the identity provider could not start (unreachable, its metadata refused): read here.
  const [failed, setFailed] = useState<string>()
  const error = failed ?? (state.status === 'anonymous' ? state.error : undefined)
  // Opened by the notification of a call (step 5): signs in at once, the person already clicked for it; once per call
  // in this tab (back from the identity provider, they sign in themselves), and not after a failure (they read why).
  const call = calledFor(window.location.search)
  const [forCall, setForCall] = useState(() => call !== null && !error && triedFor() !== call)
  const tried = useRef(false)
  const redirect = useCallback(() => {
    setFailed(undefined)
    signIn().catch((err: unknown) => {
      // Nothing left to wait for: the page says why, and offers the button again.
      setForCall(false)
      setFailed(err instanceof Error ? err.message : String(err))
    })
  }, [signIn])
  useEffect(() => {
    if (!forCall || tried.current) return
    tried.current = true
    rememberTried(call!)
    redirect()
  }, [forCall, call, redirect])
  // A window of the app left signed out when a notification is clicked: the service worker brings it forward.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
    const onMessage = (e: MessageEvent) => {
      const path = (e.data as { type?: unknown; path?: unknown } | null)?.type === 'twakephone.open' ? (e.data as { path?: unknown }).path : null
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return
      window.history.replaceState(null, '', path)
      redirect()
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [redirect])
  if (forCall) {
    return (
      <CenteredPage>
        <p role="status">{t('auth.openingCall')}</p>
      </CenteredPage>
    )
  }
  return (
    <CenteredPage>
      <Typography variant="h3" component="h1" gutterBottom>
        {t('app.name')}
      </Typography>
      <Typography component="p" className="u-mb-1">{t('auth.welcome')}</Typography>
      {error ? (
        <Alert severity="error" role="alert" className="u-mb-1">
          {t('auth.error', { reason: error })}
        </Alert>
      ) : null}
      <Button onClick={redirect}>{t('auth.signin')}</Button>
    </CenteredPage>
  )
}
