import React from 'react'
import { BrowserRouter } from 'react-router-dom'

import { CozyProvider, createMockClient } from 'cozy-client'
import AlertProvider from 'cozy-ui/transpiled/react/providers/Alert'
import { BreakpointsProvider } from 'cozy-ui/transpiled/react/providers/Breakpoints'
import { I18n } from 'twake-i18n'

import enLocale from '../src/locales/en.json'

const AppLike = ({ children, client }) => (
  <CozyProvider client={client || createMockClient({})}>
    <I18n dictRequire={() => enLocale} lang="en">
      <BreakpointsProvider>
        <BrowserRouter>
          <AlertProvider>{children}</AlertProvider>
        </BrowserRouter>
      </BreakpointsProvider>
    </I18n>
  </CozyProvider>
)

export default AppLike
