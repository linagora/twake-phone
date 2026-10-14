import { useAuth } from '../auth/AuthProvider.js'
import { displayNameFor } from '../auth/oidc.js'
import type { AppConfig } from '../config.js'
import { useGateway } from '../gateway.js'
import { LANGS, type Lang } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'

export const Settings = ({ config }: { config: AppConfig }) => {
  const { t, lang, setLang } = useT()
  const { state } = useAuth()
  const { me, meError } = useGateway()
  const user = state.status === 'signed-in' ? state.user : null
  return (
    <>
      <h1>{t('settings.title')}</h1>
      <section className="card" aria-labelledby="account">
        <h2 id="account">{t('settings.account')}</h2>
        <p>
          <strong>{displayNameFor(me, user)}</strong>
          <br />
          {typeof user?.profile.email === 'string' ? user.profile.email : null}
          <br />
          {me ? (me.extension ? t('auth.extension', { extension: me.extension }) : t('auth.noExtension')) : null}
        </p>
        {meError ? (
          <p className="alert alert-error" role="alert">
            {meError}
          </p>
        ) : null}
      </section>
      <section className="card" aria-labelledby="language">
        <h2 id="language">{t('settings.language')}</h2>
        <div className="field">
          <label htmlFor="lang">{t('settings.languageLabel')}</label>
          <select id="lang" value={lang} onChange={e => setLang(e.target.value as Lang)}>
            {LANGS.map(l => (
              <option key={l} value={l}>
                {l === 'fr' ? 'Français' : 'English'}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="card" aria-labelledby="gateway">
        <h2 id="gateway">{t('settings.gateway')}</h2>
        <p>
          <code>{config.gatewayUrl}</code>
        </p>
      </section>
    </>
  )
}
