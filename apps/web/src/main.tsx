import createCache from '@emotion/cache'
import { CacheProvider } from '@emotion/react'
import '@linagora/twake-css/dist/utils.css'
import { TwakeMuiThemeProvider } from '@linagora/twake-mui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { registerServiceWorker } from './push.js'

// It shows the notifications of calls (step 5), and asks nothing by itself.
registerServiceWorker()

// The styles of the design system carry the nonce the app's server put in the page (its CSP allows no other inline style).
const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content
const cache = createCache({ key: 'twake', ...(nonce ? { nonce } : {}) })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CacheProvider value={cache}>
      <TwakeMuiThemeProvider mode="light">
        <App />
      </TwakeMuiThemeProvider>
    </CacheProvider>
  </StrictMode>
)
