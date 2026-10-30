import { createRoot } from 'react-dom/client'

import CozyClient from 'cozy-client'
import flag from 'cozy-flags'
import { RealtimePlugin } from 'cozy-realtime'
import { initTranslation } from 'twake-i18n'

import en from '@/locales/en.json'
import fr from '@/locales/fr.json'

import manifest from '../../../manifest.webapp'

import schema from '@/doctypes'

/** The client of the stack, from what the stack wrote in the page (data-cozy). */
export const makeClient = container => {
  const data = JSON.parse(container.dataset.cozy)
  return new CozyClient({
    uri: `${window.location.protocol}//${data.domain}`,
    token: data.token,
    appMetadata: { slug: manifest.slug, version: manifest.version },
    schema,
    store: true,
    autoHydrate: true
  })
}

const getDataOrDefault = (data, defaultData) => (/^\{\{\..*\}\}$/.test(data) ? defaultData : data)

export const setupApp = () => {
  const container = document.querySelector('[role=application]')
  const root = createRoot(container)
  const client = makeClient(container)
  const lang = getDataOrDefault(JSON.parse(container.dataset.cozy)?.locale, 'en')
  const polyglot = initTranslation(lang, l => (l === 'fr' ? fr : en))
  client.registerPlugin(flag.plugin)
  client.registerPlugin(RealtimePlugin)
  return { root, client, lang, polyglot }
}
