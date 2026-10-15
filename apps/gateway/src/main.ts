import { LiveKitConferenceBridge, MeetApi } from '@twake/conference-livekit'
import { miniPbxProvisioner } from '@twake/provider-asterisk'
import { buildApp } from './app.js'
import { authenticatorFromEnv } from './auth.js'
import { parseKey } from './crypto.js'
import { StoreDirectory, parseUserMap } from './directory.js'
import { DirectorySync, parseInterval } from './directory-sync.js'
import { ldapDirectoryFromEnv } from './ldap-directory.js'
import { storedAsteriskFactory, storedOpensipsFactory, type StoredAsteriskConfig, type StoredOpensipsConfig } from './providers.js'
import { ProviderRegistry } from './registry.js'
import { SipSecrets } from './sip-secrets.js'
import { PgStore } from './store/pg.js'

const env = process.env
const need = (name: string): string => {
  const v = env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

// A dev authenticator trusts the caller's word: never let it run in a production-flagged process by accident.
if (env.AUTH_MODE === 'dev' && env.NODE_ENV === 'production' && env.ALLOW_DEV_AUTH !== '1') {
  throw new Error('AUTH_MODE=dev is refused when NODE_ENV=production (set ALLOW_DEV_AUTH=1 on a throwaway dev stack)')
}

const store = new PgStore(need('DATABASE_URL'))
await store.migrate()

// Bootstrap of a single-tenant dev stack from the environment. It never overwrites configuration already in the database.
const tenant = env.DEFAULT_TENANT ?? 'default'
if (env.BOOTSTRAP_PROVIDER_URL && !(await store.listProviders()).some(p => p.tenantId === tenant)) {
  const config: StoredAsteriskConfig = {
    ari: { url: env.BOOTSTRAP_PROVIDER_URL, user: env.ARI_USER ?? 'twake', passwordRef: 'env:ARI_PASSWORD', ...(env.ARI_APP ? { app: env.ARI_APP } : {}) },
    websocketUrl: need('PBX_WSS_URL'),
    ...(env.ASTERISK_TRUNK_ENDPOINT ? { trunkEndpoint: env.ASTERISK_TRUNK_ENDPOINT } : {}),
    ...(env.ASTERISK_EXTERNAL_CONTEXT ? { externalDial: { context: env.ASTERISK_EXTERNAL_CONTEXT, ...(env.ASTERISK_EXTERNAL_E164_PREFIX ? { e164Prefix: env.ASTERISK_EXTERNAL_E164_PREFIX } : {}), ...(env.ASTERISK_EXTERNAL_NATIONAL_PREFIX ? { nationalPrefix: env.ASTERISK_EXTERNAL_NATIONAL_PREFIX } : {}) } } : {}),
    ...(env.ASTERISK_ORIGINATE_CONTEXT ? { originateContext: env.ASTERISK_ORIGINATE_CONTEXT } : {}),
    ...(env.PBX_PROVISION_URL ? { provisioning: { url: env.PBX_PROVISION_URL, tokenRef: 'env:TWAKE_PROVISION_TOKEN' } } : { staticSipSecretRef: 'env:DEV_SIP_SECRET' })
  }
  await store.upsertProvider({ tenantId: tenant, type: 'asterisk', config })
}
// OpenSIPS (step 3): the SIP server the browsers register to. OPENSIPS_WS_URL is public; the accounts live in the
// `subscriber` table of OPENSIPS_DB_URL (the Gateway's own database when unset); SIP_DOMAIN defaults to the WS host.
// Step 4: OPENSIPS_MI_URL (`udp:host:port` of mi_datagram) is where the Gateway subscribes to the events, delivered
// to OPENSIPS_EVENTS_LISTEN (`host[:port]`; the loopback and a free port by default), or to OPENSIPS_EVENTS_ADVERTISE
// (`host[:port]`) when OpenSIPS must be given another address than the listening one (0.0.0.0, a container), and
// accepted from the MI host and OPENSIPS_EVENTS_FROM (comma-separated IPv4 addresses or names): event_datagram
// sends from the address its kernel picks for the route, not always the MI one. These variables only seed the
// tenant's provider when the database has none; a stored one is not read again (see the README).
if (env.OPENSIPS_WS_URL && env.BOOTSTRAP_PROVIDER_URL) console.warn(`Both BOOTSTRAP_PROVIDER_URL and OPENSIPS_WS_URL are set: tenant ${tenant} keeps the provider already in the database, Asterisk when neither was`)
const eventsFrom = (env.OPENSIPS_EVENTS_FROM ?? '').split(',').map(s => s.trim()).filter(Boolean)
if (env.OPENSIPS_WS_URL && !(await store.listProviders()).some(p => p.tenantId === tenant)) {
  const config: StoredOpensipsConfig = {
    websocketUrl: env.OPENSIPS_WS_URL,
    domain: env.SIP_DOMAIN ?? new URL(env.OPENSIPS_WS_URL).hostname,
    ...(env.ICE_SERVERS ? { iceServers: [{ urls: env.ICE_SERVERS.split(',').map(u => u.trim()).filter(Boolean) }] } : {}),
    subscriberDbUrlRef: env.OPENSIPS_DB_URL ? 'env:OPENSIPS_DB_URL' : 'env:DATABASE_URL',
    ...(env.OPENSIPS_MI_URL
      ? {
          events: {
            miUrl: env.OPENSIPS_MI_URL,
            ...(env.OPENSIPS_EVENTS_LISTEN ? { listen: env.OPENSIPS_EVENTS_LISTEN } : {}),
            ...(env.OPENSIPS_EVENTS_ADVERTISE ? { advertise: env.OPENSIPS_EVENTS_ADVERTISE } : {}),
            ...(eventsFrom.length ? { from: eventsFrom } : {})
          }
        }
      : {})
  }
  await store.upsertProvider({ tenantId: tenant, type: 'opensips', config })
}
// DEV_USER_MAP seeds a mapping once; it never overwrites what an administrator or the directory wrote since.
for (const m of parseUserMap(env.DEV_USER_MAP)) if (!(await store.getMappingByUser(tenant, m.userId))) await store.upsertMapping({ tenantId: tenant, ...m })

const key = env.SECRETS_KEY ? parseKey(env.SECRETS_KEY) : undefined
const secretsFor = key ? (url: string, token: string) => new SipSecrets({ store, key, provisioner: miniPbxProvisioner({ url, token }) }) : undefined

const registry = new ProviderRegistry(await store.listProviders(), [
  storedAsteriskFactory({ store, ...(secretsFor ? { secretsFor } : {}) }),
  storedOpensipsFactory({ store, ...(key ? { key } : {}) })
])

// Meet phone access: one LiveKit for the deployment, enabled when its API credentials are given.
const conference = env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_URL
  ? (() => {
      const bridge = new LiveKitConferenceBridge({
        url: env.LIVEKIT_URL!,
        apiKey: env.LIVEKIT_API_KEY!,
        apiSecret: env.LIVEKIT_API_SECRET!,
        dialInNumbers: (env.MEET_DIALIN_NUMBERS ?? '8000').split(',').map(e164 => ({ country: env.MEET_DIALIN_COUNTRY ?? 'FR', e164: e164.trim() })),
        outboundAddress: need('MEET_OUTBOUND_ADDRESS'),
        ...(env.MEET_NUMBER_PRIVACY ? { numberPrivacy: env.MEET_NUMBER_PRIVACY as 'show' | 'mask' | 'hide' } : {})
      })
      // Meet owns rooms, PINs and dial-in rules when its external API is configured for the Gateway.
      const meet = env.MEET_URL && env.MEET_CLIENT_ID && env.MEET_CLIENT_SECRET ? new MeetApi({ url: env.MEET_URL, clientId: env.MEET_CLIENT_ID, clientSecret: env.MEET_CLIENT_SECRET }) : undefined
      // The trunks LiveKit needs (accept calls to the dial-in number, place dial-out calls). LiveKit may start later.
      const prepare = (attempt = 0): void => {
        bridge.ensureTrunks().catch(err => {
          console.error('LiveKit SIP trunks not ready, retrying:', (err as Error).message)
          if (attempt < 30) setTimeout(() => prepare(attempt + 1), 10_000).unref()
        })
      }
      prepare()
      return { bridge: () => bridge, ...(meet ? { meet } : {}), webhookKey: env.LIVEKIT_API_KEY!, webhookSecret: env.LIVEKIT_API_SECRET! }
    })()
  : undefined

const contacts = ldapDirectoryFromEnv(env, message => console.warn(`WARNING: ${message}`))
// The accounts of the directory become user ↔ extension mappings, on a schedule (LDAP_SYNC_INTERVAL, "0" to disable)
// and on demand from the administration screen. Only when the schema says which attribute holds the extension.
const directorySync = contacts && env.LDAP_ATTR_EXTENSION ? new DirectorySync({ store, directory: contacts, tenantId: env.LDAP_TENANT ?? tenant }) : undefined
const hstsMaxAge = env.HSTS_MAX_AGE ? Number(env.HSTS_MAX_AGE) : undefined
if (hstsMaxAge !== undefined && !(Number.isInteger(hstsMaxAge) && hstsMaxAge >= 0)) throw new Error('HSTS_MAX_AGE must be a number of seconds')
const app = await buildApp(registry, {
  store,
  directory: new StoreDirectory(store),
  ...(contacts ? { contacts } : {}),
  ...(directorySync ? { directorySync } : {}),
  ...(hstsMaxAge !== undefined ? { security: { hstsMaxAge, hstsIncludeSubDomains: env.HSTS_INCLUDE_SUBDOMAINS === '1' } } : {}),
  auth: authenticatorFromEnv(env),
  ...(conference ? { conference } : {})
})
directorySync?.useLogger(app.log)
const syncEvery = parseInterval(env.LDAP_SYNC_INTERVAL, 3_600_000)
if (directorySync && syncEvery > 0) directorySync.start(syncEvery)
app.addHook('onClose', async () => directorySync?.stop())
registry.startAll()
await app.listen({ host: env.HOST ?? '0.0.0.0', port: Number(env.PORT ?? 8080) })
