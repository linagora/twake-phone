import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Contact } from '@twake/telephony-client'
import { useGateway } from './gateway.js'

export interface Favorites {
  /** null while loading. */
  items: Contact[] | null
  error: boolean
  has: (id: string) => boolean
  /** True while a change for this contact is on its way to the Gateway: the star is disabled meanwhile. */
  pending: (id: string) => boolean
  toggle: (contact: Contact) => Promise<void>
}

const FavoritesContext = createContext<Favorites | null>(null)

/**
 * The signed-in user's favourites, loaded once and updated optimistically: the Gateway keeps them. One change per
 * contact at a time, state updates by function (never from a stale closure), and the list is reloaded after a failure.
 */
export const FavoritesProvider = ({ children }: { children: ReactNode }) => {
  const { client, me } = useGateway()
  const enabled = me?.features?.directory !== false
  const [items, setItems] = useState<Contact[] | null>(null)
  const [error, setError] = useState(false)
  const [inFlight, setInFlight] = useState<Set<string>>(() => new Set())

  const reload = useCallback(() => {
    if (!enabled) {
      setItems([])
      return Promise.resolve()
    }
    return client
      .getFavorites()
      .then(page => {
        setItems(page.items)
        setError(false)
      })
      .catch(() => {
        setItems(current => current ?? [])
        setError(true)
      })
  }, [client, enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  const has = useCallback((id: string) => !!items?.some(c => c.id === id), [items])
  const pending = useCallback((id: string) => inFlight.has(id), [inFlight])
  const toggle = useCallback(
    async (contact: Contact) => {
      if (inFlight.has(contact.id) || items === null) return
      const on = items.some(c => c.id === contact.id)
      setInFlight(s => new Set(s).add(contact.id))
      setItems(current => (on ? (current ?? []).filter(c => c.id !== contact.id) : [...(current ?? []).filter(c => c.id !== contact.id), contact]))
      try {
        if (on) await client.removeFavorite(contact.id)
        else await client.addFavorite(contact.id)
        setError(false)
      } catch {
        setError(true)
        await reload()
      } finally {
        setInFlight(s => {
          const next = new Set(s)
          next.delete(contact.id)
          return next
        })
      }
    },
    [client, inFlight, items, reload]
  )

  const value = useMemo(() => ({ items, error, has, pending, toggle }), [items, error, has, pending, toggle])
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>
}

export const useFavorites = (): Favorites => {
  const ctx = useContext(FavoritesContext)
  if (!ctx) throw new Error('useFavorites outside FavoritesProvider')
  return ctx
}
