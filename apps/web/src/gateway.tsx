import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { TelephonyClient } from '@twake/telephony-client'
import { useAuth } from './auth/AuthProvider.js'
import type { AppConfig } from './config.js'

export interface Me {
  id: string
  displayName: string
  extension?: string
  /** What this platform offers; absent on an older Gateway. */
  features?: { directory?: boolean; admin?: boolean }
}

interface Gateway {
  client: TelephonyClient
  me: Me | null
  meError: string | null
  /** Asks the Gateway again who the user is (after a synchronisation gave them an extension, for instance). */
  refreshMe: () => void
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

  const value = useMemo(() => ({ client, me, meError, refreshMe }), [client, me, meError, refreshMe])
  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}

export const useGateway = (): Gateway => {
  const ctx = useContext(GatewayContext)
  if (!ctx) throw new Error('useGateway outside GatewayProvider')
  return ctx
}
