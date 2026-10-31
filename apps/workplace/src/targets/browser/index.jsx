import 'cozy-ui/transpiled/react/stylesheet.css'
import 'cozy-ui/dist/cozy-ui.utils.min.css'
import 'cozy-ui-plus/dist/stylesheet.css'
import 'cozy-bar/dist/stylesheet.css'

import '@/styles/index.styl'
import React from 'react'
import AppProviders from '@/components/AppProviders'
import AppRouter from '@/components/AppRouter'
import { setupApp } from '@/targets/browser/setupApp'

const init = async () => {
  const { root, client, lang, polyglot } = setupApp()
  // The address of TwakePhone is a flag: known before the first render, or the app would say it is not configured.
  await client.plugins.flags.initializing
  root.render(
    <AppProviders client={client} lang={lang} polyglot={polyglot}>
      <AppRouter />
    </AppProviders>
  )
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init())
else void init()
