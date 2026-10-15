import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Presence } from '@twake/telephony-types'
import { useGateway } from './gateway.js'
import { PresenceSync } from './presenceSync.js'
import { useT } from './i18n/useT.js'

export interface Presences {
  /** The platform tells presences as they change; false: nothing to show (an older Gateway, a provider without events). */
  realtime: boolean
  /** The presence of an extension; offline when the Gateway never heard of it. */
  of: (extension: string) => Presence
}

const PresenceContext = createContext<Presences | null>(null)

/** The presence of everyone, by extension: loaded from the Gateway at start and at each reconnection, then kept up to date by its events. */
export const PresenceProvider = ({ children }: { children: ReactNode }) => {
  const { client, onEvent, onConnected } = useGateway()
  const [realtime, setRealtime] = useState(false)
  const [items, setItems] = useState<Map<string, Presence>>(() => new Map())

  useEffect(() => {
    const sync = new PresenceSync(
      () => client.getPresences(),
      state => {
        setRealtime(state.realtime)
        setItems(state.items)
      }
    )
    const stopEvents = onEvent(event => {
      if (event.type === 'presence.changed' && event.payload.extension) sync.changed(event.payload.extension, event.payload.presence)
    })
    const stopConnected = onConnected(() => sync.load())
    sync.load()
    return () => {
      sync.stop()
      stopEvents()
      stopConnected()
    }
  }, [client, onEvent, onConnected])

  const of = useCallback((extension: string): Presence => items.get(extension) ?? { status: 'offline', source: 'telephony' }, [items])
  const value = useMemo(() => ({ realtime, of }), [realtime, of])
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>
}

export const usePresence = (): Presences => {
  const ctx = useContext(PresenceContext)
  if (!ctx) throw new Error('usePresence outside PresenceProvider')
  return ctx
}

/** A coloured dot and its word (RGAA 10.2: the colour is never alone) for the presence of an extension. */
export const PresenceBadge = ({ extension }: { extension: string }) => {
  const { t } = useT()
  const { realtime, of } = usePresence()
  if (!realtime) return null
  const { status } = of(extension)
  return (
    <span className={`presence presence-${status}`} data-testid={`presence-${extension}`}>
      <span aria-hidden="true">●</span> {t(`presence.${status}`)}
    </span>
  )
}
