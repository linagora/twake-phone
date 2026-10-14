import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Contact } from '@twake/telephony-client'
import { useGateway } from './gateway.js'

export interface Favorites {
  /** null while loading. */
  items: Contact[] | null
  error: boolean
  has: (id: string) => boolean
  toggle: (contact: Contact) => Promise<void>
}

const FavoritesContext = createContext<Favorites | null>(null)

/** The signed-in user's favourites, loaded once and updated optimistically: the Gateway keeps them. */
export const FavoritesProvider = ({ children }: { children: ReactNode }) => {
  const { client } = useGateway()
  const [items, setItems] = useState<Contact[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    client
      .getFavorites()
      .then(page => !cancelled && setItems(page.items))
      .catch(() => {
        if (cancelled) return
        setItems([])
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const has = useCallback((id: string) => !!items?.some(c => c.id === id), [items])
  const toggle = useCallback(
    async (contact: Contact) => {
      const before = items ?? []
      const on = before.some(c => c.id === contact.id)
      setItems(on ? before.filter(c => c.id !== contact.id) : [...before, contact])
      try {
        if (on) await client.removeFavorite(contact.id)
        else await client.addFavorite(contact.id)
        setError(false)
      } catch {
        setItems(before)
        setError(true)
      }
    },
    [client, items]
  )

  const value = useMemo(() => ({ items, error, has, toggle }), [items, error, has, toggle])
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>
}

export const useFavorites = (): Favorites => {
  const ctx = useContext(FavoritesContext)
  if (!ctx) throw new Error('useFavorites outside FavoritesProvider')
  return ctx
}
