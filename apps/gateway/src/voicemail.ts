import { hkdfSync } from 'node:crypto'
import { WazoVoicemail, type WazoLogger } from '@twake/provider-wazo'

// The voicemail server of the platform (step 11a, ADR 0022): Wazo Platform, for the tenant of a single-tenant stack
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
 *                        the Gateway's account in Wazo (wazo-auth), in the tenant whose mailboxes these are;
 *   VOICEMAIL_MAX_MESSAGES, VOICEMAIL_MAX_SEC
 *                        the most messages a mailbox keeps (50), the longest a message lasts in seconds (180);
 *   VOICEMAIL_GRACE_DAYS how long the mailbox of someone who holds no extension any more is kept aside, with its
 *                        messages, in case they come back (7).
 *
 * SECRETS_KEY is required with it: Wazo knows the holder of a mailbox only by a print of their id keyed with a key
 * derived from it (review 11a, n°9).
 */
export const wazoFromEnv = (env: NodeJS.ProcessEnv, secretsKey: Buffer | undefined, logger?: WazoLogger): WazoVoicemail | undefined => {
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
  if (!secretsKey) throw new Error('Wazo: SECRETS_KEY is required with the URLs of Wazo (the holders of the mailboxes are keyed with it)')
  const whole = (name: string, max: number) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return undefined
    const n = Number(raw)
    if (!/^[0-9]+$/.test(raw) || n < 1 || n > max) throw new Error(`Wazo: ${name} must be a whole number from 1 to ${max}`)
    return n
  }
  const maxMessages = whole('VOICEMAIL_MAX_MESSAGES', 9999)
  const maxMessageSec = whole('VOICEMAIL_MAX_SEC', 3600)
  const graceDays = env.VOICEMAIL_GRACE_DAYS === '0' ? 0 : whole('VOICEMAIL_GRACE_DAYS', 365)
  return new WazoVoicemail({
    ...urls,
    authUrl: urls.authUrl.replace(/\/+$/, ''),
    confdUrl: urls.confdUrl.replace(/\/+$/, ''),
    calldUrl: urls.calldUrl.replace(/\/+$/, ''),
    username: env.WAZO_USER,
    password: env.WAZO_PASSWORD,
    holderSecret: holderSecretOf(secretsKey),
    ...(maxMessages !== undefined ? { maxMessages } : {}),
    ...(maxMessageSec !== undefined ? { maxMessageSec } : {}),
    ...(graceDays !== undefined ? { graceMs: graceDays * 86_400_000 } : {}),
    ...(logger ? { logger } : {})
  })
}

/** The key of the prints of the holders of the mailboxes in Wazo, derived from SECRETS_KEY for that use only. */
export const holderSecretOf = (secretsKey: Buffer) => Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'twake-phone: holders of mailboxes', 32))

/** VOICEMAIL_RETENTION_DAYS: how long a message is kept (30 days by default; 0: for good). */
export const retentionDaysOf = (env: NodeJS.ProcessEnv) => {
  const raw = env.VOICEMAIL_RETENTION_DAYS
  if (raw === undefined || raw === '') return 30
  if (!/^[0-9]+$/.test(raw) || Number(raw) > 3650) throw new Error('VOICEMAIL_RETENTION_DAYS must be a whole number of days from 0 to 3650')
  return Number(raw)
}
