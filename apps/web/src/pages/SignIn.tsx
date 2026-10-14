import { useAuth } from '../auth/AuthProvider.js'
import { useT } from '../i18n/useT.js'

export const SignIn = () => {
  const { t } = useT()
  const { state, signIn } = useAuth()
  const error = state.status === 'anonymous' ? state.error : undefined
  return (
    <main id="main" className="center">
      <h1>{t('app.name')}</h1>
      <p>{t('auth.welcome')}</p>
      {error ? (
        <div className="alert alert-error" role="alert">
          {t('auth.error', { reason: error })}
        </div>
      ) : null}
      <button type="button" className="btn btn-primary" onClick={() => void signIn()}>
        {t('auth.signin')}
      </button>
    </main>
  )
}
