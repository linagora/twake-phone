import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider.js'
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
  const error = state.status === 'anonymous' ? state.error : undefined
  // Opened by the notification of a call (step 5): signs in at once, the person already clicked for it; once per call
  // in this tab (back from the identity provider, they sign in themselves), and not after a failure (they read why).
  const call = calledFor(window.location.search)
  const [forCall] = useState(() => call !== null && !error && triedFor() !== call)
  const tried = useRef(false)
  useEffect(() => {
    if (!forCall || tried.current) return
    tried.current = true
    rememberTried(call!)
    void signIn()
  }, [forCall, call, signIn])
  // A window of the app left signed out when a notification is clicked: the service worker brings it forward.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
    const onMessage = (e: MessageEvent) => {
      const path = (e.data as { type?: unknown; path?: unknown } | null)?.type === 'twakephone.open' ? (e.data as { path?: unknown }).path : null
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return
      window.history.replaceState(null, '', path)
      void signIn()
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [signIn])
  if (forCall) {
    return (
      <main id="main" className="center">
        <p role="status">{t('auth.openingCall')}</p>
      </main>
    )
  }
  return (
    <main id="main" className="center">
      <h1>{t('app.name')}</h1>
      <p>{t('auth.welcome')}</p>
      {error ? (
        <div className="alert alert-error" role="alert">
          {t('auth.error', { reason: error })}
        </div>
      ) : null}
      <button type="button" className="btn btn-primary" onClick={() => void signIn()}>
        {t('auth.signin')}
      </button>
    </main>
  )
}
