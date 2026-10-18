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
 *   VOICEMAIL_MAX_CALL_SEC
 *                        the longest a call to a mailbox lasts (300), as OpenSIPS and Asterisk have it: VOICEMAIL_MAX_SEC
 *                        above it is refused (the call would cut the message first), and the
 *                        recordings handed out are bounded on it;
 *   VOICEMAIL_GRACE_DAYS how long the mailbox of someone who holds no extension any more is kept aside, with its
 *                        messages, in case they come back (7). With VOICEMAIL_RETENTION_DAYS=0 (no retention period),
 *                        the mailbox goes with its messages once past it: 1 day at least then.
 *
 * SECRETS_KEY is required with it: Wazo knows the holder of a mailbox only by a print of their id keyed with a key
 * derived from it.
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
  const maxCallSec = whole('VOICEMAIL_MAX_CALL_SEC', 3600) ?? 300
  if (maxCallSec < 30) throw new Error('Wazo: VOICEMAIL_MAX_CALL_SEC must be 30 to 3600 seconds')
  if ((maxMessageSec ?? 180) > maxCallSec) throw new Error(`Wazo: VOICEMAIL_MAX_SEC (${maxMessageSec ?? 180} s) is longer than a call to a mailbox lasts (VOICEMAIL_MAX_CALL_SEC, ${maxCallSec} s): the call would cut the message`)
  const graceDays = env.VOICEMAIL_GRACE_DAYS === '0' ? 0 : whole('VOICEMAIL_GRACE_DAYS', 365)
  // Without a retention period, a mailbox aside goes with its messages once past its grace period: a day at least.
  if (graceDays === 0 && retentionDaysOf(env) === 0) throw new Error('Wazo: VOICEMAIL_GRACE_DAYS must be at least 1 day with VOICEMAIL_RETENTION_DAYS=0 (the mailbox of someone without an extension then goes with its messages once past it)')
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
    maxCallSec,
    ...(graceDays !== undefined ? { graceMs: graceDays * 86_400_000 } : {}),
    ...(logger ? { logger } : {})
  })
}

/** The key of the prints of the holders of the mailboxes in Wazo, derived from SECRETS_KEY for that use only. */
export const holderSecretOf = (secretsKey: Buffer) => Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'twake-phone: holders of mailboxes', 32))

/**
 * What differs between this Gateway's mailboxes and what OpenSIPS has of them, said at
 * its start: OpenSIPS sends no call to the mailboxes while this Gateway has a voicemail server, or sends them while it
 * has none (it then leaves `voicemail_boxes` to a Gateway that has one), or ends a call to a mailbox before the
 * longest message is left (VOICEMAIL_MAX_SEC against OpenSIPS's own VOICEMAIL_MAX_CALL_SEC, not this Gateway's copy).
 * Nothing when OpenSIPS could not say.
 */
export const voicemailMismatch = (voicemail: { maxMessageSec?: number } | undefined, sip: { on: boolean; maxCallSec?: number } | undefined): string[] => {
  if (!sip) return []
  if (!voicemail) return sip.on ? ['OpenSIPS sends calls to the mailboxes (WAZO_SIP) but this Gateway has no voicemail server (WAZO_*): it leaves voicemail_boxes to a Gateway that has one, and the mailboxes stay as they are without one'] : []
  if (!sip.on) return ['this Gateway has a voicemail server (WAZO_*) but OpenSIPS sends no call to the mailboxes (its WAZO_SIP is empty): nobody reaches them']
  const max = voicemail.maxMessageSec
  if (max !== undefined && sip.maxCallSec !== undefined && max > sip.maxCallSec) return [`VOICEMAIL_MAX_SEC (${max} s) is longer than OpenSIPS lets a call to a mailbox last (its VOICEMAIL_MAX_CALL_SEC, ${sip.maxCallSec} s): a message that long is cut; make them agree`]
  return []
}

/** VOICEMAIL_RETENTION_DAYS: how long a message is kept (30 days by default; 0: for good). */
export const retentionDaysOf = (env: NodeJS.ProcessEnv) => {
  const raw = env.VOICEMAIL_RETENTION_DAYS
  if (raw === undefined || raw === '') return 30
  if (!/^[0-9]+$/.test(raw) || Number(raw) > 3650) throw new Error('VOICEMAIL_RETENTION_DAYS must be a whole number of days from 0 to 3650')
  return Number(raw)
}
