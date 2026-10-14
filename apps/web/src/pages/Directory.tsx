import { useEffect, useState } from 'react'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { useFavorites } from '../favorites.js'
import { ContactList } from '../components/ContactList.js'
import type { Contact } from '@twake/telephony-client'

const DEBOUNCE_MS = 250

export const Directory = () => {
  const { t } = useT()
  const { client, me } = useGateway()
  const favorites = useFavorites()
  // The Gateway says whether this platform has a directory; an older Gateway does not, and the search then tells.
  const noDirectory = me?.features?.directory === false
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ items: Contact[]; truncated: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<'unavailable' | 'failed' | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q || noDirectory) {
      setResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      client
        .searchDirectory(q)
        .then(page => {
          if (cancelled) return
          setResults(page)
          setError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setResults({ items: [], truncated: false })
          setError(err instanceof Error && /Gateway 501 /.test(err.message) ? 'unavailable' : 'failed')
        })
        .finally(() => !cancelled && setSearching(false))
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, query, noDirectory])

  return (
    <>
      <h1>{t('directory.title')}</h1>
      {noDirectory || error === 'unavailable' ? <p className="alert">{t('directory.unavailable')}</p> : null}
      {noDirectory ? null : (
        <form role="search" onSubmit={e => e.preventDefault()}>
          <div className="field">
            <label htmlFor="directory-search">{t('directory.search')}</label>
            <input id="directory-search" type="search" autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('directory.placeholder')} />
          </div>
        </form>
      )}
      {error === 'failed' ? <p className="alert alert-error" role="alert">{t('directory.error')}</p> : null}
      <div role="status" className="sr-only">
        {searching ? t('directory.searching') : results ? t(results.items.length === 1 ? 'directory.countOne' : 'directory.count', { count: results.items.length }) : ''}
      </div>
      {results ? (
        <section aria-labelledby="results">
          <h2 id="results">{t('directory.results')}</h2>
          {results.items.length === 0 && !searching && !error ? <p>{t('directory.empty', { query: query.trim() })}</p> : <ContactList contacts={results.items} favorites={favorites} />}
          {results.truncated ? <p className="alert">{t('directory.truncated')}</p> : null}
        </section>
      ) : noDirectory ? null : (
        <section aria-labelledby="favorites">
          <h2 id="favorites">{t('directory.favorites')}</h2>
          {favorites.error ? <p className="alert alert-error" role="alert">{t('directory.favoritesError')}</p> : null}
          {favorites.items === null ? null : favorites.items.length === 0 ? <p>{t('directory.noFavorites')}</p> : <ContactList contacts={favorites.items} favorites={favorites} />}
        </section>
      )}
    </>
  )
}
