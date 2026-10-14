import type { Identity } from './auth.js'

/**
 * Who administers the platform. A role asserted by the identity provider (ADMIN_ROLE in the roles claim), or a user
 * named in ADMIN_USERS for a deployment whose provider issues no roles. Nothing in a request can claim it.
 */
export interface AdminPolicy {
  /** The role that makes an administrator, as the identity provider writes it. */
  adminRole: string
  /** "tenant:user" entries; a bare user id means the default tenant. */
  adminUsers: Set<string>
}

export const DEFAULT_ADMIN_ROLE = 'twakephone-admin'

export const isAdmin = (identity: Identity, policy: AdminPolicy): boolean =>
  (identity.roles ?? []).includes(policy.adminRole) || policy.adminUsers.has(`${identity.tenantId}:${identity.userId}`)

/** ADMIN_ROLE (default twakephone-admin) and ADMIN_USERS ("alice,acme:bob": a bare id is in DEFAULT_TENANT). */
export const adminPolicyFromEnv = (env: NodeJS.ProcessEnv): AdminPolicy => {
  // The same default as the authenticators: 'dev' in dev mode, 'default' otherwise.
  const defaultTenant = env.DEFAULT_TENANT ?? (env.AUTH_MODE === 'dev' ? 'dev' : 'default')
  const adminUsers = new Set(
    (env.ADMIN_USERS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(entry => (entry.includes(':') ? entry : `${defaultTenant}:${entry}`))
  )
  return { adminRole: env.ADMIN_ROLE || DEFAULT_ADMIN_ROLE, adminUsers }
}
