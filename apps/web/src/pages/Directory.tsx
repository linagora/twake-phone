import { useEffect, useState } from 'react'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { useFavorites } from '../favorites.js'
import { ContactList } from '../components/ContactList.js'
import type { Contact } from '@twake/telephony-client'

const DEBOUNCE_MS = 250

export const Directory = () => {
  const { t } = useT()
  const { client } = useGateway()
  const favorites = useFavorites()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Contact[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<'unavailable' | 'failed' | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      client
        .searchDirectory(q)
        .then(page => {
          if (cancelled) return
          setResults(page.items)
          setError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setResults([])
          setError(err instanceof Error && /Gateway 501 /.test(err.message) ? 'unavailable' : 'failed')
        })
        .finally(() => !cancelled && setSearching(false))
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, query])

  return (
    <>
      <h1>{t('directory.title')}</h1>
      <form role="search" onSubmit={e => e.preventDefault()}>
        <div className="field">
          <label htmlFor="directory-search">{t('directory.search')}</label>
          <input id="directory-search" type="search" autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('directory.placeholder')} />
        </div>
      </form>
      {error === 'unavailable' ? <p className="alert">{t('directory.unavailable')}</p> : null}
      {error === 'failed' ? <p className="alert alert-error" role="alert">{t('directory.error')}</p> : null}
      <div role="status" className="sr-only">
        {searching ? t('directory.searching') : results ? t('directory.count', { count: results.length }) : ''}
      </div>
      {results ? (
        <section aria-labelledby="results">
          <h2 id="results">{t('directory.results')}</h2>
          {results.length === 0 && !searching && !error ? <p>{t('directory.empty', { query: query.trim() })}</p> : <ContactList contacts={results} favorites={favorites} />}
        </section>
      ) : (
        <section aria-labelledby="favorites">
          <h2 id="favorites">{t('directory.favorites')}</h2>
          {favorites.error ? <p className="alert alert-error" role="alert">{t('directory.favoritesError')}</p> : null}
          {favorites.items === null ? null : favorites.items.length === 0 ? <p>{t('directory.noFavorites')}</p> : <ContactList contacts={favorites.items} favorites={favorites} />}
        </section>
      )}
    </>
  )
}
