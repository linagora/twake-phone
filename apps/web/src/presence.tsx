import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Presence } from '@twake/telephony-types'
import { useGateway } from './gateway.js'
import { useT } from './i18n/useT.js'

export interface Presences {
  /** The platform tells presences as they change; false: nothing to show (an older Gateway, a provider without events). */
  realtime: boolean
  /** The presence of an extension; offline when the Gateway never heard of it. */
  of: (extension: string) => Presence
}

const PresenceContext = createContext<Presences | null>(null)

/** The presence of everyone, by extension: loaded once from the Gateway, then kept up to date by its events. */
export const PresenceProvider = ({ children }: { children: ReactNode }) => {
  const { client, onEvent } = useGateway()
  const [realtime, setRealtime] = useState(false)
  const [items, setItems] = useState<Map<string, Presence>>(() => new Map())

  useEffect(() => {
    let cancelled = false
    // Changes heard before the list arrives win over it; the list fills the rest.
    const stop = onEvent(event => {
      if (event.type !== 'presence.changed' || !event.payload.extension) return
      const { extension, presence } = event.payload
      setItems(current => new Map(current).set(extension, presence))
    })
    client
      .getPresences()
      .then(page => {
        if (cancelled) return
        setRealtime(page.realtime)
        setItems(current => {
          const next = new Map(page.items.map(i => [i.extension, i.presence] as const))
          for (const [extension, presence] of current) next.set(extension, presence)
          return next
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      stop()
    }
  }, [client, onEvent])

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
