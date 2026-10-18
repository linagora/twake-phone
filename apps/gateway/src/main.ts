import { LiveKitConferenceBridge, MeetApi } from '@twake/conference-livekit'
import { ovhOperatorFromEnv } from '@twake/provider-ovh'
import { buildApp } from './app.js'
import { authenticatorFromEnv } from './auth.js'
import { sweepDialIns, webhookKeyFromEnv } from './conference-sweep.js'
import { parseKey } from './crypto.js'
import { StoreDirectory, accessNumberInUse, meetAccessMismatch, reservedInUse, seedUserMap } from './directory.js'
import { DirectorySync, parseInterval } from './directory-sync.js'
import { ldapDirectoryFromEnv } from './ldap-directory.js'
import { storedOpensipsFactory, type StoredOpensipsConfig } from './providers.js'
import { WebPush, parsePushServices, parseVapidSubject } from './push.js'
import { ProviderRegistry } from './registry.js'
import { PgStore } from './store/pg.js'
import { trunkFromEnv, trunkRecord } from './trunks.js'
import { wazoFromEnv } from './voicemail.js'
import { networkInterfaces } from 'node:os'
import { denyNetworks, parsePorts, parseTenantNetworks } from './webhook-delivery.js'

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
// OpenSIPS (step 3): the SIP server the browsers register to. OPENSIPS_WS_URL is public; the accounts live in the
// `subscriber` table of OPENSIPS_DB_URL (the Gateway's own database when unset); SIP_DOMAIN defaults to the WS host.
// Step 4: OPENSIPS_MI_URL (`udp:host:port` of mi_datagram) is where the Gateway subscribes to the events, delivered
// to OPENSIPS_EVENTS_LISTEN (`host[:port]`; the loopback and a free port by default), or to OPENSIPS_EVENTS_ADVERTISE
// (`host[:port]`) when OpenSIPS must be given another address than the listening one (0.0.0.0, a container), and
// accepted from the MI host and OPENSIPS_EVENTS_FROM (comma-separated IPv4 addresses or names): event_datagram
// sends from the address its kernel picks for the route, not always the MI one. These variables only seed the
// tenant's provider when the database has none; a stored one is not read again (see the README).
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
// Meet phone access: one LiveKit for the deployment, enabled when its API credentials are given (step 8, ADR 0018).
// MEET_NUMBER: the access number OpenSIPS sends to LiveKit SIP, read only then: it is nobody's extension.
const conferenceOn = !!(env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_URL)
const accessNumber = conferenceOn ? env.MEET_NUMBER || '8000' : undefined
if (accessNumber !== undefined && !/^[1-9][0-9]{1,5}$/.test(accessNumber)) throw new Error('MEET_NUMBER must be two to six digits, not starting with 0')
// DEV_USER_MAP seeds a mapping once; it never overwrites what an administrator or the directory wrote since.
await seedUserMap(store, tenant, env.DEV_USER_MAP, message => console.warn(`WARNING: USER_EXTENSIONS (DEV_USER_MAP): ${message}`), accessNumber)

const key = env.SECRETS_KEY ? parseKey(env.SECRETS_KEY) : undefined

// Step 6 (ADR 0016): a first trunk to the operator and its direct numbers from TRUNK_* (docker/pilot/README.md), when
// the tenant has none; administrators change them from then on (/v1/admin/trunks, /v1/admin/dids), the variables are
// not read again. The password is kept encrypted with SECRETS_KEY.
const seed = trunkFromEnv(env)
if (seed && !(await store.listTrunks(tenant)).length) {
  await store.upsertTrunk(trunkRecord(tenant, seed.id, seed.parsed, undefined, key))
  for (const did of seed.dids) await store.upsertDid({ tenantId: tenant, ...did })
}
// The password is in the database from then on, encrypted; left in the environment it is one more copy to protect.
if (seed && env.TRUNK_PASSWORD) console.warn('TRUNK_PASSWORD: the trunk is in the database now (its password encrypted); remove TRUNK_PASSWORD from the environment (.env)')

const registry = new ProviderRegistry(await store.listProviders(), [storedOpensipsFactory({ store, ...(key ? { key } : {}) })])

// LiveKit SIP sees OpenSIPS only: it takes calls from MEET_INBOUND_ADDRESSES (OpenSIPS's address, comma-separated:
// required, LiveKit refuses an inbound trunk without), places its dial-out calls to MEET_OUTBOUND_ADDRESS (OpenSIPS's
// socket for it) and answers OpenSIPS's challenge with MEET_SIP_USER and MEET_SIP_PASSWORD, the same as OpenSIPS's.
// MEET_MAX_CALL_SEC: the longest a room's call lasts (LiveKit SIP hangs up then), 7200 s by default, as OpenSIPS's.
const conference = conferenceOn && accessNumber
  ? (() => {
      const inboundAddresses = (env.MEET_INBOUND_ADDRESSES ?? '').split(',').map(a => a.trim()).filter(Boolean)
      if (!inboundAddresses.length) throw new Error("MEET_INBOUND_ADDRESSES is required with LIVEKIT_URL: OpenSIPS's address, the only one LiveKit SIP takes calls from")
      const maxCallSec = Number(env.MEET_MAX_CALL_SEC || 7200)
      if (!(Number.isInteger(maxCallSec) && maxCallSec >= 60 && maxCallSec <= 86_400)) throw new Error('MEET_MAX_CALL_SEC must be 60 to 86400 seconds')
      const bridge = new LiveKitConferenceBridge({
        url: env.LIVEKIT_URL!,
        apiKey: env.LIVEKIT_API_KEY!,
        apiSecret: env.LIVEKIT_API_SECRET!,
        dialInNumbers: (env.MEET_DIALIN_NUMBERS || accessNumber).split(',').map(e164 => ({ country: env.MEET_DIALIN_COUNTRY || 'FR', e164: e164.trim() })),
        inboundAddresses,
        maxCallSec,
        outboundAddress: need('MEET_OUTBOUND_ADDRESS'),
        ...(env.MEET_SIP_PASSWORD ? { outboundAuth: { username: env.MEET_SIP_USER ?? 'livekit', password: env.MEET_SIP_PASSWORD } } : {}),
        ...(env.MEET_NUMBER_PRIVACY ? { numberPrivacy: env.MEET_NUMBER_PRIVACY as 'show' | 'mask' | 'hide' } : {})
      })
      if (!env.MEET_SIP_PASSWORD) console.warn('WARNING: MEET_SIP_PASSWORD is not set: OpenSIPS refuses the calls of the rooms (dial-out)')
      // Meet owns rooms, PINs and dial-in rules when its external API is configured for the Gateway.
      const meet = env.MEET_URL && env.MEET_CLIENT_ID && env.MEET_CLIENT_SECRET ? new MeetApi({ url: env.MEET_URL, clientId: env.MEET_CLIENT_ID, clientSecret: env.MEET_CLIENT_SECRET }) : undefined
      // The trunks LiveKit needs (accept calls to the dial-in number, place dial-out calls). LiveKit may start later.
      // Then, without Meet, the dispatch rules that let in no room the Gateway serves are deleted (third review n°4).
      const prepare = (attempt = 0): void => {
        bridge.ensureTrunks().then(
          () => {
            if (meet) return
            sweepDialIns(bridge, store)
              .then(dropped => dropped.length && console.warn(`LiveKit SIP: ${dropped.length} dial-in rule(s) of no room served deleted: ${dropped.join(', ')}`))
              .catch((err: unknown) => console.error('LiveKit SIP dial-in rules not swept:', err instanceof Error ? err.message : String(err)))
          },
          err => {
            console.error('LiveKit SIP trunks not ready, retrying:', (err as Error).message)
            if (attempt < 30) setTimeout(() => prepare(attempt + 1), 10_000).unref()
          }
        )
      }
      prepare()
      return { bridge: () => bridge, ...(meet ? { meet } : {}), accessNumber, ...webhookKeyFromEnv(env) }
    })()
  : undefined

// Web Push (step 5, ADR 0015): VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (both or neither; `npx web-push
// generate-vapid-keys`), else a pair made at the first start and kept in the database, encrypted with SECRETS_KEY.
// VAPID_SUBJECT tells the push services whom to reach (mailto: or https:); the first https origin of CORS_ORIGINS (the
// app) by default. PUSH_SERVICES: the push services allowed (the browsers' own by default); PUSH_PROXY: a proxy to them.
const vapidGiven = env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY
if (vapidGiven && !(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)) throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY go together')
if (env.VAPID_PUBLIC_KEY && Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url').length !== 65) throw new Error('VAPID_PUBLIC_KEY must be a P-256 public key in base64url (65 bytes)')
if (env.VAPID_PRIVATE_KEY && Buffer.from(env.VAPID_PRIVATE_KEY, 'base64url').length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a P-256 private key in base64url (32 bytes)')
const vapidSubject = env.VAPID_SUBJECT ?? env.CORS_ORIGINS?.split(',').map(o => o.trim()).find(o => o.startsWith('https://'))
const push =
  vapidSubject && (vapidGiven || key)
    ? new WebPush({
        store,
        ...(key ? { key } : {}),
        ...(vapidGiven ? { vapid: { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! } } : {}),
        subject: parseVapidSubject(vapidSubject),
        services: parsePushServices(env.PUSH_SERVICES),
        ...(env.PUSH_PROXY ? { proxy: env.PUSH_PROXY } : {})
      })
    : undefined
if (!push) console.warn('WARNING: no notifications of calls without a window (Web Push): set VAPID_SUBJECT (or an https origin in CORS_ORIGINS), and SECRETS_KEY or the VAPID keys')

const contacts = ldapDirectoryFromEnv(env, message => console.warn(`WARNING: ${message}`))
// The accounts of the directory become user ↔ extension mappings, on a schedule (LDAP_SYNC_INTERVAL, "0" to disable)
// and on demand from the administration screen. Only when the schema says which attribute holds the extension.
// A group's number is never given to someone: the synchronisation reads the tenant's groups first (ADR 0014).
const groupNumbers = async (tenantId: string) => {
  if (!registry.serves(tenantId)) return []
  const provider = registry.forTenant(tenantId)
  return provider.listGroups ? (await provider.listGroups()).map(g => g.number) : []
}
const directorySync = contacts && env.LDAP_ATTR_EXTENSION ? new DirectorySync({ store, directory: contacts, tenantId: env.LDAP_TENANT ?? tenant, reserved: async t => [...(await groupNumbers(t)), ...(conference && accessNumber ? [accessNumber] : [])] }) : undefined
// Webhooks (step 10a, ADR 0020), with SECRETS_KEY: deliveries in https only, on port 443 (80 in http; WEBHOOK_PORTS:
// others), never to this host or the private networks, unless the operator opens some to one organisation
// (WEBHOOK_PRIVATE_NETWORKS, `acme=10.20.0.0/16;beta=192.0.2.10`, a bare list for DEFAULT_TENANT: the CRM of that
// organisation in its network, never the others') or allows http (WEBHOOK_ALLOW_HTTP=1, development only). Never,
// whatever it opened, to the addresses of this host's interfaces (its public one included) nor to
// WEBHOOK_DENY_NETWORKS (the platform's other public addresses: its entry point, services that trust the Gateway's
// address).
const webhookOpen = parseTenantNetworks(env.WEBHOOK_PRIVATE_NETWORKS, tenant)
// Said at each start: what the operator opened, to whom; an organisation no provider configuration serves (a typing
// error, another case) opens nothing now, and would to one made later under that name.
for (const [t, networks] of webhookOpen) {
  console.info(`webhooks: networks opened to the deliveries of ${JSON.stringify(t)}: ${networks.entries.join(', ')}`)
  if (!registry.serves(t)) console.warn(`WARNING: WEBHOOK_PRIVATE_NETWORKS names ${JSON.stringify(t)}, which no provider configuration serves: check how its organisation is written`)
}
const webhookPorts = parsePorts(env.WEBHOOK_PORTS)
const webhookDeny = denyNetworks(env.WEBHOOK_DENY_NETWORKS, networkInterfaces())
const webhookHttp = env.WEBHOOK_ALLOW_HTTP === '1'
if (webhookHttp) console.warn('WARNING: WEBHOOK_ALLOW_HTTP=1: webhooks may be delivered in clear (http), for development only')
if (!key) console.warn('WARNING: no webhooks without SECRETS_KEY (their secrets are kept encrypted with it)')
// The operator of the trunks (step 10b, ADR 0021): OVHcloud for the organisation of the pilot (DEFAULT_TENANT), from
// OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY and OVH_BILLING_ACCOUNT (all four, or none: no
// operator), OVH_ENDPOINT (ovh-eu by default, ovh-ca or ovh-us, never a URL). The keys stay in the environment: never in
// the database nor the log.
const ovh = ovhOperatorFromEnv(env)
if (ovh) console.info(`OVHcloud: the operator of the trunks of ${JSON.stringify(tenant)} (billing account ${env.OVH_BILLING_ACCOUNT})`)

// The mailboxes (step 11a, ADR 0022): Wazo Platform for DEFAULT_TENANT, from WAZO_URL (or the URL of each of its
// APIs), WAZO_USER and WAZO_PASSWORD (voicemail.ts). Without it, a call nobody takes ends as before.
const voicemail = wazoFromEnv(env)
if (!voicemail) console.warn('WARNING: no mailboxes (WAZO_URL or the URLs of its APIs, WAZO_USER, WAZO_PASSWORD): a call nobody takes is not taken by a mailbox')
const hstsMaxAge = env.HSTS_MAX_AGE ? Number(env.HSTS_MAX_AGE) : undefined
if (hstsMaxAge !== undefined && !(Number.isInteger(hstsMaxAge) && hstsMaxAge >= 0)) throw new Error('HSTS_MAX_AGE must be a number of seconds')
const app = await buildApp(registry, {
  store,
  directory: new StoreDirectory(store),
  ...(contacts ? { contacts } : {}),
  ...(directorySync ? { directorySync } : {}),
  ...(hstsMaxAge !== undefined ? { security: { hstsMaxAge, hstsIncludeSubDomains: env.HSTS_INCLUDE_SUBDOMAINS === '1' } } : {}),
  auth: authenticatorFromEnv(env),
  ...(push ? { push } : {}),
  ...(key ? { secretsKey: key } : {}),
  webhooks: { policy: { allowHttp: webhookHttp, ...(webhookPorts ? { ports: webhookPorts } : {}) }, open: webhookOpen, deny: webhookDeny },
  ...(ovh ? { operators: new Map([[tenant, ovh]]) } : {}),
  ...(conference ? { conference } : {}),
  ...(voicemail ? { voicemail: (t: string) => (t === tenant ? voicemail : undefined) } : {})
})
directorySync?.useLogger(app.log)
app.addHook('onClose', async () => voicemail?.close())
const syncEvery = parseInterval(env.LDAP_SYNC_INTERVAL, 3_600_000)
if (directorySync && syncEvery > 0) directorySync.start(syncEvery)
app.addHook('onClose', async () => directorySync?.stop())
registry.startAll()
// Extensions and groups kept from before step 6a that are emergency numbers (or other short numbers of the French
// plan): a call to them goes to the operator, never to whoever has them. Said at each start until changed.
for (const what of await reservedInUse(store, tenant, await groupNumbers(tenant).catch(() => [])))
  console.warn(`WARNING: ${what} is an emergency number or another short number of the French plan: dialled, it goes to the operator, never there; give it another number`)
// The access number of Meet's rooms (step 8): nobody's extension nor group; the same here and in OpenSIPS, asked once
// it can answer (its MI, a little after the start).
for (const what of await accessNumberInUse(store, tenant, accessNumber, await groupNumbers(tenant).catch(() => [])))
  console.warn(`WARNING: ${what} is the access number of the meeting rooms (MEET_NUMBER): dialled, it goes to LiveKit SIP, never there; give it another number`)
setTimeout(() => {
  if (!registry.serves(tenant)) return
  void Promise.resolve(registry.forTenant(tenant).getMeetAccess?.())
    .then(sip => {
      for (const what of meetAccessMismatch(accessNumber, sip)) console.warn(`WARNING: ${what}`)
    })
    .catch((err: unknown) => console.warn(`WARNING: the access number of the meeting rooms not compared with OpenSIPS's: ${err instanceof Error ? err.message : String(err)}`))
}, 10_000).unref()
await app.listen({ host: env.HOST ?? '0.0.0.0', port: Number(env.PORT ?? 8080) })
