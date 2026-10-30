import { Alert, AlertProvider, Typography } from '@linagora/twake-mui'
import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthProvider.js'
import { createUserManager } from './auth/oidc.js'
import { loadConfig, type AppConfig } from './config.js'
import { ParentDial } from './embedded.js'
import { GatewayProvider } from './gateway.js'
import { I18nProvider, useT } from './i18n/useT.js'
import { CenteredPage } from './components/CenteredPage.js'
import { Layout } from './components/Layout.js'
import { Admin } from './pages/admin/Admin.js'
import { Alerts } from './pages/admin/Alerts.js'
import { Accounts } from './pages/admin/Directory.js'
import { Limits } from './pages/admin/Limits.js'
import { Numbers } from './pages/admin/Numbers.js'
import { Sites } from './pages/admin/Sites.js'
import { Rights } from './pages/admin/Rights.js'
import { CallFlows } from './pages/admin/CallFlows.js'
import { RingGroups } from './pages/admin/RingGroups.js'
import { Trunks } from './pages/admin/Trunks.js'
import { Webhooks } from './pages/admin/Webhooks.js'
import { ContactPage } from './pages/ContactPage.js'
import { Phone } from './pages/Phone.js'
import { SupervisionPage } from './pages/Supervision.js'
import { VoicemailPage } from './pages/Voicemail.js'
import { PresenceProvider } from './presence.js'
import { Recents } from './pages/Recents.js'
import { Settings } from './pages/Settings.js'
import { SignIn } from './pages/SignIn.js'
import { SoftphoneProvider } from './softphone.js'

const Gate = ({ config }: { config: AppConfig }) => {
  const { t } = useT()
  const { state } = useAuth()
  if (state.status === 'loading') return <CenteredPage><p role="status">{t('auth.loading')}</p></CenteredPage>
  if (state.status === 'anonymous') return <SignIn />
  return (
    <GatewayProvider config={config}>
      <SoftphoneProvider>
        <AlertProvider>
          <PresenceProvider>
          <BrowserRouter>
            <ParentDial />
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Phone />} />
                <Route path="recents" element={<Recents />} />
                <Route path="voicemail" element={<VoicemailPage />} />
                <Route path="supervision" element={<SupervisionPage />} />
                <Route path="directory" element={<Navigate to="/" replace />} />
                <Route path="directory/:id" element={<ContactPage />} />
                <Route path="settings" element={<Settings config={config} />} />
                <Route path="admin" element={<Admin />}>
                  <Route index element={<Accounts />} />
                  <Route path="trunks" element={<Trunks />} />
                  <Route path="numbers" element={<Numbers />} />
                  <Route path="sites" element={<Sites />} />
                  <Route path="groups" element={<RingGroups />} />
                  <Route path="flows" element={<CallFlows />} />
                  <Route path="rights" element={<Rights />} />
                  <Route path="limits" element={<Limits />} />
                  <Route path="alerts" element={<Alerts />} />
                  <Route path="webhooks" element={<Webhooks />} />
                  <Route path="*" element={<Navigate to="/admin" replace />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
          </PresenceProvider>
        </AlertProvider>
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
  if (error)
    return (
      <CenteredPage>
        <Typography variant="h4" component="h1" gutterBottom>
          {t('error.title')}
        </Typography>
        <Alert severity="error" role="alert">
          {t('config.error', { reason: error })}
        </Alert>
      </CenteredPage>
    )
  if (!config) return <CenteredPage><p role="status">{t('auth.loading')}</p></CenteredPage>
  return <Configured config={config} />
}

export const App = () => (
  <I18nProvider>
    <Boot />
  </I18nProvider>
)
