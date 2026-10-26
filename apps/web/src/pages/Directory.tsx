import { Alert, TextField, Typography } from '@linagora/twake-mui'
import { useEffect, useState } from 'react'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { ContactList } from '../components/ContactList.js'
import type { Contact } from '@twake/telephony-client'

const DEBOUNCE_MS = 250
/** As many people as the Gateway gives at once (MAX_SEARCH): past them, the search narrows the list. */
const LIMIT = 50

/** The people of the organisation, all of them at first, narrowed by the search. */
export const Directory = () => {
  const { t } = useT()
  const { client, me } = useGateway()
  // The Gateway says whether this platform has a directory; an older Gateway does not, and the search then tells.
  const noDirectory = me?.features?.directory === false
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ items: Contact[]; truncated: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<'unavailable' | 'failed' | null>(null)
  // One letter is no search for the directory: the whole list stays.
  const q = query.trim().length < 2 ? '' : query.trim()

  useEffect(() => {
    if (noDirectory) return
    let cancelled = false
    const timer = setTimeout(
      () => {
        setSearching(true)
        client
          .searchDirectory(q, LIMIT)
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
      },
      q ? DEBOUNCE_MS : 0
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, q, noDirectory])

  return (
    <>
      <Typography variant="h5" component="h2" id="directory-title" gutterBottom>
        {t('directory.title')}
      </Typography>
      {noDirectory || error === 'unavailable' ? (
        <Alert severity="info" className="u-mb-1">
          {t('directory.unavailable')}
        </Alert>
      ) : null}
      {noDirectory ? null : (
        <form role="search" onSubmit={e => e.preventDefault()}>
          <TextField
            id="directory-search"
            type="search"
            label={t('directory.search')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('directory.placeholder')}
            fullWidth
            className="u-mb-1"
            slotProps={{ htmlInput: { autoComplete: 'off' }, inputLabel: { shrink: true } }}
          />
        </form>
      )}
      {error === 'failed' ? (
        <Alert severity="error" role="alert" className="u-mb-1">
          {t('directory.error')}
        </Alert>
      ) : null}
      <div role="status" className="u-visuallyhidden">
        {searching ? t('directory.searching') : results && q ? t(results.items.length === 1 ? 'directory.countOne' : 'directory.count', { count: results.items.length }) : ''}
      </div>
      {results ? (
        <>
          {results.items.length === 0 && !searching && !error ? <Typography component="p">{t('directory.empty', { query: q })}</Typography> : <ContactList contacts={results.items} />}
          {results.truncated ? (
            <Alert severity="info" className="u-mt-1">
              {t('directory.truncated')}
            </Alert>
          ) : null}
        </>
      ) : null}
    </>
  )
}
