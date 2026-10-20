import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TelephonyClient } from '@twake/telephony-client'
import type { TelephonyEvent } from '@twake/telephony-types'
import { useAuth } from './auth/AuthProvider.js'
import type { AppConfig } from './config.js'

export interface Me {
  id: string
  displayName: string
  extension?: string
  /** What this platform offers; absent on an older Gateway. */
  features?: { directory?: boolean; admin?: boolean; supervision?: boolean }
}

interface Gateway {
  client: TelephonyClient
  me: Me | null
  meError: string | null
  /** Asks the Gateway again who the user is (after a synchronisation gave them an extension, for instance). */
  refreshMe: () => void
  /** What the Gateway tells as it happens (the presence of the others, calls); one stream for the whole app. */
  onEvent: (listener: (event: TelephonyEvent) => void) => () => void
  /**
   * Each time that stream is established, and at once when it already is: what was told while it was closed is
   * lost, time to read the state (and the only time: a part of the app reads it then, not also when it appears).
   */
  onConnected: (listener: () => void) => () => void
}

const GatewayContext = createContext<Gateway | null>(null)

/** The Gateway client for the signed-in user, plus who the Gateway says they are (extension included). */
export const GatewayProvider = ({ config, children }: { config: AppConfig; children: ReactNode }) => {
  const { getToken, state } = useAuth()
  const client = useMemo(() => new TelephonyClient({ baseUrl: config.gatewayUrl, getToken }), [config.gatewayUrl, getToken])
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const refreshMe = useCallback(() => setGeneration(g => g + 1), [])
  const signedIn = state.status === 'signed-in'

  useEffect(() => {
    if (!signedIn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- never under Gate (App.tsx mounts this only signed in); mounted elsewhere, a sign-out forgets the user at once
      setMe(null)
      setMeError(null)
      return
    }
    let cancelled = false
    client
      .getMe()
      .then(m => {
        if (!cancelled) {
          setMe(m)
          setMeError(null)
        }
      })
      .catch(err => {
        if (!cancelled) setMeError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [client, signedIn, generation])

  // The event stream stays open while signed in; each part of the app listens to what concerns it.
  const listeners = useRef(new Set<(event: TelephonyEvent) => void>())
  const connectedListeners = useRef(new Set<() => void>())
  const established = useRef(false)
  useEffect(() => {
    if (!signedIn) return
    const stop = client.connect(
      event => {
        for (const listener of listeners.current) listener(event)
      },
      {
        onOpen: () => {
          established.current = true
          for (const listener of connectedListeners.current) listener()
        },
        onClose: () => {
          established.current = false
        }
      }
    )
    return () => {
      established.current = false
      stop()
    }
  }, [client, signedIn])
  const onEvent = useCallback((listener: (event: TelephonyEvent) => void) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }, [])
  const onConnected = useCallback((listener: () => void) => {
    connectedListeners.current.add(listener)
    if (established.current) listener()
    return () => void connectedListeners.current.delete(listener)
  }, [])

  const value = useMemo(() => ({ client, me, meError, refreshMe, onEvent, onConnected }), [client, me, meError, refreshMe, onEvent, onConnected])
  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}

export const useGateway = (): Gateway => {
  const ctx = useContext(GatewayContext)
  if (!ctx) throw new Error('useGateway outside GatewayProvider')
  return ctx
}
