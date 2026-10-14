import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthProvider.js'
import { createUserManager } from './auth/oidc.js'
import { loadConfig, type AppConfig } from './config.js'
import { GatewayProvider } from './gateway.js'
import { I18nProvider, useT } from './i18n/useT.js'
import { Layout } from './components/Layout.js'
import { Admin } from './pages/Admin.js'
import { Dialer } from './pages/Dialer.js'
import { ContactPage } from './pages/ContactPage.js'
import { Directory } from './pages/Directory.js'
import { FavoritesProvider } from './favorites.js'
import { PresenceProvider } from './presence.js'
import { Recents } from './pages/Recents.js'
import { Settings } from './pages/Settings.js'
import { SignIn } from './pages/SignIn.js'
import { SoftphoneProvider } from './softphone.js'

const Gate = ({ config }: { config: AppConfig }) => {
  const { t } = useT()
  const { state } = useAuth()
  if (state.status === 'loading') return <main id="main" className="center"><p role="status">{t('auth.loading')}</p></main>
  if (state.status === 'anonymous') return <SignIn />
  return (
    <GatewayProvider config={config}>
      <SoftphoneProvider>
        <FavoritesProvider>
          <PresenceProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Dialer />} />
                <Route path="recents" element={<Recents />} />
                <Route path="directory" element={<Directory />} />
                <Route path="directory/:id" element={<ContactPage />} />
                <Route path="settings" element={<Settings config={config} />} />
                <Route path="admin" element={<Admin />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
          </PresenceProvider>
        </FavoritesProvider>
      </SoftphoneProvider>
    </GatewayProvider>
  )
}

const Configured = ({ config }: { config: AppConfig }) => {
  const manager = useMemo(() => createUserManager(config), [config])
  return (
    <AuthProvider manager={manager}>
      <Gate config={config} />
    </AuthProvider>
  )
}

const Boot = () => {
  const { t } = useT()
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadConfig()
      .then(setConfig)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])
  if (error) return <main id="main" className="center"><h1>{t('error.title')}</h1><p className="alert alert-error" role="alert">{t('config.error', { reason: error })}</p></main>
  if (!config) return <main id="main" className="center"><p role="status">{t('auth.loading')}</p></main>
  return <Configured config={config} />
}

export const App = () => (
  <I18nProvider>
    <Boot />
  </I18nProvider>
)
