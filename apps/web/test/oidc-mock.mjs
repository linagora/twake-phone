// A throwaway OpenID provider for the web e2e: any login is accepted, access tokens are JWTs for the Gateway.
import Provider from 'oidc-provider'

// Logins are the LDAP uids: the SSO and the directory name people the same way, as LemonLDAP::NG does on an LDAP.
const NAMES = { amartin: 'Alice Martin', jdupont: 'Jean Dupont', bdurand: 'Bob Durand' }
/** Roles the provider asserts in the access token, as LemonLDAP::NG would from a group: alice administers the platform. */
const ROLES = { amartin: ['staff', 'twakephone-admin'], bdurand: ['staff'] }

/** Starts the provider on `port`; `appOrigin` is the web app allowed to sign in. Returns a stop function. */
export const startOidcMock = async ({ port, appOrigin, audience, resource = 'https://gateway.twakephone.test' }) => {
  const issuer = `http://127.0.0.1:${port}`
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: 'twakephone-web',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        redirect_uris: [`${appOrigin}/callback`],
        post_logout_redirect_uris: [`${appOrigin}/`]
      }
    ],
    pkce: { required: () => true },
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    claims: { openid: ['sub'], profile: ['name'], email: ['email'] },
    features: {
      devInteractions: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: () => ({ scope: 'openid profile email', audience, accessTokenFormat: 'jwt' })
      }
    },
    // A custom claim in the JWT access token: what the Gateway reads as roles (JWT_ROLES_CLAIM=roles).
    extraTokenClaims: async (_ctx, token) => ({ roles: ROLES[token.accountId] ?? [] }),
    findAccount: async (_ctx, id) => ({
      accountId: id,
      claims: async () => ({ sub: id, name: NAMES[id] ?? id, email: `${id}@example.test` })
    }),
    cookies: { keys: ['twakephone-e2e'] },
    ttl: { AccessToken: 600, IdToken: 600, Session: 600, Grant: 600, Interaction: 600 }
  })
  // The app runs on another origin: no SameSite trap, and plain http is fine for a local test.
  provider.proxy = true
  const server = await new Promise(resolve => {
    const s = provider.listen(port, '127.0.0.1', () => resolve(s))
  })
  return { issuer, jwksUrl: `${issuer}/jwks`, stop: () => new Promise(r => server.close(r)) }
}
