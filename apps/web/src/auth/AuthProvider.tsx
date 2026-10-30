import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { User, UserManager } from 'oidc-client-ts'
import { isFramed, SIGNIN_POPUP } from '../embedded.js'
import { CALLBACK_PATH, bearerOf } from './oidc.js'

export type AuthState = { status: 'loading' } | { status: 'anonymous'; error?: string } | { status: 'signed-in'; user: User }

interface Auth {
  state: AuthState
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  /** A fresh bearer for the Gateway. Throws when nobody is signed in. */
  getToken: () => Promise<string>
}

const AuthContext = createContext<Auth | null>(null)

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Drives the OIDC session: completes the code flow on /callback, restores the session from storage,
 * and exposes a token getter the Gateway client uses. Sign-in is a redirect, or a popup when the app is framed by its
 * Twake Workplace app (ADR 0032): the identity provider refuses to be framed.
 */
export const AuthProvider = ({ manager, children }: { manager: UserManager; children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const settle = (s: AuthState) => {
      if (!cancelled) setState(s)
    }
    const run = async () => {
      if (window.location.pathname === CALLBACK_PATH && window.name === SIGNIN_POPUP && window.opener) {
        // The sign-in popup of a framed app: hands the answer to the frame that opened it, which completes it, and closes.
        // Not signinCallback: it would look for the request in this window's storage, which is not the frame's.
        await manager.signinPopupCallback()
        return
      }
      if (window.location.pathname === CALLBACK_PATH) {
        try {
          const user = await manager.signinCallback()
          // Drop code and state from the address bar, then land where the user wanted to go.
          const target = (user?.state as { returnTo?: string } | undefined)?.returnTo ?? '/'
          window.history.replaceState(null, '', target)
          settle(user ? { status: 'signed-in', user } : { status: 'anonymous' })
        } catch (err) {
          window.history.replaceState(null, '', '/')
          settle({ status: 'anonymous', error: describe(err) })
        }
        return
      }
      const user = await manager.getUser()
      settle(user && !user.expired ? { status: 'signed-in', user } : { status: 'anonymous' })
    }
    run().catch(err => settle({ status: 'anonymous', error: describe(err) }))

    const onLoaded = (user: User) => settle({ status: 'signed-in', user })
    const onUnloaded = () => settle({ status: 'anonymous' })
    // The session is over when the token expired and nothing renewed it, or when the renewal failed:
    // better a sign-in page than a "connected" screen whose every request fails.
    const endSession = (error: string) => {
      // removeUser fires userUnloaded (plain anonymous): the reason is set afterwards so it is what the user reads.
      manager.removeUser().catch(() => undefined).finally(() => settle({ status: 'anonymous', error }))
    }
    const onExpired = () => endSession('session expired')
    const onRenewError = (err: Error) => endSession(`session renewal failed: ${describe(err)}`)
    manager.events.addUserLoaded(onLoaded)
    manager.events.addUserUnloaded(onUnloaded)
    manager.events.addAccessTokenExpired(onExpired)
    manager.events.addSilentRenewError(onRenewError)
    return () => {
      cancelled = true
      manager.events.removeUserLoaded(onLoaded)
      manager.events.removeUserUnloaded(onUnloaded)
      manager.events.removeAccessTokenExpired(onExpired)
      manager.events.removeSilentRenewError(onRenewError)
    }
  }, [manager])

  const signIn = useCallback(async () => {
    if (!isFramed()) return manager.signinRedirect({ state: { returnTo: window.location.pathname + window.location.search } })
    // The popup's user lands through userLoaded, as a silent renewal does.
    await manager.signinPopup({ popupWindowTarget: SIGNIN_POPUP })
  }, [manager])
  const signOut = useCallback(async () => {
    await manager.signoutRedirect()
  }, [manager])
  const getToken = useCallback(async () => {
    const user = await manager.getUser()
    if (!user || user.expired) throw new Error('not signed in')
    return bearerOf(user)
  }, [manager])

  const value = useMemo(() => ({ state, signIn, signOut, getToken }), [state, signIn, signOut, getToken])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = (): Auth => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
