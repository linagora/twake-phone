import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts'
import type { AppConfig } from '../config.js'

export const CALLBACK_PATH = '/callback'

/**
 * The scopes asked by default. `offline_access` makes the identity provider issue a refresh token, which is how the
 * session renews silently: without it oidc-client-ts falls back to a hidden iframe on the provider, which third-party
 * cookie blocking breaks.
 */
export const DEFAULT_SCOPE = 'openid profile email offline_access'

/**
 * The prompt sent with the sign-in request. OpenID Connect Core (11) has the provider ignore `offline_access` unless
 * the request says `prompt=consent`, so that is the default whenever the scope asks for it. A provider that issues
 * refresh tokens without it (and would show a consent page for nothing) gets `oidc.prompt: ""` in config.json.
 */
export const promptFor = (scope: string, configured?: string): string | undefined => {
  if (configured !== undefined) return configured || undefined
  return scope.split(' ').includes('offline_access') ? 'consent' : undefined
}

/** One UserManager per app: PKCE, tokens in sessionStorage (gone when the tab closes), silent renew by refresh token. */
export const createUserManager = (config: AppConfig, origin = window.location.origin): UserManager => {
  const scope = config.oidc.scope ?? DEFAULT_SCOPE
  const prompt = promptFor(scope, config.oidc.prompt)
  return new UserManager({
    authority: config.oidc.authority,
    client_id: config.oidc.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    scope,
    response_type: 'code',
    ...(prompt ? { prompt } : {}),
    ...(config.oidc.resource ? { resource: config.oidc.resource } : {}),
    automaticSilentRenew: true,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage })
  })
}

const looksLikeJwt = (token: string) => token.split('.').length === 3 && token.split('.').every(part => part.length > 0)

/**
 * The bearer the Gateway verifies: the access token, which must be a JWT for the Gateway (its audience), never the ID
 * token (meant for this app, with its own audience and the user's claims). An opaque access token means the identity
 * provider is not configured to issue a token for the Gateway (`oidc.resource`, or an audience mapper on the client).
 */
export const bearerOf = (user: User): string => {
  if (!user.access_token || !looksLikeJwt(user.access_token)) {
    throw new Error('the identity provider issued an opaque access token; configure it to issue a JWT for the Gateway (oidc.resource)')
  }
  return user.access_token
}

export const displayNameOf = (user: User): string => {
  const p = user.profile
  return (typeof p.name === 'string' && p.name) || (typeof p.preferred_username === 'string' && p.preferred_username) || (typeof p.email === 'string' && p.email) || p.sub
}

/**
 * The name to show: the Gateway's when its directory knows one (an LDAP name, a mapping), else the identity
 * provider's profile. A Gateway that only knows the user id answers with that id, which is no name.
 */
export const displayNameFor = (me: { id: string; displayName: string } | null, user: User | null): string => {
  if (me && me.displayName && me.displayName !== me.id) return me.displayName
  if (user) return displayNameOf(user)
  return me?.displayName ?? ''
}
