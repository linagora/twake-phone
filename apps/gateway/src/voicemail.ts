import { WazoVoicemail, type WazoLogger } from '@twake/provider-wazo'

// The voicemail server of the platform (step 11a, ADR 0021): Wazo Platform, for the tenant of a single-tenant stack
// (DEFAULT_TENANT), from the environment. The routes are in app.ts (/v1/voicemails).

/** A message id as it may reach the voicemail server: the provider checks it again. */
export const VOICEMAIL_ID = /^[0-9A-Za-z_-]{1,64}$/

/**
 * Wazo from the environment, or nothing when it is not set (no mailboxes: a call nobody takes ends as before).
 *
 *   WAZO_URL             Wazo's own entry point (its nginx: https://wazo.example.test), each API at its usual path;
 *   WAZO_AUTH_URL, WAZO_CONFD_URL, WAZO_CALLD_URL, WAZO_WEBSOCKETD_URL
 *                        or each API where it listens (the development stack, without nginx), which win over WAZO_URL;
 *   WAZO_USER, WAZO_PASSWORD
 *                        the Gateway's account in Wazo (wazo-auth), in the tenant whose mailboxes these are.
 */
export const wazoFromEnv = (env: NodeJS.ProcessEnv, logger?: WazoLogger): WazoVoicemail | undefined => {
  const base = env.WAZO_URL?.replace(/\/+$/, '')
  const urls = {
    authUrl: env.WAZO_AUTH_URL || (base ? `${base}/api/auth/0.1` : ''),
    confdUrl: env.WAZO_CONFD_URL || (base ? `${base}/api/confd/1.1` : ''),
    calldUrl: env.WAZO_CALLD_URL || (base ? `${base}/api/calld/1.0` : ''),
    websocketdUrl: env.WAZO_WEBSOCKETD_URL || (base ? `${base.replace(/^http/, 'ws')}/api/websocketd/` : '')
  }
  const given = Object.values(urls).filter(Boolean).length
  if (!given && !env.WAZO_USER) return undefined
  if (given < 4) throw new Error('Wazo: set WAZO_URL, or WAZO_AUTH_URL, WAZO_CONFD_URL, WAZO_CALLD_URL and WAZO_WEBSOCKETD_URL')
  for (const [name, url] of Object.entries(urls)) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new Error(`Wazo: ${name} is not a URL`)
    }
    const ws = name === 'websocketdUrl'
    if (!(ws ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(u.protocol)) throw new Error(`Wazo: ${name} must be ${ws ? 'ws: or wss:' : 'http: or https:'}`)
    if (u.username || u.password) throw new Error(`Wazo: ${name} must not carry credentials (WAZO_USER, WAZO_PASSWORD)`)
  }
  if (!env.WAZO_USER || !env.WAZO_PASSWORD) throw new Error('Wazo: WAZO_USER and WAZO_PASSWORD are required with the URLs of Wazo')
  return new WazoVoicemail({ ...urls, authUrl: urls.authUrl.replace(/\/+$/, ''), confdUrl: urls.confdUrl.replace(/\/+$/, ''), calldUrl: urls.calldUrl.replace(/\/+$/, ''), username: env.WAZO_USER, password: env.WAZO_PASSWORD, ...(logger ? { logger } : {}) })
}
