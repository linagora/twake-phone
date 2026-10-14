import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts'
import type { AppConfig } from '../config.js'

export const CALLBACK_PATH = '/callback'

/** One UserManager per app: PKCE, tokens in sessionStorage (gone when the tab closes), silent renew by refresh token. */
export const createUserManager = (config: AppConfig, origin = window.location.origin): UserManager =>
  new UserManager({
    authority: config.oidc.authority,
    client_id: config.oidc.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    scope: config.oidc.scope ?? 'openid profile email',
    response_type: 'code',
    ...(config.oidc.resource ? { resource: config.oidc.resource } : {}),
    automaticSilentRenew: true,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage })
  })

/** The bearer the Gateway verifies: the access token, or the ID token when the IdP issued an opaque access token. */
export const bearerOf = (user: User): string => (user.access_token && user.access_token.split('.').length === 3 ? user.access_token : (user.id_token ?? user.access_token))

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
