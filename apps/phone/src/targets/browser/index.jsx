/* eslint-disable import/order */
import 'cozy-ui/transpiled/react/stylesheet.css'
import 'cozy-ui/dist/cozy-ui.utils.min.css'
import 'cozy-ui-plus/dist/stylesheet.css'
import 'cozy-bar/dist/stylesheet.css'
import 'cozy-search/dist/stylesheet.css'

import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/plus-jakarta-sans/800.css'
import '@/styles/index.styl'
import '@/styles/phone.css'
import React from 'react'
import AppProviders from '@/components/AppProviders'
import setupApp from '@/targets/browser/setupApp'
import AppRouter from '@/components/AppRouter'

const init = () => {
  const { root, client, lang, polyglot } = setupApp()

  root.render(
    <AppProviders client={client} lang={lang} polyglot={polyglot}>
      <AppRouter />
    </AppProviders>
  )
}

document.addEventListener('DOMContentLoaded', () => {
  init()
})
