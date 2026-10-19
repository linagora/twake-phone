// End to end of steps 3 to 6b (calls, transfers, what the Gateway hears from OpenSIPS, forwards and "do not
// disturb", ring groups, calls to someone without a window of the app, calls to and from the public network through
// a trunk to an operator this process simulates, apps/web/test/sip-trunk.mjs): people call and transfer each other from
// their browsers through OpenSIPS and rtpengine; the Gateway
// subscribes to OpenSIPS's events and shows the presence of the others in the directory and the calls in the
// history; the forwards and the "do not disturb" set in the app are applied by OpenSIPS (`call_rules`). The SIP stack is the only thing
// outside this process (docker/docker-compose.sip.yml, or OpenSIPS and rtpengine started by hand); the identity
// provider, the directory, the Gateway (with the OpenSIPS provider) and the app run here, and three browser
// contexts with a simulated microphone play Alice (101), Jean (102) and Bob (103). Step 5: a push service of this
// process (apps/gateway/test/push-service.mjs) stands for the browsers' own; it checks and decrypts what the Gateway
// sends, and the test hands it to the service worker as Chromium's push service would (DevTools; Firefox offers no
// such way, its run checks the push and opens the app on the call as the notification does).
//
//   BROWSER              chromium (default), firefox or msedge (Edge installed on the machine, as Playwright finds it)
//   PLAYWRIGHT_CHROMIUM  a Chromium binary to use instead of Playwright's (PLAYWRIGHT_FIREFOX likewise)
//   SIP_WSS_URL          WSS socket of OpenSIPS (default wss://127.0.0.1:8089)
//   SIP_DOMAIN           SIP domain and digest realm (default: the host of SIP_WSS_URL)
//   SIP_UDP, SIP_WS      UDP and WS sockets of OpenSIPS for the user agents of this process (default 127.0.0.1:5060, ws://127.0.0.1:8088)
//   OPENSIPS_DB_URL      the database auth_db reads (default postgres://twake:twake@127.0.0.1:54320/twake)
//   GATEWAY_DB_URL       the Gateway's own database (default: twakephone_e2e on the server of OPENSIPS_DB_URL, made
//                        afresh at each run); its leases, fences and queues as a deployment has them (PgStore)
//   OPENSIPS_MI_URL      the MI socket of OpenSIPS, where the Gateway subscribes to its events (default udp:127.0.0.1:8880)
//   SIP_TRUNK            the trunk socket of OpenSIPS, where the simulated operator talks to it (default 127.0.0.1:5070)
//   TRUNK_ADVERTISE      the address OpenSIPS announces on that socket (its own TRUNK_ADVERTISE, host:port), as behind a
//                        NAT: the operator is told it and reaches SIP_TRUNK through it; unset, none
//   RTPENGINE_DTMF_LOG   where rtpengine reports the tones it sees (default 127.0.0.1:22223); "off" skips the check
//   SIP_E2E_PRESENCE_MS  how long a presence change may take to show in the directory (default 3000; raise it on a loaded runner)
//
// Step 8 (ADR 0018): the phone access to the rooms, through the LiveKit server and LiveKit SIP of the same stack, which
// sees OpenSIPS only (dial-in by the access number and a room's PIN, the rooms' calls at the name of who asked):
//   LIVEKIT_URL          the LiveKit server's API (default http://127.0.0.1:7880)
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET  its keys (default the stack's development ones)
//   SIP_MEET             OpenSIPS's socket for LiveKit SIP, where the rooms' calls go (default 127.0.0.1:5090)
//   MEET_SIP_USER, MEET_SIP_PASSWORD     the account those calls answer OpenSIPS's challenge with (default the stack's)
//   MEET_NUMBER          the access number of the rooms (default 8000)
//
// Step 11a (ADR 0022): the mailboxes, on the Wazo of the same stack, behind OpenSIPS (the Gateway with provider-wazo):
//   WAZO_AUTH_URL, WAZO_CONFD_URL, WAZO_CALLD_URL, WAZO_WEBSOCKETD_URL  its APIs (default the stack's, on the loopback)
//   WAZO_USER, WAZO_PASSWORD             the Gateway's account in Wazo (default the stack's development one)
// Step 11b (ADR 0023): each message transcribed by the LinTO STT of the same stack, the bot's notice of it in the
// stack's Matrix homeserver (Synapse), where this process makes the bot's account and those of the cast (its
// shared-secret registration): the bot's access token is the one Synapse gives at its registration, never written.
//   LINTO_URL            LinTO STT's HTTP API (default http://127.0.0.1:8090)
//   SYNAPSE_URL          the homeserver's client-server API (default http://127.0.0.1:8008)
//   SYNAPSE_REGISTRATION_SECRET  its registration_shared_secret (default the stack's, docker/synapse/homeserver.yaml)
// The caller of the demo of step 11b says apps/web/test/fixtures/caller-message.wav (« Bonjour Jean, ici Paul. Merci de
// me rappeler demain matin. »): SVOX Pico's French voice (Apache 2.0; pico2wave -l fr-FR of libttspico-utils
// 1.0+git20130326), brought to a telephone's band by ffmpeg (-ar 8000, highpass=200, lowpass=3400, 16 bits, mono), 4.8 s.
// A voice closer to a person's than eSpeak's (the prompts of the stack), which the small model of the stack's LinTO STT
// does not recognise.
// Asterisk's CLI (its dialplan, a trace of the calls to the mailboxes) and its spool are read in the stack's container
// (docker compose -f docker/docker-compose.sip.yml exec wazo-asterisk; COMPOSE_PROJECT_NAME as Docker Compose reads
// it), and docker/wazo/check-loopback.py runs during a call to a mailbox (as root: sudo -n when this is not root).
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { chromium, firefox } from 'playwright-core'
import { LiveKitConferenceBridge } from '../../../packages/conference-livekit/dist/index.js'
import { buildApp } from '../../gateway/dist/app.js'
import { RateLimiter } from '../../gateway/dist/contacts.js'
import { WebPush } from '../../gateway/dist/push.js'
import { JwtAuthenticator } from '../../gateway/dist/auth.js'
import { DirectorySync } from '../../gateway/dist/directory-sync.js'
import { DEFAULT_ATTRIBUTES, LdapDirectory } from '../../gateway/dist/ldap-directory.js'
import { storedOpensipsFactory } from '../../gateway/dist/providers.js'
import { WazoVoicemail, holderKey, mailboxNumber } from '../../../packages/provider-wazo/dist/index.js'
import { holderSecretOf } from '../../gateway/dist/voicemail.js'
import { MatrixBot } from '../../gateway/dist/matrix.js'
import { LintoTranscription } from '../../../packages/transcription-linto/dist/index.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { SubscriberProvisioner } from '../../../packages/provider-opensips/dist/subscriber.js'
import { PgStore } from '../../gateway/dist/store/pg.js'
import { parseNetworks } from '../../gateway/dist/webhook-delivery.js'
import { BASE_DN, PEOPLE, READER_DN, READER_PASSWORD, startLdapMock } from '../../gateway/test/ldap-mock.mjs'
import { startPushService } from '../../gateway/test/push-service.mjs'
import { startWebhookReceiver } from '../../gateway/test/webhook-receiver.mjs'
import { startOidcMock } from './oidc-mock.mjs'
import { serveApp } from '../server/serve.mjs'
import { sipPhone } from './sip-phone.mjs'
import { sipUa } from './sip-ua.mjs'
import { plainRtp, startOperator, wavSamples } from './sip-trunk.mjs'

const AUDIENCE = 'twakephone-gateway'
const RESOURCE = 'https://gateway.twakephone.test'
const SIP_WSS_URL = process.env.SIP_WSS_URL ?? 'wss://127.0.0.1:8089'
const SIP_DOMAIN = process.env.SIP_DOMAIN ?? new URL(SIP_WSS_URL).hostname
const OPENSIPS_DB_URL = process.env.OPENSIPS_DB_URL ?? 'postgres://twake:twake@127.0.0.1:54320/twake'
const OPENSIPS_MI_URL = process.env.OPENSIPS_MI_URL ?? 'udp:127.0.0.1:8880'
// OpenSIPS's UDP socket, for the user agents of this process (sip-ua.mjs): on this host.
const SIP_UDP = process.env.SIP_UDP ?? '127.0.0.1:5060'
const SIP_WS = process.env.SIP_WS ?? 'ws://127.0.0.1:8088'
const DTMF_LOG = process.env.RTPENGINE_DTMF_LOG ?? '127.0.0.1:22223'
const SIP_TRUNK = process.env.SIP_TRUNK ?? '127.0.0.1:5070'
const TRUNK_ADVERTISE = process.env.TRUNK_ADVERTISE ?? ''
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880'
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'twake-dev'
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'twake-dev-only-livekit-secret-0123456789'
const SIP_MEET = process.env.SIP_MEET ?? '127.0.0.1:5090'
const MEET_SIP_USER = process.env.MEET_SIP_USER ?? 'livekit'
const MEET_SIP_PASSWORD = process.env.MEET_SIP_PASSWORD ?? 'twake-meet-dev-only'
const MEET_NUMBER = process.env.MEET_NUMBER ?? '8000'
// As OpenSIPS has them (docker-compose.sip.yml, the CI's env): the failed tries of a PIN per caller, the alert for all.
const MEET_PIN_TRIES = Number(process.env.MEET_PIN_TRIES ?? 10)
const MEET_PIN_TRIES_ALL = Number(process.env.MEET_PIN_TRIES_ALL ?? 300)
const MEET_MAX_CALL_SEC = Number(process.env.MEET_MAX_CALL_SEC ?? 7200)
const MEET_CALLS_PER_CALLER = Number(process.env.MEET_CALLS_PER_CALLER ?? 2)
// Wazo's APIs as the stack has them (docker-compose.sip.yml), and the Gateway's account there.
const WAZO = {
  authUrl: process.env.WAZO_AUTH_URL ?? 'http://127.0.0.1:9497/0.1',
  confdUrl: process.env.WAZO_CONFD_URL ?? 'http://127.0.0.1:9486/1.1',
  calldUrl: process.env.WAZO_CALLD_URL ?? 'http://127.0.0.1:9500/1.0',
  websocketdUrl: process.env.WAZO_WEBSOCKETD_URL ?? 'ws://127.0.0.1:9502/',
  username: process.env.WAZO_USER ?? 'twakephone',
  password: process.env.WAZO_PASSWORD ?? 'twake-wazo-dev-only-gateway'
}
const TENANT = 'e2e'
const BROWSER = process.env.BROWSER ?? 'chromium'
// Step 11b: LinTO STT and the Matrix homeserver of the stack.
const LINTO_URL = process.env.LINTO_URL ?? 'http://127.0.0.1:8090'
const SYNAPSE_URL = process.env.SYNAPSE_URL ?? 'http://127.0.0.1:8008'
const SYNAPSE_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET ?? 'twake-synapse-dev-only-registration'
const MATRIX_SERVER = 'twakephone.test'
/** What the caller of the demo of step 11b says, 8 kHz. */
const CALLER_WAV = readFileSync(new URL('./fixtures/caller-message.wav', import.meta.url))
const CALLER_MESSAGE = wavSamples(CALLER_WAV)
const PRESENCE_MS = Number(process.env.SIP_E2E_PRESENCE_MS) || 3_000

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), err => { console.log(`FAIL ${name}`); throw err })
/** Scalars by value, arrays and objects by content (in order). */
const expectEqual = (actual, expected, what) => {
  const same = typeof expected === 'object' && expected !== null ? typeof actual === 'object' && actual !== null && Array.isArray(actual) === Array.isArray(expected) && JSON.stringify(actual) === JSON.stringify(expected) : actual === expected
  if (!same) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Polls `fn` until it returns something truthy; the message says what never came. */
const until = async (what, fn, { timeout = 15_000, every = 250 } = {}) => {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`)
}

/**
 * A TCP relay in front of the SIP WebSocket: the browsers register through it, and the test cuts every connection
 * at once to prove the softphone comes back on its own. The TLS bytes pass untouched (the certificate is OpenSIPS's).
 */
const startRelay = (targetHost, targetPort, port, { refusing = false } = {}) =>
  new Promise((resolve, reject) => {
    const sockets = new Set()
    const pairs = []
    // Refusing: listening already (its port is its own from the start), every connection closed at once until open().
    let open = !refusing
    const server = createServer(client => {
      if (!open) {
        client.destroy()
        return
      }
      const upstream = connect(targetPort, targetHost)
      sockets.add(client).add(upstream)
      pairs.push({ client, upstream })
      client.pipe(upstream).pipe(client)
      const drop = () => {
        client.destroy()
        upstream.destroy()
        sockets.delete(client)
        sockets.delete(upstream)
      }
      client.on('error', drop).on('close', drop)
      upstream.on('error', drop).on('close', drop)
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        /** A relay started refusing relays from now on. */
        open: () => void (open = true),
        /** Refuses every new connection again (the ones relayed stay until cut). */
        refuse: () => void (open = false),
        /** Drops the SIP server's side of the n-th connection only: the browser keeps its socket and suspects nothing. */
        cutUpstream: n => {
          const pair = pairs[n]
          if (!pair) throw new Error(`no relayed connection ${n}`)
          pair.upstream.removeAllListeners('close')
          pair.upstream.removeAllListeners('error')
          pair.client.unpipe(pair.upstream)
          pair.upstream.destroy()
        },
        /**
         * Holds what the browsers send (the SIP server waits, nothing is lost) until the function it returns is called:
         * a page closed meanwhile never gets its last words through, as a laptop put to sleep.
         */
        hold: () => {
          const held = pairs.filter(p => !p.client.destroyed && !p.upstream.destroyed)
          for (const p of held) {
            p.client.unpipe(p.upstream)
            p.client.pause()
          }
          return () => {
            for (const p of held) if (!p.client.destroyed && !p.upstream.destroyed) p.client.pipe(p.upstream)
          }
        },
        cut: () => {
          const n = sockets.size
          for (const s of sockets) s.destroy()
          sockets.clear()
          return n
        },
        stop: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r) })
      })
    )
  })

/** Listens where rtpengine reports the RFC 4733 tones it detects (one JSON datagram per tone). */
const listenDtmf = address => {
  if (address === 'off') return null
  const [host, port] = address.split(':')
  const events = []
  const socket = createSocket('udp4')
  socket.on('message', msg => {
    try {
      events.push(JSON.parse(msg.toString()))
    } catch {
      console.log('unreadable DTMF report:', msg.toString())
    }
  })
  socket.bind(Number(port), host)
  return { events, stop: () => new Promise(r => socket.close(r)) }
}
const DTMF_EVENTS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#']

const [APP_PORT, OIDC_PORT, RELAY_PORT] = await Promise.all([freePort(), freePort(), freePort()])
// Where the stack's LiveKit sends its webhooks (docker-compose.sip.yml, LIVEKIT_WEBHOOK_URL; second review 8b, n°3): a
// port known before the stack starts, not drawn like the others. Taken, the run stops at once and says so (third
// review 8b, n°7): GATEWAY_PORT moves it, LIVEKIT_WEBHOOK_URL of the stack along with it.
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18080)
const appOrigin = `http://127.0.0.1:${APP_PORT}`
const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`
const wss = new URL(SIP_WSS_URL)
const relay = await startRelay(wss.hostname, Number(wss.port || (wss.protocol === 'wss:' ? 443 : 80)), RELAY_PORT)
const relayUrl = `${wss.protocol}//127.0.0.1:${RELAY_PORT}${wss.pathname === '/' ? '' : wss.pathname}`
const dtmf = listenDtmf(DTMF_LOG)
// The operator of the trunk (step 6): its login and password are this run's, made up (the operator is simulated).
const TRUNK_LOGIN = '0033199000100'
const TRUNK_PASSWORD = randomBytes(12).toString('base64url')
// Two servers, as an operator gives (the second one challenges with 401); behind the NAT TRUNK_ADVERTISE plays, the
// address OpenSIPS announces is reached at SIP_TRUNK.
const nat = TRUNK_ADVERTISE ? { [TRUNK_ADVERTISE]: SIP_TRUNK } : {}
const operator = await startOperator({ opensips: SIP_TRUNK, user: TRUNK_LOGIN, password: TRUNK_PASSWORD, nat })
const operator2 = await startOperator({ opensips: SIP_TRUNK, user: TRUNK_LOGIN, password: TRUNK_PASSWORD, nat, challenge: 'www' })

process.env.LOG_LEVEL ??= 'warn'
process.env.CORS_ORIGINS = appOrigin
process.env.DEFAULT_TENANT = TENANT

const oidc = await startOidcMock({ port: OIDC_PORT, appOrigin, audience: AUDIENCE, resource: RESOURCE })
const auth = new JwtAuthenticator({ jwksUrl: oidc.jwksUrl, issuer: oidc.issuer, audience: AUDIENCE, defaultTenant: TENANT, rolesClaim: 'roles' })
// The Gateway's own database, a fresh one by default: what PostgreSQL fences (the leases of the mailboxes and of the
// transcriptions, their queues) end to end, as a deployment runs it.
const GATEWAY_DB_URL =
  process.env.GATEWAY_DB_URL ??
  (await (async () => {
    const admin = new pg.Client({ connectionString: OPENSIPS_DB_URL })
    await admin.connect()
    try {
      await admin.query('DROP DATABASE IF EXISTS twakephone_e2e WITH (FORCE)')
      await admin.query('CREATE DATABASE twakephone_e2e')
    } finally {
      await admin.end()
    }
    const url = new URL(OPENSIPS_DB_URL)
    url.pathname = '/twakephone_e2e'
    return url.toString()
  })())
const store = new PgStore(GATEWAY_DB_URL)
await store.migrate()
// What an administrator (or the LDAP synchronisation) would have set: who has which extension.
await store.upsertMapping({ tenantId: TENANT, userId: 'amartin', extension: '101', displayName: 'Alice Martin' })
await store.upsertMapping({ tenantId: TENANT, userId: 'jdupont', extension: '102', displayName: 'Jean Dupont' })
await store.upsertMapping({ tenantId: TENANT, userId: 'bdurand', extension: '103', displayName: 'Bob Durand' })
// The reception desk: an extension nobody registers, that a forward can target.
await store.upsertMapping({ tenantId: TENANT, userId: 'accueil', extension: '104', displayName: 'Accueil' })
// What `OPENSIPS_WS_URL` and `OPENSIPS_MI_URL` make the Gateway store at startup, pointed at the relay.
await store.upsertProvider({ tenantId: TENANT, type: 'opensips', config: { websocketUrl: relayUrl, domain: SIP_DOMAIN, subscriberDbUrlRef: 'env:OPENSIPS_DB_URL', events: { miUrl: OPENSIPS_MI_URL } } })
const key = randomBytes(32)
const registry = new ProviderRegistry(await store.listProviders(), [storedOpensipsFactory({ store, key, env: { OPENSIPS_DB_URL, OPENSIPS_TRUNK_SOCKET: `udp:${SIP_TRUNK}`, ...(TRUNK_ADVERTISE ? { OPENSIPS_TRUNK_ADVERTISE: TRUNK_ADVERTISE } : {}) } })])
// The directory (same people as the web e2e; the ipPhone attribute holds the extension), for the presence next to each
// contact, and Paul Leroy (105), who leaves the organisation during the run. The test changes the entries in place.
const people = [...PEOPLE.map(p => ({ ...p })), { uid: 'pleroy', cn: 'Paul Leroy', sn: 'Leroy', givenName: 'Paul', mail: 'paul.leroy@example.test', ipPhone: '105', ou: 'Support' }]
const ldap = await startLdapMock({ people })
const contacts = new LdapDirectory({ url: ldap.url, tenantId: TENANT, bindDn: READER_DN, bindPassword: READER_PASSWORD, baseDn: BASE_DN, userFilter: '(objectClass=inetOrgPerson)', attributes: { ...DEFAULT_ATTRIBUTES, extension: 'ipPhone' } })
// The synchronisation of the directory into the mappings, as main.ts builds it: run from Administration only here.
const directorySync = new DirectorySync({ store, directory: contacts, tenantId: TENANT, reserved: async () => (await registry.forTenant(TENANT).listGroups()).map(g => g.number) })
// Web Push (step 5): the Gateway's VAPID keys made at its start (kept in the store, encrypted), its pushes sent to the
// push service of this process only.
const pushService = await startPushService()
const push = new WebPush({ store, key, subject: 'mailto:e2e@example.test', allowEndpoint: url => url.origin === pushService.origin, agent: pushService.agent })
// Step 8: the rooms' phone access as main.ts builds it, without Meet (a room is any LiveKit room name): LiveKit SIP
// takes calls from OpenSIPS's address only and places the rooms' calls to OpenSIPS's socket for it.
const bridge = new LiveKitConferenceBridge({
  url: LIVEKIT_URL,
  apiKey: LIVEKIT_API_KEY,
  apiSecret: LIVEKIT_API_SECRET,
  dialInNumbers: [{ country: 'FR', e164: MEET_NUMBER }],
  inboundAddresses: [SIP_MEET.split(':')[0]],
  outboundAddress: SIP_MEET,
  outboundAuth: { username: MEET_SIP_USER, password: MEET_SIP_PASSWORD },
  ringingTimeoutSec: 20
})
// The same, ringing 3 s only: swapped in for the step of a room's call nobody answers.
const shortBridge = new LiveKitConferenceBridge({
  url: LIVEKIT_URL,
  apiKey: LIVEKIT_API_KEY,
  apiSecret: LIVEKIT_API_SECRET,
  dialInNumbers: [{ country: 'FR', e164: MEET_NUMBER }],
  inboundAddresses: [SIP_MEET.split(':')[0]],
  outboundAddress: SIP_MEET,
  outboundAuth: { username: MEET_SIP_USER, password: MEET_SIP_PASSWORD },
  ringingTimeoutSec: 3
})
let activeBridge = bridge
const conference = { bridge: () => activeBridge, accessNumber: MEET_NUMBER, webhookKey: LIVEKIT_API_KEY, webhookSecret: LIVEKIT_API_SECRET }
// A call with the public network whose person has no window left is ended after 3 s here (30 s by default).
// Step 10a: the tool an administrator subscribes to the webhooks, on this host (the operator opens the loopback to
// the deliveries and allows http and its port: WEBHOOK_PRIVATE_NETWORKS, WEBHOOK_ALLOW_HTTP=1, WEBHOOK_PORTS); the
// trunks read every 2 s.
const receiver = await startWebhookReceiver()
// Step 11a: Wazo out of reach until the voicemail steps (nothing listens where the Gateway reaches it), as a Wazo that
// starts after the Gateway or is down a while: every call before them ends as without mailboxes. Those steps open the
// way, a TCP relay to each of its APIs, and the Gateway makes the mailboxes without a restart.
// Each relay listens from the start on a port of its own (none picked then freed, which another
// process could take meanwhile), closing every connection until openWazo().
const WAZO_APIS = ['authUrl', 'confdUrl', 'calldUrl', 'websocketdUrl']
const wazoVia = {}
const wazoRelays = []
for (const api of WAZO_APIS) {
  const target = new URL(WAZO[api])
  const relay = await startRelay(target.hostname, Number(target.port || (/^(https|wss):$/.test(target.protocol) ? 443 : 80)), 0, { refusing: true })
  wazoRelays.push(relay)
  const relayed = new URL(WAZO[api])
  relayed.host = `127.0.0.1:${relay.port}`
  wazoVia[api] = { target, relayed, relay }
}
let wazoOpen = false
const openWazo = async () => {
  for (const { relay } of Object.values(wazoVia)) relay.open()
  wazoOpen = true
}
const wazo = new WazoVoicemail({
  ...WAZO,
  ...Object.fromEntries(WAZO_APIS.map(api => [api, wazoVia[api].relayed.toString()])),
  // The key of the holders' prints, as the Gateway derives it from SECRETS_KEY (voicemail.ts).
  holderSecret: holderSecretOf(key),
  reconnectMs: [1_000, 2_000, 5_000],
  // What it says while out of reach is what the steps expect; once reachable, everything.
  logger: { info: () => {}, warn: m => wazoOpen && console.log(`[wazo] ${m}`), error: m => console.log(`[wazo] ${m}`) }
})
// Step 11b: the client-server API of the stack's homeserver, as a person's Twake Chat (or the bot) calls it.
const matrix = async (token, method, path, body) => {
  const res = await fetch(`${SYNAPSE_URL}/_matrix/client/v3${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Matrix ${method} ${path.split('?')[0]}: ${res.status} ${json.errcode ?? ''}`)
  return json
}
/**
 * An account of the homeserver, made by its shared-secret registration (its admin API), or signed in to when an earlier
 * run made it (its volume kept): its access token.
 */
const matrixAccount = async localpart => {
  const password = `e2e-${localpart}-not-a-secret`
  const url = `${SYNAPSE_URL}/_synapse/admin/v1/register`
  const { nonce } = await (await fetch(url)).json()
  const mac = createHmac('sha1', SYNAPSE_SECRET).update([nonce, localpart, password, 'notadmin'].join('\u0000')).digest('hex')
  const made = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce, username: localpart, password, admin: false, mac }) })
  if (made.ok) return (await made.json()).access_token
  return (await matrix(undefined, 'POST', '/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: localpart }, password })).access_token
}
const matrixTokens = Object.fromEntries(await Promise.all(['twakephone-bot', 'amartin', 'jdupont', 'bdurand', 'accueil'].map(async u => [u, await matrixAccount(u)])))
const gateway = await buildApp(registry, {
  auth,
  store,
  contacts,
  directorySync,
  push,
  secretsKey: key,
  admin: { adminRole: 'twakephone-admin', adminUsers: new Set() },
  conference,
  // The calls of rooms a person may place a minute (10 by default): the conferences of steps 8b, 8c and 8d follow one another within it.
  dialOutLimiter: new RateLimiter(100, 60_000),
  webhooks: { policy: { allowHttp: true, ports: [Number(new URL(receiver.url).port)] }, open: parseNetworks('127.0.0.1/32'), retryBaseMs: 1_000 },
  trunkWatchMs: 2_000,
  voicemail: tenantId => (tenantId === TENANT ? wazo : undefined),
  // A synchronisation of the mailboxes that failed (Wazo out of reach) is tried again every 2 s here (the steps wait for it, not for the 30 s of the Gateway's default).
  voicemailRetryMs: [1_000, 2_000],
  // Step 11b: LinTO STT of the stack, the bot on its homeserver, each person's Matrix id from their uid.
  transcription: { provider: new LintoTranscription({ url: LINTO_URL, timeoutMs: 60_000 }), maxSec: 180, queueMax: 100, maxBytes: 180 * 48_000 + 65_536, lang: 'fr' },
  notices: { bot: new MatrixBot({ homeserverUrl: SYNAPSE_URL, token: matrixTokens['twakephone-bot'] }), userTemplate: `@{uid}:${MATRIX_SERVER}`, appUrl: appOrigin, timeZone: 'Europe/Paris' }
})
// LiveKit's webhooks as the Gateway answered them: signed with its key, each one 204.
const livekitWebhooks = []
gateway.addHook('onResponse', async (req, reply) => {
  if (req.url === '/api/v1/webhooks/livekit') livekitWebhooks.push(reply.statusCode)
})
registry.startAll()
await gateway.listen({ host: '127.0.0.1', port: GATEWAY_PORT }).catch(err => {
  if (err?.code !== 'EADDRINUSE') throw err
  throw new Error(`port ${GATEWAY_PORT} (GATEWAY_PORT) is taken: free it, or set GATEWAY_PORT and the stack's LIVEKIT_WEBHOOK_URL to another one`)
})
const web = await serveApp({
  dir: fileURLToPath(new URL('../dist/', import.meta.url)),
  port: APP_PORT,
  config: { gatewayUrl, oidc: { authority: oidc.issuer, clientId: 'twakephone-web', resource: RESOURCE } },
  // CONNECT_SRC in production: the SIP WebSocket is not on the Gateway's origin.
  policy: { connectSrc: [new URL(relayUrl).origin] }
})
const db = new pg.Pool({ connectionString: OPENSIPS_DB_URL, max: 1 })
// The CDRs written after this run started: those of earlier runs the database kept are left out. Two runs at once
// on the same database would still see each other's rows: one run at a time per database.
const lastId = async table => (await db.query(`SELECT coalesce(max(id), 0) AS id FROM ${table}`)).rows[0].id
const since = { acc: await lastId('acc'), missed_calls: await lastId('missed_calls') }
// The forwards and "do not disturb" of this cast that an interrupted run may have left: every run starts without.
// The provider creates the table as it starts (a fresh database): waited for, and a missing table fails the run.
await until('the call_rules table', async () => (await db.query("SELECT to_regclass('call_rules') AS t")).rows[0].t)
await db.query("DELETE FROM call_rules WHERE extension IN ('101', '102', '103', '104', '105')")
// Nor the ring groups of an interrupted run.
await db.query("DELETE FROM call_groups WHERE number IN ('200', '105', '106', '210', '220')")
// Nor the mailboxes an interrupted run handed to OpenSIPS (step 11a): none until Wazo is reached.
await until('the voicemail_boxes table', async () => (await db.query("SELECT to_regclass('voicemail_boxes') AS t")).rows[0].t)
await db.query('DELETE FROM voicemail_boxes WHERE tenant_id = $1', [TENANT])
// Nor the account an older Gateway would have left (106), which this run writes by hand.
await db.query("DELETE FROM subscriber WHERE username = '106'")
// Nor anyone left to wake by an interrupted run (step 5): the Gateway writes the rows of this run's subscriptions.
await db.query("DELETE FROM push_targets WHERE extension IN ('101', '102', '103', '104', '105') OR tenant_id = 'e2e-ua'")

// A microphone that produces a tone, no permission prompt, sound allowed without a gesture, OpenSIPS's self-signed
// certificate accepted (Firefox: through the context's ignoreHTTPSErrors). Firefox ignores ICE candidates on the
// loopback, and rtpengine only offers 127.0.0.1 here (RTPENGINE_INTERFACE): without ice.loopback the call sets up,
// ICE fails and no RTP flows.
const browser =
  BROWSER === 'firefox'
    ? await firefox.launch({
        ...(process.env.PLAYWRIGHT_FIREFOX ? { executablePath: process.env.PLAYWRIGHT_FIREFOX } : {}),
        firefoxUserPrefs: {
          'media.navigator.streams.fake': true,
          'media.navigator.permission.disabled': true,
          'media.autoplay.default': 0,
          'media.autoplay.blocking_policy': 0,
          'media.setsinkid.enabled': true,
          'media.autoplay.block-webaudio': false,
          'media.peerconnection.ice.loopback': true,
          'media.peerconnection.ice.obfuscate_host_addresses': false
        }
      })
    : await chromium.launch({
        // Chromium itself in its new headless mode, not Playwright's default headless shell: the shell reports every
        // notification permission as denied and shows no notification (step 5).
        ...(BROWSER === 'msedge' ? { channel: 'msedge' } : process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: 'chromium' }),
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required']
      })
console.log(`browser: ${BROWSER} ${browser.version()}`)

/** One person in their own browser context: signs in, lands on the dialer. `timezoneId`: the browser's time zone. */
const open = async (login, name, { timezoneId } = {}) => {
  const context = await browser.newContext({ locale: 'fr-FR', ignoreHTTPSErrors: true, ...(timezoneId ? { timezoneId } : {}) })
  // SIP_E2E_DEBUG=1: every SIP message JsSIP sends and receives, in this process's output.
  if (process.env.SIP_E2E_DEBUG) await context.addInitScript(() => localStorage.setItem('debug', 'JsSIP:*'))
  const page = await context.newPage()
  await page.route(/fonts\.g(static|oogleapis)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
  page.on('pageerror', err => console.log(`[${name}] page error:`, err.message))
  page.on('console', msg => { if (process.env.SIP_E2E_DEBUG || ['error', 'warning'].includes(msg.type())) console.log(`[${name}] browser ${msg.type()}:`, msg.text()) })
  await page.goto(`${web.origin}/`)
  await page.getByRole('button', { name: 'Se connecter' }).click()
  await page.locator('input[name=login]').fill(login)
  await page.locator('input[name=password]').fill('whatever')
  await page.getByRole('button', { name: 'Sign-in' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL(`${appOrigin}/`)
  await page.getByTestId('who').getByText(name).waitFor()
  return { page, context, name }
}
const phoneState = page => page.getByTestId('phone-state')
const calls = page => page.evaluate(() => window.twakephone.calls)
const lastEnded = page => page.evaluate(() => window.twakephone.lastEnded)
/** Dials and waits for that call to end: not for the one that ended just before (shown a few seconds longer). */
const dialUntilEnded = async (page, number) => {
  const before = await lastEnded(page)
  await dial(page, number)
  return until(`the call to ${number} to end`, async () => {
    const ended = await lastEnded(page)
    return ended && ended.id !== before?.id ? ended : null
  }, { timeout: 20_000 })
}
const stats = page => page.evaluate(() => window.twakephone.stats())
/** One MI command of OpenSIPS (JSON-RPC over its datagram socket, OPENSIPS_MI_URL), as the Gateway sends them. */
const mi = (method, params) =>
  new Promise((resolve, reject) => {
    const [, host, port] = /^udp:(.+):(\d+)$/.exec(OPENSIPS_MI_URL) ?? []
    const socket = createSocket('udp4')
    const timer = setTimeout(() => (socket.close(), reject(new Error(`MI ${method}: no answer`))), 5_000)
    socket.on('message', msg => (clearTimeout(timer), socket.close(), resolve(JSON.parse(msg.toString()))))
    socket.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), id: 1 }), Number(port), host)
  })
const soundBlocked = page => page.evaluate(() => window.twakephone.soundBlocked)
/** Waits for the ringtone element to play (not paused, live stream) or to be quiet; says what it saw otherwise. */
const ringerPlaying = async (page, playing) => {
  const state = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid=ringer]')
    return el ? { paused: el.paused, active: el.srcObject?.active ?? null, readyState: el.readyState, soundBlocked: window.twakephone.soundBlocked } : null
  })
  try {
    await page.waitForFunction(
      expected => {
        const el = document.querySelector('[data-testid=ringer]')
        return !!el && !el.paused === expected && (!expected || (el.srcObject?.active ?? false))
      },
      playing,
      { timeout: 10_000 }
    )
  } catch (err) {
    throw new Error(`ringtone not ${playing ? 'playing' : 'quiet'} after 10 s: ${JSON.stringify(await state())}`, { cause: err })
  }
}
const ringerSink = page => page.evaluate(() => document.querySelector('[data-testid=ringer]')?.sinkId ?? '')
/** Signs out from this page (unregisters its softphone first) and closes its context. */
const signOut = async who => {
  await who.page.getByRole('button', { name: 'Se déconnecter' }).click()
  await who.page.waitForURL(`${oidc.issuer}/session/end**`)
  await who.page.getByRole('button', { name: /yes, sign me out/i }).click()
  await who.page.waitForURL(`${appOrigin}/`)
  await who.page.getByRole('button', { name: 'Se connecter' }).waitFor()
  await who.context.close()
}
/** Dials from the keypad (back to it first when the page is elsewhere, such as the directory). */
const dial = async (page, number) => {
  if (!(await page.getByLabel('Numéro à appeler').isVisible())) await page.getByRole('link', { name: 'Clavier' }).click()
  await page.getByLabel('Numéro à appeler').fill(number)
  await page.getByRole('button', { name: 'Appeler' }).click()
}
/** RTP flows both ways on each side; `last` picks the newest call of the page (a consultation) instead of the oldest. */
const bothHearEachOther = async (a, b, { last = false } = {}) => {
  for (const who of [a, b]) {
    const pick = all => (last ? all[all.length - 1] : all[0])
    const before = pick(await stats(who.page))
    await until(`RTP both ways for ${who.name}`, async () => {
      const s = pick(await stats(who.page))
      return s && s.packetsReceived > before.packetsReceived + 20 && s.packetsSent > before.packetsSent + 20 ? s : null
    })
  }
}
/** Opens the directory, searches `query` (one person) and waits for the presence next to that extension to read `status`. */
const presenceIs = async (page, query, extension, status, timeout = 10_000) => {
  await page.getByRole('link', { name: 'Annuaire' }).click()
  await page.getByLabel('Rechercher').fill(query)
  await page.getByTestId(`presence-${extension}`).filter({ hasText: status }).waitFor({ timeout })
}
/** Opens Récents and reads its lines as "number: label" (newest first), once at least `atLeast` are shown. */
const recents = async (page, atLeast) => {
  await page.getByRole('link', { name: 'Récents' }).click()
  await page.getByRole('heading', { level: 1, name: 'Récents' }).waitFor()
  return until(`${atLeast} recent calls`, async () => {
    const lines = await page.locator('main ul.list li').evaluateAll(items => items.map(li => `${li.querySelector('strong')?.textContent}: ${li.querySelector('.badge')?.textContent}`))
    return lines.length >= atLeast ? lines : null
  })
}
const transferButton = page => page.getByRole('button', { name: 'Transférer', exact: true })
const transferTarget = page => page.getByLabel('Transférer à (poste ou numéro)')
/** Opens Réglages and sets the forwards of `who` (an empty field: none in that case), as a person does. */
const setForwarding = async (who, { always = '', busy = '', noAnswer = '', delay = '20' } = {}) => {
  await who.page.getByRole('link', { name: 'Réglages' }).click()
  await who.page.getByRole('heading', { level: 2, name: "Renvois d'appel" }).waitFor()
  await who.page.getByLabel('Renvoyer tous les appels vers le poste').fill(always)
  await who.page.getByLabel("Si vous êtes en ligne ou refusez l'appel, renvoyer vers le poste").fill(busy)
  await who.page.getByLabel('Si vous ne répondez pas, renvoyer vers le poste').fill(noAnswer)
  await who.page.getByLabel('Délai avant le renvoi (environ, en secondes de sonnerie)').fill(delay)
  await who.page.getByRole('button', { name: 'Enregistrer les renvois' }).click()
  await who.page.getByRole('status').filter({ hasText: 'Renvois enregistrés.' }).waitFor()
}
/** Opens Réglages and sets the status of `who`; `inMinutes`: an end that many minutes from now (the browser's clock). */
const setStatus = async (who, label, { inMinutes, message = '' } = {}) => {
  await who.page.getByRole('link', { name: 'Réglages' }).click()
  await who.page.getByRole('heading', { level: 2, name: 'Disponibilité' }).waitFor()
  await who.page.getByLabel('Statut', { exact: true }).selectOption({ label })
  if (label !== 'Disponible') {
    const until = inMinutes
      ? await who.page.evaluate(m => {
          const d = new Date(Date.now() + m * 60_000)
          const p = n => String(n).padStart(2, '0')
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
        }, inMinutes)
      : ''
    await who.page.getByLabel("Jusqu'au (facultatif)").fill(until)
    await who.page.getByLabel('Message pour vos correspondants (facultatif)').fill(message)
  }
  await who.page.getByRole('button', { name: 'Enregistrer le statut' }).click()
  await who.page.getByRole('status').filter({ hasText: 'Statut enregistré.' }).waitFor()
}
/** What the person's app would send the Gateway (their access token, as the app keeps it): for what the screens cannot do, such as an end a few seconds away. */
const asPerson = async who => {
  const token = await who.page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(k => k.startsWith('oidc.user'))
    return key ? JSON.parse(sessionStorage.getItem(key)).access_token : null
  })
  if (!token) throw new Error(`no access token for ${who.name}`)
  return (method, url, payload) => gateway.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })
}
/** Opens a part of the administration (step 7) from the main navigation, then the administration's own. */
const openAdmin = async (page, section) => {
  await page.getByRole('link', { name: 'Administration' }).click()
  await page.getByRole('navigation', { name: "Rubriques de l'administration" }).getByRole('link', { name: section, exact: true }).click()
  await page.getByRole('heading', { level: 2, name: section, exact: true }).waitFor()
}
/** The rows of `missed_calls` written since `after` (an id), as "caller>callee code". */
const missedSince = async after => (await db.query('SELECT caller, callee, sip_code FROM missed_calls WHERE id > $1 ORDER BY id', [after])).rows.map(r => `${r.caller}>${r.callee} ${r.sip_code}`)
/** The CDRs acc wrote since `after` (an id), as "caller>callee code", once there is one (written at the end of the call). */
const cdrsSince = after =>
  until('a CDR in acc', async () => {
    const { rows } = await db.query('SELECT caller, callee, sip_code FROM acc WHERE id > $1 ORDER BY id', [after])
    return rows.length ? rows.map(r => `${r.caller}>${r.callee} ${r.sip_code}`) : null
  })
/** The newest entry of a person's history once it is newer than `after` (the Gateway's store, as Récents reads it). */
const newestCall = (userId, after) =>
  until(`a call in the history of ${userId}`, async () => {
    const [entry] = (await store.listHistory(TENANT, userId, { limit: 1 })).items
    return entry && entry.startedAt > after ? entry : null
  })
/** Alice calls Jean, who answers. */
const aliceCallsJean = async (alice, jean) => {
  await dial(alice.page, '102')
  await jean.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
  await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
  await alice.page.getByText('En communication avec Jean Dupont (102)').waitFor()
}

/** Starts a synchronisation of the directory as `who` (an administrator) and resolves with its report once it ended. */
const synchronise = async who => {
  const api = await asPerson(who)
  const res = await api('POST', '/admin/directory/sync')
  expectEqual(res.statusCode, 202, 'POST /admin/directory/sync')
  return until('the synchronisation to end', async () => {
    const { sync } = (await api('GET', '/admin/directory')).json()
    return !sync.running && sync.last ? sync.last : null
  })
}

let failed = false
let gatewayClosed = false
let alice
let jean
let jean2
let bob
let desk
try {
  await step('Alice signs in and her softphone registers over WSS: the header says she is online', async () => {
    alice = await open('amartin', 'Alice Martin')
    await phoneState(alice.page).getByText('En ligne').waitFor({ timeout: 20_000 })
  })
  await step('the Gateway wrote her digest hashes in subscriber, never the secret', async () => {
    const { rows } = await db.query('SELECT username, domain, password, ha1, ha1_sha256 FROM subscriber WHERE username = $1', ['101'])
    expectEqual(rows.length, 1, 'rows for 101')
    expectEqual(rows[0].password, '', 'clear-text password column')
    expectEqual(rows[0].ha1.length, 32, 'ha1 length')
    expectEqual(rows[0].ha1_sha256.length, 64, 'ha1_sha256 length')
  })
  await step('Jean signs in and registers too', async () => {
    // Another time zone than the runner's and the database's (UTC in the CI): the end Jean types is his local time.
    jean = await open('jdupont', 'Jean Dupont', { timezoneId: 'Europe/Paris' })
    await phoneState(jean.page).getByText('En ligne').waitFor({ timeout: 20_000 })
  })
  await step('a call to an extension nobody registered ends as unreachable', async () => {
    await dial(alice.page, '105')
    await alice.page.getByText('105 est injoignable.').waitFor()
    expectEqual((await lastEnded(alice.page))?.endStatus, 404, 'SIP status for an unregistered extension')
  })
  await step('Alice calls 102: Jean sees who is calling and refuses; Alice is told', async () => {
    await dial(alice.page, '102')
    await alice.page.getByText('Appel de 102…').waitFor()
    const ringing = jean.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor()
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await alice.page.getByText("102 a refusé l'appel.").waitFor()
    expectEqual((await calls(jean.page)).length, 0, 'calls left on Jean side')
  })
  await step('Alice calls again, Jean answers: both are in communication', async () => {
    await dial(alice.page, '102')
    await jean.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await alice.page.getByText('En communication avec Jean Dupont (102)').waitFor()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    expectEqual((await calls(alice.page))[0].direction, 'outbound', 'Alice call direction')
    expectEqual((await calls(jean.page))[0].direction, 'inbound', 'Jean call direction')
  })
  await step('RTP flows both ways through rtpengine', async () => {
    await bothHearEachOther(alice, jean)
  })
  await step('Alice puts Jean on hold: Jean is told, then she resumes and audio flows again', async () => {
    await alice.page.getByRole('button', { name: 'Mettre en attente' }).click()
    await alice.page.getByText('Jean Dupont (102) en attente').waitFor()
    await jean.page.getByText('Votre correspondant vous a mis en attente.').waitFor()
    expectEqual((await calls(jean.page))[0].remoteHold, true, 'remoteHold on Jean side')
    await alice.page.getByRole('button', { name: 'Reprendre' }).click()
    await alice.page.getByText('En communication avec Jean Dupont (102)').waitFor()
    await until('Jean no longer on hold', async () => !(await calls(jean.page))[0].remoteHold)
    await bothHearEachOther(alice, jean)
  })
  await step('Alice mutes and unmutes her microphone', async () => {
    await alice.page.getByRole('button', { name: 'Couper le micro' }).click()
    expectEqual((await calls(alice.page))[0].muted, true, 'muted')
    await alice.page.getByRole('button', { name: 'Rétablir le micro' }).click()
    expectEqual((await calls(alice.page))[0].muted, false, 'unmuted')
  })
  await step('Alice sends tones from the keypad; rtpengine sees them in the RTP stream (RFC 4733)', async () => {
    await alice.page.getByRole('button', { name: 'Clavier' }).click()
    for (const tone of ['5', '#']) await alice.page.getByRole('button', { name: `Envoyer la touche ${tone}` }).click()
    await alice.page.getByText('Touches envoyées : 5#').waitFor()
    if (dtmf) {
      await until('rtpengine DTMF report', () => dtmf.events.length >= 2 ? dtmf.events : null)
      expectEqual(dtmf.events.map(e => DTMF_EVENTS[e.event] ?? `?${e.event}`).join(''), '5#', 'tones rtpengine detected')
    } else console.log('     (rtpengine DTMF report not checked: RTPENGINE_DTMF_LOG=off)')
  })
  await step('Jean hangs up: both are told how the call ended', async () => {
    await jean.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    await alice.page.getByText('Appel avec Jean Dupont (102) terminé.').waitFor()
    expectEqual((await calls(alice.page)).length, 0, 'calls left on Alice side')
  })
  await step('the Gateway heard the calls from OpenSIPS: Récents on both sides (Jean declined one, it reads Refusé), the CDR in acc', async () => {
    expectEqual(await recents(alice.page, 3), ['102: Sortant', '102: Sortant', '105: Sortant'], "Alice's recent calls")
    expectEqual(await recents(jean.page, 2), ['101: Entrant', '101: Refusé'], "Jean's recent calls")
    const { rows } = await db.query('SELECT caller, callee, sip_code, duration FROM acc WHERE id > $1 ORDER BY id', [since.acc])
    expectEqual(rows.map(r => `${r.caller}>${r.callee} ${r.sip_code} ${r.duration > 0 ? 'talked' : 'silent'}`), ['101>102 200 talked'], 'CDRs in acc')
    const missed = await db.query('SELECT caller, callee, sip_code FROM missed_calls WHERE id > $1 ORDER BY id', [since.missed_calls])
    expectEqual(missed.rows.map(r => `${r.caller}>${r.callee} ${r.sip_code}`), ['101>105 404', '101>102 603'], 'rows in missed_calls')
  })
  await step('the directory says who is free: Jean is available, Bob (not signed in) is offline', async () => {
    await presenceIs(alice.page, 'Dupont', '102', 'Disponible')
    await presenceIs(alice.page, 'Durand', '103', 'Hors ligne')
    await presenceIs(jean.page, 'Martin', '101', 'Disponible')
  })
  await step(`Jean calls Alice, who answers from the directory: Jean reads as in a call within ${PRESENCE_MS / 1000} s, available again once they hang up`, async () => {
    await presenceIs(alice.page, 'Dupont', '102', 'Disponible')
    await dial(jean.page, '101')
    await alice.page.getByTestId('presence-102').filter({ hasText: 'En communication' }).waitFor({ timeout: PRESENCE_MS })
    await alice.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await presenceIs(jean.page, 'Martin', '101', 'En communication', PRESENCE_MS)
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    await alice.page.getByTestId('presence-102').filter({ hasText: 'Disponible' }).waitFor({ timeout: PRESENCE_MS })
    await jean.page.getByTestId('presence-101').filter({ hasText: 'Disponible' }).waitFor({ timeout: PRESENCE_MS })
  })
  await step('step 10a: Alice, an administrator, subscribes a tool of the organisation to the missed calls and the trunks degraded (its domain allowed first); a test reaches it, signed', async () => {
    const api = await asPerson(alice)
    expectEqual((await api('PUT', '/webhooks/domains', { domains: ['127.0.0.1'] })).statusCode, 200, 'PUT /webhooks/domains')
    const made = await api('POST', '/webhooks', { url: `${receiver.url}/twakephone`, events: ['call.missed', 'trunk.degraded'], description: 'CRM' })
    expectEqual(made.statusCode, 201, 'POST /webhooks')
    receiver.secret = made.json().secret
    expectEqual((await api('POST', `/webhooks/${made.json().id}/test`)).statusCode, 202, 'POST /webhooks/:id/test')
    const test = await receiver.waitFor(e => e?.type === 'webhook.test', 'webhook.test')
    expectEqual(test.verified, true, 'signature of the test')
  })
  await step('Alice calls Jean and gives up while it rings: a missed call for Jean, in his Récents and in missed_calls (487), and a signed call.missed for the tool', async () => {
    const delivered = receiver.received.length
    await dial(alice.page, '102')
    await jean.page.getByTestId('incoming-call').waitFor()
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByTestId('incoming-call').waitFor({ state: 'hidden' })
    expectEqual((await recents(jean.page, 4))[0], '101: Manqué', "Jean's newest recent call")
    expectEqual((await recents(alice.page, 5)).slice(0, 2), ['102: Sortant', '102: Entrant'], "Alice's newest recent calls")
    const missed = await db.query("SELECT caller, callee, sip_code FROM missed_calls WHERE sip_code = '487' AND id > $1", [since.missed_calls])
    expectEqual(missed.rows.map(r => `${r.caller}>${r.callee}`), ['101>102'], 'cancelled call in missed_calls')
    // The tool hears it from the Gateway: who called whom, for whom, signed with the secret it was shown.
    const hook = await receiver.waitFor((e, d) => e?.type === 'call.missed' && receiver.received.indexOf(d) >= delivered, 'call.missed')
    expectEqual(hook.verified, true, 'signature of call.missed')
    const c = hook.event.call
    expectEqual(JSON.stringify([c.direction, c.from, c.to, c.user, c.extension, c.outcome, c.duration_sec]), JSON.stringify(['inbound', '101', '102', 'jdupont', '102', 'missed', 0]), 'the missed call as the tool reads it')
    expectEqual(hook.headers['idempotency-key'], hook.event.id, 'idempotency key')
  })
  await step('Alice gives up while OpenSIPS still reads the rules of 102 (a slow database): 487, a missed call for Jean, nobody left in a call', async () => {
    const missedFrom = await lastId('missed_calls')
    // call_rules locked: OpenSIPS's read of Jean's rules waits (up to its statement_timeout, 1 s) while Alice hangs up.
    const locker = new pg.Client({ connectionString: OPENSIPS_DB_URL })
    await locker.connect()
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE call_rules IN ACCESS EXCLUSIVE MODE')
      const before = await lastEnded(alice.page)
      await dial(alice.page, '102')
      // Hung up once OpenSIPS waits on the lock: the INVITE is there (a click before it leaves the browser sends nothing).
      await until("OpenSIPS's read of the rules to wait on the lock", async () => {
        // `locker` is inside its transaction, which reads pg_stat_activity once: the snapshot is cleared each time.
        await locker.query('SELECT pg_stat_clear_snapshot()')
        const { rows } = await locker.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%JOIN call_rules r ON r.extension = ''102''%'")
        return rows[0].n > 0
      }, { timeout: 5_000, every: 20 })
      await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
      await until('the cancelled call to end', async () => {
        const e = await lastEnded(alice.page)
        return e && e.id !== before?.id ? e : null
      })
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined)
      await locker.end()
    }
    // Long enough for a call to be told after the read (the bug: a call told, then never ended, Alice busy for hours).
    await sleep(2_000)
    expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
    await until('the missed call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['101>102 487'], 'missed_calls rows of the call given up during the read')
    await presenceIs(jean.page, 'Martin', '101', 'Disponible', PRESENCE_MS)
  })
  await step('Alice chooses a microphone and outputs in the settings: the next call uses them, the ringtone can be tested', async () => {
    await alice.page.getByRole('link', { name: 'Réglages' }).click()
    await alice.page.getByRole('heading', { level: 2, name: 'Audio' }).waitFor()
    // The browsers' simulated devices: Chromium and Edge list several microphones and outputs (the choices are
    // proven there); Firefox lists one microphone and no output, so it only proves the screen and the ringtone.
    const several = BROWSER !== 'firefox'
    const options = async label => (await alice.page.getByLabel(label).locator('option').all()).length - 1
    const pick = async (label, index) => {
      // The lists fill once enumerateDevices answers (a moment on a loaded runner): wait for the wanted entry,
      // or give up on a browser that lists fewer devices.
      await alice.page.getByLabel(label).locator('option').nth(index + 1).waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined)
      const n = await options(label)
      if (n <= index) {
        if (several) throw new Error(`${label}: ${n} device(s) listed, expected more than ${index}`)
        return null
      }
      await alice.page.getByLabel(label).selectOption({ index: index + 1 })
      return alice.page.getByLabel(label).inputValue()
    }
    const microphone = await pick('Microphone', 1)
    const canChooseOutput = await alice.page.evaluate(() => 'setSinkId' in HTMLMediaElement.prototype)
    if (several) expectEqual(canChooseOutput, true, 'setSinkId available')
    const output = canChooseOutput ? await pick('Sortie de la voix', 1) : null
    const ringerOutput = canChooseOutput ? await pick('Sortie de la sonnerie', 2) : null
    console.log(`     devices: microphone ${microphone ?? 'default'}, output ${output ?? 'default'}, ringer ${ringerOutput ?? 'default'}${several ? '' : ' (one device per kind here: choices not proven)'}`)
    const chosen = await alice.page.evaluate(() => window.twakephone.devices)
    if (microphone) expectEqual(chosen.microphoneId, microphone, 'microphone kept')
    await alice.page.getByRole('button', { name: 'Tester la sonnerie' }).click()
    // The ringtone plays (its element is not paused and carries a live stream), on the chosen output, then stops.
    await ringerPlaying(alice.page, true)
    if (ringerOutput) expectEqual(await ringerSink(alice.page), ringerOutput, 'output of the ringtone')
    expectEqual(await soundBlocked(alice.page), false, 'sound blocked during the ringtone test')
    await ringerPlaying(alice.page, false)
    await alice.page.getByRole('link', { name: 'Clavier' }).click()
    await aliceCallsJean(alice, jean)
    await bothHearEachOther(alice, jean)
    const [s] = await stats(alice.page)
    if (microphone) expectEqual(s.microphoneId, microphone, 'microphone of the call')
    if (output) expectEqual(s.outputId, output, 'output of the call')
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
  })
  await step('Alice is signed in twice (a second window): both ring, the one that answers takes the call, the other is told', async () => {
    const alice2 = await open('amartin', 'Alice Martin')
    await phoneState(alice2.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    await dial(jean.page, '101')
    for (const who of [alice, alice2]) {
      await who.page.getByTestId('incoming-call').getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
      await ringerPlaying(who.page, true)
      expectEqual(await soundBlocked(who.page), false, `sound blocked while ringing (${who === alice ? 'first' : 'second'} window)`)
    }
    await alice2.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await alice.page.getByText('Appel de Jean Dupont (102) pris sur un autre poste.').waitFor()
    // Both ringtones stop: the window that answered, and the one the SIP server cancelled.
    for (const who of [alice, alice2]) await ringerPlaying(who.page, false)
    expectEqual((await calls(alice.page)).length, 0, 'calls left in the first window')
    await bothHearEachOther(alice2, jean)
    await alice2.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    // Signing out unregisters that window: 101 is reached in the first one only from now on.
    await signOut(alice2)
  })
  await step('Bob signs in and registers: a third person, for the transfers', async () => {
    bob = await open('bdurand', 'Bob Durand')
    await phoneState(bob.page).getByText('En ligne').waitFor({ timeout: 20_000 })
  })
  await step('Jean transfers Alice to an extension nobody registered: told why, and still in the call with Alice', async () => {
    await aliceCallsJean(alice, jean)
    await transferButton(jean.page).click()
    await transferTarget(jean.page).fill('105')
    await jean.page.getByRole('button', { name: 'Transférer directement' }).click()
    // Alice (the transferee) was told to call 105, got 404 and reported it to Jean (NOTIFY), who resumed her.
    await jean.page.getByRole('alert').getByText('Transfert impossible : le poste visé est injoignable (404).').waitFor({ timeout: 20_000 })
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await until('Alice back from hold with her one call', async () => {
      const c = await calls(alice.page)
      return c.length === 1 && !c[0].remoteHold ? c : null
    })
    await jean.page.getByRole('button', { name: 'Fermer' }).click()
    await bothHearEachOther(alice, jean)
  })
  await step('Jean transfers Alice directly to Bob (REFER): Bob answers Alice, Jean is freed, Alice and Bob hear each other', async () => {
    await transferButton(jean.page).click()
    await transferTarget(jean.page).fill('103')
    await jean.page.getByRole('button', { name: 'Transférer directement' }).click()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    // Until Bob answers, Jean is told the transfer is on its way, and can still hang up.
    await jean.page.getByText('Transfert de Alice Martin (101) en cours…').waitFor()
    if (await jean.page.getByRole('button', { name: 'Raccrocher' }).isDisabled()) throw new Error('hanging up during a transfer must stay possible')
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) transféré.').waitFor()
    expectEqual((await calls(jean.page)).length, 0, 'calls left on Jean side')
    await alice.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await until('Alice has only her call with Bob', async () => (await calls(alice.page)).length === 1)
    await bob.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await bothHearEachOther(alice, bob)
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await bob.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
  })
  await step('Jean consults Bob while Alice waits, then drops the consultation: Alice is back', async () => {
    await aliceCallsJean(alice, jean)
    await transferButton(jean.page).click()
    await transferTarget(jean.page).fill('103')
    await jean.page.getByRole('button', { name: "Consulter d'abord" }).click()
    await jean.page.getByText('Alice Martin (101) en attente').waitFor()
    await alice.page.getByText('Votre correspondant vous a mis en attente.').waitFor()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    const consultation = jean.page.getByTestId('consultation')
    await consultation.getByText('En communication avec Bob Durand (103)').waitFor()
    await bothHearEachOther(jean, bob, { last: true })
    await consultation.getByRole('button', { name: 'Annuler la consultation' }).click()
    await bob.page.getByText('Appel avec Jean Dupont (102) terminé.').waitFor()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await until('Alice back from hold', async () => !(await calls(alice.page))[0]?.remoteHold)
    await bothHearEachOther(alice, jean)
  })
  await step('Jean consults an extension nobody registered: told so, and Alice is taken back without a click', async () => {
    await transferButton(jean.page).click()
    await transferTarget(jean.page).fill('105')
    await jean.page.getByRole('button', { name: "Consulter d'abord" }).click()
    // The end of the consultation is said even though the call with Alice goes on.
    await jean.page.getByRole('status').getByText('105 est injoignable.').waitFor({ timeout: 20_000 })
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await until('Alice back from hold with her one call', async () => {
      const c = await calls(alice.page)
      return c.length === 1 && !c[0].remoteHold ? c : null
    })
    expectEqual((await calls(jean.page)).length, 1, 'calls left on Jean side')
    await bothHearEachOther(alice, jean)
  })
  await step('Jean consults Bob, who hangs up: Alice is taken back without a click', async () => {
    await transferButton(jean.page).click()
    await transferTarget(jean.page).fill('103')
    await jean.page.getByRole('button', { name: "Consulter d'abord" }).click()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByTestId('consultation').getByText('En communication avec Bob Durand (103)').waitFor()
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByRole('status').getByText('Appel avec Bob Durand (103) terminé.').waitFor()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await until('Alice back from hold', async () => !(await calls(alice.page))[0]?.remoteHold)
    await bothHearEachOther(alice, jean)
  })
  await step('attended transfer: Jean consults Bob, then hands Alice over (REFER with Replaces); Jean is freed, Alice and Bob hear each other', async () => {
    await transferButton(jean.page).click()
    await transferTarget(jean.page).fill('103')
    await jean.page.getByRole('button', { name: "Consulter d'abord" }).click()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    const consultation = jean.page.getByTestId('consultation')
    await consultation.getByText('En communication avec Bob Durand (103)').waitFor()
    await consultation.getByRole('button', { name: 'Transférer Alice Martin (101) à Bob Durand (103)' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) transféré.').waitFor({ timeout: 20_000 })
    await until('Jean has no call left', async () => (await calls(jean.page)).length === 0)
    await alice.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await bob.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await until('Bob has one call, the one with Alice, which took the place of the one with Jean', async () => {
      const c = await calls(bob.page)
      return c.length === 1 && c[0].replacedCallId && c[0].remoteNumber === '101' ? c : null
    })
    await until('Alice has only her call with Bob', async () => (await calls(alice.page)).length === 1)
    await bothHearEachOther(alice, bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice.page.getByText('Appel avec Bob Durand (103) terminé.').waitFor()
  })
  await step('attended transfer to an extension that forwards (the desk, 104, sends everything to Bob): Alice ends up with Bob', async () => {
    // What the desk's rules would be had someone set them in Réglages: all its calls to Bob.
    await db.query("INSERT INTO call_rules (extension, tenant_id, holder, forward_always, forward_always_holder) VALUES ('104', $1, 'accueil', '103', 'bdurand')", [TENANT])
    await aliceCallsJean(alice, jean)
    await transferButton(jean.page).click()
    await transferTarget(jean.page).fill('104')
    await jean.page.getByRole('button', { name: "Consulter d'abord" }).click()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    const consultation = jean.page.getByTestId('consultation')
    await consultation.getByText('En communication avec Bob Durand (103)').waitFor()
    // The INVITE with Replaces names 104: OpenSIPS sends it where the consultation is, Bob, not to the desk's rules.
    await consultation.getByRole('button', { name: 'Transférer Alice Martin (101) à Bob Durand (103)' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) transféré.').waitFor({ timeout: 20_000 })
    await until('Jean has no call left', async () => (await calls(jean.page)).length === 0)
    await bob.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await until('Bob has one call, the one with Alice, which took the place of the one with Jean', async () => {
      const c = await calls(bob.page)
      return c.length === 1 && c[0].replacedCallId && c[0].remoteNumber === '101' ? c : null
    })
    await until('Alice has only her call, now with Bob', async () => (await calls(alice.page)).length === 1)
    await bothHearEachOther(alice, bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice.page.getByText(/^Appel avec (Bob Durand \(103\)|Accueil \(104\)) terminé\.$/).waitFor()
    await db.query("DELETE FROM call_rules WHERE extension = '104'")
  })
  await step('Jean forwards all his calls to 103 in Réglages: Alice calls 102, Bob rings and answers, Jean is not disturbed', async () => {
    await setForwarding(jean, { always: '103' })
    const { rows } = await db.query('SELECT forward_always, forward_busy, forward_noanswer FROM call_rules WHERE extension = $1', ['102'])
    expectEqual(JSON.stringify(rows), JSON.stringify([{ forward_always: '103', forward_busy: null, forward_noanswer: null }]), 'call_rules of 102')
    const started = new Date().toISOString()
    const cdrFrom = await lastId('acc')
    await dial(alice.page, '102')
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await alice.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await bob.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await bothHearEachOther(alice, bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice.page.getByText('Appel avec Bob Durand (103) terminé.').waitFor()
    // The history says what happened: Alice called 102, Bob took it; Jean has nothing new.
    const aliceCall = await newestCall('amartin', started)
    expectEqual(`${aliceCall.direction} ${aliceCall.remoteNumber} ${aliceCall.answered}`, 'outbound 102 true', "Alice's newest call")
    const bobCall = await newestCall('bdurand', started)
    expectEqual(`${bobCall.direction} ${bobCall.remoteNumber} ${bobCall.answered}`, 'inbound 101 true', "Bob's newest call")
    expectEqual((await store.listHistory(TENANT, 'jdupont', { from: started })).items.length, 0, "Jean's calls since the forward")
    // acc's CDR names the extension that answered, Bob.
    expectEqual(await cdrsSince(cdrFrom), ['101>103 200'], 'CDR of the forwarded call')
    await setForwarding(jean, {})
    expectEqual((await db.query('SELECT 1 FROM call_rules WHERE extension = $1', ['102'])).rows.length, 0, 'call_rules rows of 102 once nothing is forwarded')
  })
  await step('Jean forwards on no answer after 5 s: his phone rings, then Bob\'s, who answers; a missed call for Jean', async () => {
    await setForwarding(jean, { noAnswer: '103', delay: '5' })
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    const cdrFrom = await lastId('acc')
    await dial(alice.page, '102')
    await jean.page.getByTestId('incoming-call').getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    const rang = Date.now()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    const after = Date.now() - rang
    // About the delay: OpenSIPS's timer has a one-second grain, and at times comes a second or two late.
    if (after < 4_000 || after > 12_000) throw new Error(`Bob rang ${after} ms after Jean, about 5 s expected`)
    await jean.page.getByTestId('incoming-call').waitFor({ state: 'hidden' })
    // Longer than the delay: the call to Bob is not cut by Jean's timer.
    await sleep(6_000)
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await alice.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await bothHearEachOther(alice, bob)
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await bob.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.state}`, 'inbound 101 missed', "Jean's newest call")
    expectEqual((await recents(jean.page, 1))[0], '101: Manqué', "Jean's newest recent call")
    const bobCall = await newestCall('bdurand', started)
    expectEqual(`${bobCall.direction} ${bobCall.remoteNumber} ${bobCall.answered}`, 'inbound 101 true', "Bob's newest call")
    // Answered in the end: no missed call in OpenSIPS's tables, and the CDR names Bob.
    expectEqual(await missedSince(missedFrom), [], 'missed_calls rows of the forwarded call')
    expectEqual(await cdrsSince(cdrFrom), ['101>103 200'], 'CDR of the forwarded call')
  })
  await step('Alice gives up while the forward rings Bob: a missed call for Jean and for Bob, 487 for Bob in missed_calls', async () => {
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    await dial(alice.page, '102')
    await jean.page.getByTestId('incoming-call').getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    await bob.page.getByTestId('incoming-call').getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await bob.page.getByTestId('incoming-call').waitFor({ state: 'hidden' })
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.state}`, 'inbound 101 missed', "Jean's newest call")
    const bobCall = await newestCall('bdurand', started)
    expectEqual(`${bobCall.direction} ${bobCall.remoteNumber} ${bobCall.state}`, 'inbound 101 missed', "Bob's newest call")
    expectEqual((await recents(bob.page, 1))[0], '101: Manqué', "Bob's newest recent call")
    await until('the missed call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['101>103 487'], 'missed_calls rows of the call given up')
  })
  await step('Jean forwards when busy: in a call with Alice, a call from her second window goes to Bob', async () => {
    await setForwarding(jean, { busy: '103' })
    const alice2 = await open('amartin', 'Alice Martin')
    await phoneState(alice2.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    await dial(jean.page, '101')
    await alice.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await alice2.page.getByText('Appel de Jean Dupont (102) pris sur un autre poste.').waitFor()
    // Jean's softphone answers 486 (already in a call): his busy forward takes the call to Bob.
    await dial(alice2.page, '102')
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await alice2.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await bothHearEachOther(alice2, bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice2.page.getByText('Appel avec Bob Durand (103) terminé.').waitFor()
    await jean.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice.page.getByText('Appel avec Jean Dupont (102) terminé.').waitFor()
    await signOut(alice2)
  })
  await step('Jean, in a call in one window, does not answer in his other one: after the delay his no-answer forward rings Bob', async () => {
    await setForwarding(jean, { noAnswer: '103', delay: '5' })
    const jean2 = await open('jdupont', 'Jean Dupont')
    const alice2 = await open('amartin', 'Alice Martin')
    for (const who of [jean2, alice2]) await phoneState(who.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    await dial(alice2.page, '102')
    await jean.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await alice2.page.getByText('En communication avec Jean Dupont (102)').waitFor()
    await jean2.page.getByText('Appel de Alice Martin (101) pris sur un autre poste.').waitFor()
    // Jean's first window answers 486 (in a call), his second one rings: nobody answers it, a no answer.
    await dial(alice.page, '102')
    await jean2.page.getByTestId('incoming-call').getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    const rang = Date.now()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    const after = Date.now() - rang
    if (after < 4_000 || after > 12_000) throw new Error(`Bob rang ${after} ms after Jean's second window, about 5 s expected`)
    await jean2.page.getByTestId('incoming-call').waitFor({ state: 'hidden' })
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await alice.page.getByText("102 a refusé l'appel.").waitFor()
    await jean.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice2.page.getByText('Appel avec Jean Dupont (102) terminé.').waitFor()
    await signOut(alice2)
    await signOut(jean2)
    await setForwarding(jean, {})
  })
  await step('Jean forwards everything to Bob, who does not want to be disturbed: Alice is told 102 cannot be reached, never Bob\'s message', async () => {
    await setForwarding(jean, { always: '103' })
    await setStatus(bob, 'Ne pas déranger', { message: 'Bob en congé' })
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    const ended = await dialUntilEnded(alice.page, '102')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endMessage}`, '480 unavailable undefined', 'how the call to 102 ended')
    await alice.page.getByText('102 est injoignable.').waitFor()
    expectEqual(await alice.page.getByText('Bob en congé').count(), 0, "Bob's message on Alice's screen")
    expectEqual(await jean.page.getByTestId('incoming-call').count() + (await bob.page.getByTestId('incoming-call').count()), 0, 'incoming calls on Jean and Bob sides')
    // Refused on Bob's behalf: a missed call for him, a failed one for Alice, nothing for Jean.
    const bobCall = await newestCall('bdurand', started)
    expectEqual(`${bobCall.direction} ${bobCall.remoteNumber} ${bobCall.state}`, 'inbound 101 missed', "Bob's newest call")
    const aliceCall = await newestCall('amartin', started)
    expectEqual(`${aliceCall.direction} ${aliceCall.remoteNumber} ${aliceCall.state}`, 'outbound 102 failed', "Alice's newest call")
    expectEqual((await store.listHistory(TENANT, 'jdupont', { from: started })).items.length, 0, "Jean's calls since")
    expectEqual(await missedSince(missedFrom), ['101>103 480'], 'missed_calls rows')
    await setStatus(bob, 'Disponible')
    await setForwarding(jean, {})
  })
  await step('Jean does not want to be disturbed until later, with a message: Alice\'s call goes to his no-answer forward, Bob', async () => {
    await setForwarding(jean, { noAnswer: '103', delay: '20' })
    await setStatus(jean, 'Ne pas déranger', { inMinutes: 60, message: "En réunion jusqu'à 16 h" })
    await jean.page.getByTestId('my-presence').getByText(/Ne pas déranger jusqu'au/).waitFor()
    // Typed in Paris time: an hour from now on the database's clock, not one or two hours off.
    const { rows } = await db.query("SELECT dnd, dnd_message, dnd_until BETWEEN now() + interval '50 minutes' AND now() + interval '70 minutes' AS in_an_hour FROM call_rules WHERE extension = $1", ['102'])
    expectEqual(JSON.stringify(rows), JSON.stringify([{ dnd: true, dnd_message: "En réunion jusqu'à 16 h", in_an_hour: true }]), 'call_rules of 102')
    const missedFrom = await lastId('missed_calls')
    await presenceIs(alice.page, 'Dupont', '102', 'Ne pas déranger', PRESENCE_MS)
    await dial(alice.page, '102')
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    // Bob declined it, Jean did not: Alice hears Jean's "do not disturb", with his message; the missed call is Jean's.
    await alice.page.getByText("102 ne souhaite pas être dérangé : « En réunion jusqu'à 16 h »").waitFor()
    await until('the refused call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['101>102 480'], 'missed_calls rows')
  })
  await step('without a forward, his "do not disturb" refuses the call and Alice reads his message; a missed call for Jean', async () => {
    await setForwarding(jean, {})
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    const ended = await dialUntilEnded(alice.page, '102')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endMessage}`, "480 dnd En réunion jusqu'à 16 h", 'how the call to 102 ended')
    await alice.page.getByText("102 ne souhaite pas être dérangé : « En réunion jusqu'à 16 h »").waitFor()
    expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.state}`, 'inbound 101 missed', "Jean's newest call")
    expectEqual(await missedSince(missedFrom), ['101>102 480'], 'refused call in missed_calls')
  })
  await step('his forward leads nowhere (the desk, nobody registered) or to Bob, who does not want to be disturbed either: Alice reads Jean\'s message', async () => {
    await setForwarding(jean, { always: '104' })
    const missedFrom = await lastId('missed_calls')
    let ended = await dialUntilEnded(alice.page, '102')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endMessage}`, "480 dnd En réunion jusqu'à 16 h", 'how the call forwarded to 104 ended')
    await setForwarding(jean, { always: '103' })
    await setStatus(bob, 'Ne pas déranger', { message: 'Bob en congé' })
    ended = await dialUntilEnded(alice.page, '102')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endMessage}`, "480 dnd En réunion jusqu'à 16 h", 'how the call forwarded to Bob ended')
    expectEqual(await alice.page.getByText('Bob en congé').count(), 0, "Bob's message on Alice's screen")
    expectEqual(await bob.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Bob side')
    expectEqual(await missedSince(missedFrom), ['101>102 480', '101>102 480'], 'missed_calls rows: Jean refused them')
    await setStatus(bob, 'Disponible')
    await setForwarding(jean, {})
  })
  await step('the "do not disturb" ends by itself at its date: the Gateway says so, forgets it, and a call to 102 rings Jean again', async () => {
    // An end a few seconds away (the screen takes minutes): what Jean's app sends.
    const api = await asPerson(jean)
    const endMs = Date.now() + 8_000
    const res = await api('PUT', '/me/presence', { status: 'dnd', until: new Date(endMs).toISOString(), message: 'Bientôt libre' })
    expectEqual(res.statusCode, 200, 'PUT /me/presence')
    // Called at once (OpenSIPS reads call_rules, written before the answer): a call before the end, however slow the
    // directory is to show the presence.
    const ended = await dialUntilEnded(alice.page, '102')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endMessage}`, '480 dnd Bientôt libre', 'how the call before the end ended')
    if (Date.now() >= endMs) throw new Error('the call before the end of the "do not disturb" ended after it: too slow a machine for this step')
    // Past its end: the Gateway's own timer tells the directory, and its store no longer holds the choice.
    await presenceIs(alice.page, 'Dupont', '102', 'Disponible', endMs - Date.now() + PRESENCE_MS + 2_000)
    expectEqual(await store.getUserPresence(TENANT, 'jdupont'), null, "Jean's choice in the store once over")
    expectEqual((await api('GET', '/me/presence')).json().choice, undefined, 'the choice Jean reads once over')
    await dial(alice.page, '102')
    const ringing = jean.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await alice.page.getByText("102 a refusé l'appel.").waitFor()
    await setStatus(jean, 'Disponible')
    expectEqual((await db.query('SELECT 1 FROM call_rules WHERE extension = $1', ['102'])).rows.length, 0, 'call_rules rows of 102 once available')
  })
  await step('forwards never loop: a forward to oneself or outside is refused in words, and 102 → 103 → 102 stops at Bob, who rings', async () => {
    await jean.page.getByRole('link', { name: 'Réglages' }).click()
    for (const [target, words] of [['102', 'Un renvoi vers votre propre poste vous ferait sonner à nouveau'], ['0612345678', "Seul le poste d'un collègue peut recevoir vos appels"]]) {
      await jean.page.getByLabel('Renvoyer tous les appels vers le poste').fill(target)
      await jean.page.getByRole('button', { name: 'Enregistrer les renvois' }).click()
      await jean.page.getByRole('alert').filter({ hasText: words }).waitFor()
    }
    expectEqual((await db.query('SELECT 1 FROM call_rules WHERE extension = $1', ['102'])).rows.length, 0, 'call_rules rows of 102 after the refusals')
    await setForwarding(jean, { always: '103' })
    await setForwarding(bob, { always: '102' })
    await dial(alice.page, '102')
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await alice.page.getByText("102 a refusé l'appel.").waitFor()
    await setForwarding(jean, {})
    await setForwarding(bob, {})
    expectEqual((await db.query('SELECT 1 FROM call_rules')).rows.length, 0, 'call_rules rows once nothing is forwarded')
  })
  await step('the Gateway wrote the directory name of each extension where OpenSIPS reads it (display_names)', async () => {
    const { rows } = await db.query("SELECT extension, tenant_id, display_name FROM display_names WHERE extension IN ('101', '102', '103', '104') ORDER BY extension")
    expectEqual(rows.map(r => `${r.extension} ${r.tenant_id} ${r.display_name}`), ['101 e2e Alice Martin', '102 e2e Jean Dupont', '103 e2e Bob Durand', '104 e2e Accueil'], 'display_names rows')
  })
  await step('Alice, an administrator, creates ring group 200 (101, 102, 103) in Administration; an extension, or an account OpenSIPS still has, is no group number; "Nouveau groupe" never replaces one; a group is no forward target, and nobody else may manage groups (403)', async () => {
    await openAdmin(alice.page, "Groupes d'appel")
    // Fills and sends the form; resolves with what the Gateway answered ("status code"), and the words shown.
    const save = async (number, name = 'Accueil commun') => {
      await alice.page.getByLabel('Numéro du groupe').fill(number)
      await alice.page.getByLabel('Nom affiché').fill(name)
      await alice.page.getByLabel('Postes membres').fill('101, 102, 103')
      const answered = alice.page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/admin/groups'))
      await alice.page.getByRole('button', { name: 'Enregistrer le groupe' }).click()
      const res = await answered
      return `${res.status()} ${res.ok() ? '' : (await res.json()).code}`.trim()
    }
    expectEqual(await save('102'), '409 GROUP_NUMBER_TAKEN', 'creating group 102')
    // Said next to the number (its error, tied to the field), the form saying how many problems it has.
    await alice.page.locator('#group-number-error').filter({ hasText: 'Ce numéro est déjà pris' }).waitFor()
    await alice.page.getByRole('alert').filter({ hasText: '1 erreur' }).waitFor()
    // An account an older Gateway left in subscriber (nobody's extension any more): OpenSIPS would route 106 as an
    // extension, so no group gets it either (the provider checks subscriber).
    await db.query("INSERT INTO subscriber (username, domain, password, ha1, ha1_sha256, ha1_sha512t256) VALUES ('106', '', '', 'x', 'x', 'x') ON CONFLICT DO NOTHING")
    expectEqual(await save('106'), '409 GROUP_NUMBER_TAKEN', 'creating group 106')
    // Said next to the number (its error, tied to the field), the form saying how many problems it has.
    await alice.page.locator('#group-number-error').filter({ hasText: 'Ce numéro est déjà pris' }).waitFor()
    await alice.page.getByRole('alert').filter({ hasText: '1 erreur' }).waitFor()
    expectEqual((await db.query("SELECT 1 FROM call_groups WHERE number = '106'")).rows.length, 0, 'call_groups rows of 106')
    expectEqual(await save('200'), '201', 'creating group 200')
    await alice.page.getByRole('status').filter({ hasText: 'Groupe 200 enregistré.' }).waitFor()
    await alice.page.getByRole('list', { name: 'Groupes existants' }).getByText('101, 102, 103').waitFor()
    // The creation form again, with the same number: refused, the group stays as it was.
    expectEqual(await save('200', 'Autre chose'), '409 GROUP_EXISTS', 'creating group 200 again')
    await alice.page.locator('#group-number-error').filter({ hasText: 'Un groupe de votre organisation a déjà ce numéro' }).waitFor()
    // The focus on the field in error.
    await alice.page.waitForFunction(() => document.activeElement?.id === 'group-number', undefined, { timeout: 5_000 })
    const { rows } = await db.query("SELECT tenant_id, name, members FROM call_groups WHERE number = '200'")
    expectEqual(rows, [{ tenant_id: TENANT, name: 'Accueil commun', members: ['101', '102', '103'] }], 'the group OpenSIPS reads')
    await alice.page.getByLabel('Numéro du groupe').fill('')
    await alice.page.getByLabel('Nom affiché').fill('')
    await alice.page.getByLabel('Postes membres').fill('')
    // Bob is no administrator: no link to the screen, and the Gateway refuses whatever he sends.
    expectEqual(await bob.page.getByRole('link', { name: 'Administration' }).count(), 0, 'Administration links on Bob side')
    const api = await asPerson(bob)
    for (const [method, url, payload] of [['GET', '/admin/groups'], ['POST', '/admin/groups', { number: '201', name: 'Pirate', members: ['103'] }], ['PUT', '/admin/groups/200', { name: 'Pirate', members: ['103'] }], ['DELETE', '/admin/groups/200']])
      expectEqual((await api(method, url, payload)).statusCode, 403, `${method} ${url} as Bob`)
    expectEqual((await db.query("SELECT number FROM call_groups WHERE number IN ('200', '201')")).rows.map(r => r.number), ['200'], 'groups after Bob tried')
    // A forward to the group is refused like any number that is not a colleague's extension.
    await jean.page.getByRole('link', { name: 'Réglages' }).click()
    await jean.page.getByLabel('Renvoyer tous les appels vers le poste').fill('200')
    await jean.page.getByRole('button', { name: 'Enregistrer les renvois' }).click()
    await jean.page.getByRole('alert').filter({ hasText: "Seul le poste d'un collègue" }).waitFor()
    await jean.page.getByLabel('Renvoyer tous les appels vers le poste').fill('')
  })
  await step('the desk (104) calls 200: Alice, Jean and Bob ring at once; Jean answers, the two others stop ringing, told it was answered elsewhere; each side reads the other\'s directory name', async () => {
    desk = await open('accueil', 'Accueil')
    await phoneState(desk.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    const cdrFrom = await lastId('acc')
    await dial(desk.page, '200')
    for (const who of [alice, jean, bob]) {
      await who.page.getByTestId('incoming-call').getByText('Appel entrant de Accueil (104)').waitFor({ timeout: 20_000 })
      await ringerPlaying(who.page, true)
    }
    await jean.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec Accueil (104)').waitFor()
    await desk.page.getByText('En communication avec Jean Dupont (102)').waitFor()
    for (const who of [alice, bob]) {
      await who.page.getByText('Appel de Accueil (104) pris sur un autre poste.').waitFor()
      await ringerPlaying(who.page, false)
      expectEqual((await calls(who.page)).length, 0, `calls left on ${who.name} side`)
    }
    await bothHearEachOther(desk, jean)
    await desk.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec Accueil (104) terminé.').waitFor()
    await desk.page.getByText('Appel avec Jean Dupont (102) terminé.').waitFor()
    // The desk dialled the group, and keeps its number; Jean took the call; for Alice and Bob, nothing to call back.
    const deskCall = await newestCall('accueil', started)
    expectEqual(`${deskCall.direction} ${deskCall.remoteNumber} ${deskCall.answered}`, 'outbound 200 true', "the desk's newest call")
    expectEqual((await recents(desk.page, 1))[0], '200: Sortant', "the desk's newest recent call")
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.answered}`, 'inbound 104 true', "Jean's newest call")
    for (const userId of ['amartin', 'bdurand']) {
      const [entry] = (await store.listHistory(TENANT, userId, { limit: 1 })).items
      if (entry && entry.startedAt > started) throw new Error(`a call in the history of ${userId}: ${JSON.stringify(entry)}`)
    }
    // acc names the member who answered, next to the number dialled; no missed call.
    await cdrsSince(cdrFrom)
    const { rows } = await db.query('SELECT caller, callee, dialled, sip_code FROM acc WHERE id > $1 ORDER BY id', [cdrFrom])
    expectEqual(rows.map(r => `${r.caller}>${r.callee} via ${r.dialled} ${r.sip_code}`), ['104>102 via 200 200'], 'CDR of the group call')
    expectEqual(await missedSince(missedFrom), [], 'missed_calls rows of the group call')
  })
  await step('Jean and Bob are in a call together (their windows answer busy at once) and Alice declines: the desk is told the group cannot be reached (480), not that it declined; the missed call of the group says 480', async () => {
    await dial(jean.page, '103')
    await bob.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec Bob Durand (103)').waitFor()
    const missedFrom = await lastId('missed_calls')
    const ended = dialUntilEnded(desk.page, '200')
    const ringing = alice.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Accueil (104)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    // One refusal out of three windows: tm would pick it (a 6xx) and tell the desk the group declined.
    const { endStatus, endReason } = await ended
    expectEqual(`${endStatus} ${endReason}`, '480 unavailable', 'how the call to 200 ended')
    await desk.page.getByText('200 est injoignable.').waitFor()
    await until('the missed call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['104>200 480'], 'missed_calls rows of the group call nobody took')
    // Jean and Bob talk on, undisturbed.
    expectEqual((await calls(bob.page)).length, 1, 'calls on Bob side')
    await jean.page.getByRole('button', { name: 'Raccrocher' }).click()
    await bob.page.getByText('Appel avec Jean Dupont (102) terminé.').waitFor()
  })
  await step('Jean opens a second window; the desk calls 200: Alice declines while the others ring (Bob, Jean on both windows); Jean answers on his second window, his first and Bob are told it was answered elsewhere', async () => {
    jean2 = await open('jdupont', 'Jean Dupont')
    await phoneState(jean2.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    const cdrFrom = await lastId('acc')
    const missedFrom = await lastId('missed_calls')
    await dial(desk.page, '200')
    for (const who of [alice, jean, jean2, bob]) await who.page.getByTestId('incoming-call').getByText('Appel entrant de Accueil (104)').waitFor({ timeout: 20_000 })
    await alice.page.getByTestId('incoming-call').getByRole('button', { name: 'Refuser' }).click()
    await until('Alice to stop ringing', async () => (await calls(alice.page)).length === 0)
    // Her refusal leaves her colleagues ringing: the call is still to be taken.
    for (const who of [jean, jean2, bob]) await ringerPlaying(who.page, true)
    await jean2.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean2.page.getByText('En communication avec Accueil (104)').waitFor()
    await desk.page.getByText('En communication avec Jean Dupont (102)').waitFor()
    for (const who of [jean, bob]) {
      await who.page.getByText('Appel de Accueil (104) pris sur un autre poste.').waitFor()
      expectEqual((await calls(who.page)).length, 0, `calls left on ${who.name} side (${who === jean ? 'first window' : 'Bob'})`)
    }
    await bothHearEachOther(desk, jean2)
    await desk.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean2.page.getByText('Appel avec Accueil (104) terminé.').waitFor()
    await cdrsSince(cdrFrom)
    const { rows } = await db.query('SELECT caller, callee, dialled, sip_code FROM acc WHERE id > $1 ORDER BY id', [cdrFrom])
    expectEqual(rows.map(r => `${r.caller}>${r.callee} via ${r.dialled} ${r.sip_code}`), ['104>102 via 200 200'], 'CDR of the group call')
    expectEqual(await missedSince(missedFrom), [], 'missed_calls rows of the group call')
  })
  await step('Jean, on two windows, forwards on busy to Bob; Alice calls 102 and one of his windows declines while the other rings: the call goes to Bob (the OpenSIPS of step 4b answered 500 there)', async () => {
    await setForwarding(jean, { busy: '103' })
    await dial(alice.page, '102')
    for (const who of [jean, jean2]) await who.page.getByTestId('incoming-call').getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    await jean.page.getByTestId('incoming-call').getByRole('button', { name: 'Refuser' }).click()
    // The other window stops ringing (the refusal declines the call), and the busy forward follows.
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 10_000 })
    await until("Jean's second window to stop ringing", async () => (await calls(jean2.page)).length === 0)
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await alice.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await bob.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    await setForwarding(jean, {})
    await signOut(jean2)
    jean2 = undefined
  })
  await step('Bob does not want to be disturbed: a call to 200 rings Alice and Jean only; the desk gives up: a missed call for each of them, one for the group in missed_calls, and Bob never saw the call', async () => {
    await setStatus(bob, 'Ne pas déranger')
    // Whatever shows on Bob's page from now on is seen, even if it goes away at once.
    await bob.page.evaluate(() => {
      window.e2eSawIncoming = false
      window.e2eObserver?.disconnect()
      window.e2eObserver = new MutationObserver(() => {
        if (document.querySelector('[data-testid=incoming-call]')) window.e2eSawIncoming = true
      })
      window.e2eObserver.observe(document.body, { childList: true, subtree: true })
    })
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    await dial(desk.page, '200')
    for (const who of [alice, jean]) await who.page.getByTestId('incoming-call').getByText('Appel entrant de Accueil (104)').waitFor({ timeout: 20_000 })
    await desk.page.getByRole('button', { name: 'Raccrocher' }).click()
    for (const who of [alice, jean]) {
      await who.page.getByText('Appel de Accueil (104) pris sur un autre poste ou abandonné.').waitFor()
      const call = await newestCall(who === alice ? 'amartin' : 'jdupont', started)
      expectEqual(`${call.direction} ${call.remoteNumber} ${call.state}`, 'inbound 104 missed', `${who.name}'s newest call`)
      expectEqual((await recents(who.page, 1))[0], '104: Manqué', `${who.name}'s newest recent call`)
    }
    // The transaction is over (its missed call is written once every window answered): had Bob been rung, his page
    // would have shown it by now.
    await until('the missed call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['104>200 487'], 'missed_calls rows of the group call given up')
    expectEqual(await bob.page.evaluate(() => window.e2eSawIncoming), false, 'an incoming call shown on Bob side')
    const [bobEntry] = (await store.listHistory(TENANT, 'bdurand', { limit: 1 })).items
    if (bobEntry && bobEntry.startedAt > started) throw new Error(`a call in Bob's history: ${JSON.stringify(bobEntry)}`)
    await bob.page.evaluate(() => window.e2eObserver?.disconnect())
    await setStatus(bob, 'Disponible')
  })
  await step('ring group 210 of three extensions with five windows each (user agents of this process): twelve windows ring, four of each member; all decline: 603; one member busy on all its windows: 480', async () => {
    // Three extensions and a caller nobody signs in to in a browser: their accounts written for them as their sessions do.
    const members = ['131', '132', '133']
    const credentials = {}
    for (const extension of [...members, '134']) {
      const userId = `ua-${extension}`
      await store.upsertMapping({ tenantId: TENANT, userId, extension, displayName: `Fenêtre ${extension}` })
      credentials[extension] = (await registry.forTenant(TENANT).getSession({ id: userId, tenantId: TENANT, displayName: `Fenêtre ${extension}`, extension }, { id: 'ua', type: 'browser', label: 'UA' })).credential
    }
    const holders = (await db.query("SELECT username, holder FROM subscriber WHERE username IN ('131', '132', '133', '134') ORDER BY username")).rows
    expectEqual(holders.map(r => `${r.username} ${r.holder}`), ['131 ua-131', '132 ua-132', '133 ua-133', '134 ua-134'], 'the holders of the accounts')
    const api = await asPerson(alice)
    expectEqual((await api('POST', '/admin/groups', { number: '210', name: 'Fenêtres', members })).statusCode, 201, 'creating group 210')
    const windows = []
    const caller = await sipUa({ proxy: SIP_UDP, domain: SIP_DOMAIN, user: '134', password: credentials['134'] })
    try {
      for (const user of members) {
        for (let i = 0; i < 5; i++) {
          const ua = await sipUa({ proxy: SIP_UDP, domain: SIP_DOMAIN, user, password: credentials[user] })
          windows.push(ua)
          expectEqual(await ua.register(), 200, `registration of window ${i + 1} of ${user}`)
        }
      }
      // How many INVITEs each window got since `before`, by member.
      const rung = before => members.map(m => `${m}: ${windows.filter(w => w.user === m && w.invites.length > (before.get(w) ?? 0)).length}`)
      const counts = () => new Map(windows.map(w => [w, w.invites.length]))
      for (const w of windows) w.answer('603 Decline')
      let before = counts()
      expectEqual(await caller.call('210'), '603 Decline', 'the answer to 210 when every window declines')
      expectEqual(rung(before), ['131: 4', '132: 4', '133: 4'], 'windows rung per member (12 at most, in turn)')
      // 132 is busy on every window: not every window declined, the group cannot be reached (480).
      for (const w of windows) w.answer(w.user === '132' ? '486 Busy Here' : '603 Decline')
      before = counts()
      expectEqual(await caller.call('210'), '480 Temporarily Unavailable', 'the answer to 210 when one member is busy and the others decline')
      expectEqual(rung(before), ['131: 4', '132: 4', '133: 4'], 'windows rung per member, the second time')
    } finally {
      for (const ua of [...windows, caller]) await ua.close()
      await api('DELETE', '/admin/groups/210')
      // Nobody holds them any more: the next synchronisation removes their accounts (step of the names).
      for (const extension of [...members, '134']) await store.deleteMapping(TENANT, `ua-${extension}`)
    }
  })
  // Step 5 in SIP only (user agents of this process): the windows that come back, the dead ones, and the races a
  // browser cannot set up on purpose. 141 and 143 have windows over a WebSocket, as a browser's; 142 calls over UDP;
  // ring group 220 is 143 and 144. Their browsers can be woken: rows of push_targets, as a Gateway of another tenant
  // writes them, alive (that Gateway listens). Nothing pushes to them: only this test opens their windows.
  const wakeable = { members: ['141', '143', '144'], credentials: {} }
  /** A window of `user`, over a WebSocket (a browser's) or over UDP. */
  const windowOf = (user, { ws = false } = {}) => sipUa({ ...(ws ? { ws: SIP_WS } : { proxy: SIP_UDP }), domain: SIP_DOMAIN, user, password: wakeable.credentials[user] })
  /** A window over a WebSocket, registered, whose connection is gone: OpenSIPS keeps a contact it cannot reach. */
  const deadWindow = async user => {
    const ua = await windowOf(user, { ws: true })
    expectEqual(await ua.register(), 200, `registration of a window of ${user} over a WebSocket`)
    await ua.drop()
    // A moment for OpenSIPS to see its side of the connection close.
    await sleep(300)
    return ua
  }
  /** For `ms`, the call has no final answer (OpenSIPS holds it), and the caller was told 180. */
  const held = async (dialled, ms = 1_500) => {
    const early = await Promise.race([dialled.ended, sleep(ms).then(() => null)])
    if (early) throw new Error(`the call ended (${early.answer} after ${early.afterMs} ms), held expected`)
    if (!dialled.provisional().includes(180)) throw new Error(`no 180 while the call is held: ${dialled.provisional()}`)
  }
  /** The final answer of `dialled`, which must come within `ms` of `since`. */
  const endsWithin = async (dialled, ms, since = Date.now()) => {
    const { answer } = await dialled.ended
    const after = Date.now() - since
    if (after > ms) throw new Error(`${answer} after ${after} ms, within ${ms} ms expected`)
    return answer
  }
  /**
   * A transaction that holds push_targets (ACCESS EXCLUSIVE): OpenSIPS's read of it waits, for less than its
   * statement_timeout (1 s), and once more after a timeout. `waited()` resolves once a read waits on it (pg_locks).
   */
  const lockPushTargets = async () => {
    const locker = new pg.Client({ connectionString: OPENSIPS_DB_URL })
    await locker.connect()
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE push_targets IN ACCESS EXCLUSIVE MODE')
    return {
      waited: () => until('a read of push_targets waiting on the lock', async () => ((await db.query("SELECT 1 FROM pg_locks WHERE relation = 'push_targets'::regclass AND NOT granted")).rows.length ? true : null), { timeout: 5_000, every: 20 }),
      release: () => locker.query('COMMIT'),
      end: async () => {
        await locker.query('ROLLBACK').catch(() => undefined)
        await locker.end()
      }
    }
  }
  const uas = []
  const closeAll = async () => {
    for (const ua of uas.splice(0)) await ua.close().catch(() => undefined)
  }
  let caller
  let admin
  try {
    await step('the windows of 141, 143 and 144 (user agents of this process) get their accounts, and their browsers can be woken: rows of push_targets that a Gateway keeps alive', async () => {
      for (const extension of [...wakeable.members, '142']) {
        const userId = `ua-${extension}`
        await store.upsertMapping({ tenantId: TENANT, userId, extension, displayName: `Fenêtre ${extension}` })
        wakeable.credentials[extension] = (await registry.forTenant(TENANT).getSession({ id: userId, tenantId: TENANT, displayName: `Fenêtre ${extension}`, extension }, { id: 'ua', type: 'browser', label: 'UA' })).credential
      }
      await db.query("INSERT INTO push_targets (extension, tenant_id, holder, alive_until) SELECT e, 'e2e-ua', 'ua-' || e, now() + interval '1 hour' FROM unnest($1::text[]) AS e", [wakeable.members])
      caller = await windowOf('142')
      admin = await asPerson(alice)
    })
    await step('two windows of 141 whose WebSockets died (laptops put to sleep): the call waits; the caller gives up after 1.5 s and is told at once (487, not at the end of the wait); a missed call for 141 in missed_calls', async () => {
      try {
        uas.push(await deadWindow('141'), await deadWindow('141'))
        const missedFrom = await lastId('missed_calls')
        const dialled = await caller.dial('141')
        await held(dialled)
        const cancelled = Date.now()
        await dialled.cancel()
        expectEqual(await endsWithin(dialled, 1_000, cancelled), '487 Request Terminated', 'the answer once the caller gave up')
        await until('the missed call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null), { timeout: 5_000 })
        expectEqual(await missedSince(missedFrom), ['142>141 487'], 'missed_calls rows of the held call given up')
      } finally {
        await closeAll()
      }
    })
    await step('the window of 141 comes back on a new connection with the same Contact (the same registration: E_UL_CONTACT_UPDATE): it rings in the call that waits, and declines it', async () => {
      try {
        const ua = await deadWindow('141')
        uas.push(ua)
        ua.answer('603 Decline')
        const dialled = await caller.dial('141')
        await held(dialled)
        const back = Date.now()
        expectEqual(await ua.reconnect(), 200, 'the registration again, on the new connection')
        expectEqual(await endsWithin(dialled, 3_000, back), '603 Decline', 'the answer of the window back')
        expectEqual(ua.invites.length, 1, 'INVITEs to the window back')
      } finally {
        await closeAll()
      }
    })
    await step('a woken window of 141 (over UDP: it keeps its Call-ID) renews its registration twice while it rings: it rings once, not once per renewal', async () => {
      try {
        const dialled = await caller.dial('141')
        await held(dialled, 500)
        const ua = await windowOf('141')
        uas.push(ua)
        ua.answer('603 Decline', 2_000)
        expectEqual(await ua.register(), 200, 'the registration of the woken window')
        await until('the woken window rung', async () => ua.invites.length === 1 || null)
        for (let i = 0; i < 2; i++) expectEqual(await ua.register(), 200, `renewal ${i + 1} while it rings`)
        expectEqual(await endsWithin(dialled, 5_000), '603 Decline', 'the answer of the woken window')
        expectEqual(ua.invites.length, 1, 'INVITEs to the woken window')
      } finally {
        await closeAll()
      }
    })
    await step('a window of 141 registers while OpenSIPS still reads whether 141 can be woken (push_targets locked until that read waits): it rings at once, not at the end of the wait, and once though it renews its registration', async () => {
      const lock = await lockPushTargets()
      try {
        const dialled = await caller.dial('141')
        // OpenSIPS found no window and waits on the table.
        await lock.waited()
        const ua = await windowOf('141')
        uas.push(ua)
        ua.answer('603 Decline', 2_000)
        expectEqual(await ua.register(), 200, 'the registration of 141 while the read waits')
        const registered = Date.now()
        await lock.release()
        await until('the window registered meanwhile rung', async () => ua.invites.length === 1 || null, { timeout: 3_000 })
        expectEqual(await ua.register(), 200, 'its renewal while it rings')
        expectEqual(await endsWithin(dialled, 5_000, registered), '603 Decline', 'the answer of the window registered meanwhile')
        expectEqual(ua.invites.length, 1, 'INVITEs to that window')
      } finally {
        await lock.end()
        await closeAll()
      }
    })
    await step('a window of 141 registers over a WebSocket while push_targets is read, and its connection dies before the call is held: the caller gives up and is told at once (487, not at the end of the wait)', async () => {
      const lock = await lockPushTargets()
      try {
        const dialled = await caller.dial('141')
        await lock.waited()
        const ua = await windowOf('141', { ws: true })
        uas.push(ua)
        expectEqual(await ua.register(), 200, 'the registration of 141 while the read waits')
        await ua.drop()
        // A moment for OpenSIPS to see its side of the connection close.
        await sleep(300)
        await lock.release()
        await held(dialled)
        const cancelled = Date.now()
        await dialled.cancel()
        expectEqual(await endsWithin(dialled, 1_000, cancelled), '487 Request Terminated', 'the answer once the caller gave up')
      } finally {
        await lock.end()
        await closeAll()
      }
    })
    await step('a call with Replaces (an attended transfer) to the window of 141 on a dead WebSocket: unreachable at once (477), nobody woken', async () => {
      try {
        uas.push(await deadWindow('141'))
        const dialled = await caller.dial('141', { extra: ['Replaces: gone@127.0.0.1;to-tag=a;from-tag=b'] })
        expectEqual(await endsWithin(dialled, 3_000), '477 Send failed', 'the answer to the INVITE with Replaces')
      } finally {
        await closeAll()
      }
    })
    await step('no Gateway listens for 141 any more (its row of push_targets no longer alive): the call to its dead window is not held, unreachable at once (477)', async () => {
      try {
        uas.push(await deadWindow('141'))
        await db.query("UPDATE push_targets SET alive_until = now() WHERE extension = '141'")
        const dialled = await caller.dial('141')
        expectEqual(await endsWithin(dialled, 3_000), '477 Send failed', 'the answer when nobody can wake 141')
      } finally {
        await db.query("UPDATE push_targets SET alive_until = now() + interval '1 hour' WHERE extension = '141'")
        await closeAll()
      }
    })
    await step('ring group 220 (143 and 144), none of whose windows is open: 143 opens two that decline, the call still waits for 144 (the first window of each member counts), whose window rings once though it renews its registration, and declines: 603', async () => {
      expectEqual((await admin('POST', '/admin/groups', { number: '220', name: 'Réveils', members: ['143', '144'] })).statusCode, 201, 'creating group 220')
      try {
        const dialled = await caller.dial('220')
        await held(dialled, 500)
        for (let i = 0; i < 2; i++) {
          const ua = await windowOf('143')
          uas.push(ua)
          ua.answer('603 Decline')
          expectEqual(await ua.register(), 200, `registration of window ${i + 1} of 143`)
        }
        await until('both windows of 143 rung', async () => uas.every(w => w.invites.length === 1))
        // Both declined (300 ms after their 180): the call waits on.
        await held(dialled, 1_500)
        const late = await windowOf('144')
        uas.push(late)
        late.answer('603 Decline', 2_000)
        expectEqual(await late.register(), 200, 'registration of the window of 144')
        await until('the window of 144 rung', async () => late.invites.length === 1 || null)
        expectEqual(await late.register(), 200, 'its renewal while it rings')
        expectEqual(await endsWithin(dialled, 5_000), '603 Decline', 'the answer of 220')
        expectEqual(uas.map(w => `${w.user} ${w.invites.length}`), ['143 1', '143 1', '144 1'], 'INVITEs per window')
      } finally {
        await closeAll()
      }
    })
    await step('ring group 220 whose only window (of 143) died: its members are woken, not 477; 143 comes back on a new connection and 144 opens a window: both ring and decline, 603', async () => {
      try {
        const dead = await deadWindow('143')
        uas.push(dead)
        dead.answer('603 Decline')
        const dialled = await caller.dial('220')
        await held(dialled)
        expectEqual(await dead.reconnect(), 200, 'the registration of 143 again, on the new connection')
        await until('the window of 143 back rung', async () => dead.invites.length === 1)
        const other = await windowOf('144')
        uas.push(other)
        other.answer('603 Decline')
        expectEqual(await other.register(), 200, 'registration of the window of 144')
        expectEqual(await endsWithin(dialled, 3_000), '603 Decline', 'the answer of 220')
        expectEqual(uas.map(w => `${w.user} ${w.invites.length}`), ['143 1', '144 1'], 'INVITEs per window')
      } finally {
        await closeAll()
      }
    })
    await step('push_targets as the first version of step 5 wrote it (no alive_until): ring group 225 (143 and 144) still rings the window of 143, nobody woken; the start of the provider adds the column back', async () => {
      expectEqual((await admin('POST', '/admin/groups', { number: '225', name: 'Ancien schéma', members: ['143', '144'] })).statusCode, 201, 'creating group 225')
      try {
        await db.query('ALTER TABLE push_targets DROP COLUMN alive_until')
        const ua = await windowOf('143')
        uas.push(ua)
        ua.answer('603 Decline')
        expectEqual(await ua.register(), 200, 'registration of the window of 143')
        const dialled = await caller.dial('225')
        expectEqual(await endsWithin(dialled, 3_000), '603 Decline', 'the answer of 225')
        expectEqual(ua.invites.length, 1, 'INVITEs to the window of 143')
      } finally {
        await closeAll()
        await admin('DELETE', '/admin/groups/225')
        await new SubscriberProvisioner({ pool: db, realm: SIP_DOMAIN }).ensureSchema()
        await db.query("UPDATE push_targets SET alive_until = now() + interval '1 hour' WHERE tenant_id = 'e2e-ua'")
      }
      expectEqual((await db.query("SELECT count(*)::int AS n FROM push_targets WHERE tenant_id = 'e2e-ua' AND alive_until > now()")).rows[0].n, 3, 'rows of 141, 143 and 144 alive again')
    })
    await step('ring group 230 of 12 members, full: 6 windows ring, 5 members are woken (the branch that waits for them takes the last place); 157 opens two windows: the second rings nobody, it would take the place of 161; 158 to 161 each ring: 603', async () => {
      const members = Array.from({ length: 12 }, (_, i) => String(151 + i))
      for (const extension of members) {
        const userId = `ua-${extension}`
        await store.upsertMapping({ tenantId: TENANT, userId, extension, displayName: `Fenêtre ${extension}` })
        wakeable.credentials[extension] = (await registry.forTenant(TENANT).getSession({ id: userId, tenantId: TENANT, displayName: `Fenêtre ${extension}`, extension }, { id: 'ua', type: 'browser', label: 'UA' })).credential
      }
      // 151 to 156 have a window; 157 to 161 a browser to wake; 162 neither.
      const woken = members.slice(6, 11)
      await db.query("INSERT INTO push_targets (extension, tenant_id, holder, alive_until) SELECT e, 'e2e-ua', 'ua-' || e, now() + interval '1 hour' FROM unnest($1::text[]) AS e", [woken])
      expectEqual((await admin('POST', '/admin/groups', { number: '230', name: 'Complet', members })).statusCode, 201, 'creating group 230')
      try {
        for (const user of members.slice(0, 6)) {
          const ua = await windowOf(user)
          uas.push(ua)
          ua.answer('603 Decline')
          expectEqual(await ua.register(), 200, `registration of the window of ${user}`)
        }
        const dialled = await caller.dial('230')
        await until('the six windows rung', async () => uas.every(w => w.invites.length === 1) || null)
        await held(dialled, 500)
        const first = await windowOf('157')
        uas.push(first)
        first.answer('603 Decline', 5_000)
        expectEqual(await first.register(), 200, 'registration of the first window of 157')
        await until('the first window of 157 rung', async () => first.invites.length === 1 || null)
        const second = await windowOf('157')
        uas.push(second)
        second.answer('603 Decline')
        expectEqual(await second.register(), 200, 'registration of the second window of 157')
        for (const user of woken.slice(1)) {
          const ua = await windowOf(user)
          uas.push(ua)
          ua.answer('603 Decline')
          expectEqual(await ua.register(), 200, `registration of the window of ${user}`)
          await until(`the window of ${user} rung`, async () => ua.invites.length === 1 || null, { timeout: 3_000 })
        }
        expectEqual(await endsWithin(dialled, 8_000), '603 Decline', 'the answer of 230')
        expectEqual(uas.map(w => `${w.user} ${w.invites.length}`), [...members.slice(0, 6).map(m => `${m} 1`), '157 1', '157 0', ...woken.slice(1).map(m => `${m} 1`)], 'INVITEs per window')
      } finally {
        await closeAll()
        await admin('DELETE', '/admin/groups/230')
        for (const extension of members) await store.deleteMapping(TENANT, `ua-${extension}`)
        // Their accounts go now: the synchronisation of the step of the names removes only so many at once (a mapping
        // emptied by mistake must not take every account), and expects those of 131 to 134 and 141 to 144.
        await db.query('DELETE FROM subscriber WHERE username = ANY($1::text[])', [members])
      }
    })
  } finally {
    await closeAll()
    await caller?.close()
    await admin?.('DELETE', '/admin/groups/220')
    await db.query("DELETE FROM push_targets WHERE tenant_id = 'e2e-ua'")
    // Nobody holds them any more: the next synchronisation removes their accounts (step of the names).
    for (const extension of [...wakeable.members, '142']) await store.deleteMapping(TENANT, `ua-${extension}`)
  }
  await step('OpenSIPS shows the name the directory gives: Bob, renamed in the directory, calls Alice as Robert Durand once Alice synchronised it from Administration (POST /admin/directory/sync); the accounts of the extensions nobody holds now go, not the one the Gateway did not write (106)', async () => {
    const bobEntry = people.find(p => p.uid === 'bdurand')
    const nameOf103 = async () => (await db.query("SELECT display_name FROM display_names WHERE extension = '103'")).rows[0]?.display_name
    bobEntry.cn = 'Robert Durand'
    try {
      await synchronise(alice)
      await until('the new name in display_names', async () => (await nameOf103()) === 'Robert Durand')
      // Nobody holds 131 to 134 and 141 to 144 any more: the accounts the Gateway wrote for them go. 106, written by
      // hand (no holder), stays: the Gateway removes only what it wrote.
      await until('the accounts of 131 to 134 and 141 to 144 to go', async () => (await db.query("SELECT 1 FROM subscriber WHERE username IN ('131', '132', '133', '134', '141', '142', '143', '144')")).rows.length === 0)
      expectEqual((await db.query("SELECT holder FROM subscriber WHERE username = '106'")).rows, [{ holder: null }], 'the account of 106')
      await dial(bob.page, '101')
      const ringing = alice.page.getByTestId('incoming-call')
      await ringing.getByText('Appel entrant de Robert Durand (103)').waitFor({ timeout: 20_000 })
      await ringing.getByRole('button', { name: 'Répondre' }).click()
      await alice.page.getByText('En communication avec Robert Durand (103)').waitFor()
      await bob.page.getByText('En communication avec Alice Martin (101)').waitFor()
      await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
      await bob.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    } finally {
      bobEntry.cn = 'Bob Durand'
      await db.query("DELETE FROM subscriber WHERE username = '106'")
      await synchronise(alice)
      await until('the name back in display_names', async () => (await nameOf103()) === 'Bob Durand')
    }
  })
  await step('Paul Leroy (105) signs in, then out: his account stays; signed in again, he leaves the directory: the synchronisation removes his mapping, his account and his registration at once (a call to 105 finds nobody, 404); 105 becomes a group of its own and the desk rings it', async () => {
    let paul = await open('pleroy', 'Paul Leroy')
    await phoneState(paul.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    await signOut(paul)
    // Signing out unregisters; the account is his (written for him) as long as he holds 105.
    expectEqual((await db.query("SELECT holder FROM subscriber WHERE username = '105'")).rows, [{ holder: 'pleroy' }], 'the account of 105 after Paul signed out')
    paul = await open('pleroy', 'Paul Leroy')
    await phoneState(paul.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    try {
      people.splice(people.findIndex(p => p.uid === 'pleroy'), 1)
      const report = await synchronise(alice)
      expectEqual(report.removed, 1, 'mappings the synchronisation removed')
      await until('the account of 105 to go', async () => (await db.query("SELECT 1 FROM subscriber WHERE username = '105'")).rows.length === 0)
      // His window is still open and registered a moment ago: OpenSIPS forgot it with the account (MI ul_rm).
      const ended = await dialUntilEnded(desk.page, '105')
      expectEqual(`${ended.endStatus} ${ended.endReason}`, '404 unavailable', 'how the call to 105 ended')
      expectEqual(await paul.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Paul side')
    } finally {
      await paul.context.close()
    }
    await openAdmin(alice.page, "Groupes d'appel")
    await alice.page.getByLabel('Numéro du groupe').fill('105')
    await alice.page.getByLabel('Nom affiché').fill('Support')
    await alice.page.getByLabel('Postes membres').fill('101')
    await alice.page.getByRole('button', { name: 'Enregistrer le groupe' }).click()
    await alice.page.getByRole('status').filter({ hasText: 'Groupe 105 enregistré.' }).waitFor()
    // OpenSIPS takes 105 for the group (no account has it any more): Alice rings.
    await dial(desk.page, '105')
    await alice.page.getByTestId('incoming-call').getByText('Appel entrant de Accueil (104)').waitFor({ timeout: 20_000 })
    await desk.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice.page.getByText('Appel de Accueil (104) pris sur un autre poste ou abandonné.').waitFor()
  })
  await step('Alice deletes ring groups 105 and 200 in Administration, each once she confirmed: a call to 200 is a number nobody has again', async () => {
    await openAdmin(alice.page, "Groupes d'appel")
    // Not without a confirmation: "Non, garder" keeps the group.
    await alice.page.getByRole('button', { name: 'Supprimer le groupe 200' }).click()
    await alice.page.getByRole('group', { name: 'Supprimer le groupe 200 ?' }).getByRole('button', { name: 'Non, garder' }).click()
    expectEqual((await db.query("SELECT 1 FROM call_groups WHERE number = '200'")).rows.length, 1, 'call_groups rows of 200 once kept')
    for (const number of ['105', '200']) {
      await alice.page.getByRole('button', { name: `Supprimer le groupe ${number}` }).click()
      await alice.page.getByRole('group', { name: `Supprimer le groupe ${number} ?` }).getByRole('button', { name: 'Oui, supprimer' }).click()
      await alice.page.getByRole('status').filter({ hasText: `Groupe ${number} supprimé.` }).waitFor()
    }
    expectEqual((await db.query("SELECT 1 FROM call_groups WHERE number IN ('105', '200')")).rows.length, 0, 'call_groups rows of 105 and 200')
    const ended = await dialUntilEnded(desk.page, '200')
    expectEqual(`${ended.endStatus} ${ended.endReason}`, '404 unavailable', 'how the call to 200 ended')
    await signOut(desk)
  })
  // Step 5: Jean is told of his calls by his browser while no window of TwakePhone is open (Web Push).
  /** A browser with no page of the app: another page keeps it open (a browser closed altogether gets nothing). */
  const leaveApp = async who => {
    who.blank ??= await who.context.newPage()
    // Closed, the page tries to unregister (pagehide, best effort): what it sends then is held at the relay until the
    // page is gone, as when a laptop is put to sleep. What it leaves is always a registration on a closed WebSocket:
    // OpenSIPS cannot reach it, and holds a call to it for the browser to wake (or answers 477 once nobody can).
    const release = relay.hold()
    try {
      await who.page.close({ runBeforeUnload: true })
      // A moment for the relay to close the SIP server's side of that connection.
      await sleep(1_000)
    } finally {
      release()
    }
  }
  /** The service worker of the app in `who`'s browser (Chromium and Edge: Playwright has no handle on Firefox's). */
  const workerOf = who => who.context.serviceWorkers().find(w => w.url() === `${appOrigin}/sw.js`)
  /**
   * The notifications the service worker of `who`'s browser shows, once it showed `shown` of them since it was watched
   * (deliverPush) and none is being shown. Never listed while one is: Chromium and Edge then forget the one being
   * shown (getNotifications drops what is not on screen yet), which is what made this step fail on Edge.
   */
  const notificationsOf = async (who, shown = 1) =>
    until(`${shown} notification(s) shown`, async () => {
      const listed = await workerOf(who)?.evaluate(async shown => {
        const e2e = self.__e2e
        if (!e2e || e2e.pending || e2e.shown < shown) return null
        return (await self.registration.getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url, requireInteraction: n.requireInteraction, silent: n.silent }))
      }, shown)
      return listed ?? null
    }).catch(async err => {
      throw new Error(`${err.message}; worker: ${await workerOf(who)?.evaluate(() => JSON.stringify(self.__e2e ?? null)).catch(e => e.message)}`)
    })
  /**
   * Hands `text` (a decrypted push) to the service worker of `who`'s browser, as its push service would (DevTools).
   * The worker is watched first: what it shows, and whether a notification is being shown (notificationsOf); counted
   * from this push on, or from the one before it too (`fresh` false).
   */
  const deliverPush = async (who, text, { fresh = true } = {}) => {
    const cdp = await who.context.newCDPSession(who.blank)
    const ids = new Map()
    cdp.on('ServiceWorker.workerRegistrationUpdated', e => {
      for (const r of e.registrations) ids.set(r.scopeURL, r.registrationId)
    })
    await cdp.send('ServiceWorker.enable')
    const registrationId = await until('the service worker of the app', async () => ids.get(`${appOrigin}/`))
    await workerOf(who).evaluate(fresh => {
      if (self.__e2e) {
        if (fresh) self.__e2e.shown = 0
        return
      }
      const e2e = (self.__e2e = { pending: 0, shown: 0, log: [] })
      const show = self.registration.showNotification.bind(self.registration)
      self.registration.showNotification = (title, options) => {
        e2e.pending++
        e2e.log.push(`show ${title}`)
        return show(title, options).finally(() => (e2e.pending--, e2e.shown++))
      }
    }, fresh)
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: appOrigin, registrationId, data: text })
    await cdp.detach().catch(() => undefined)
  }
  /**
   * Clicks the notification `tag` of `who`'s browser through its service worker: the browser's own notification, given
   * to the worker's notificationclick listeners as a click would. No user activation comes with it, so what the
   * worker opens (clients.openWindow) is noted, not opened: the caller opens it. Returns that, whether the
   * notification is gone, and what the windows of the app were told.
   */
  const clickNotification = async (who, tag) =>
    workerOf(who).evaluate(async tag => {
      const [notification] = await self.registration.getNotifications({ tag })
      if (!notification) throw new Error(`no notification ${tag}`)
      const opened = []
      const openWindow = self.clients.openWindow
      self.clients.openWindow = async url => (opened.push(url), null)
      try {
        const event = new NotificationEvent('notificationclick', { notification })
        const waits = []
        Object.defineProperty(event, 'waitUntil', { value: p => void waits.push(p) })
        self.dispatchEvent(event)
        await Promise.all(waits)
      } finally {
        self.clients.openWindow = openWindow
      }
      return { opened, left: (await self.registration.getNotifications({ tag })).length }
    }, tag)
  /** A new page of the app in `who`'s browser, at `path`. */
  const appPage = async (who, path) => {
    const page = await who.context.newPage()
    await page.route(/fonts\.g(static|oogleapis)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
    page.on('pageerror', err => console.log(`[${who.name}] page error:`, err.message))
    await page.goto(`${appOrigin}${path}`)
    return page
  }
  /** Opens the app at `path` in `who`'s browser, as a click on the notification does: it signs in by itself. */
  const openFromNotification = async (who, login, path) => signedInFromNotification(who, login, await appPage(who, path))
  /** `page` goes to the identity provider by itself (a notification was clicked): `who` signs in there, back on it. */
  const signedInFromNotification = async (who, login, page) => {
    // The identity provider may ask again (its sessions last ten minutes here), and asks for consent.
    await until(`${who.name} signed in from the notification`, async () => {
      try {
        if (page.url() === `${appOrigin}/` && (await page.getByTestId('who').getByText(who.name).isVisible())) return true
        if (await page.locator('input[name=login]').isVisible()) {
          await page.locator('input[name=login]').fill(login)
          await page.locator('input[name=password]').fill('whatever')
          await page.getByRole('button', { name: 'Sign-in' }).click()
        } else if (await page.getByRole('button', { name: 'Continue' }).isVisible()) {
          await page.getByRole('button', { name: 'Continue' }).click()
        }
      } catch {
        // The page navigated meanwhile: looked at again.
      }
      return false
    }, { timeout: 20_000, every: 200 })
    who.page = page
    return page
  }
  const PUSH_TO_WORKER = BROWSER !== 'firefox'
  let jeanBrowser
  let jeanApi
  /** The next push of `kind` for Jean's browser, once it came. */
  const pushFor = async (kind = 'call') => {
    const message = await pushService.next(jeanBrowser.id, m => m.error || m.data?.type === kind, 10_000)
    if (message.error) throw new Error(`the push service refused the push: ${message.error}`)
    return message
  }
  await step('Jean turns on call notifications in Réglages: only then does the browser ask him, the Gateway keeps his browser and OpenSIPS knows 102 can be woken', async () => {
    jeanBrowser = pushService.subscribe()
    // Playwright's browsers have no push service: the subscription is the test service's, the rest is the browser's.
    await jean.context.grantPermissions(['notifications'], { origin: appOrigin })
    await jean.context.addInitScript(sub => {
      if (!('PushManager' in window)) return
      const KEY = 'twakephone.e2e.push'
      const of = key => ({
        endpoint: sub.endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key), c => c.charCodeAt(0)).buffer },
        toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
        unsubscribe: async () => (localStorage.removeItem(KEY), true)
      })
      PushManager.prototype.subscribe = async function (o) {
        const key = btoa(String.fromCharCode(...new Uint8Array(o.applicationServerKey)))
        localStorage.setItem(KEY, key)
        return of(key)
      }
      PushManager.prototype.getSubscription = async function () {
        const key = localStorage.getItem(KEY)
        return key ? of(key) : null
      }
    }, jeanBrowser)
    await jean.page.reload()
    await phoneState(jean.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    await setForwarding(jean, {})
    await jean.page.getByRole('heading', { level: 2, name: "Notifications d'appel" }).waitFor()
    await jean.page.getByText('Désactivées sur ce navigateur.', { exact: true }).waitFor()
    await jean.page.getByRole('button', { name: 'Activer les notifications' }).click()
    await jean.page.getByText('Activées sur ce navigateur.', { exact: true }).waitFor()
    expectEqual((await store.listPushSubscriptions(TENANT, 'jdupont')).map(s => s.endpoint), [jeanBrowser.endpoint], "Jean's subscriptions at the Gateway")
    await until('102 in push_targets', async () => (await db.query("SELECT holder FROM push_targets WHERE extension = '102'")).rows[0]?.holder === 'jdupont')
    // Alive as long as the Gateway hears OpenSIPS (its subscription to the events, renewed every minute, lives 2).
    expectEqual((await db.query("SELECT alive_until > now() + interval '30 seconds' AS alive FROM push_targets WHERE extension = '102'")).rows[0]?.alive, true, 'the row of 102 kept alive by the Gateway')
    if (PUSH_TO_WORKER) await until('the service worker of the app', async () => jean.context.serviceWorkers().some(w => w.url() === `${appOrigin}/sw.js`))
    // For what the screens cannot do once Jean has no window: his forwards (his access token, as his app kept it).
    jeanApi = await asPerson(jean)
  })
  let woken
  await step('Jean closes TwakePhone, his browser stays open; Alice calls 102: she hears it ringing, and in less than 3 s the push service has a message for Jean\'s browser, encrypted for it (aes128gcm) and signed by the Gateway (VAPID), with Alice\'s directory name', async () => {
    await leaveApp(jean)
    const dialled = Date.now()
    await dial(alice.page, '102')
    woken = await pushFor('call')
    const after = woken.receivedAt - dialled
    if (after > 3_000) throw new Error(`the push came ${after} ms after the call, under 3 s expected (FR-B10)`)
    expectEqual(woken.vapid.publicKey, await push.publicKey(), 'the VAPID key of the push')
    expectEqual(`${woken.headers.urgency} ${woken.headers['content-encoding']}`, 'high aes128gcm', 'urgency and encoding of the push')
    expectEqual(`${woken.data.number} ${woken.data.name}`, '101 Alice Martin', 'who the push says is calling')
    await alice.page.getByText('Appel de 102…').waitFor()
  })
  await step(`the notification ${PUSH_TO_WORKER ? 'the service worker shows says Alice calls (one, kept until Jean acts); clicked (notificationclick in the worker), it goes and opens' : 'opens'} TwakePhone on the call: Jean signs in by himself, his softphone registers and rings in the same call, he answers and they hear each other`, async () => {
    let path = `/?call=${encodeURIComponent(woken.data.callId)}`
    if (PUSH_TO_WORKER) {
      await deliverPush(jean, woken.text)
      const [shown, ...more] = await notificationsOf(jean)
      expectEqual(more, [], 'other notifications')
      expectEqual(`${shown.title} | ${shown.body} | ${shown.tag} | ${shown.requireInteraction}`, `Appel de Alice Martin (101) | Cliquez pour répondre dans TwakePhone. | call-${woken.data.callId} | true`, 'the notification')
      // Clicked: no window of the app is open, the worker opens one on the call, and the notification goes.
      const click = await clickNotification(jean, shown.tag)
      expectEqual(click, { opened: [`${appOrigin}/?call=${encodeURIComponent(woken.data.callId)}`], left: 0 }, 'what the click on the notification did')
      path = new URL(click.opened[0]).pathname + new URL(click.opened[0]).search
    }
    const page = await openFromNotification(jean, 'jdupont', path)
    await phoneState(page).getByText('En ligne').waitFor({ timeout: 20_000 })
    await page.getByTestId('incoming-call').getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    await page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await page.getByText('En communication avec Alice Martin (101)').waitFor()
    await alice.page.getByText('En communication avec Jean Dupont (102)').waitFor()
    await bothHearEachOther(alice, jean)
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    // Nothing of the notification is left in the address.
    expectEqual(page.url(), `${appOrigin}/`, 'the address of the app opened from the notification')
  })
  // Chromium and Edge only: Firefox's service worker gets no push here, and Playwright has no handle on it.
  if (PUSH_TO_WORKER) {
    await step('a window of TwakePhone that rings the call itself (on screen, signed in, registered): the worker shows no notification for it, the page rings', async () => {
      // A push of a call while that window is there (its WebSocket was dead a moment): it asks the window first. Then
      // a missed call, which shows whatever the windows say: pushes are handled one after the other, so once it shows
      // the call's push is done with.
      const here = `e2e-here-${randomBytes(4).toString('hex')}`
      await deliverPush(jean, JSON.stringify({ type: 'call', callId: here, number: '101', name: 'Alice Martin', until: Date.now() + 30_000 }))
      await deliverPush(jean, JSON.stringify({ type: 'missed', callId: `${here}-missed`, number: '101', name: 'Alice Martin' }), { fresh: false })
      const listed = await notificationsOf(jean, 1)
      expectEqual(listed.map(n => `${n.title} | ${n.tag}`), [`Appel manqué de Alice Martin (101) | call-${here}-missed`], 'the notifications shown')
      await workerOf(jean).evaluate(async () => {
        for (const n of await self.registration.getNotifications()) n.close()
      })
    })
    await step('Jean leaves a window of TwakePhone signed out, on screen (a new tab); Alice calls: that window cannot ring, the notification shows; clicked, the worker tells that window (no other opens), which signs Jean in on the call: it rings there, he declines', async () => {
      await leaveApp(jean)
      const waiting = await appPage(jean, '/')
      await waiting.getByRole('button', { name: 'Se connecter' }).waitFor()
      await dial(alice.page, '102')
      const { text, data } = await pushFor('call')
      await deliverPush(jean, text)
      const [shown, ...more] = await notificationsOf(jean)
      expectEqual(more, [], 'other notifications')
      expectEqual(`${shown.tag} ${shown.requireInteraction}`, `call-${data.callId} true`, 'the notification of the call')
      expectEqual(await clickNotification(jean, shown.tag), { opened: [], left: 0 }, 'what the click on the notification did')
      const page = await signedInFromNotification(jean, 'jdupont', waiting)
      jean.page = page
      expectEqual(jean.context.pages().filter(p => p.url().startsWith(appOrigin) && p !== jean.blank).length, 1, 'windows of the app in Jean\'s browser')
      await phoneState(page).getByText('En ligne').waitFor({ timeout: 20_000 })
      await page.getByTestId('incoming-call').getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
      await page.getByTestId('incoming-call').getByRole('button', { name: 'Refuser' }).click()
      await alice.page.getByText("102 a refusé l'appel.").waitFor()
    })
  }
  await step(`nobody opens the notification, Jean forwards on no answer after 5 s: Bob rings after those 5 s, not later; a missed call for Jean, whose notification ${PUSH_TO_WORKER ? 'replaces that of the call (the same one, it no longer waits for him)' : 'says so'}`, async () => {
    await setForwarding(jean, { noAnswer: '103', delay: '5' })
    await leaveApp(jean)
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    const dialled = Date.now()
    await dial(alice.page, '102')
    const pushed = await pushFor('call')
    const { data } = pushed
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    const after = Date.now() - dialled
    if (after > 12_000) throw new Error(`Bob rang ${after} ms after the call, about 5 s expected`)
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await alice.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await bob.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
    const missed = await pushFor('missed')
    expectEqual(`${missed.data.callId} ${missed.data.name}`, `${data.callId} Alice Martin`, 'the push of the missed call')
    if (PUSH_TO_WORKER) {
      await deliverPush(jean, pushed.text)
      await deliverPush(jean, missed.text, { fresh: false })
      const listed = await notificationsOf(jean, 2)
      expectEqual(listed.map(n => `${n.title} | ${n.body} | ${n.tag} | ${n.requireInteraction}`), [`Appel manqué de Alice Martin (101) | TwakePhone | call-${data.callId} | false`], 'the notifications once the call was missed')
    }
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.state}`, 'inbound 101 missed', "Jean's newest call")
    expectEqual(await missedSince(missedFrom), [], 'missed_calls rows of the forwarded call')
    expectEqual((await jeanApi('PUT', '/me/forwarding', {})).statusCode, 200, 'PUT /me/forwarding (none)')
  })
  await step('nobody opens it and Jean has no forward: after the wait Alice is told 102 did not answer, a missed call for Jean (408 in missed_calls), whose notification says so', async () => {
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    const before = await lastEnded(alice.page)
    await dial(alice.page, '102')
    await pushFor('call')
    const ended = await until('the end of the call nobody took', async () => {
      const e = await lastEnded(alice.page)
      return e && e.id !== before?.id ? e : null
    }, { timeout: 60_000 })
    expectEqual(`${ended.endStatus} ${ended.endReason}`, '408 no-answer', 'how the call to Jean ended')
    await alice.page.getByText("102 n'a pas répondu.").waitFor()
    await pushFor('missed')
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.state}`, 'inbound 101 missed', "Jean's newest call")
    await until('the missed call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['101>102 408'], 'missed_calls rows of the call nobody woke for')
  })
  await step('the push service says Jean\'s browser dropped its subscription (410): the Gateway forgets it; Alice gives up while the call waits, it ends at once; OpenSIPS no longer holds his calls, a call to 102 is unreachable at once', async () => {
    pushService.gone(jeanBrowser.id)
    const missedFrom = await lastId('missed_calls')
    await dial(alice.page, '102')
    await until('the subscription removed', async () => (await store.listPushSubscriptions(TENANT, 'jdupont')).length === 0)
    await until('102 out of push_targets', async () => (await db.query("SELECT 1 FROM push_targets WHERE extension = '102'")).rows.length === 0)
    // Alice gives up while the call waits: it ends at once (487), not at the end of the wait, a missed call for Jean.
    // The windows Jean closed are registered on dead connections (leaveApp): the path of route[past_dead_branches].
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await until('the call given up in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null), { timeout: 5_000 })
    expectEqual(await missedSince(missedFrom), ['101>102 487'], 'missed_calls rows of the call given up while it waited')
    const dialled = Date.now()
    const ended = await dialUntilEnded(alice.page, '102')
    // 477: the registrations his closed windows left (leaveApp) cannot be reached, and nobody can be woken.
    expectEqual(`${ended.endStatus} ${ended.endReason}`, '477 unavailable', 'how the call to 102 ended once nobody can be woken')
    if (Date.now() - dialled > 5_000) throw new Error('the call to 102 waited: nobody can be woken any more')
  })
  await step('Jean opens TwakePhone again for what follows', async () => {
    await jean.context.close()
    jean = await open('jdupont', 'Jean Dupont')
    await phoneState(jean.page).getByText('En ligne').waitFor({ timeout: 20_000 })
  })
  // Step 6a (ADR 0016): the trunk to an operator of two servers, simulated by this process (sip-trunk.mjs, as any SIP
  // trunk does: registration and calls challenged, OPTIONS answered, G.711 A-law, re-INVITEs, REFER). Fictional
  // numbers only (ARCEP reserves 01 99 00 xx xx and 06 39 98 xx xx for fiction; Ofcom 020 7946 0xxx).
  await step('before any trunk, 112 is refused: no operator is connected, Alice is told to call 112 from another phone (403, emergency)', async () => {
    const ended = await dialUntilEnded(alice.page, '112')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal}`, '403 refused emergency', 'how the call to 112 ended without a trunk')
    await alice.page.getByText("L'appel vers 112 n'a pas pu passer par Twake Phone : appelez 112 depuis un autre téléphone").waitFor()
  })
  const trunkBody = {
    name: 'Opérateur (simulé)',
    auth: 'register',
    domain: 'operator.example',
    proxies: [operator.address, operator2.address],
    username: TRUNK_LOGIN,
    password: TRUNK_PASSWORD,
    codecs: ['PCMA', 'PCMU'],
    numberFormat: 'e164',
    defaultNumber: '+33199000100'
  }
  await step('Alice, an administrator, sets the trunk to the operator (two servers) and its direct numbers in Administration (step 7, no console): OpenSIPS registers to the first one (challenged, 401) at the address it announces, and probes both (OPTIONS); the screen shows it registered; the password is never shown again', async () => {
    const api = await asPerson(alice)
    const page = alice.page
    await openAdmin(page, 'Trunks')
    await page.getByRole('textbox', { name: 'Identifiant', exact: true }).fill('operator')
    await page.getByLabel('Nom affiché').fill(trunkBody.name)
    await page.getByLabel("Domaine SIP de l'opérateur").fill(trunkBody.domain)
    await page.getByLabel("Serveurs de l'opérateur").fill(trunkBody.proxies.join(', '))
    await page.getByLabel("Identifiant chez l'opérateur").fill(TRUNK_LOGIN)
    await page.getByLabel('Mot de passe', { exact: true }).fill(TRUNK_PASSWORD)
    await page.getByLabel('Numéro présenté par défaut').fill('01 99 00 01 00')
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/admin/trunks/operator'))
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    const trunk = await saved
    expectEqual(trunk.status(), 201, 'PUT /admin/trunks/operator')
    expectEqual((await trunk.json()).hasPassword, true, 'hasPassword')
    await page.getByRole('status').filter({ hasText: 'Trunk operator enregistré.' }).waitFor()
    // What the screen sent: the trunk as an administrator would write it to the API, the number in E.164.
    const sorted = o => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))))
    expectEqual(sorted(JSON.parse(trunk.request().postData())), sorted({ ...trunkBody, allowed: ['fixed', 'mobile', 'freephone', 'standard-rate'] }), 'trunk sent by the screen')
    // The staff's direct numbers: +33 1 99 00 01 0x rings extension 10x. A range whose last digits make an emergency
    // number (+33 1 99 00 01 12 would ring 112) is refused before it is sent, naming them; the Gateway refuses it too.
    await openAdmin(page, 'Numéros directs')
    await page.getByText("Aucun numéro direct pour l'instant.").waitFor()
    await page.getByRole('textbox', { name: 'Identifiant', exact: true }).fill('staff')
    await page.getByLabel('Numéro (ou premier de la plage)').fill('+33 1 99 00 01 00')
    await page.getByLabel('Dernier numéro de la plage').fill('+33 1 99 00 01 99')
    await page.getByLabel('Le poste qui finit par les derniers chiffres du numéro appelé').check()
    await page.getByRole('button', { name: 'Enregistrer les numéros directs' }).click()
    await page.locator('#did-suffixDigits-error').filter({ hasText: '112' }).waitFor()
    const reserved = await api('PUT', '/admin/dids/staff', { trunkId: 'operator', first: '+33199000100', last: '+33199000199', suffixDigits: 3 })
    expectEqual(`${reserved.statusCode} ${reserved.json().code}`, '400 DID_RESERVED', 'PUT /admin/dids/staff over 112')
    await page.getByLabel('Dernier numéro de la plage').fill('+33 1 99 00 01 09')
    const didSaved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/admin/dids/staff'))
    await page.getByRole('button', { name: 'Enregistrer les numéros directs' }).click()
    expectEqual((await didSaved).status(), 201, 'PUT /admin/dids/staff')
    await page.getByRole('list', { name: 'Numéros directs existants' }).getByText('+33199000100 à +33199000109').waitFor()
    const listed = await api('GET', '/admin/trunks')
    if (listed.body.includes(TRUNK_PASSWORD)) throw new Error('GET /admin/trunks shows the password')
    // Bob is no administrator: the Gateway refuses him the trunks, their state and the direct numbers.
    const asBob = await asPerson(bob)
    for (const [method, url] of [['GET', '/admin/trunks'], ['GET', '/admin/trunks/status'], ['GET', '/admin/dids'], ['GET', '/admin/users'], ['DELETE', '/admin/dids/staff']])
      expectEqual((await asBob(method, url)).statusCode, 403, `${method} ${url} as Bob`)
    const [registration] = await operator.registered(1, 30_000)
    if (!registration.aor.includes(`sip:${TRUNK_LOGIN}@operator.example`)) throw new Error(`registered as ${registration.aor}`)
    // TRUNK_ADVERTISE: the operator is told the address OpenSIPS announces, in the binding and the Via.
    if (TRUNK_ADVERTISE && !(registration.contact.includes(TRUNK_ADVERTISE) && registration.via.includes(TRUNK_ADVERTISE))) throw new Error(`registered from ${registration.via}, binding ${registration.contact}`)
    await Promise.all([operator.probed(1, 40_000), operator2.probed(1, 40_000)])
    expectEqual(operator2.state.registrations.length, 0, 'registrations at the second server')
    // The screen says so, as OpenSIPS does (reg_list, ds_list): registered, both servers reachable.
    await openAdmin(page, 'Trunks')
    const trunks = page.getByRole('list', { name: 'Trunks existants' })
    await trunks.getByText('Enregistré', { exact: true }).waitFor({ timeout: 30_000 })
    for (const address of trunkBody.proxies) await trunks.getByText(`Serveur ${address} : Joignable`).waitFor({ timeout: 30_000 })
    await trunks.getByText('enregistré (jamais affiché)').waitFor()
    if ((await page.content()).includes(TRUNK_PASSWORD)) throw new Error('the trunk screen shows the password')
  })
  await step('Alice dials 06 39 98 00 01, a number of Mayotte (0639): overseas numbers are not allowed on the trunk by default, refused before the operator (403, overseas)', async () => {
    const attempts = operator.state.attempts.length + operator2.state.attempts.length
    const ended = await dialUntilEnded(alice.page, '06 39 98 00 01')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal}`, '403 refused overseas', 'how the call to 06 39 98 00 01 ended')
    await alice.page.getByText("Les appels vers l'outre-mer ne sont pas autorisés").waitFor()
    expectEqual(operator.state.attempts.length + operator2.state.attempts.length, attempts, 'calls the operator was sent')
  })
  let mobileCall, mobileAcc, mobileAt
  await step('Alice allows the overseas numbers on the trunk and dials 06 39 98 00 01 again: the first server (priority) is sent +33639980001 at its domain (Request-URI and To) from her direct number +33 1 99 00 01 01 (challenged, 407), nothing names OpenSIPS; plain G.711; both sides hear each other; her keypad tones reach the operator as RFC 4733 events', async () => {
    // Changed on its screen, without typing the password again: the one kept still answers the operator's challenges.
    await openAdmin(alice.page, 'Trunks')
    await alice.page.getByRole('button', { name: 'Modifier le trunk operator' }).click()
    await alice.page.getByRole('group', { name: 'Appels permis' }).getByLabel('Outre-mer').check()
    const saved = alice.page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/admin/trunks/operator'))
    await alice.page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    const allowed = await saved
    expectEqual(allowed.status(), 200, 'PUT /admin/trunks/operator (allowed)')
    expectEqual(JSON.parse(allowed.request().postData()).password, undefined, 'no password sent when it is kept')
    expectEqual(JSON.stringify((await allowed.json()).allowed), JSON.stringify(['fixed', 'mobile', 'freephone', 'standard-rate', 'overseas']), 'allowed classes')
    await alice.page.getByRole('status').filter({ hasText: 'Trunk operator enregistré.' }).waitFor()
    const before = operator.state.challenged
    const second = operator2.state.attempts.length
    mobileAcc = await lastId('acc')
    mobileAt = new Date().toISOString()
    await dial(alice.page, '06 39 98 00 01')
    const call = (mobileCall = await operator.invited(invite => invite.uri === 'sip:+33639980001@operator.example'))
    const header = name => call.invite.headers.get(name)?.[0] ?? ''
    if (!header('from').includes('<sip:+33199000101@operator.example>')) throw new Error(`From sent to the operator: ${header('from')}`)
    if (!header('to').startsWith('<sip:+33639980001@operator.example>')) throw new Error(`To sent to the operator: ${header('to')}`)
    if (/opensips/i.test(call.invite.raw)) throw new Error(`OpenSIPS named to the operator: ${call.invite.raw.split('\r\n\r\n')[0]}`)
    if (TRUNK_ADVERTISE && !(header('via').includes(TRUNK_ADVERTISE) && (call.invite.headers.get('record-route') ?? []).join(',').includes(TRUNK_ADVERTISE))) throw new Error(`Via ${header('via')}, Record-Route ${call.invite.headers.get('record-route')}`)
    if (operator.state.challenged <= before) throw new Error('the call was not challenged by the operator')
    expectEqual(operator2.state.attempts.length, second, 'calls the second server was sent')
    // Plain RTP to the operator, A-law (or μ-law) only: rtpengine bridges the browser's DTLS-SRTP.
    const offer = call.invite.body
    const m = /^m=audio \d+ (\S+) ([\d ]+)/m.exec(offer)
    const rtpmap = Object.fromEntries([...offer.matchAll(/^a=rtpmap:(\d+) ([^/\s]+)/gm)].map(x => [x[1], x[2]]))
    const codecs = (m?.[2].trim().split(' ') ?? []).map(pt => rtpmap[pt] ?? { 0: 'PCMU', 8: 'PCMA' }[pt] ?? pt)
    if (!plainRtp(offer) || !codecs.every(c => ['PCMA', 'PCMU', 'telephone-event'].includes(c)) || !codecs.includes('PCMA')) throw new Error(`offer sent to the operator: ${offer}`)
    await alice.page.getByText('En communication avec +33 6 39 98 00 01').waitFor()
    // The browser sends and receives RTP; the operator receives sound (the simulated microphone's tone) and sends its own.
    const before2 = (await stats(alice.page))[0]
    await until('RTP both ways for Alice and sound at the operator', async () => {
      const s = (await stats(alice.page))[0]
      return s && s.packetsReceived > before2.packetsReceived + 20 && s.packetsSent > before2.packetsSent + 20 && call.media.stats.voiced > 20 ? s : null
    })
    await alice.page.getByRole('button', { name: 'Clavier' }).click()
    await alice.page.getByRole('button', { name: 'Envoyer la touche 1' }).click()
    await until('DTMF events at the operator', () => (call.media.stats.events > 0 ? true : null))
  })
  await step('Alice puts the call on hold and resumes it: the operator gets both re-INVITEs in plain RTP through rtpengine; then the operator refreshes the session with a re-INVITE without SDP: the offer of Alice\'s browser reaches it as plain RTP, its answer goes back in the ACK, and both still hear each other', async () => {
    const call = mobileCall
    const reinvites = call.reinvites.length
    await alice.page.getByRole('button', { name: 'Mettre en attente' }).click()
    await alice.page.getByText('+33 6 39 98 00 01 en attente').waitFor()
    await alice.page.getByRole('button', { name: 'Reprendre' }).click()
    await alice.page.getByText('En communication avec +33 6 39 98 00 01').waitFor()
    await until('the hold and resume re-INVITEs at the operator', () => (call.reinvites.length >= reinvites + 2 ? true : null))
    const [hold, resume] = call.reinvites.slice(reinvites)
    if (!plainRtp(hold.body) || !/^a=(sendonly|inactive)/m.test(hold.body)) throw new Error(`hold sent to the operator: ${hold.body}`)
    if (!plainRtp(resume.body) || /^a=(sendonly|inactive)/m.test(resume.body)) throw new Error(`resume sent to the operator: ${resume.body}`)
    const answer = await operator.reinvite(call)
    expectEqual(answer.status, 200, 'answer to the re-INVITE without SDP')
    if (!plainRtp(answer.body)) throw new Error(`offer of the browser in the 200: ${answer.body}`)
    const voiced = call.media.stats.voiced
    const before = (await stats(alice.page))[0]
    await until('RTP both ways for Alice and sound at the operator after the late offer', async () => {
      const s = (await stats(alice.page))[0]
      return s && s.packetsReceived > before.packetsReceived + 20 && s.packetsSent > before.packetsSent + 20 && call.media.stats.voiced > voiced + 20 ? s : null
    })
  })
  await step('no transfer with an external party: the operator\'s REFER is refused (403), and so is Alice\'s transfer to 08 99 00 00 00, which she is told about; no REFER reaches the operator; she hangs up; the CDR and her history say +33639980001', async () => {
    const call = mobileCall
    const accFrom = mobileAcc
    const refer = await operator.request(call, 'REFER', { extra: ['Refer-To: <sip:+33899000000@operator.example>', 'Referred-By: <sip:+33639980001@operator.example>'] })
    expectEqual(refer.status, 403, 'answer to the REFER of the operator')
    await transferButton(alice.page).click()
    await transferTarget(alice.page).fill('08 99 00 00 00')
    await alice.page.getByRole('button', { name: 'Transférer directement' }).click()
    await alice.page.getByRole('alert').getByText('Un appel avec un correspondant extérieur ne peut pas encore être transféré').waitFor({ timeout: 20_000 })
    await alice.page.getByRole('button', { name: 'Fermer' }).click()
    await alice.page.getByText('En communication avec +33 6 39 98 00 01').waitFor()
    if (call.requests.some(r => r.method === 'REFER') || operator.state.requests.some(r => r.method === 'REFER')) throw new Error('a REFER reached the operator')
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await operator.callState(call, 'ended')
    expectEqual(await cdrsSince(accFrom), ['101>+33639980001 200'], 'CDR of the call to the mobile')
    const entry = await newestCall('amartin', mobileAt)
    expectEqual(`${entry.direction} ${entry.remoteNumber} ${entry.answered}`, 'outbound +33639980001 true', 'Alice history entry')
  })
  await step('the operator calls the direct number +33 1 99 00 01 02 (as a registered trunk does: the Request-URI is the binding, the To the number), the caller in nine digits (639980002, as some operators write it): Jean sees +33 6 39 98 00 02 calling and answers; both hear each other; his Récents show the caller', async () => {
    const accFrom = await lastId('acc')
    const placed = await operator.call('+33199000102', { from: '639980002', ruri: TRUNK_LOGIN })
    const ringing = jean.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de +33 6 39 98 00 02').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    const answer = await placed.final
    expectEqual(answer.status, 200, 'answer to the operator')
    await jean.page.getByText('En communication avec +33 6 39 98 00 02').waitFor()
    const before = (await stats(jean.page))[0]
    await until('RTP both ways for Jean and sound at the operator', async () => {
      const s = (await stats(jean.page))[0]
      return s && s.packetsReceived > before.packetsReceived + 20 && s.packetsSent > before.packetsSent + 20 && placed.media.stats.voiced > 20 ? s : null
    })
    expectEqual((await placed.hangup()).status, 200, 'answer to the operator BYE')
    await until('the end of the call on Jean side', async () => (await calls(jean.page)).length === 0)
    expectEqual(await cdrsSince(accFrom), ['+33639980002>102 200'], 'CDR of the call from the mobile')
    // Newest first: once the history has it (Récents reads it again as the call ends).
    await until('the call from +33 6 39 98 00 02 first in the Récents of Jean', async () => ((await recents(jean.page, 1))[0].startsWith('+33 6 39 98 00 02: Entrant') ? true : null))
    await jean.page.getByRole('link', { name: 'Clavier' }).click()
  })
  await step('the operator calls Jean without SDP (a late offer) and with Privacy: id: Jean sees "Numéro masqué" and answers; the offer of his browser reaches the operator as plain RTP, the answer goes back in the ACK, both hear each other. Jean then closes TwakePhone without hanging up: his browser no longer answers the OPTIONS OpenSIPS sends in the call (CALL_PING_SEC), which ends it (BYE to the operator)', async () => {
    const placed = await operator.call('+33199000102', { from: '+33639980002', ruri: TRUNK_LOGIN, lateOffer: true, headers: ['Privacy: id'] })
    const ringing = jean.page.getByTestId('incoming-call')
    await ringing.getByText('Numéro masqué').waitFor({ timeout: 20_000 })
    if (await ringing.getByText('39 98 00 02').count()) throw new Error('the hidden number is shown')
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    const answer = await placed.final
    expectEqual(answer.status, 200, 'answer to the operator')
    if (!plainRtp(answer.body)) throw new Error(`offer of the browser in the 200: ${answer.body}`)
    await jean.page.getByText('En communication avec Numéro masqué').waitFor()
    const before = (await stats(jean.page))[0]
    await until('RTP both ways for Jean and sound at the operator (late offer)', async () => {
      const s = (await stats(jean.page))[0]
      return s && s.packetsReceived > before.packetsReceived + 20 && s.packetsSent > before.packetsSent + 20 && placed.media.stats.voiced > 20 ? s : null
    })
    await jean.context.close()
    // Within CALL_PING_SEC + CALL_PING_TIMEOUT_SEC (5 + 15 in CI), the OPTIONS of OpenSIPS retransmitted meanwhile.
    await operator.callState(placed, 'ended', 45_000)
  })
  await step('Jean opens TwakePhone again; the operator calls Bob\'s direct number and gives up while it rings (CANCEL): Bob stops ringing', async () => {
    jean = await open('jdupont', 'Jean Dupont')
    await phoneState(jean.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    const placed = await operator.call('+33199000103', { from: '+33639980002' })
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de +33 6 39 98 00 02').waitFor({ timeout: 20_000 })
    await placed.cancel()
    expectEqual((await placed.final).status, 487, 'final answer to the cancelled call')
    await ringing.waitFor({ state: 'hidden' })
  })
  await step('Alice dials 112: it reaches the operator as dialled (sip:112@operator.example), from her direct number; the operator refuses it (486): Alice is told to call 112 from another phone (503, emergency); then she dials Bob\'s direct number 01 99 00 01 03: it rings Bob inside, never through the operator', async () => {
    operator.state.next.push({ reply: '486 Busy Here' })
    const ended = await dialUntilEnded(alice.page, '112')
    const call = await operator.invited(invite => invite.uri === 'sip:112@operator.example')
    if (!(call.invite.headers.get('from')?.[0] ?? '').includes('<sip:+33199000101@operator.example>')) throw new Error(`From sent to the operator: ${call.invite.headers.get('from')}`)
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal}`, '503 refused emergency', 'how the call to 112 ended (the operator busy)')
    await alice.page.getByText("L'appel vers 112 n'a pas pu passer par Twake Phone : appelez 112 depuis un autre téléphone").waitFor()
    const attempts = operator.state.attempts.length + operator2.state.attempts.length
    await dial(alice.page, '01 99 00 01 03')
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Alice Martin (101)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await until('the end of the call on Alice side', async () => (await calls(alice.page)).length === 0)
    expectEqual(operator.state.attempts.length + operator2.state.attempts.length, attempts, 'calls the operator was sent')
  })
  await step('numbers the platform does not call are refused before the operator, with the code and the reason the app tells: +44 20 7946 0123 (403, international), 08 99 00 00 00 (403, premium), 063998 (484)', async () => {
    const attempts = operator.state.attempts.length + operator2.state.attempts.length
    for (const [number, status, refusal, text] of [
      ['+44 20 7946 0123', 403, 'international', "Les appels vers l'étranger ne sont pas autorisés : +44 20 7946 0123 n'a pas été appelé."],
      ['08 99 00 00 00', 403, 'premium', 'Les numéros surtaxés ne sont pas autorisés'],
      // Six digits go as dialled (an extension would); OpenSIPS knows a leading 0 for a public number, incomplete.
      ['063998', 484, 'invalid', "06 39 98 n'est pas un numéro complet"]
    ]) {
      const ended = await dialUntilEnded(alice.page, number)
      expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal}`, `${status} refused ${refusal}`, `how the call to ${number} ended`)
      await alice.page.getByText(text).waitFor()
    }
    expectEqual(operator.state.attempts.length + operator2.state.attempts.length, attempts, 'calls the operator was sent')
  })
  // Step 6b (ADR 0017): rights profiles and caps, as an administrator sets them (the screen comes at step 7).
  const PROFILES = [
    { id: 'internal', allowed: [] },
    { id: 'france', allowed: ['fixed', 'mobile', 'freephone', 'standard-rate', 'overseas'] }
  ]
  // This test dials numbers of Mayotte (0639), the same one twenty times or so and up to six in a minute; the overseas
  // numbers have the thresholds of international ones (review 6b, n°14): six calls in a minute, or fifteen in a row to
  // one number, are refused (fraud). Raised here for those two only: the thresholds are proven by trunk.sip.mjs.
  const FRAUD = { international: { callsPerMinute: { warning: 30, critical: 60 }, sequentialCalls: { warning: 50, critical: 100 } } }
  await step('step 6b: Alice gives Bob the rights profile "internal calls only" (PUT /admin/outbound): his call to 06 39 98 00 03 is refused before the operator (403, rights) and the app tells him why; given "France" (PUT /admin/outbound/users/bdurand), the same call reaches the operator', async () => {
    const api = await asPerson(alice)
    const put = await api('PUT', '/admin/outbound', { policy: { fraud: FRAUD }, profiles: PROFILES, assignments: [{ userId: 'bdurand', profileId: 'internal' }] })
    expectEqual(put.statusCode, 200, `PUT /admin/outbound ${put.body}`)
    const attempts = operator.state.attempts.length + operator2.state.attempts.length
    const ended = await dialUntilEnded(bob.page, '06 39 98 00 03')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal}`, '403 refused rights', 'how the call to 06 39 98 00 03 ended')
    await bob.page.getByText("Vos droits d'appel ne permettent pas d'appeler ce type de numéro").waitFor()
    expectEqual(operator.state.attempts.length + operator2.state.attempts.length, attempts, 'calls the operator was sent')
    const given = await api('PUT', '/admin/outbound/users/bdurand', { profileId: 'france' })
    expectEqual(given.statusCode, 200, `PUT /admin/outbound/users/bdurand ${given.body}`)
    operator.state.next.push({ reply: '486 Busy Here' })
    const busy = await dialUntilEnded(bob.page, '06 39 98 00 03')
    await operator.invited(invite => invite.uri === 'sip:+33639980003@operator.example')
    expectEqual(busy.endStatus, 486, 'how the call ended (the operator busy)')
  })
  await step('step 6b: an organisation cap of one external call at a time: while Alice is in a call with the operator, Bob\'s call is refused (403, limit) and he is told why; the administrators see the alert (GET /admin/alerts); his 112 still reaches the operator; once Alice hangs up, his call goes', async () => {
    const api = await asPerson(alice)
    const put = await api('PUT', '/admin/outbound', { policy: { caps: { concurrent: 1 }, fraud: FRAUD }, profiles: PROFILES, assignments: [{ userId: 'bdurand', profileId: 'france' }] })
    expectEqual(put.statusCode, 200, `PUT /admin/outbound ${put.body}`)
    await dial(alice.page, '06 39 98 00 04')
    const call = await operator.invited(invite => invite.uri === 'sip:+33639980004@operator.example')
    await alice.page.getByText('En communication avec +33 6 39 98 00 04').waitFor()
    const ended = await dialUntilEnded(bob.page, '06 39 98 00 05')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal}`, '403 refused limit', 'how the call to 06 39 98 00 05 ended')
    await bob.page.getByText("Le plafond d'appels vers l'extérieur est atteint").waitFor()
    const alert = await until('the alert for the administrators', async () => {
      const res = await api('GET', '/admin/alerts')
      return res.json().items.find(a => a.kind === 'limit' && a.number === '+33639980005') ?? null
    })
    expectEqual(`${alert.param} ${alert.scope} ${alert.extension} ${alert.userId}`, 'concurrent tenant 103 bdurand', 'the alert')
    // Review 6b, n°7: kept once while it repeats (count, lastAt), a page at a time.
    expectEqual(`${alert.count >= 1} ${typeof alert.lastAt} ${typeof alert.id}`, 'true string string', 'the alert as kept')
    const defaults = (await api('GET', '/admin/outbound')).json().defaults
    expectEqual(JSON.stringify(defaults.caps), JSON.stringify({ user: { concurrent: 2, dailyMinutes: 300 }, tenant: { concurrent: 20, dailyMinutes: 3000 } }), 'the default caps shown')
    operator.state.next.push({ reply: '486 Busy Here' })
    const sos = await dialUntilEnded(bob.page, '112')
    await operator.invited(invite => invite.uri === 'sip:112@operator.example' && (invite.headers.get('from')?.[0] ?? '').includes('<sip:+33199000103@operator.example>'))
    expectEqual(`${sos.endStatus} ${sos.endRefusal}`, '503 emergency', 'how the call to 112 ended (the operator busy)')
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await operator.callState(call, 'ended')
    operator.state.next.push({ reply: '486 Busy Here' })
    const again = await dialUntilEnded(bob.page, '06 39 98 00 05')
    await operator.invited(invite => invite.uri === 'sip:+33639980005@operator.example')
    expectEqual(again.endStatus, 486, 'how the call ended once Alice hung up (the operator busy)')
    const reset = await api('PUT', '/admin/outbound', { policy: { fraud: FRAUD } })
    expectEqual(reset.statusCode, 200, 'PUT /admin/outbound (no profile)')
  })
  await step('the first server out of order (503 at once): the call goes to the second one (challenged, 401), which answers; once the first one rang, its 503 ends the call (no second call to the person); its own Twake-Call-Refused never reaches the app; a challenge it repeats ends the call as "no trunk", never asked of the browser', async () => {
    operator.state.next.push({ reply: '503 Service Unavailable' })
    const challenged = operator2.state.challenged
    await dial(alice.page, '06 39 98 00 01')
    const call = await operator2.invited(invite => invite.uri === 'sip:+33639980001@operator.example')
    if (operator2.state.challenged <= challenged) throw new Error('the call was not challenged by the second server')
    if (!plainRtp(call.invite.body)) throw new Error(`offer sent to the second server: ${call.invite.body}`)
    if (!(call.invite.headers.get('to')?.[0] ?? '').startsWith('<sip:+33639980001@operator.example>')) throw new Error(`To sent to the second server: ${call.invite.headers.get('to')}`)
    await alice.page.getByText('En communication avec +33 6 39 98 00 01').waitFor()
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await operator2.callState(call, 'ended')

    operator.state.next.push({ ringThen: '503 Service Unavailable', afterMs: 500 })
    const second = operator2.state.attempts.length
    let ended = await dialUntilEnded(alice.page, '06 39 98 00 01')
    // A proxy relays no 503 (RFC 3261 16.7): 500.
    expectEqual(ended.endStatus, 500, 'how the call ended once the first server rang')
    expectEqual(operator2.state.attempts.length, second, 'calls the second server was sent')

    operator.state.next.push({ reply: '403 Forbidden', headers: ['Twake-Call-Refused: emergency'] })
    ended = await dialUntilEnded(alice.page, '06 39 98 00 01')
    // A plain refusal: the operator cannot have the app say "call 112 from another phone".
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal ?? '-'}`, '403 rejected -', 'how the call refused by the operator ended')

    operator.state.next.push({ rejectAuth: true })
    ended = await dialUntilEnded(alice.page, '06 39 98 00 01')
    expectEqual(`${ended.endStatus} ${ended.endReason} ${ended.endRefusal}`, '503 refused no-trunk', 'how the call ended when the operator challenges again')
    await alice.page.getByText("Les appels vers l'extérieur ne sont pas disponibles pour le moment").waitFor()
  })
  await step('the first server answers nothing any more: OpenSIPS marks it down (OPTIONS) and the next call goes straight to the second one', async () => {
    operator.state.dead = true
    try {
      await until('the first server marked down', async () => {
        const destinations = (await mi('ds_list')).result.PARTITIONS.flatMap(p => p.SETS.flatMap(s => s.Destinations))
        return destinations.some(d => d.URI === `sip:${operator.address}` && d.state !== 'Active') ? true : null
      }, { timeout: 90_000, every: 2_000 })
      const attempts = operator.state.attempts.length
      operator2.state.next.push({ reply: '486 Busy Here' })
      const started = Date.now()
      const ended = await dialUntilEnded(alice.page, '06 39 98 00 01')
      expectEqual(ended.endStatus, 486, 'how the call ended (the second server busy)')
      if (Date.now() - started > 4_000) throw new Error(`the call waited ${Date.now() - started} ms: the dead server was tried first`)
      expectEqual(operator.state.attempts.length, attempts, 'calls the dead server was sent')
      // Step 10a: what OpenSIPS knows of the trunk, read by the Gateway, told to the tool once: trunk.degraded.
      const hook = await receiver.waitFor(e => e?.type === 'trunk.degraded' && e.trunk.servers.some(x => x.address === operator.address && x.state === 'probing'), 'trunk.degraded', 30_000)
      expectEqual(hook.verified, true, 'signature of trunk.degraded')
      if (!['degraded', 'down'].includes(hook.event.trunk.state)) throw new Error(`trunk.degraded: state ${hook.event.trunk.state}`)
      expectEqual(hook.event.trunk.id, 'operator', 'the trunk degraded')
    } finally {
      operator.state.dead = false
    }
  })
  await step('a request to the trunk socket from an address that is not the operator is refused (403), out of a dialog or in one that is none of its calls; a call to a number that is no direct number is not found (404)', async () => {
    const intruder = await startOperator({ opensips: SIP_TRUNK, user: 'x', password: 'y', bind: '127.0.0.2' })
    try {
      expectEqual((await intruder.raw('INVITE', '+33199000101')).status, 403, 'INVITE from 127.0.0.2')
      expectEqual((await intruder.raw('BYE', '+33199000101', { toTag: 'forged' })).status, 403, 'BYE in a dialog from 127.0.0.2')
    } finally {
      await intruder.close()
    }
    const nowhere = await operator.call('+33199000250')
    expectEqual((await nowhere.final).status, 404, 'call to a number of no range')
  })
  // Step 8 (ADR 0018): the phone access to a room, through LiveKit SIP behind OpenSIPS (its only trunk). No Meet here:
  // the Gateway names the room (twake-...), its PIN drawn by the Gateway.
  let ROOM
  let pin
  let roomCaller
  /** The room's participants, as its owner reads them (GET /v1/conferences/:id): none while LiveKit has no such room. */
  const inRoom = async () => {
    const res = await (await asPerson(alice))('GET', `/conferences/${ROOM}`)
    return res.statusCode === 200 ? res.json().participants : []
  }
  // Once a second: these reads are Alice's, counted with her window's (60 a minute, CONFERENCE_READ_LIMIT). Four a
  // second left her conference of step 8b, a few seconds later, nothing to read its participants with (429).
  const roomHas = (count, what) =>
    until(what, async () => {
      const people = await inRoom()
      return people.length === count ? people : null
    }, { timeout: 20_000, every: 1_000 })
  const connected = (page, what) => until(what, async () => ((await calls(page))[0]?.state === 'connected' ? true : null), { timeout: 20_000 })
  // LiveKit SIP answers, then asks for the PIN (a recorded prompt): the digits are typed once it has begun.
  const PROMPT_MS = 3_000
  /** Types `digits` on the keypad of the page's call (RFC 4733 events in its RTP); `shown`: waits for the app to list them. */
  const typeOnKeypad = async (page, digits, { shown = true } = {}) => {
    await page.getByRole('button', { name: 'Clavier' }).click()
    for (const digit of digits) await page.getByRole('button', { name: `Envoyer la touche ${digit}` }).click()
    if (shown) await page.getByText(`Touches envoyées : ${digits}`).waitFor()
  }
  /** The next call OpenSIPS sends either server of the operator that `test` takes (the first may still be marked down). */
  const invitedAtOperator = test => Promise.any([operator, operator2].map(at => at.invited(test, 30_000).then(call => ({ call, at }))))
  await step('step 8: Alice opens a room (POST /v1/conferences, create), named by the Gateway (without Meet, nobody claims a room of LiveKit by its name): the access number and its PIN of 10 digits; Jean dials 8000 from his browser: LiveKit SIP answers through OpenSIPS and asks for the PIN, which he types on the keypad, then #: he is in the room, a phone, his extension its number', async () => {
    const api = await asPerson(alice)
    const caps = (await api('GET', '/capabilities')).json()
    expectEqual(caps.conference, { dialIn: true, dialOut: true }, 'conference capabilities')
    const claimed = await api('POST', '/conferences', { meetingId: `e2e-${randomBytes(4).toString('hex')}` })
    expectEqual(claimed.statusCode, 404, `POST /conferences with a room name of LiveKit ${claimed.body}`)
    const res = await api('POST', '/conferences', { create: true })
    expectEqual(res.statusCode, 201, `POST /conferences ${res.body}`)
    const { meetingId, dialIn } = res.json()
    if (!/^twake-[0-9a-f]{16}$/.test(meetingId ?? '')) throw new Error(`name of the room: ${meetingId}`)
    ROOM = meetingId
    expectEqual(dialIn.numbers.map(n => n.e164), [MEET_NUMBER], 'the access number shown')
    if (!/^\d{10}$/.test(dialIn.pin ?? '')) throw new Error(`PIN of the room: ${dialIn.pin}`)
    pin = dialIn.pin
    await dial(jean.page, MEET_NUMBER)
    await connected(jean.page, 'Jean\'s call to 8000 answered')
    await sleep(PROMPT_MS)
    await typeOnKeypad(jean.page, `${pin}#`)
    const [jeanIn] = await roomHas(1, 'Jean in the room')
    expectEqual(`${jeanIn.kind} ${jeanIn.number}`, 'phone 102', 'Jean in the room')
  })
  await step('step 8: Bob dials 8000 and types a wrong PIN: LiveKit SIP hangs up on him (a BYE, once the PIN is typed); the room still has Jean only', async () => {
    const before = await lastEnded(bob.page)
    await dial(bob.page, MEET_NUMBER)
    await connected(bob.page, 'Bob\'s call to 8000 answered')
    await sleep(PROMPT_MS)
    const wrong = pin === '0000000000' ? '1111111111' : '0000000000'
    await typeOnKeypad(bob.page, `${wrong}#`, { shown: false })
    const typedAt = Date.now()
    const ended = await until('LiveKit SIP to hang up on Bob', async () => {
      const last = await lastEnded(bob.page)
      return last && last.id !== before?.id ? last : null
    }, { timeout: 30_000 })
    // Hung up by the far end (a BYE: no status), not refused nor cut, after the PIN and before any ping could end it.
    expectEqual(`${ended.endReason} ${ended.endStatus ?? '-'}`, 'hangup -', 'how Bob\'s call to 8000 ended')
    if (Date.now() - typedAt > 25_000) throw new Error('Bob\'s call to 8000 ended long after the wrong PIN')
    expectEqual((await inRoom()).length, 1, 'people in the room')
  })
  await step('step 8: Alice has the room call Bob (POST /v1/conferences/:id/participants): his browser rings from her extension (the room calls at the name of who asked), he answers, and only then does the Gateway answer (201); Jean and Bob hear each other through the room', async () => {
    const api = await asPerson(alice)
    const placing = api('POST', `/conferences/${ROOM}/participants`, { number: '103' })
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.waitFor({ timeout: 20_000 })
    expectEqual((await calls(bob.page))[0]?.remoteNumber, '101', 'who calls Bob')
    // Placed at Alice's name, not by her browser: her app shows no call of hers (review n°15).
    expectEqual((await calls(alice.page)).length, 0, 'calls on Alice\'s page while the room calls at her name')
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    const res = await placing
    expectEqual(`${res.statusCode} ${res.json().kind} ${res.json().number}`, '201 phone 103', `POST /conferences/:id/participants ${res.body}`)
    await roomHas(2, 'Jean and Bob in the room')
    await bothHearEachOther(jean, bob)
  })
  await step('step 8: Alice aims the direct number +33 1 99 00 01 50 at the access number (PUT /admin/dids/meet, target 8000), which no ring group may take; the operator calls it: LiveKit SIP asks for the PIN, typed as RFC 4733 events, in plain RTP: the caller is in the room with Jean and Bob, its number known, and hears them', async () => {
    const api = await asPerson(alice)
    const put = await api('PUT', '/admin/dids/meet', { trunkId: 'operator', first: '+33199000150', target: MEET_NUMBER })
    expectEqual(put.statusCode, 201, `PUT /admin/dids/meet ${put.body}`)
    const group = await api('POST', '/admin/groups', { number: MEET_NUMBER, name: 'Salle', members: ['101'] })
    expectEqual(`${group.statusCode} ${group.json().code}`, '400 GROUP_NUMBER_RESERVED', 'POST /admin/groups 8000')
    const placed = (roomCaller = await operator.call('+33199000150', { from: '+33639980006' }))
    const answer = await placed.final
    expectEqual(answer.status, 200, 'answer to the operator')
    if (!plainRtp(answer.body)) throw new Error(`answer of LiveKit SIP to the operator: ${answer.body}`)
    await sleep(PROMPT_MS)
    await placed.dtmf(`${pin}#`)
    const people = await roomHas(3, 'the operator\'s caller in the room')
    if (!people.some(p => p.kind === 'phone' && p.number === '+33639980006')) throw new Error(`in the room: ${JSON.stringify(people)}`)
    const voiced = placed.media.stats.voiced
    await until('the room heard at the operator', () => (placed.media.stats.voiced > voiced + 20 ? true : null))
  })
  await step(`step 8 (second review, n°1 and n°2): callers who present ${MEET_PIN_TRIES_ALL + 1} numbers in turn and hang up at the PIN prompt (a try each) refuse nobody else, the administrators see the alert (GET /admin/alerts); one number with ${MEET_PIN_TRIES} tries is refused (403, pin-tries); a caller with the right PIN still joins the room; the operator's call to 8000 lasts MEET_MAX_CALL_SEC at most, not TRUNK_MAX_CALL_SEC`, async () => {
    const api = await asPerson(alice)
    // Hung up at the prompt: LiveKit SIP answered, a try.
    const shortCall = async from => {
      const call = await operator.call('+33199000150', { from })
      const answer = await call.final
      if (answer.status === 200) {
        await sleep(1_000)
        await call.hangup()
      }
      return answer
    }
    await mi('cache_remove_chunk', { glob: 'pin:*' })
    try {
      for (let i = 1; i <= MEET_PIN_TRIES_ALL + 1; i++) {
        const answer = await shortCall(`+336399810${String(i).padStart(2, '0')}`)
        expectEqual(answer.status, 200, `the answer to presented number ${i}`)
      }
      const alert = await until('the alert of the failed tries of a PIN', async () => {
        const res = await api('GET', '/admin/alerts')
        return res.json().items.find(a => a.kind === 'meet' && a.param === 'pin-tries') ?? null
      })
      expectEqual(`${alert.number} ${alert.threshold}`, `${MEET_NUMBER} ${MEET_PIN_TRIES_ALL}`, 'the alert')
      for (let i = 1; i < MEET_PIN_TRIES; i++) expectEqual((await shortCall('+33639981001')).status, 200, `failed try ${i + 1} of +33639981001`)
      const refused = await (await operator.call('+33199000150', { from: '+33639981001' })).final
      expectEqual(`${refused.status} ${refused.headers.get('twake-call-refused')?.[0]}`, '403 pin-tries', 'the next call of +33639981001')
      const guest = await operator.call('+33199000150', { from: '+33639980007' })
      expectEqual((await guest.final).status, 200, 'the answer to the caller with the right PIN')
      await sleep(PROMPT_MS)
      await guest.dtmf(`${pin}#`)
      const people = await roomHas(4, 'the caller with the right PIN in the room')
      if (!people.some(p => p.kind === 'phone' && p.number === '+33639980007')) throw new Error(`in the room: ${JSON.stringify(people)}`)
      expectEqual((await guest.hangup()).status, 200, 'answer to the BYE of the caller with the right PIN')
      await roomHas(3, 'three in the room again')
      const dialog = ((await mi('dlg_list')).result?.Dialogs ?? []).find(d => d.callid === roomCaller.callId)
      const left = Number(dialog?.timeout) - Math.floor(Date.now() / 1000)
      if (!(left <= MEET_MAX_CALL_SEC && left > MEET_MAX_CALL_SEC - 600)) throw new Error(`the operator's call to 8000 ends in ${left} s, at most ${MEET_MAX_CALL_SEC} expected`)
    } finally {
      await mi('cache_remove_chunk', { glob: 'pin:*' })
    }
  })
  await step(`step 8 (third review, n°1): one number calls the access number ${MEET_CALLS_PER_CALLER} times at once, and once more: busy (486, meet-busy), no try; the first call waits more than a minute before a wrong PIN, which LiveKit SIP hangs up on: it was a try all the same, as the second one; the number is refused once it made ${MEET_PIN_TRIES}`, async () => {
    await mi('cache_remove_chunk', { glob: 'pin:*' })
    const from = '+33639981050'
    const wrong = pin === '0000000000' ? '1111111111' : '0000000000'
    try {
      const atOnce = []
      for (let i = 0; i < MEET_CALLS_PER_CALLER; i++) {
        const call = await operator.call('+33199000150', { from })
        expectEqual((await call.final).status, 200, `the answer to call ${i + 1} of ${from}`)
        atOnce.push(call)
      }
      const busy = await (await operator.call('+33199000150', { from })).final
      expectEqual(`${busy.status} ${busy.headers.get('twake-call-refused')?.[0]}`, '486 meet-busy', `call ${MEET_CALLS_PER_CALLER + 1} at the same time`)
      expectEqual((await atOnce[1].hangup()).status, 200, 'answer to the BYE of the second call')
      // More than a minute (the length a try was counted within before), then a wrong PIN: LiveKit SIP hangs up.
      await sleep(65_000)
      await atOnce[0].dtmf(`${wrong}#`)
      await until('LiveKit SIP to hang up on the wrong PIN typed late', () => (atOnce[0].state === 'ended' ? true : null), { timeout: 30_000 })
      for (let i = MEET_CALLS_PER_CALLER; i < MEET_PIN_TRIES; i++) {
        const call = await operator.call('+33199000150', { from })
        expectEqual((await call.final).status, 200, `the answer to try ${i + 1} of ${from}`)
        await call.hangup()
      }
      const refused = await (await operator.call('+33199000150', { from })).final
      expectEqual(`${refused.status} ${refused.headers.get('twake-call-refused')?.[0]}`, '403 pin-tries', `the call of ${from} after ${MEET_PIN_TRIES} tries`)
    } finally {
      await mi('cache_remove_chunk', { glob: 'pin:*' })
    }
  })
  await step('step 8: Alice has the room call 01 99 00 00 24: OpenSIPS sends it to the operator as one of her calls, from her direct number +33 1 99 00 01 01, in plain G.711; the operator answers, hears the room and hangs up; the CDR says 101', async () => {
    const api = await asPerson(alice)
    const accFrom = await lastId('acc')
    const placing = api('POST', `/conferences/${ROOM}/participants`, { number: '0199000024' })
    const { call, at } = await invitedAtOperator(invite => invite.uri === 'sip:+33199000024@operator.example')
    const header = name => call.invite.headers.get(name)?.[0] ?? ''
    if (!header('from').includes('<sip:+33199000101@operator.example>')) throw new Error(`From sent to the operator: ${header('from')}`)
    if (!plainRtp(call.invite.body) || /opus/i.test(call.invite.body)) throw new Error(`offer sent to the operator: ${call.invite.body}`)
    const res = await placing
    expectEqual(`${res.statusCode} ${res.json().number}`, '201 0199000024', `POST /conferences/:id/participants ${res.body}`)
    await roomHas(4, 'four in the room')
    const voiced = call.media.stats.voiced
    await until('the room heard at the operator', () => (call.media.stats.voiced > voiced + 20 ? true : null))
    expectEqual((await at.hangupReceived(call)).status, 200, 'answer to the operator\'s BYE')
    await roomHas(3, 'three in the room again')
    await until('the CDR of the room\'s call', async () => ((await cdrsSince(accFrom)).includes('101>+33199000024 200') ? true : null))
  })
  await step('step 8: the room cannot call what Alice may not: 08 99 00 00 00 (premium) nor 112 (an emergency call from a room tells no place) are refused by OpenSIPS before the operator, and the Gateway says so (409 DIAL_FAILED, SIP 403)', async () => {
    const api = await asPerson(alice)
    const attempts = operator.state.attempts.length + operator2.state.attempts.length
    for (const number of ['0899000000', '112']) {
      const res = await api('POST', `/conferences/${ROOM}/participants`, { number })
      expectEqual(`${res.statusCode} ${res.json().code} ${res.json().sipStatus}`, '409 DIAL_FAILED 403', `the room's call to ${number}: ${res.body}`)
    }
    expectEqual(operator.state.attempts.length + operator2.state.attempts.length, attempts, 'calls the operator was sent')
    expectEqual((await inRoom()).length, 3, 'people in the room')
  })
  await step('step 8: Alice has the room call 01 99 00 00 25, which rings and is never answered: LiveKit SIP gives up after its ringing time (CANCEL to the operator) and the Gateway says so (409 DIAL_FAILED with the SIP status), nothing of LiveKit\'s own error', async () => {
    const api = await asPerson(alice)
    const servers = [operator, operator2]
    for (const at of servers) at.state.next.push({ ringOnly: true })
    activeBridge = shortBridge
    try {
      const placing = api('POST', `/conferences/${ROOM}/participants`, { number: '0199000025' })
      const { call } = await invitedAtOperator(invite => invite.uri === 'sip:+33199000025@operator.example')
      const res = await placing
      expectEqual(`${res.statusCode} ${res.json().code}`, '409 DIAL_FAILED', `the room's call nobody answers: ${res.body}`)
      if (![408, 480, 487].includes(res.json().sipStatus)) throw new Error(`SIP status of the room's call nobody answers: ${res.body}`)
      if (/livekit|twirp|psrpc/i.test(res.body)) throw new Error(`the Gateway passes LiveKit's error on: ${res.body}`)
      await until('the CANCEL at the operator', () => (call.state === 'cancelled' ? true : null))
      expectEqual((await inRoom()).length, 3, 'people in the room')
    } finally {
      activeBridge = bridge
      // The server that was not sent the call keeps no such behaviour for the next steps.
      for (const at of servers) {
        const i = at.state.next.findIndex(n => n.ringOnly)
        if (i >= 0) at.state.next.splice(i, 1)
      }
    }
  })
  await step('step 8 (third review, n°3): a call from a phone to the access number lasts MEET_MAX_CALL_SEC at most, then OpenSIPS ends it on both sides: Jean, back in the room with it shortened a moment (MI shv_set), is told the call ended and leaves the room', async () => {
    await jean.page.getByRole('button', { name: 'Raccrocher' }).click()
    await until('the end of Jean\'s call', async () => (await calls(jean.page)).length === 0)
    await roomHas(2, 'Bob and the operator\'s caller in the room')
    const before = await lastEnded(jean.page)
    await mi('shv_set', { name: 'meet_max_sec', type: 'int', value: 25 })
    try {
      await dial(jean.page, MEET_NUMBER)
      await connected(jean.page, 'Jean\'s call to 8000 answered')
      await sleep(PROMPT_MS)
      await typeOnKeypad(jean.page, `${pin}#`)
      await roomHas(3, 'Jean in the room again')
    } finally {
      await mi('shv_set', { name: 'meet_max_sec', type: 'int', value: MEET_MAX_CALL_SEC })
    }
    // The BYE to Jean's browser (no status: hung up by the far end) and to LiveKit SIP (he leaves the room).
    const ended = await until('the end of Jean\'s call at MEET_MAX_CALL_SEC', async () => {
      const last = await lastEnded(jean.page)
      return last && last.id !== before?.id ? last : null
    }, { timeout: 40_000 })
    expectEqual(`${ended.endReason} ${ended.endStatus ?? '-'}`, 'hangup -', 'how Jean\'s call to 8000 ended')
    await roomHas(2, 'Bob and the operator\'s caller in the room, Jean gone')
  })
  await step('step 8: everyone leaves the room (the operator and Bob hang up); Alice closes it (DELETE /v1/conferences/:id) and removes the direct number aimed at 8000', async () => {
    const api = await asPerson(alice)
    expectEqual((await roomCaller.hangup()).status, 200, 'answer to the operator\'s BYE')
    for (const who of [bob]) {
      await who.page.getByRole('button', { name: 'Raccrocher' }).click()
      await until(`the end of the call on ${who.name} side`, async () => (await calls(who.page)).length === 0)
    }
    await roomHas(0, 'an empty room')
    expectEqual((await api('DELETE', `/conferences/${ROOM}`)).statusCode, 204, 'DELETE /conferences/:id')
    expectEqual((await api('DELETE', '/admin/dids/meet')).statusCode, 204, 'DELETE /admin/dids/meet')
  })
  // Step 8b (ADR 0019): « Ajouter un participant ». A call between two extensions becomes a conference in a room of
  // its own: the room calls Alice's window (its token), then Jean in the place of their call (Replaces), then Bob.
  let CONFERENCE
  let conferenceFrom
  let conferenceAcc
  /** The participants of the conference, as Alice reads them (none once LiveKit no longer has the room). */
  const inConference = async () => {
    const res = await (await asPerson(alice))('GET', `/conferences/${CONFERENCE}`)
    return res.statusCode === 200 ? res.json().participants : []
  }
  /** The person's newest calls of the history that are a conference, once there are `count` since `after`. */
  const conferenceCalls = (userId, after, count) =>
    until(`${count} conference calls in the history of ${userId}`, async () => {
      const items = (await store.listHistory(TENANT, userId, { limit: 10 })).items.filter(e => e.startedAt > after && e.conference)
      return items.length >= count ? items : null
    })
  await step('step 8b: Alice calls Jean, who answers; while Jean holds the call, Alice cannot add anyone (review 8b, n°1); both mute their microphone; she adds Bob (« Ajouter un participant », 103): the room calls her window, answered by itself, then Jean in the place of their call (Replaces, answered by itself), each microphone still muted; Bob rings from her extension and answers: a conference of three, each hearing the others, neither hold nor transfer; Jean and Bob see who is in it, without acting on anyone, and are told who came (review 8b, n°2); Alice removes Bob, whose call ends, and Jean is told he left', async () => {
    conferenceFrom = new Date().toISOString()
    conferenceAcc = await lastId('acc')
    await aliceCallsJean(alice, jean)
    const [original] = await calls(alice.page)
    const [jeans] = await calls(jean.page)
    if (!original?.sipCallId || original.sipCallId !== jeans?.sipCallId) throw new Error(`the Call-ID of the call on both sides: ${original?.sipCallId} ${jeans?.sipCallId}`)
    // Jean holds the call: the room would take it unheld, his microphone open to it; Alice has nothing to add with.
    await jean.page.getByRole('button', { name: 'Mettre en attente' }).click()
    await until('Alice seeing Jean hold the call', async () => ((await calls(alice.page))[0]?.remoteHold ? true : null))
    expectEqual(await alice.page.getByRole('button', { name: 'Ajouter un participant' }).count(), 0, 'the button to add a participant while Jean holds the call')
    await jean.page.getByRole('button', { name: 'Reprendre' }).click()
    await until('Alice seeing Jean resume the call', async () => ((await calls(alice.page))[0]?.remoteHold === false ? true : null))
    // Each one mutes their microphone: the calls of the conference start so.
    for (const who of [alice, jean]) await who.page.getByRole('button', { name: 'Couper le micro' }).click()
    // The race of the announcement, forced: the panels of Alice and Jean get no read of the room until Bob is in it,
    // so their first read finds him there already. He is told all the same (an arrival after their own calls).
    const roomRead = /\/api\/v1\/conferences\/twake-call-[0-9a-f]{16}(\?|$)/
    const refuseReads = route =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ statusCode: 429, code: 'CONFERENCE_READ_LIMIT', message: 'held by the e2e' }) })
        : route.fallback()
    for (const who of [alice, jean]) await who.page.route(roomRead, refuseReads)
    // Every text the status region shows from now on, in each window: no announcement is lost by being replaced.
    for (const who of [alice, jean, bob])
      await who.page.evaluate(() => {
        const seen = (window.__statusTexts = [])
        const look = () => {
          const text = document.querySelector('[data-testid="call-status"]')?.textContent ?? ''
          if (text && seen.at(-1) !== text) seen.push(text)
        }
        new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true })
        look()
      })
    const statusTexts = who => who.page.evaluate(() => window.__statusTexts ?? [])
    await alice.page.getByRole('button', { name: 'Ajouter un participant' }).click()
    await alice.page.getByLabel('Participant à ajouter (poste ou numéro)').fill('103')
    await alice.page.getByRole('button', { name: 'Appeler et ajouter' }).click()
    // Alice: the room's call to her window only, her call with Jean ended as a conference.
    const [mine] = await until('Alice in the conference', async () => {
      const c = await calls(alice.page)
      return c.length === 1 && c[0].room === 'conference' && c[0].state === 'connected' ? c : null
    }, { timeout: 30_000 })
    expectEqual(`${mine.conferenceOf === original.id} ${mine.direction} ${mine.remoteNumber} ${mine.muted}`, 'true inbound 101 true', 'Alice\'s call of the conference')
    expectEqual((await lastEnded(alice.page))?.endReason, 'conference', 'how Alice\'s call with Jean ended')
    // Jean: the room's call in the place of theirs, from Alice's extension; his call with her ended as a conference.
    const [his] = await until('Jean in the conference', async () => {
      const c = await calls(jean.page)
      return c.length === 1 && c[0].room === 'conference' && c[0].state === 'connected' ? c : null
    }, { timeout: 30_000 })
    expectEqual(`${his.replacedCallId === jeans.id} ${his.remoteNumber} ${his.muted}`, 'true 101 true', 'Jean\'s call of the conference')
    expectEqual((await lastEnded(jean.page))?.endReason, 'conference', 'how Jean\'s call with Alice ended')
    await jean.page.getByText('Conférence avec Alice Martin (101)').waitFor()
    // Bob: rung by the room, at Alice's name, as any call a room places.
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.waitFor({ timeout: 30_000 })
    expectEqual((await calls(bob.page))[0]?.remoteNumber, '101', 'who calls Bob')
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await until('Bob in the conference', async () => ((await calls(bob.page))[0]?.state === 'connected' ? true : null), { timeout: 30_000 })
    for (const who of [alice, jean]) await who.page.unroute(roomRead, refuseReads)
    await alice.page.getByTestId('conference-participant').nth(2).waitFor({ timeout: 20_000 })
    const shown = await alice.page.getByTestId('conference-participant').allTextContents()
    expectEqual(shown.length, 3, `the participants Alice sees: ${JSON.stringify(shown)}`)
    for (const button of ['Retirer 102 de la conférence', 'Retirer 103 de la conférence', 'Terminer pour tous', 'Quitter la conférence']) await alice.page.getByRole('button', { name: button }).waitFor()
    CONFERENCE = await until('the room of the conference, kept for Alice', async () => (await store.listConferences(TENANT, 'amartin')).find(r => /^twake-call-[0-9a-f]{16}$/.test(r.meetingId))?.meetingId ?? null)
    expectEqual((await inConference()).map(p => `${p.kind} ${p.number}`).sort().join(', '), 'phone 101, phone 102, phone 103', 'the room of the conference')
    // When each came in, by the Gateway's clock (it dials every call of the room and writes when): there for everyone,
    // in milliseconds, Bob after the two others.
    const came = Object.fromEntries((await inConference()).map(p => [p.number, p.joinedAt]))
    expectEqual(Object.values(came).every(at => Number.isSafeInteger(at) && at > 1e12), true, `when each came in: ${JSON.stringify(came)}`)
    expectEqual(came['103'] > Math.max(came['101'], came['102']), true, `Bob after the others: ${JSON.stringify(came)}`)
    // Bob's call names the room of the conference (Twake-Conference): he sees who is in it, as Jean does; neither acts on anyone.
    const [bobs] = await calls(bob.page)
    expectEqual(`${bobs?.room} ${bobs?.conferenceRoom === CONFERENCE}`, 'conference true', `Bob's call of the conference ${JSON.stringify(bobs)}`)
    for (const who of [jean, bob]) {
      await who.page.getByTestId('conference-participant').nth(2).waitFor({ timeout: 20_000 })
      expectEqual(await who.page.getByTestId('conference-participant').count(), 3, `the participants ${who.name} sees`)
      expectEqual(await who.page.getByRole('button', { name: /^Retirer / }).count(), 0, `the buttons to remove a participant on ${who.name}'s page`)
    }
    // Whoever is in it is told who came, in a region read out.
    for (const who of [alice, jean]) await who.page.getByTestId('call-status').getByText('103 a rejoint la conférence.').waitFor({ timeout: 20_000 })
    // Only Bob, ever: neither party of the call it began with, nor oneself; and Bob, who came last, of nobody.
    for (const who of [alice, jean]) {
      const told = await statusTexts(who)
      expectEqual(told.some(text => /10[12] a rejoint/.test(text)), false, `what ${who.name} was told: ${JSON.stringify(told)}`)
    }
    const toldBob = await statusTexts(bob)
    expectEqual(toldBob.some(text => /a rejoint|a quitté/.test(text)), false, `what Bob was told: ${JSON.stringify(toldBob)}`)
    for (const who of [alice, jean]) await who.page.getByTestId('conference').getByRole('button', { name: 'Rétablir le micro' }).click()
    // Each one hears the others, through the room.
    await bothHearEachOther(alice, jean)
    await bothHearEachOther(jean, bob)
    // A call of a room is neither held nor transferred; nobody places another call meanwhile.
    for (const who of [alice, jean, bob]) {
      expectEqual(await who.page.getByRole('button', { name: 'Mettre en attente' }).count(), 0, `the hold button on ${who.name}'s page`)
      expectEqual(await transferButton(who.page).count(), 0, `the transfer button on ${who.name}'s page`)
    }
    // Alice removes Bob (« Retirer 103 de la conférence »): his call ends, the conference goes on; whoever is in it is told.
    await alice.page.getByRole('button', { name: 'Retirer 103 de la conférence' }).click()
    await until('the end of Bob\'s call', async () => ((await calls(bob.page)).length === 0 ? true : null), { timeout: 20_000 })
    await bob.page.getByText('La conférence est terminée pour vous.').waitFor()
    for (const who of [alice, jean]) await who.page.getByTestId('call-status').getByText('103 a quitté la conférence.').waitFor({ timeout: 20_000 })
    expectEqual(`${(await calls(alice.page)).length} ${(await calls(jean.page)).length}`, '1 1', 'the calls of Alice and Jean once Bob was removed')
  })
  await step('step 8b: Alice ends the conference for everyone (« Terminer pour tous », then « Oui, terminer pour tous »): the calls end, the room and its record go; the history of Alice and Jean says conference, as their Récents do', async () => {
    // Asked first (review 8b, n°7): « Annuler » changes nothing.
    await alice.page.getByRole('button', { name: 'Terminer pour tous' }).click()
    await alice.page.getByTestId('conference-confirm').getByRole('button', { name: 'Annuler' }).click()
    expectEqual((await calls(jean.page)).length, 1, 'Jean\'s calls once Alice said no')
    await alice.page.getByRole('button', { name: 'Terminer pour tous' }).click()
    await alice.page.getByRole('button', { name: 'Oui, terminer pour tous' }).click()
    for (const who of [alice, jean, bob]) await until(`the end of the conference on ${who.name}'s page`, async () => ((await calls(who.page)).length === 0 ? true : null), { timeout: 20_000 })
    for (const who of [alice, jean]) await who.page.getByText('La conférence est terminée pour vous.').waitFor()
    expectEqual((await (await asPerson(alice))('GET', `/conferences/${CONFERENCE}`)).statusCode, 404, 'GET /conferences/:id once ended')
    expectEqual(await store.getConference(CONFERENCE), null, 'the record of the conference')
    const [aliceIn] = await conferenceCalls('amartin', conferenceFrom, 1)
    // The room called her at her own name: a call of hers, to herself (Récents reads « Votre conférence »).
    expectEqual(`${aliceIn.remoteNumber} ${aliceIn.direction}`, '101 outbound', 'Alice\'s history: the room called her at her name')
    const [jeanIn] = await conferenceCalls('jdupont', conferenceFrom, 1)
    expectEqual(`${jeanIn.remoteNumber} ${jeanIn.direction}`, '101 inbound', 'Jean\'s history: the room called him at Alice\'s name')
    if (!(await recents(alice.page, 1)).includes('Votre conférence: Conférence')) throw new Error(`Alice's Récents: ${JSON.stringify(await recents(alice.page, 1))}`)
    if (!(await recents(jean.page, 1)).some(l => l.endsWith(': Conférence'))) throw new Error(`Jean's Récents: ${JSON.stringify(await recents(jean.page, 1))}`)
    // Bob, the third participant, likewise (second review 8b, n°8): a call of the conference, at Alice's name.
    const [bobIn] = await conferenceCalls('bdurand', conferenceFrom, 1)
    expectEqual(`${bobIn.remoteNumber} ${bobIn.direction}`, '101 inbound', 'Bob\'s history: the room called him at Alice\'s name')
    if (!(await recents(bob.page, 1)).some(l => l.endsWith(': Conférence'))) throw new Error(`Bob's Récents: ${JSON.stringify(await recents(bob.page, 1))}`)
    const cdrs = await until('the CDRs of the conference\'s calls', async () => {
      const { rows } = await db.query("SELECT callee FROM acc WHERE via = 'conference' AND id > $1 ORDER BY id", [conferenceAcc])
      return rows.length >= 3 ? rows.map(r => r.callee).sort() : null
    })
    expectEqual(cdrs.join(' '), '101 102 103', 'the CDRs of the conference\'s calls (via conference)')
    // LiveKit told the Gateway (its webhooks, second review 8b, n°3), each time with a signature it took.
    await until('LiveKit\'s webhooks at the Gateway', async () => (livekitWebhooks.includes(204) ? true : null))
    expectEqual(livekitWebhooks.filter(s => s !== 204).join(' '), '', 'the webhooks of LiveKit the Gateway refused')
  })
  // Step 8c (ADR 0025): a call with the operator becomes a conference by the room calling the same number again.
  const OPERATED = 'sip:+33639980006@operator.example'
  const operatorConference = async () => {
    await alice.page.getByRole('button', { name: 'Ajouter un participant' }).click()
    await alice.page.getByLabel('Participant à ajouter (poste ou numéro)').fill('103')
    await alice.page.getByRole('button', { name: 'Appeler et ajouter' }).click()
  }
  await step('step 8c: a call with the operator becomes a conference (« Ajouter un participant », 103): the room calls Alice\'s window, then the number again from her direct number (the operator answers it as a call of its own), her first call ends as a conference, Bob rings; the room holds Alice, the number and Bob, and the operator hears the room', async () => {
    conferenceFrom = new Date().toISOString()
    conferenceAcc = await lastId('acc')
    await dial(alice.page, '06 39 98 00 06')
    const { call: first, at } = await invitedAtOperator(invite => invite.uri === OPERATED)
    await alice.page.getByText('En communication avec +33 6 39 98 00 06').waitFor()
    await at.callState(first, 'answered')
    const [original] = await calls(alice.page)
    await operatorConference()
    // The same number, again, from her direct number: through the grant and the checks of any call of hers.
    const { call: second, at: at2 } = await invitedAtOperator(invite => invite.uri === OPERATED)
    for (const [name, c] of [['first', first], ['second', second]]) if (!(c.invite.headers.get('from')?.[0] ?? '').includes('<sip:+33199000101@operator.example>')) throw new Error(`From of the ${name} call at the operator: ${c.invite.headers.get('from')}`)
    await at2.callState(second, 'answered')
    // The window ends the first call (nothing takes the operator's place in it): its BYE reaches the operator.
    await at.callState(first, 'ended')
    const [mine] = await until('Alice in the conference', async () => {
      const c = await calls(alice.page)
      return c.length === 1 && c[0].room === 'conference' && c[0].state === 'connected' ? c : null
    }, { timeout: 30_000 })
    expectEqual(`${mine.conferenceOf === original.id} ${mine.direction} ${mine.remoteNumber}`, 'true inbound 101', 'Alice\'s call of the conference')
    expectEqual((await lastEnded(alice.page))?.endReason, 'conference', 'how Alice\'s first call ended')
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.waitFor({ timeout: 30_000 })
    expectEqual((await calls(bob.page))[0]?.remoteNumber, '101', 'who calls Bob')
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await until('Bob in the conference', async () => ((await calls(bob.page))[0]?.state === 'connected' ? true : null), { timeout: 30_000 })
    await alice.page.getByTestId('conference-participant').nth(2).waitFor({ timeout: 20_000 })
    CONFERENCE = await until('the room of the conference, kept for Alice', async () => (await store.listConferences(TENANT, 'amartin')).find(r => /^twake-call-[0-9a-f]{16}$/.test(r.meetingId))?.meetingId ?? null)
    expectEqual((await inConference()).map(p => `${p.kind} ${p.number}`).sort().join(', '), 'phone +33639980006, phone 101, phone 103', 'the room of the conference')
    // The operator hears the room (Alice's microphone, Bob's), and its own tone reaches them.
    await until('sound from the room at the operator', async () => (second.media.stats.voiced > 20 ? true : null), { timeout: 30_000 })
    await bothHearEachOther(alice, bob)
  })
  await step('step 8c: the number is added to a conference too (« Ajouter un participant » with an external number, the rights and caps of Alice): the room calls it from her direct number and it joins; Alice removes it and ends the conference for everyone', async () => {
    await alice.page.getByRole('button', { name: 'Ajouter un participant' }).click()
    await alice.page.getByLabel('Participant à ajouter (poste ou numéro)').fill('06 39 98 00 07')
    await alice.page.getByRole('button', { name: 'Appeler et ajouter' }).click()
    const { call, at } = await invitedAtOperator(invite => invite.uri === 'sip:+33639980007@operator.example')
    if (!(call.invite.headers.get('from')?.[0] ?? '').includes('<sip:+33199000101@operator.example>')) throw new Error(`From of the call to the added number: ${call.invite.headers.get('from')}`)
    await at.callState(call, 'answered')
    await until('the added number in the room', async () => ((await inConference()).some(p => p.number === '+33639980007') ? true : null), { timeout: 30_000 })
    await alice.page.getByRole('button', { name: 'Retirer +33 6 39 98 00 07 de la conférence' }).click()
    await at.callState(call, 'ended', 20_000)
    await alice.page.getByRole('button', { name: 'Terminer pour tous' }).click()
    await alice.page.getByRole('button', { name: 'Oui, terminer pour tous' }).click()
    for (const who of [alice, bob]) await until(`the end of the conference on ${who.name}'s page`, async () => ((await calls(who.page)).length === 0 ? true : null), { timeout: 20_000 })
    await until('the room ended', async () => ((await inConference()).length === 0 ? true : null))
    const cdrs = await until('the CDRs of the conference\'s calls', async () => {
      const { rows } = await db.query("SELECT callee FROM acc WHERE via = 'conference' AND id > $1 ORDER BY id", [conferenceAcc])
      return rows.length >= 2 ? rows.map(r => r.callee).sort() : null
    })
    expectEqual(cdrs.join(' '), '101 103', 'the CDRs of the conference\'s calls to extensions (via conference)')
  })
  await step('step 8c: a call received from the operator becomes a conference too: the room calls the number that called (shown, E.164) and the first call ends; with a hidden number nothing can be called back: Alice is told (CONFERENCE_EXTERNAL) and the call goes on', async () => {
    const shown = await operator.call('+33199000101', { from: '+33639980008' })
    await alice.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    expectEqual((await shown.final).status, 200, 'answer to the operator')
    await alice.page.getByText('En communication avec +33 6 39 98 00 08').waitFor()
    await operatorConference()
    const { call: back, at } = await invitedAtOperator(invite => invite.uri === 'sip:+33639980008@operator.example')
    await at.callState(back, 'answered')
    await operator.callState(shown, 'ended', 20_000)
    await until('Alice in the conference', async () => {
      const c = await calls(alice.page)
      return c.length === 1 && c[0].room === 'conference' ? true : null
    }, { timeout: 30_000 })
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.waitFor({ timeout: 30_000 })
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await alice.page.getByRole('button', { name: 'Terminer pour tous' }).click()
    await alice.page.getByRole('button', { name: 'Oui, terminer pour tous' }).click()
    await until('the end of the conference', async () => ((await calls(alice.page)).length === 0 ? true : null), { timeout: 20_000 })
    const hidden = await operator.call('+33199000101', { from: '+33639980009', headers: ['Privacy: id'] })
    await alice.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    expectEqual((await hidden.final).status, 200, 'answer to the operator (hidden number)')
    await alice.page.getByText('En communication avec Numéro masqué').waitFor()
    const attempts = operator.state.attempts.length + operator2.state.attempts.length
    await operatorConference()
    await alice.page.getByRole('alert').filter({ hasText: "ou le numéro de votre correspondant est masqué" }).waitFor()
    await sleep(1_000)
    expectEqual(operator.state.attempts.length + operator2.state.attempts.length, attempts, 'calls the operator was sent')
    expectEqual((await calls(bob.page)).length, 0, 'calls on Bob\'s page')
    const [still] = await calls(alice.page)
    expectEqual(`${still?.state} ${still?.room ?? '-'}`, 'connected -', 'Alice\'s call with the operator')
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await operator.callState(hidden, 'ended', 20_000)
  })
  await step('step 8c: the caps hold for the room as for Alice: with one external call at a time in the organisation, her call with the operator cannot become a conference (the room\'s call is refused, 403, limit): she is told, nobody is rung and her call goes on', async () => {
    const api = await asPerson(alice)
    expectEqual((await api('PUT', '/admin/outbound', { policy: { caps: { concurrent: 1 }, fraud: FRAUD } })).statusCode, 200, 'PUT /admin/outbound (one external call at a time)')
    try {
      await dial(alice.page, '06 39 98 00 06')
      const { call, at } = await invitedAtOperator(invite => invite.uri === OPERATED)
      await alice.page.getByText('En communication avec +33 6 39 98 00 06').waitFor()
      await operatorConference()
      await alice.page.getByRole('alert').filter({ hasText: "plafond d'appels vers l'extérieur atteint" }).waitFor({ timeout: 30_000 })
      // The room's call to her window, answered at once, is hung up: her call with the operator is the only one left, unquiet.
      const [still] = await until('only her call with the operator left', async () => {
        const c = await calls(alice.page)
        return c.length === 1 && c[0].room === undefined && !c[0].muted ? c : null
      })
      expectEqual(`${still?.state} ${still?.room ?? '-'}`, 'connected -', 'Alice\'s call with the operator')
      expectEqual((await calls(bob.page)).length, 0, 'calls on Bob\'s page')
      expectEqual(call.state, 'answered', 'the operator\'s call')
      expectEqual(await store.countConferences(TENANT), 0, 'rooms left')
      await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
      await at.callState(call, 'ended')
    } finally {
      expectEqual((await api('PUT', '/admin/outbound', { policy: { fraud: FRAUD } })).statusCode, 200, 'PUT /admin/outbound (no profile)')
    }
  })
  await step('a registration left on a dead connection (the first one, Alice) with a no-answer forward: Bob rings at once, not after the delay', async () => {
    await setForwarding(alice, { noAnswer: '103', delay: '20' })
    relay.cutUpstream(0)
    await sleep(500)
    const missedFrom = await lastId('missed_calls')
    const dialled = Date.now()
    await dial(jean.page, '101')
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
    // Nobody can answer a dead window: a no answer at once, not 20 s of ringing nobody hears.
    const after = Date.now() - dialled
    if (after > 10_000) throw new Error(`Bob rang ${after} ms after the call, at once expected`)
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await jean.page.getByText("101 a refusé l'appel.").waitFor()
    await until('the declined call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['102>103 603'], 'missed_calls rows of the forwarded call')
    await setForwarding(alice, {})
  })
  await step('the same dead connection without a forward: the caller is told unreachable, not an error; a missed call for Alice', async () => {
    const missedFrom = await lastId('missed_calls')
    const ended = await dialUntilEnded(jean.page, '101')
    // 477 "Send failed": OpenSIPS could not reach the contact; the person reads the same as for nobody registered.
    expectEqual(`${ended.endStatus} ${ended.endReason}`, '477 unavailable', 'how the call to a dead contact ended')
    await jean.page.getByText('101 est injoignable.').waitFor()
    await until('the missed call in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null))
    expectEqual(await missedSince(missedFrom), ['102>101 477'], 'missed_calls rows of the call to a dead contact')
  })
  await step('the SIP connections drop: the header says offline, then the softphones come back on their own', async () => {
    const cut = relay.cut()
    if (cut < 3) throw new Error(`expected at least three relayed connections, cut ${cut}`)
    await phoneState(alice.page).getByText('Hors ligne').waitFor()
    for (const who of [alice, jean, bob]) await phoneState(who.page).getByText('En ligne').waitFor({ timeout: 40_000 })
  })
  await step('after the reconnection Jean calls Alice, who answers and hangs up', async () => {
    await dial(jean.page, '101')
    await alice.page.getByTestId('incoming-call').getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
    await alice.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await bothHearEachOther(alice, jean)
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) terminé.').waitFor()
  })
  await step('Alice signs out, which unregisters her: a call to 101 is now unreachable', async () => {
    await signOut(alice)
    const ended = await dialUntilEnded(jean.page, '101')
    // 404: no contact left for 101. A registration left behind would have given 477 (dead contact) or rung.
    expectEqual(`${ended.endStatus} ${ended.endReason}`, '404 unavailable', 'how the call to 101 ended after Alice signed out')
    await jean.page.getByText('101 est injoignable.').waitFor()
  })
  // ---- Step 11a (ADR 0022): the mailboxes, on Wazo behind OpenSIPS ----------------------------------------------
  /** The tenant's rows of voicemail_boxes, as "extension mailbox". */
  const mailboxRows = async () => (await db.query('SELECT extension, mailbox FROM voicemail_boxes WHERE tenant_id = $1 ORDER BY extension', [TENANT])).rows
  /** The number of a person's mailbox in Wazo: theirs, whatever extension they hold. */
  const numberOf = userId => mailboxNumber(holderKey(holderSecretOf(key), userId))
  /** The calls of a caller to a mailbox in the hour, as OpenSIPS counts them (0: none, or the key gone). */
  const hourOf = async key => {
    const got = await mi('cache_fetch', { system: 'local', attr: key })
    return got.result?.value === undefined ? 0 : Number(got.result.value)
  }
  /** OpenSIPS's shared variable `name` (MI shv_get), as a string. */
  const shvOf = async name => {
    const result = (await mi('shv_get', { name })).result
    // OpenSIPS 3.6 answers a variable asked by its name as { VAR: { type, value } }; the list forms are read as well.
    const value = result?.VAR?.value ?? [result?.VARs ?? result].flat(3).find(v => v && typeof v === 'object' && v.name === name)?.value
    if (value === undefined) throw new Error(`shv_get ${name}: ${JSON.stringify(result)}`)
    return String(value)
  }
  /** The print OpenSIPS counts a caller by (route[voicemail]): HMAC-SHA256 of the number with its key of the start. */
  const whoOf = async number => createHmac('sha256', await shvOf('vm_key')).update(number).digest('hex').slice(0, 24)
  /** The key of the calls of `number` to the mailbox of `extension` in the hour: by its print, by the mailbox. */
  const hourKey = async (number, extension) => `vm:h:${await whoOf(number)}:${(await mailboxRows()).find(r => r.extension === extension).mailbox}`
  /** The commands wazo-sysconfd ran for wazo-confd since `since` (module reloads of Asterisk), from its log. */
  const reloadsSince = since =>
    execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'logs', '--no-log-prefix', '--since', since, 'wazo-sysconfd'], { encoding: 'utf8', timeout: 30_000 })
      .split('\n')
      .map(l => /sysconfd: ran '([^']+)'/.exec(l)?.[1])
      .filter(Boolean)
  // Asterisk of the stack, in its container: its CLI, a command of its own.
  const COMPOSE_FILE = fileURLToPath(new URL('../../../docker/docker-compose.sip.yml', import.meta.url))
  const inAsterisk = (...args) => execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'wazo-asterisk', ...args], { encoding: 'utf8', timeout: 30_000 })
  const asteriskCli = command => inAsterisk('asterisk', '-rx', command)
  // A trace of the dialplan (verbose 3) to a file of its own while the steps call mailboxes, never to Docker's log.
  const TRACE = 'twake-e2e-trace'
  const stopTrace = () => {
    try {
      asteriskCli(`logger remove channel ${TRACE}`)
      inAsterisk('rm', '-f', `/var/log/asterisk/${TRACE}`)
    } catch {
      // Not there: nothing to stop.
    }
  }
  /** docker/wazo/check-loopback.py, now (with the sockets a call opened); root reads them. */
  const checkLoopback = () => {
    const args = ['-I', fileURLToPath(new URL('../../../docker/wazo/check-loopback.py', import.meta.url)), COMPOSE_FILE, ...(process.env.COMPOSE_PROJECT_NAME ? [process.env.COMPOSE_PROJECT_NAME] : [])]
    try {
      return process.getuid?.() === 0 ? execFileSync('python3', args, { encoding: 'utf8' }) : execFileSync('sudo', ['-n', 'python3', ...args], { encoding: 'utf8' })
    } catch (err) {
      throw new Error(`docker/wazo/check-loopback.py during a call to a mailbox: ${err.stdout ?? ''}${err.stderr ?? err.message}`, { cause: err })
    }
  }
  /** RTP flows both ways on the call of `who` (with a mailbox: its greeting one way, the caller's voice the other). */
  const rtpBothWays = async who => {
    const [before] = await stats(who.page)
    await until(`RTP both ways for ${who.name}`, async () => {
      const [s] = await stats(who.page)
      return s && s.packetsReceived > (before?.packetsReceived ?? 0) + 20 && s.packetsSent > (before?.packetsSent ?? 0) + 20 ? s : null
    })
  }
  /** The CDRs since `after` with the way the call went, as "caller>callee code via". */
  const cdrsViaSince = after =>
    until('a CDR in acc', async () => {
      const { rows } = await db.query('SELECT caller, callee, sip_code, via FROM acc WHERE id > $1 ORDER BY id', [after])
      return rows.length ? rows.map(r => `${r.caller}>${r.callee} ${r.sip_code} ${r.via || '-'}`) : null
    })
  // The greeting of a mailbox with none recorded (docker/wazo/asterisk/extensions.conf): "Votre correspondant", the
  // extension (to a caller of the platform only), "n'est pas disponible" or "est déjà en ligne", the instructions and
  // the beep, as long as this stack's prompts last (read from their files, not guessed), and 1.5 s
  // more. A message is what the caller says after it.
  const SOUNDS = new URL('../../../docker/wazo/asterisk/sounds/', import.meta.url)
  /** How long a prompt plays: the bytes of its WAV's data chunk over its byte rate. */
  const promptMs = name => {
    const wav = readFileSync(new URL(`${name}.wav`, SOUNDS))
    let byteRate = 0
    for (let at = 12; at + 8 <= wav.length; at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) % 2)) {
      const id = wav.toString('ascii', at, at + 4)
      if (id === 'fmt ') byteRate = wav.readUInt32LE(at + 16)
      if (id === 'data' && byteRate) return (wav.readUInt32LE(at + 4) / byteRate) * 1_000
    }
    throw new Error(`${name}.wav: no data chunk`)
  }
  const greetingMs = ({ extension = '', busy = false } = {}) =>
    ['vm-theperson', ...[...extension].map(d => `digits/${d}`), busy ? 'vm-isonphone' : 'vm-isunavail', 'vm-intro', 'beep'].reduce((ms, name) => ms + promptMs(name), 1_500)
  let jeanMailbox
  await step('step 11a: Wazo, out of reach since the Gateway started (nothing listened at its addresses): the Gateway was ready all along, saying its mailboxes degraded, and OpenSIPS had none; Wazo answers: without a restart, each holder of an extension has a mailbox in a TwakePhone context, handed to OpenSIPS', async () => {
    const before = await gateway.inject({ method: 'GET', url: '/ready' })
    expectEqual(before.statusCode, 200, 'GET /ready while Wazo is out of reach')
    if (!(before.json().reasons ?? []).some(r => r.startsWith('voicemail server not reached'))) throw new Error(`GET /ready while Wazo is out of reach: ${before.body}`)
    expectEqual(await mailboxRows(), [], 'voicemail_boxes while Wazo is out of reach')
    await openWazo()
    const holders = (await store.listMappings(TENANT)).map(m => m.extension).sort()
    // The Gateway tries again on its own, every 2 s here (voicemailRetryMs; 1, 5, 15 then every 30 s by default).
    const boxes = await until('a mailbox for each holder in voicemail_boxes', async () => {
      const rows = await mailboxRows()
      return rows.length === holders.length ? rows : null
    }, { timeout: 20_000 })
    expectEqual(boxes.map(b => b.extension), holders, 'the extensions with a mailbox')
    // Each holder's at a number of their own, never the extension's.
    const holderOf = new Map((await store.listMappings(TENANT)).map(m => [m.extension, m.userId]))
    for (const b of boxes) if (b.mailbox.split('@')[0] !== numberOf(holderOf.get(b.extension)) || !/^0001[0-9]{20}@[A-Za-z0-9_-]+$/.test(b.mailbox)) throw new Error(`mailbox of ${b.extension}: ${b.mailbox}`)
    expectEqual(new Set(boxes.map(b => b.mailbox.split('@')[1])).size, 1, 'contexts of the mailboxes')
    await until('the Gateway ready without its mailboxes degraded', async () => {
      const r = (await gateway.inject({ method: 'GET', url: '/ready' })).json()
      return r.ready && !(r.reasons ?? []).some(x => x.startsWith('voicemail')) ? r : null
    }, { timeout: 45_000 })
    // The messages an interrupted run left in Jean's mailbox (his, kept: he still holds 102).
    jeanMailbox = await asPerson(jean)
    const caps = (await jeanMailbox('GET', '/capabilities')).json()
    expectEqual(caps.voicemail, true, 'voicemail capability for Jean')
    for (const m of (await jeanMailbox('GET', '/voicemails')).json().items) expectEqual((await jeanMailbox('DELETE', `/voicemails/${m.id}`)).statusCode, 204, 'DELETE of a message left by an earlier run')
  })
  await step('step 11a: the dialplan Asterisk runs for OpenSIPS is docker/wazo/asterisk/extensions.conf, priority by priority (dialplan show), its refusal of a mailbox Wazo does not have included, the greeting a person recorded read at their mailbox\'s number; its trace goes to a file of its own for the steps that follow', async () => {
    const expected = {}
    let exten
    for (const line of readFileSync(new URL('../../../docker/wazo/asterisk/extensions.conf', import.meta.url), 'utf8').split('\n')) {
      const m = /^\s*(exten|same)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m) continue
      const [, name, priority, app] = m[1] === 'exten' ? /^([^,]+),([^,]+),(.*)$/.exec(m[2]) : [null, exten, ...(/^([^,]+),(.*)$/.exec(m[2]) ?? []).slice(1)]
      if (m[1] === 'exten') {
        exten = name
        expected[exten] = []
      }
      const label = /\((\w+)\)/.exec(priority)?.[1]
      expected[exten].push(`${label ? `[${label}] ` : ''}${app.replace(/\\;/g, ';')}`)
    }
    const shown = {}
    for (const line of asteriskCli('dialplan show twake-opensips').split('\n')) {
      const m = /^\s*(?:'([^']+)' =>)?\s*(?:\[(\w+)\])?\s*\d+\. (.*?)\s+\[[^\]\s]+:\d+\]\s*$/.exec(line)
      if (!m) continue
      if (m[1]) exten = m[1]
      ;(shown[exten] ??= []).push(`${m[2] ? `[${m[2]}] ` : ''}${m[3]}`)
    }
    // Asterisk lists its extensions in an order of its own: compared extension by extension.
    const byName = dialplan => Object.fromEntries(Object.entries(dialplan).sort(([a], [b]) => a.localeCompare(b)))
    expectEqual(byName(shown), byName(expected), 'the dialplan of twake-opensips Asterisk runs')
    if (!expected['_[0-9]!']?.includes('GotoIf(${VM_INFO(${TWAKE_MAILBOX},exists)}?record)')) throw new Error('the refusal of a mailbox Wazo does not have is not in extensions.conf')
    if (!expected['_[0-9]!']?.includes('Set(TWAKE_SPOOL=/var/spool/asterisk/voicemail/${CUT(TWAKE_MAILBOX,@,2)}/${CUT(TWAKE_MAILBOX,@,1)})')) throw new Error("the greeting a person recorded is not read at their mailbox's number")
    stopTrace()
    asteriskCli(`logger add channel ${TRACE} verbose(3)`)
  })
  await step('step 11a, the demo: Jean does not want to be disturbed and looks at his Messagerie vocale; Bob calls 102: Jean\'s mailbox answers, Bob\'s panel says so, Bob speaks and hangs up; the message arrives in Jean\'s Messagerie vocale as he looks at it, new, from Bob, told with its time and the unread count; Bob\'s Récents say « Messagerie vocale », Jean\'s a missed call', async () => {
    await setStatus(jean, 'Ne pas déranger')
    await jean.page.getByRole('link', { name: /^Messagerie vocale/ }).click()
    await jean.page.getByRole('heading', { level: 1, name: 'Messagerie vocale' }).waitFor()
    await jean.page.getByText('Aucun message.').waitFor()
    const started = new Date().toISOString()
    const accFrom = await lastId('acc')
    const missedFrom = await lastId('missed_calls')
    await dial(bob.page, '102')
    await connected(bob.page, 'the call of Bob answered by the mailbox')
    const answeredAt = Date.now()
    expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
    // His panel says whose mailbox he hears (Twake-Voicemail in the answer OpenSIPS relayed).
    const panel = await bob.page.getByText(/^Messagerie de /).first().textContent({ timeout: 10_000 })
    if (!panel.includes('102')) throw new Error(`Bob's call panel says ${panel}`)
    // Bob hears the greeting and the mailbox hears him: the media of a browser to Asterisk, through rtpengine.
    await rtpBothWays(bob)
    await sleep(Math.max(0, answeredAt + greetingMs({ extension: '102' }) + 4_000 - Date.now()))
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    // Live: Jean's page is not reloaded, the message comes as an event (wazo-websocketd, then the Gateway's stream).
    const message = jean.page.getByTestId('voicemail')
    await message.first().waitFor({ timeout: 20_000 })
    expectEqual(await message.count(), 1, "messages in Jean's Messagerie")
    expectEqual(await message.getAttribute('data-unread'), '1', 'the new message unread')
    const who = await message.locator('strong').textContent()
    if (!who.includes('103')) throw new Error(`the message is from ${who}, 103 expected`)
    await jean.page.getByText('Messages non lus : 1').waitFor()
    const told = await jean.page.locator('[aria-live=polite]').textContent()
    if (!/^Nouveau message de .+, reçu à \d{2}:\d{2} \(1 non lu\)/.test(told)) throw new Error(`what assistive tech is told: ${told}`)
    // The tab says it too, on whatever page: its count, and its name for assistive tech.
    await jean.page.getByRole('link', { name: 'Messagerie vocale, 1 message non lu' }).waitFor()
    expectEqual(await jean.page.getByTestId('voicemail-unread').textContent(), '1', 'the count on the tab')
    const [item, ...more] = (await jeanMailbox('GET', '/voicemails')).json().items
    expectEqual(more.length, 0, 'other messages for Jean')
    expectEqual(`${item.from} ${item.unread}`, '103 true', 'the message as the Gateway serves it')
    if (!(item.durationSec >= 2)) throw new Error(`the message lasts ${item.durationSec} s, Bob spoke 4 s`)
    // For Bob the mailbox answered; for Jean it is a missed call.
    expectEqual((await recents(bob.page, 1))[0], '102: Messagerie vocale', "Bob's newest recent call")
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.state}`, 'inbound 103 missed', "Jean's newest call")
    // Answered, by the mailbox: a CDR that says so, no row in OpenSIPS's missed_calls (Jean's history says it).
    expectEqual(await cdrsViaSince(accFrom), ['103>102 200 voicemail'], 'CDRs of the call')
    expectEqual(await missedSince(missedFrom), [], 'missed_calls rows of the call')
  })
  await step('step 11a: Bob asks, with his own account, for the recording of Jean\'s message, to mark it read and to delete it: 404 each time, against the real Wazo; the message is still Jean\'s, unread, and not in Bob\'s list', async () => {
    const [item] = (await jeanMailbox('GET', '/voicemails')).json().items
    const bobApi = await asPerson(bob)
    expectEqual((await bobApi('GET', `/voicemails/${item.id}/audio`)).statusCode, 404, "Bob's GET of the recording of Jean's message")
    expectEqual((await bobApi('POST', `/voicemails/${item.id}/read`, {})).statusCode, 404, "Bob's POST /read of Jean's message")
    expectEqual((await bobApi('DELETE', `/voicemails/${item.id}`)).statusCode, 404, "Bob's DELETE of Jean's message")
    expectEqual((await bobApi('GET', '/voicemails')).json().items.some(i => i.id === item.id), false, "Jean's message in Bob's list")
    expectEqual((await jeanMailbox('GET', '/voicemails')).json().items.map(i => `${i.id} ${i.unread}`), [`${item.id} true`], "Jean's message after Bob's requests")
  })
  await step('step 11a: Jean listens to it in the page (the recording, from Wazo), marks it read, then calls Bob back from it: Bob\'s browser rings, they talk', async () => {
    await setStatus(jean, 'Disponible')
    await jean.page.getByRole('link', { name: /^Messagerie vocale/ }).click()
    const message = jean.page.getByTestId('voicemail')
    await message.getByRole('button', { name: /^Écouter le message de / }).click()
    // It plays: its length known (a WAV of a few seconds), its time going.
    await jean.page.waitForFunction(() => {
      const a = document.querySelector('[data-testid=voicemail-audio]')
      return !!a && a.readyState >= 2 && a.duration >= 2 && a.currentTime > 0
    }, null, { timeout: 15_000 })
    await message.getByRole('button', { name: /^Marquer comme lu le message de / }).click()
    await jean.page.locator('[data-testid=voicemail][data-unread="0"]').waitFor()
    await jean.page.getByText('Tous les messages sont lus.').waitFor()
    await jean.page.getByRole('link', { name: 'Messagerie vocale', exact: true }).waitFor()
    expectEqual((await jeanMailbox('GET', '/voicemails')).json().items.map(i => i.unread), [false], 'the message read, as Wazo keeps it')
    await message.getByRole('button', { name: /^Rappeler / }).click()
    const ringing = bob.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Jean Dupont (102)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec Bob Durand (103)').waitFor()
    await bothHearEachOther(jean, bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec Bob Durand (103) terminé.').waitFor()
  })
  await step('step 11a: Jean deletes it, once he confirmed: gone from his Messagerie vocale, and from Wazo; the focus on the title, the deletion told', async () => {
    await jean.page.getByRole('link', { name: /^Messagerie vocale/ }).click()
    await jean.page.getByTestId('voicemail').getByRole('button', { name: /^Supprimer le message de / }).click()
    // Asked first: nothing deleted yet.
    await jean.page.getByRole('group', { name: /^Supprimer pour de bon le message de / }).waitFor()
    expectEqual((await jeanMailbox('GET', '/voicemails')).json().items.length, 1, "Jean's messages before he confirmed")
    await jean.page.getByTestId('voicemail').getByRole('button', { name: /^Confirmer la suppression du message de / }).click()
    await jean.page.getByText('Aucun message.').waitFor()
    expectEqual(await jean.page.evaluate(() => document.activeElement?.tagName), 'H1', 'the focus once the last message is deleted')
    if (!/^Message de .+ supprimé\./.test(await jean.page.locator('[aria-live=polite]').textContent())) throw new Error('the deletion was not told')
    expectEqual((await jeanMailbox('GET', '/voicemails')).json().items, [], "Jean's messages after he deleted it")
  })
  await step('step 11a: Jean declines Bob\'s call: Bob reaches Jean\'s mailbox (its "busy" greeting) and hangs up before the beep: no message', async () => {
    const started = new Date().toISOString()
    const accFrom = await lastId('acc')
    const missedFrom = await lastId('missed_calls')
    await dial(bob.page, '102')
    const ringing = jean.page.getByTestId('incoming-call')
    await ringing.getByText('Appel entrant de Bob Durand (103)').waitFor({ timeout: 20_000 })
    await ringing.getByRole('button', { name: 'Refuser' }).click()
    await connected(bob.page, 'the call of Bob answered by the mailbox')
    await rtpBothWays(bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    expectEqual(await cdrsViaSince(accFrom), ['103>102 200 voicemail'], 'CDRs of the call')
    // Jean's refusal is told as before (missed_calls, 603); the mailbox then answered Bob.
    expectEqual(await missedSince(missedFrom), ['103>102 603'], 'missed_calls rows of the call')
    const jeanCall = await newestCall('jdupont', started)
    expectEqual(`${jeanCall.direction} ${jeanCall.remoteNumber} ${jeanCall.state}`, 'inbound 103 rejected', "Jean's newest call")
    // The call over at OpenSIPS (no dialog to 102 left) and at Bob's (Asterisk answered his BYE).
    await until('the end of the call to the mailbox at OpenSIPS', async () => (((await mi('dlg_list')).result?.Dialogs ?? []).some(d => JSON.stringify(d).includes('sip:102@')) ? null : true))
    await until('the end of the call on Bob side', async () => ((await calls(bob.page)).length === 0 ? true : null))
    expectEqual((await jeanMailbox('GET', '/voicemails')).json().items, [], "Jean's messages after Bob hung up during the greeting")
  })
  await step('step 11a: Jean does not answer: after his no-answer forward to 104 (5 s), where nobody answers either, the mailbox of 102 takes the call, not that of 104; Bob\'s message is Jean\'s', async () => {
    // The desk signed out: nobody can answer 104.
    await setForwarding(jean, { noAnswer: '104', delay: '5' })
    try {
      const accFrom = await lastId('acc')
      await dial(bob.page, '102')
      await jean.page.getByTestId('incoming-call').getByText('Appel entrant de Bob Durand (103)').waitFor({ timeout: 20_000 })
      await connected(bob.page, 'the call of Bob answered by the mailbox')
      const answeredAt = Date.now()
      await rtpBothWays(bob)
      await sleep(Math.max(0, answeredAt + greetingMs({ extension: '102' }) + 3_000 - Date.now()))
      await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
      expectEqual(await cdrsViaSince(accFrom), ['103>102 200 voicemail'], 'CDRs of the call')
      const items = await until("Bob's message in Jean's mailbox", async () => {
        const { items } = (await jeanMailbox('GET', '/voicemails')).json()
        return items.length ? items : null
      })
      expectEqual(items.map(i => `${i.from} ${i.unread}`), ['103 true'], "Jean's messages")
      expectEqual((await jeanMailbox('DELETE', `/voicemails/${items[0].id}`)).statusCode, 204, 'DELETE of the message')
    } finally {
      await setForwarding(jean, {})
    }
  })
  await step('step 11a: the AMI account of this stack\'s wazo-sysconfd, against the real Asterisk: refused Command, Originate and UpdateConfig; let do what docker/wazo/asterisk/entrypoint.sh and ADR 0022 say `system` lets it (GetConfig, the manager\'s file included) and VoicemailUsersList', async () => {
    const actions = [
      ['Action: Command', 'Command: core show version'],
      ['Action: Originate', 'Channel: Local/s@twake-e2e-none', 'Application: Wait', 'Data: 1'],
      ['Action: UpdateConfig', 'SrcFilename: manager.conf', 'DstFilename: manager.conf', 'Action-000000: NewCat', 'Cat-000000: twake-e2e'],
      ['Action: GetConfig', 'Filename: manager.d/01-wazo.conf'],
      ['Action: VoicemailUsersList']
    ]
    const answers = await new Promise((resolve, reject) => {
      const socket = connect(5038, '127.0.0.1')
      const got = []
      let buffer = ''
      let greeted = false
      const done = err => {
        clearTimeout(timer)
        socket.destroy()
        if (err) reject(err)
        else resolve(got)
      }
      const timer = setTimeout(() => done(new Error(`the AMI answered ${got.length} of ${actions.length + 1}: ${JSON.stringify(got)}`)), 15_000)
      socket.on('error', done)
      socket.on('data', chunk => {
        buffer += chunk.toString('latin1')
        if (!greeted) {
          const end = buffer.indexOf('\r\n')
          if (end < 0) return
          buffer = buffer.slice(end + 2)
          greeted = true
          const login = ['Action: Login', 'ActionID: e2e-0', 'Username: twake_sysconfd', 'Secret: twake-wazo-dev-only-sysconfd', 'Events: off']
          socket.write([login, ...actions.map((a, i) => [...a, `ActionID: e2e-${i + 1}`]), ['Action: Logoff']].map(lines => `${lines.join('\r\n')}\r\n\r\n`).join(''))
        }
        for (let at = buffer.indexOf('\r\n\r\n'); at >= 0; at = buffer.indexOf('\r\n\r\n')) {
          const block = Object.fromEntries(buffer.slice(0, at).split('\r\n').filter(l => l.includes(': ')).map(l => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]))
          buffer = buffer.slice(at + 4)
          const n = /^e2e-(\d+)$/.exec(block.ActionID ?? '')?.[1]
          if (n !== undefined && block.Response && !got[Number(n)]) got[Number(n)] = block
          if (got.filter(Boolean).length === actions.length + 1) done()
        }
      })
    })
    expectEqual(answers[0].Response, 'Success', 'the login of twake_sysconfd')
    for (const [i, name] of [[1, 'Command'], [2, 'Originate'], [3, 'UpdateConfig']]) expectEqual(`${answers[i].Response} ${answers[i].Message}`, 'Error Permission denied', `${name} as twake_sysconfd`)
    // What the ADR says it is let do: read a configuration file, the manager's with the accounts in it.
    expectEqual(answers[4].Response, 'Success', 'GetConfig as twake_sysconfd')
    if (!Object.entries(answers[4]).some(([k, v]) => /^Category-/.test(k) && v === 'twake_sysconfd')) throw new Error(`GetConfig of manager.d/01-wazo.conf: ${JSON.stringify(answers[4])}`)
    expectEqual(answers[5].Response, 'Success', 'VoicemailUsersList as twake_sysconfd')
  })
  await step('step 11a: Alice, signed out, has no window: Bob\'s call to 101 goes to her mailbox at once; one that Wazo no longer has (voicemail_boxes out of date) gives Bob what he had without it: 104 unreachable (404), and counts for nothing in Bob\'s hour of calls to it', async () => {
    const accFrom = await lastId('acc')
    const dialled = Date.now()
    await dial(bob.page, '101')
    await connected(bob.page, 'the call of Bob answered by the mailbox')
    const after = Date.now() - dialled
    if (after > 10_000) throw new Error(`the mailbox of 101 answered ${after} ms after the call, at once expected`)
    await rtpBothWays(bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    expectEqual(await cdrsViaSince(accFrom), ['103>101 200 voicemail'], 'CDRs of the call')
    const [row] = (await db.query("SELECT mailbox FROM voicemail_boxes WHERE extension = '104'")).rows
    const gone = `vm:h:${await whoOf('103')}:104@twake-gone`
    try {
      await db.query("UPDATE voicemail_boxes SET mailbox = '104@twake-gone' WHERE extension = '104'")
      const ended = await dialUntilEnded(bob.page, '104')
      expectEqual(`${ended.endStatus} ${ended.endReason}`, '404 unavailable', 'how the call to a mailbox Wazo does not have ended')
      await bob.page.getByText('104 est injoignable.').waitFor()
      // Counted when it went to the mailbox, counted out when Asterisk refused it: nothing left (never -1).
      expectEqual(await hourOf(gone), 0, "Bob's calls to the mailbox Wazo does not have in the hour, after its refusal")
    } finally {
      await db.query("UPDATE voicemail_boxes SET mailbox = $1 WHERE extension = '104'", [row.mailbox])
    }
  })
  await step('step 11a: Jean does not want to be disturbed; the operator calls his direct number +33 1 99 00 01 02 from +33 6 39 98 00 08 with an X-Twake-Mailbox and an X-Twake-Voicemail of its own (Bob\'s mailbox): Jean\'s mailbox answers the operator (200, plain RTP, sound both ways, VOICEMAIL_MAX_CALL_SEC at most); meanwhile, under a cap of one external call at a time, Alice\'s call to the operator still goes; the caller speaks and hangs up; the CDR says voicemail; the message is Jean\'s, none Bob\'s; the caps count nothing, no alert', async () => {
    alice = await open('amartin', 'Alice Martin')
    await phoneState(alice.page).getByText('En ligne').waitFor({ timeout: 20_000 })
    const api = await asPerson(alice)
    const jeanApi = await asPerson(jean)
    const bobApi = await asPerson(bob)
    const bobsBox = (await mailboxRows()).find(r => r.extension === '103').mailbox
    const bobsBefore = (await bobApi('GET', '/voicemails')).json().items.length
    await setStatus(jean, 'Ne pas déranger')
    const started = new Date().toISOString()
    const accFrom = await lastId('acc')
    const usage = async () => (await db.query('SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum(seconds), 0)::int AS seconds FROM outbound_usage')).rows[0]
    const used = await usage()
    expectEqual((await api('PUT', '/admin/outbound', { policy: { caps: { concurrent: 1 }, fraud: FRAUD } })).statusCode, 200, 'PUT /admin/outbound (one external call at a time)')
    try {
      const placed = await operator.call('+33199000102', { from: '+33639980008', ruri: TRUNK_LOGIN, headers: [`X-Twake-Mailbox: ${bobsBox}`, 'X-Twake-Voicemail: busy'] })
      const answer = await placed.final
      const answeredAt = Date.now()
      // Bob's mailbox would have been refused by the dialplan (not the extension called), the caller given Jean's 480.
      expectEqual(answer.status, 200, "the mailbox's answer to the operator")
      if (!plainRtp(answer.body)) throw new Error(`the answer of the mailbox to the operator: ${answer.body}`)
      if (/^Twake-/im.test(answer.raw.split('\r\n\r\n')[0])) throw new Error(`a header of the platform sent to the operator: ${answer.raw.split('\r\n\r\n')[0]}`)
      expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
      const dialog = await until('the dialog of the call to the mailbox', async () => ((await mi('dlg_list')).result?.Dialogs ?? []).find(d => d.callid === placed.callId) ?? null)
      const left = Number(dialog.timeout) - Math.floor(Date.now() / 1000)
      if (!(left > 0 && left <= 300)) throw new Error(`the call to the mailbox ends in ${left} s, VOICEMAIL_MAX_CALL_SEC (300) at most expected`)
      // Not an external call of the platform: Alice's still goes under the cap of one (the operator busy, 486).
      operator.state.next.push({ reply: '486 Busy Here' })
      const out = await dialUntilEnded(alice.page, '06 39 98 00 09')
      await operator.invited(invite => invite.uri === 'sip:+33639980009@operator.example')
      expectEqual(`${out.endStatus}`, '486', "how Alice's call to the operator ended during the call to the mailbox")
      await until('the greeting at the operator', () => (placed.media.stats.voiced > 20 ? true : null))
      // Wazo still listens on the loopback only, with the media of this call open.
      console.log(checkLoopback().trim().replace(/^/gm, '     '))
      await sleep(Math.max(0, answeredAt + greetingMs() + 4_000 - Date.now()))
      expectEqual((await placed.hangup()).status, 200, 'answer to the operator BYE')
    } finally {
      expectEqual((await api('PUT', '/admin/outbound', { policy: { fraud: FRAUD } })).statusCode, 200, 'PUT /admin/outbound (no cap)')
      await setStatus(jean, 'Disponible')
    }
    expectEqual(await cdrsViaSince(accFrom), ['+33639980008>102 200 voicemail'], 'CDRs of the call')
    const items = await until("the operator's message in Jean's mailbox", async () => {
      const { items } = (await jeanApi('GET', '/voicemails')).json()
      return items.some(i => i.from === '+33639980008') ? items : null
    })
    const [message, ...others] = items
    expectEqual(`${message.from} ${message.unread} ${others.length}`, '+33639980008 true 0', "Jean's messages")
    if (!(message.durationSec >= 2)) throw new Error(`the message lasts ${message.durationSec} s, the operator spoke 4 s`)
    expectEqual((await bobApi('GET', '/voicemails')).json().items.length, bobsBefore, "Bob's messages")
    expectEqual(await usage(), used, 'outbound_usage (the caps)')
    expectEqual((await store.listAlerts(TENANT, { limit: 100 })).filter(a => a.lastAt > started).map(a => `${a.alert.kind} ${a.alert.param}`), [], 'alerts since the call')
    expectEqual((await jeanApi('DELETE', `/voicemails/${message.id}`)).statusCode, 204, 'DELETE of the message')
  })
  await step('step 11b, the demo: Jean does not want to be disturbed and looks at his Messagerie vocale; the operator calls his direct number from +33 6 39 98 00 11 and the caller leaves a message in French; it arrives in Jean\'s Messagerie vocale, transcribed by LinTO STT, the text under it; the bot tells Jean in Twake Chat (his Matrix account on the stack\'s homeserver), in a room of his own with it: caller, time, duration, the text and the link to listen to it in TwakePhone; nothing for Bob nor Alice; Jean deletes the message: the notice is withdrawn in Chat; another message, then he erases his history: the message, its transcription and its notice gone, the bot out of the room', async () => {
    const jeanApi = await asPerson(jean)
    const bobApi = await asPerson(bob)
    const aliceApi = await asPerson(alice)
    // Réglages first (where the status is set), then his Messagerie vocale, which he keeps looking at.
    await setStatus(jean, 'Ne pas déranger')
    await jean.page.getByRole('link', { name: /^Messagerie vocale/ }).click()
    await jean.page.getByRole('heading', { level: 1, name: 'Messagerie vocale' }).waitFor()
    // Jean's Matrix account without a name nor an avatar: Synapse says his profile is not found (404 M_NOT_FOUND), not
    // that he has no account (404 M_UNKNOWN): his notices come all the same.
    const jeanId = `@jdupont:${MATRIX_SERVER}`
    await matrix(matrixTokens.jdupont, 'PUT', `/profile/${encodeURIComponent(jeanId)}/displayname`, { displayname: '' })
    const profile = await matrix(matrixTokens['twakephone-bot'], 'GET', `/profile/${encodeURIComponent(jeanId)}`).then(
      () => 'found',
      err => err.message
    )
    if (!/: 404 M_NOT_FOUND$/.test(profile)) throw new Error(`Jean's profile without a name: ${profile}, 404 M_NOT_FOUND expected`)
    const nobody = await matrix(matrixTokens['twakephone-bot'], 'GET', `/profile/${encodeURIComponent(`@nobody-e2e:${MATRIX_SERVER}`)}`).then(
      () => 'found',
      err => err.message
    )
    if (!/: 404 M_UNKNOWN$/.test(nobody)) throw new Error(`the profile of an account nobody has: ${nobody}, 404 M_UNKNOWN expected`)
    const started = new Date().toISOString()
    try {
      const placed = await operator.call('+33199000102', { from: '+33639980011', ruri: TRUNK_LOGIN })
      const answer = await placed.final
      const answeredAt = Date.now()
      expectEqual(answer.status, 200, "the mailbox's answer to the operator")
      expectEqual(await jean.page.getByTestId('incoming-call').count(), 0, 'incoming calls on Jean side')
      // After the beep: the caller's words (4.8 s), then a second of silence before hanging up.
      await sleep(Math.max(0, answeredAt + greetingMs() + 500 - Date.now()))
      await placed.media.say(CALLER_MESSAGE)
      await sleep(1_000)
      expectEqual((await placed.hangup()).status, 200, 'answer to the operator BYE')
    } catch (err) {
      await setStatus(jean, 'Disponible')
      throw err
    }
    // In his Messagerie vocale as he looks at it, then its transcription under it, said to assistive tech.
    // (Available again only at the end: setting it leaves the Messagerie vocale.)
    const item = await until("the caller's message in Jean's mailbox", async () => (await jeanApi('GET', '/voicemails')).json().items.find(i => i.from === '+33639980011') ?? null, { timeout: 20_000 })
    const shown = jean.page.locator(`[data-testid=voicemail][data-id="${item.id}"]`)
    await shown.waitFor({ timeout: 10_000 })
    const transcript = shown.locator('[data-testid=voicemail-transcript][data-status=done]')
    await transcript.waitFor({ timeout: 60_000 })
    const served = await until('the transcription as the Gateway serves it', async () => {
      const v = (await jeanApi('GET', '/voicemails')).json().items.find(i => i.id === item.id)
      return v?.transcript?.status === 'done' ? v.transcript : null
    })
    console.log(`     transcription: « ${served.text} »`)
    // Not a word-for-word check (a small model, a synthetic voice through a telephone line): words of the phrase heard
    // (not « jean », the very name of the person called).
    const heard = ['bonjour', 'paul', 'merci', 'rappeler', 'demain', 'matin'].filter(w => served.text.toLowerCase().includes(w))
    if (heard.length < 2) {
      // What LinTO hears of the phrase itself, not through the line: tells the line from the voice.
      const direct = await new LintoTranscription({ url: LINTO_URL, timeoutMs: 60_000 }).transcribe(new Uint8Array(CALLER_WAV)).then(r => r.text, err => `(${err.message})`)
      throw new Error(`the transcription « ${served.text} » has ${heard.length} word(s) of the phrase said, 2 at least expected (of the recording itself, not through the line: « ${direct} »)`)
    }
    expectEqual((await transcript.textContent()).trim(), `Transcription : « ${served.text} »`, 'the transcription in the Messagerie vocale')
    await jean.page.locator('[aria-live=polite]').filter({ hasText: /transcrit\.\s?$/ }).waitFor({ timeout: 10_000 })
    // The bot's notice: in one room only, the bot's with Jean (invited), nobody else in it; one room of the bot with him.
    const bot = matrixTokens['twakephone-bot']
    const noticesOf = async () => {
      const rooms = []
      for (const roomId of (await matrix(bot, 'GET', '/joined_rooms')).joined_rooms) {
        const { chunk } = await matrix(bot, 'GET', `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`)
        const notices = chunk.filter(e => e.type === 'm.room.message' && String(e.content?.body ?? '').includes('+33639980011'))
        if (notices.length) rooms.push({ roomId, notices })
      }
      return rooms
    }
    const roomsWithJean = async () => {
      const rooms = []
      for (const roomId of (await matrix(bot, 'GET', '/joined_rooms')).joined_rooms) {
        const { chunk } = await matrix(bot, 'GET', `/rooms/${encodeURIComponent(roomId)}/members`)
        if (chunk.some(e => e.state_key === `@jdupont:${MATRIX_SERVER}` && ['join', 'invite'].includes(e.content.membership))) rooms.push(roomId)
      }
      return rooms
    }
    const withNotices = await until("the bot's notice of the message", async () => ((await noticesOf()).length ? noticesOf() : null), { timeout: 30_000 })
    expectEqual(withNotices.length, 1, "the bot's rooms with a notice of the message")
    const [found] = withNotices
    expectEqual(found.notices.length, 1, "the bot's notices of the message")
    expectEqual(await roomsWithJean(), [found.roomId], "the bot's rooms with Jean")
    const [notice] = found.notices
    const body = notice.content.body
    console.log(`     notice: ${body.replace(/\n/g, ' | ')}`)
    expectEqual(notice.content.msgtype, 'm.notice', 'the kind of message the bot sends')
    for (const part of ['Nouveau message vocal du +33639980011', `durée 0:0`, `Transcription : « ${served.text} »`, `Écouter dans TwakePhone : ${appOrigin}/voicemail`]) {
      if (!body.includes(part)) throw new Error(`the notice « ${body} » does not say « ${part} »`)
    }
    const members = (await matrix(bot, 'GET', `/rooms/${encodeURIComponent(found.roomId)}/members`)).chunk.filter(e => ['join', 'invite'].includes(e.content.membership)).map(e => e.state_key).sort()
    expectEqual(members, [`@jdupont:${MATRIX_SERVER}`, `@twakephone-bot:${MATRIX_SERVER}`], 'the people of the room of the notice')
    // Jean's Twake Chat: invited to it, he joins and reads the notice.
    const jeanMx = matrixTokens.jdupont
    const { rooms } = await matrix(jeanMx, 'GET', '/sync?timeout=0')
    const room = found.roomId
    if (!rooms?.invite?.[room] && !rooms?.join?.[room]) throw new Error("Jean's Twake Chat has no invitation of the bot's room")
    if (rooms?.invite?.[room]) await matrix(jeanMx, 'POST', `/join/${encodeURIComponent(room)}`, {})
    const read = (await matrix(jeanMx, 'GET', `/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=50`)).chunk.find(e => e.event_id === notice.event_id)
    expectEqual(read?.content?.body, body, 'the notice as Jean reads it in Chat')
    // Nobody else: Bob and Alice in no room of that notice, their mailboxes without the message.
    for (const [who, token] of [['Bob', matrixTokens.bdurand], ['Alice', matrixTokens.amartin]]) {
      const theirs = await matrix(token, 'GET', '/sync?timeout=0')
      if (theirs.rooms?.invite?.[room] || theirs.rooms?.join?.[room]) throw new Error(`${who} is in the room of Jean's notice`)
      await matrix(token, 'GET', `/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=5`).then(
        () => {
          throw new Error(`${who} reads the room of Jean's notice`)
        },
        err => {
          if (!/: 403 M_FORBIDDEN/.test(err.message)) throw err
        }
      )
    }
    for (const [who, api] of [['Bob', bobApi], ['Alice', aliceApi]]) {
      const { items } = (await api('GET', '/voicemails')).json()
      expectEqual(items.some(i => i.id === item.id), false, `Jean's message in ${who}'s mailbox`)
    }
    expectEqual((await store.listAlerts(TENANT, { limit: 100 })).filter(a => a.lastAt > started && a.alert.kind === 'voicemail').map(a => a.alert.param), [], 'voicemail alerts since the call')
    // Jean deletes it: the notice withdrawn (redacted) in Chat, its transcription gone.
    await shown.getByRole('button', { name: /^Supprimer le message de / }).click()
    await shown.getByRole('button', { name: /^Confirmer la suppression du message de / }).click()
    await shown.waitFor({ state: 'detached', timeout: 10_000 })
    await until('the notice withdrawn in Chat', async () => {
      const e = await matrix(jeanMx, 'GET', `/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(notice.event_id)}`)
      return e.unsigned?.redacted_because && !e.content?.body ? e : null
    }, { timeout: 20_000 })
    expectEqual((await jeanApi('GET', '/voicemails')).json().items.some(i => i.id === item.id), false, "the message in Jean's mailbox after he deleted it")
    // His right to erasure: another message, its notice in the same room; he erases his history: the message gone from
    // his mailbox, its transcription with it, the notice withdrawn in Chat, the bot out of the room.
    // That message's event missed: wazo-websocketd out of the Gateway's reach meanwhile (its relay cut and refusing),
    // caught up once it is back (the stream reconnected, the mailboxes reconciled).
    const events = wazoVia.websocketdUrl.relay
    events.refuse()
    if (events.cut() < 1) throw new Error("no connection of the Gateway to wazo-websocketd to cut")
    try {
      const placed = await operator.call('+33199000102', { from: '+33639980011', ruri: TRUNK_LOGIN })
      const answer = await placed.final
      const answeredAt = Date.now()
      expectEqual(answer.status, 200, "the mailbox's answer to the operator (the second message)")
      await sleep(Math.max(0, answeredAt + greetingMs() + 500 - Date.now()))
      await placed.media.say(CALLER_MESSAGE)
      await sleep(1_000)
      expectEqual((await placed.hangup()).status, 200, 'answer to the operator BYE (the second message)')
    } catch (err) {
      events.open()
      await setStatus(jean, 'Disponible')
      throw err
    }
    // In Wazo, the Gateway not told: no row of it.
    const left = await until('the second message in Wazo', async () => (await wazo.listMessages({ extension: '102', userId: 'jdupont' })).find(i => i.from === '+33639980011') ?? null, { timeout: 20_000 })
    const gatewayDb = new pg.Pool({ connectionString: GATEWAY_DB_URL, max: 1 })
    try {
      const rowsOf = async id => Number((await gatewayDb.query('SELECT count(*) AS n FROM voicemail_transcripts WHERE tenant_id = $1 AND message_id = $2', [TENANT, id])).rows[0].n)
      await sleep(2_000)
      expectEqual(await rowsOf(left.id), 0, 'rows of the message whose event was missed, before the stream is back')
      events.open()
      await until('the message caught up', async () => ((await rowsOf(left.id)) ? true : null), { timeout: 30_000 })
    } finally {
      events.open()
      await gatewayDb.end()
    }
    const second = await until("the second message in Jean's mailbox", async () => (await jeanApi('GET', '/voicemails')).json().items.find(i => i.from === '+33639980011') ?? null, { timeout: 20_000 })
    expectEqual(second.id, left.id, 'the message caught up')
    const again = await until("the bot's notice of the second message", async () => {
      const rooms = await noticesOf()
      return rooms.length && rooms.every(r => r.notices.every(e => e.event_id !== notice.event_id)) ? rooms : null
    }, { timeout: 90_000 })
    expectEqual(again.map(r => [r.roomId, r.notices.length]), [[room, 1]], "the bot's rooms with a notice of the second message")
    const [secondNotice] = again[0].notices
    const erased = await jeanApi('DELETE', '/me/history')
    expectEqual(erased.statusCode, 200, 'DELETE /me/history')
    expectEqual([erased.json().voicemailErasure, erased.json().chatNotices], ['asked', undefined], 'the erasure, as the Gateway answers it')
    await until("Jean's mailbox erased", async () => ((await jeanApi('GET', '/voicemails')).json().items.some(i => i.id === second.id) ? null : true), { timeout: 30_000 })
    await until('the notice of the second message withdrawn in Chat', async () => {
      const e = await matrix(jeanMx, 'GET', `/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(secondNotice.event_id)}`)
      return e.unsigned?.redacted_because && !e.content?.body ? e : null
    }, { timeout: 30_000 })
    await until('the bot out of the room with Jean', async () => ((await roomsWithJean()).length ? null : true), { timeout: 30_000 })
    expectEqual((await matrix(bot, 'GET', '/joined_rooms')).joined_rooms.includes(room), false, 'the room with Jean among those of the bot')
    await setStatus(jean, 'Disponible')
  })
  await step('step 11a: the operator calls the desk\'s direct number +33 1 99 00 01 04 (the desk signed out: nobody to reach), whose fallback is the ring group 210 of Bob, in a call with Jean (his window answers busy at once): the mailbox of 104 takes the call; for the desk it is a missed call, nobody of the group took it, the message is the desk\'s', async () => {
    const api = await asPerson(alice)
    const { id: _, ...staff } = (await api('GET', '/admin/dids')).json().items.find(d => d.id === 'staff')
    expectEqual((await api('POST', '/admin/groups', { number: '210', name: 'Repli', members: ['103'] })).statusCode, 201, 'creating group 210')
    const started = new Date().toISOString()
    let callFrom
    try {
      expectEqual((await api('PUT', '/admin/dids/staff', { ...staff, fallbackTarget: '210' })).statusCode, 200, 'PUT /admin/dids/staff (its fallback the group 210)')
      await dial(jean.page, '103')
      await bob.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
      await jean.page.getByText('En communication avec Bob Durand (103)').waitFor()
      callFrom = await lastId('acc')
      const placed = await operator.call('+33199000104', { from: '+33639980031', ruri: TRUNK_LOGIN })
      const answer = await placed.final
      const answeredAt = Date.now()
      expectEqual(answer.status, 200, "the answer of the desk's mailbox to the operator")
      await until('the greeting at the operator', () => (placed.media.stats.voiced > 20 ? true : null))
      await sleep(Math.max(0, answeredAt + greetingMs() + 3_000 - Date.now()))
      expectEqual((await placed.hangup()).status, 200, 'answer to the operator BYE')
    } finally {
      await api('PUT', '/admin/dids/staff', staff)
      await api('DELETE', '/admin/groups/210')
      if (await jean.page.getByRole('button', { name: 'Raccrocher' }).count()) {
        await jean.page.getByRole('button', { name: 'Raccrocher' }).click()
        await bob.page.getByText('Appel avec Jean Dupont (102) terminé.').waitFor()
      }
    }
    // Answered by the mailbox of the number dialled: the CDR says so (not the member of the group, nor answered).
    const cdrs = await until('the CDR of the call from the operator', async () => {
      const { rows } = await db.query("SELECT caller, callee, sip_code, via FROM acc WHERE id > $1 AND caller = '+33639980031' ORDER BY id", [callFrom])
      return rows.length ? rows.map(r => `${r.caller}>${r.callee} ${r.sip_code} ${r.via || '-'}`) : null
    })
    expectEqual(cdrs, ['+33639980031>104 200 voicemail'], 'CDRs of the call')
    const deskCall = await newestCall('accueil', started)
    expectEqual(`${deskCall.direction} ${deskCall.remoteNumber} ${deskCall.state} ${!!deskCall.answered}`, 'inbound +33639980031 missed false', "the desk's newest call")
    // Bob was busy: not a call he took, nor one a colleague took (call.taken).
    for (const entry of (await store.listHistory(TENANT, 'bdurand', { limit: 5 })).items.filter(e => e.startedAt > started && e.remoteNumber === '+33639980031'))
      if (entry.answered || entry.state !== 'missed') throw new Error(`Bob's history: ${JSON.stringify(entry)}`)
    const desk104 = { extension: '104', userId: 'accueil' }
    const messages = await until("the operator's message in the desk's mailbox", async () => {
      const items = await wazo.listMessages(desk104)
      return items.some(i => i.from === '+33639980031') ? items : null
    })
    for (const m of messages) expectEqual(await wazo.deleteMessage(desk104, m.id), true, 'DELETE of a message of the desk')
    await signOut(alice)
  })
  await step('step 11a: a phone of the platform (an agent of this process, 135) calls Jean, who does not want to be disturbed, with an X-Twake-Mailbox of its own (Bob\'s mailbox) and an X-Twake-Voicemail: Jean\'s mailbox answers all the same (OpenSIPS removes those a caller sends before it writes its own): those headers never reached it', async () => {
    await store.upsertMapping({ tenantId: TENANT, userId: 'ua-135', extension: '135', displayName: 'Fenêtre 135' })
    const { credential } = await registry.forTenant(TENANT).getSession({ id: 'ua-135', tenantId: TENANT, displayName: 'Fenêtre 135', extension: '135' }, { id: 'ua', type: 'browser', label: 'UA' })
    const bobsBox = (await mailboxRows()).find(r => r.extension === '103').mailbox
    await setStatus(jean, 'Ne pas déranger')
    const accFrom = await lastId('acc')
    const phone = await sipPhone({ proxy: SIP_UDP, domain: SIP_DOMAIN, user: '135', password: credential })
    try {
      expectEqual(await phone.register(), 200, 'registration of 135')
      const call = await phone.dial('102', { extra: [`X-Twake-Mailbox: ${bobsBox}`, 'X-Twake-Voicemail: busy'] })
      expectEqual(call.final?.status, 200, "the answer to the call of 135 to 102 (Jean's mailbox)")
      expectEqual((await phone.hangup(call)).status, 200, 'answer to the BYE of 135')
    } finally {
      await phone.close()
      await setStatus(jean, 'Disponible')
    }
    expectEqual(await cdrsViaSince(accFrom), ['135>102 200 voicemail'], 'CDRs of the call')
  })
  await step('step 11a: Asterisk\'s trace of the calls to the mailboxes since: the extension was said (SayDigits) to the callers of the platform who heard the greeting, never to a caller from outside', async () => {
    let trace
    try {
      trace = inAsterisk('cat', `/var/log/asterisk/${TRACE}`)
    } finally {
      stopTrace()
    }
    const byCall = new Map()
    for (const line of trace.split('\n')) {
      const id = /\]\[(C-[0-9a-f]+)\]/.exec(line)?.[1]
      if (id) byCall.set(id, [...(byCall.get(id) ?? []), line])
    }
    const external = []
    const internal = []
    for (const lines of byCall.values()) {
      const set = lines.find(l => /Set\("[^"]+", "TWAKE_EXTERNAL=[01]"\)/.test(l))
      if (!set) continue
      const call = { said: lines.some(l => /Playing 'digits\//.test(l)), execIf: lines.find(l => /ExecIf\("[^"]+", "[01]\?SayDigits\(/.test(l)) }
      ;(set.includes('TWAKE_EXTERNAL=1') ? external : internal).push(call)
    }
    if (!external.some(c => c.execIf?.includes('"0?SayDigits(')) || external.some(c => c.said || (c.execIf && !c.execIf.includes('"0?SayDigits(')))) throw new Error(`the calls from outside: ${JSON.stringify(external)}`)
    if (!internal.some(c => c.said && c.execIf?.includes('"1?SayDigits(102)"'))) throw new Error(`the calls of the platform: ${JSON.stringify(internal)}`)
  })
  await step('step 11a: the caps of the calls to the mailboxes, lowered a moment (MI shv_set: one call of a caller at a time, one of all who have no number to a mailbox, two of a caller to a mailbox in an hour): the operator calls Alice (101, signed out: her mailbox at once) from +33 6 39 98 00 51; a second call of that number meanwhile gets what it would have had without the mailbox and counts for nothing in the hour; a third once the first ended is the mailbox\'s, a fourth is past the hour\'s; a number hidden at the caller\'s request (Privacy: id) counts as that caller\'s, by a keyed print of it (never the number in a key, a profile or a value of the dialog), apart from the others: a second call of it waits, another hidden number goes; those with no number at all are one caller at that mailbox: the second at once gets its refusal, and the administrators are told; all of them together have a bounded share of the places (lowered to one): one at Alice\'s mailbox, another is refused at Jean\'s while a caller with a number gets it, and the administrators are told', async () => {
    const shv = (name, value) => mi('shv_set', { name, type: 'int', value })
    const alicesBox = (await mailboxRows()).find(r => r.extension === '101').mailbox
    const jeansBox = (await mailboxRows()).find(r => r.extension === '102').mailbox
    const keys = [await hourKey('+33639980051', '101'), await hourKey('+33639980052', '101'), await hourKey('+33639980053', '101'), `vm:h:*hidden:${alicesBox}:${alicesBox}`, `vm:told:hidden-calls:${alicesBox}`, 'vm:told:hidden-all', 'vm:told:calls-all', `vm:h:*hidden:${jeansBox}:${jeansBox}`, await hourKey('+33639980054', '102'), await hourKey('+33639980055', '102')]
    for (const key of keys) await mi('cache_remove', { system: 'local', attr: key })
    await shv('vm_per_caller', 1)
    await shv('vm_hidden', 1)
    await shv('vm_per_hour', 2)
    const open = []
    /** A call of the operator to a direct number (Alice's by default): its final answer, the call kept open when answered. */
    const ring = async (from, headers = [], to = '+33199000101') => {
      const placed = await operator.call(to, { from, ruri: TRUNK_LOGIN, headers })
      const answer = await placed.final
      if (answer.status === 200) open.push(placed)
      return { placed, status: answer.status }
    }
    const hangUp = async placed => {
      expectEqual((await placed.hangup()).status, 200, 'answer to the operator BYE')
      open.splice(open.indexOf(placed), 1)
      await until('the end of the call at OpenSIPS', async () => (((await mi('dlg_list')).result?.Dialogs ?? []).some(d => d.callid === placed.callId) ? null : true))
    }
    const accFrom = await lastId('acc')
    const started = new Date().toISOString()
    try {
      const first = await ring('+33639980051')
      expectEqual(first.status, 200, 'the answer of the mailbox to the first call')
      expectEqual(await hourOf(keys[0]), 1, 'the calls of +33639980051 to 101 in the hour, the first answered')
      // At the same time: past the cap of one, what the call would have had without the mailbox (nobody to reach).
      const second = await ring('+33639980051')
      expectEqual(second.status, 404, 'the second call at the same time')
      expectEqual(await hourOf(keys[0]), 1, 'the calls in the hour, the second refused for want of a place')
      await hangUp(first.placed)
      const third = await ring('+33639980051')
      expectEqual(third.status, 200, 'the third call, once the first ended (the second counted for nothing)')
      await hangUp(third.placed)
      const fourth = await ring('+33639980051')
      expectEqual(fourth.status, 404, 'the fourth call, past two in the hour')
      expectEqual(await hourOf(keys[0]), 2, 'the calls in the hour, the fourth refused')
      // Hidden at the caller's request: counted on the number the operator still sent, each apart.
      const hidden = await ring('+33639980052', ['Privacy: id'])
      expectEqual(hidden.status, 200, 'the answer of the mailbox to a hidden number')
      const again = await ring('+33639980052', ['Privacy: id'])
      expectEqual(again.status, 404, 'the same hidden number at the same time')
      const other = await ring('+33639980053', ['Privacy: id'])
      expectEqual(other.status, 200, 'another hidden number at the same time: not shut out by the first')
      expectEqual([await hourOf(keys[1]), await hourOf(keys[2])], [1, 1], 'the calls of the hidden numbers to 101 in the hour, each its own')
      // A hidden number is counted by its print only: never the number in a key of the count, a profile of the
      // dialog (the MI, the `dialog` table), nor any value of the dialog.
      expectEqual(await hourOf(`vm:h:+33639980052:${alicesBox}`), 0, 'a key of the count with the hidden number itself')
      const prints = { [hidden.placed.callId]: await whoOf('+33639980052'), [other.placed.callId]: await whoOf('+33639980053') }
      // Left out: `vsf`, where uac (restore_mode auto) keeps the From the operator sent, to give it back in that
      // dialog's requests and replies, as the dialog's own From keeps it (ADR 0022, what remains).
      const listed = ((await mi('dlg_list_ctx')).result?.Dialogs ?? []).filter(d => d.callid in prints)
      expectEqual(listed.map(d => (d.context?.values ?? []).some(v => /39980052|39980053/.test(v.vsf ?? ''))), [true, true], 'the From the operator sent, kept by uac for that dialog')
      const contexts = listed.map(d => JSON.stringify({ ...d.context, values: (d.context?.values ?? []).filter(v => !('vsf' in v)) }))
      expectEqual(contexts.length, 2, 'the dialogs of the hidden numbers (MI dlg_list_ctx)')
      if (contexts.some(c => /39980052|39980053/.test(c))) throw new Error(`the context of the dialog of a hidden number (MI): ${contexts.join(' ')}`)
      const flushed = await until('the profiles of the calls of the hidden numbers in the dialog table', async () => {
        const { rows } = await db.query('SELECT callid, profiles FROM dialog WHERE callid = ANY($1)', [Object.keys(prints)])
        return rows.length === 2 && rows.every(r => String(r.profiles ?? '').includes(prints[r.callid])) ? rows : null
      }, { timeout: 15_000 })
      if (/39980052|39980053/.test(JSON.stringify(flushed))) throw new Error(`the dialog table keeps a hidden number in a profile: ${JSON.stringify(flushed)}`)
      // No number at all: one caller at this mailbox; the second at the same time refused, and said.
      const nobody = await ring('anonymous')
      expectEqual(nobody.status, 200, 'the answer of the mailbox to a caller with no number')
      const nobody2 = await ring('anonymous')
      expectEqual(nobody2.status, 404, 'another caller with no number at the same time')
      expectEqual(await hourOf(keys[3]), 1, 'the calls of those with no number to 101 in the hour')
      await until('the alert of the callers with no number at the cap of 101', async () => {
        const alerts = (await store.listAlerts(TENANT, { limit: 100 })).filter(a => a.lastAt > started && a.alert.kind === 'voicemail')
        return alerts.some(a => a.alert.param === 'hidden-calls' && a.alert.extension === '101' && a.alert.value === 1 && a.alert.threshold === 1) ? alerts : null
      })
      // Those with no number, all mailboxes together, have a bounded share of the places (VOICEMAIL_CALLS_HIDDEN_ALL,
      // lowered to one): with one of them at Alice's mailbox, another is refused at Jean's (who does not want to be
      // disturbed: his refusal, 480), and the administrators are told; a caller with a number still gets Jean's.
      await setStatus(jean, 'Ne pas déranger')
      try {
        await shv('vm_hidden_all', 1)
        const elsewhere = await ring('anonymous', [], '+33199000102')
        expectEqual(elsewhere.status, 480, 'a caller with no number at the mailbox of 102, one already at that of 101')
        const numbered = await ring('+33639980054', [], '+33199000102')
        expectEqual(numbered.status, 200, 'a caller with a number at the mailbox of 102 meanwhile')
        await until('the alert of the callers with no number at their share of all places', async () => {
          const alerts = (await store.listAlerts(TENANT, { limit: 100 })).filter(a => a.lastAt > started && a.alert.kind === 'voicemail')
          return alerts.some(a => a.alert.param === 'hidden-all' && a.alert.extension === '102' && a.alert.value === 1 && a.alert.threshold === 1) ? alerts : null
        })
        // All callers together (VOICEMAIL_CALLS_ALL, lowered to the calls in progress): one more, with a number of its
        // own, gets Jean's refusal, and the administrators are told.
        const all = open.length
        await shv('vm_calls_all', all)
        const past = await ring('+33639980055', [], '+33199000102')
        expectEqual(past.status, 480, 'a caller with a number at the mailbox of 102, all the places taken')
        await until('the alert of all callers at the cap of the platform', async () => {
          const alerts = (await store.listAlerts(TENANT, { limit: 100 })).filter(a => a.lastAt > started && a.alert.kind === 'voicemail')
          return alerts.some(a => a.alert.param === 'calls-all' && a.alert.extension === '102' && a.alert.value === all && a.alert.threshold === all) ? alerts : null
        })
      } finally {
        await shv('vm_calls_all', 30)
        await shv('vm_hidden_all', 10)
        await setStatus(jean, 'Disponible')
      }
      for (const placed of [...open]) await hangUp(placed)
    } finally {
      for (const placed of [...open]) await placed.hangup().catch(() => undefined)
      await shv('vm_per_caller', 2)
      await shv('vm_hidden', 5)
      await shv('vm_per_hour', 10)
      for (const key of keys) await mi('cache_remove', { system: 'local', attr: key }).catch(() => undefined)
    }
    // The callee and the CDRs never see a hidden number.
    expectEqual(
      await cdrsViaSince(accFrom),
      ['+33639980051>101 200 voicemail', '+33639980051>101 200 voicemail', 'anonymous>101 200 voicemail', 'anonymous>101 200 voicemail', 'anonymous>101 200 voicemail', '+33639980054>102 200 voicemail'],
      'CDRs of the calls answered by the mailbox'
    )
    await wazo.eraseMessages({ userId: 'amartin' }).catch(() => 0)
    await wazo.eraseMessages({ userId: 'jdupont' }).catch(() => 0)
  })
  await step('step 11a: against the real Wazo, a person\'s mailbox is theirs whatever extension they hold, at a number of their own that never changes (wazo-sysconfd never moves it): Alice (101, signed out) and Claire Petit (108, new in the directory) each have a message from the operator; Alice moves to 109, then she and Claire swap 109 and 108: each time each one\'s message is theirs, its recording read, their folder in the spool where it was; messages left in the spool under 108 and 109 (numbers of extensions, as a mailbox of before would have left them) are nobody\'s: no mailbox shows them; nothing of it is written in Wazo (no reload of Asterisk), whose mailboxes and users carry nothing of the person; Claire leaves the directory: her mailbox set aside with her message (its name says since when), which an administrator has erased through the Gateway', async () => {
    const claire = { uid: 'cpetit', cn: 'Claire Petit', sn: 'Petit', givenName: 'Claire', mail: 'claire.petit@example.test', ipPhone: '108', ou: 'Support' }
    const aliceEntry = people.find(p => p.uid === 'amartin')
    const context = (await mailboxRows())[0].mailbox.split('@')[1]
    const SPOOL = `/var/spool/asterisk/voicemail/${context}`
    const alices = numberOf('amartin')
    const claires = numberOf('cpetit')
    /** The messages in the spool of a mailbox number (its WAV files), as Asterisk keeps them. */
    const spooled = number => inAsterisk('sh', '-c', `find ${SPOOL}/${number} -name 'msg*.wav' 2>/dev/null | wc -l`).trim()
    /** Copies of the messages under `from` left under `to` in the spool, as an earlier mailbox there would have. */
    const plant = (from, to) => inAsterisk('sh', '-c', `mkdir -p ${SPOOL}/${to} && cp -a ${SPOOL}/${from}/INBOX ${SPOOL}/${to}/`)
    /** The mailbox OpenSIPS sends the calls of an extension to. */
    const boxAt = async extension => (await mailboxRows()).find(r => r.extension === extension)?.mailbox
    /** Each one's message at their extension now, with its recording: from Wazo, through the Gateway's provider. */
    const theirs = async (userId, extension, from) => {
      const items = await until(`the message of ${from} for ${userId} at ${extension}`, async () => {
        const found = await wazo.listMessages({ userId, extension }).catch(() => [])
        return found.some(i => i.from === from) ? found : null
      }, { timeout: 30_000 })
      expectEqual(items.map(i => i.from), [from], `the messages of ${userId} at ${extension}`)
      const recording = await wazo.getRecording({ userId, extension }, items[0].id)
      let bytes = Buffer.alloc(0)
      for await (const chunk of recording.body) bytes = Buffer.concat([bytes, Buffer.from(chunk)])
      expectEqual(`${bytes.subarray(0, 4).toString('latin1')} ${bytes.length > 8_000}`, 'RIFF true', `the recording of the message of ${userId} at ${extension}`)
    }
    const spoolIs = (want, what) => until(what, async () => (Object.entries(want).every(([n, count]) => spooled(n) === String(count)) ? true : null), { timeout: 30_000 })
    const rowsAre = (want, what) => until(what, async () => ((await Promise.all(Object.entries(want).map(async ([ext, box]) => (await boxAt(ext)) === box))).every(Boolean) ? true : null), { timeout: 30_000 })
    /**
     * A person's mailbox and its user as wazo-confd has them, read with the Gateway's own account: the mailbox's name
     * (TwakePhone, or `TwakePhone aside <date>`), and its user's name and description (nothing of the person).
     */
    const wazoOf = async userId => {
      const basic = Buffer.from(`${WAZO.username}:${WAZO.password}`).toString('base64')
      const auth = await fetch(`${WAZO.authUrl}/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' }, body: JSON.stringify({ expiration: 60 }) })
      const token = (await auth.json()).data.token
      const get = async path => (await fetch(`${WAZO.confdUrl}${path}`, { headers: { 'x-auth-token': token, accept: 'application/json' } })).json()
      const vm = (await get(`/voicemails?search=${numberOf(userId)}`)).items.find(v => v.number === numberOf(userId))
      const uuid = vm?.users?.[0]?.uuid
      const user = uuid ? await get(`/users/${uuid}`) : undefined
      return vm ? { name: vm.name, user: user ? `${user.firstname} ${user.lastname ?? ''} ${user.description ?? ''}`.trim() : undefined } : undefined
    }
    const nameIs = (userId, want, what) => until(what, async () => ((await wazoOf(userId))?.name?.startsWith(want) ? true : null), { timeout: 30_000 })
    const leave = async (number, from) => {
      const placed = await operator.call(number, { from, ruri: TRUNK_LOGIN })
      const answer = await placed.final
      const answeredAt = Date.now()
      expectEqual(answer.status, 200, `the answer of the mailbox of ${number} to the operator`)
      await until('the greeting at the operator', () => (placed.media.stats.voiced > 20 ? true : null))
      await sleep(Math.max(0, answeredAt + greetingMs() + 3_000 - Date.now()))
      expectEqual((await placed.hangup()).status, 200, 'answer to the operator BYE')
    }
    try {
      await leave('+33199000101', '+33639980041')
      await theirs('amartin', '101', '+33639980041')
      expectEqual(await boxAt('101'), `${alices}@${context}`, "the mailbox of 101: Alice's, at her number")
      // Alice's message, copied under 108 and 109, the extensions' numbers, where no mailbox is.
      plant(alices, '108')
      plant(alices, '109')
      await spoolIs({ [alices]: 1, 108: 1, 109: 1 }, 'the messages in the spool, those left under 108 and 109 included')
      people.push(claire)
      await directorySync.run()
      await rowsAre({ 108: `${claires}@${context}` }, 'a mailbox for Claire at 108, at her number')
      expectEqual(await wazoOf('cpetit'), { name: 'TwakePhone', user: 'TwakePhone' }, "Claire's mailbox and its user in Wazo: nothing of her")
      // Hers shows nothing of what was under 108: never at an extension's number.
      expectEqual(await wazo.listMessages({ userId: 'cpetit', extension: '108' }), [], "Claire's messages in her new mailbox")
      // Her account, as when she signs in: her direct number reaches her (she has no window: her mailbox at once).
      await registry.forTenant(TENANT).getSession({ id: 'cpetit', tenantId: TENANT, displayName: 'Claire Petit', extension: '108' }, { id: 'ua', type: 'browser', label: 'UA' })
      await leave('+33199000108', '+33639980042')
      await theirs('cpetit', '108', '+33639980042')
      await spoolIs({ [alices]: 1, [claires]: 1, 108: 1, 109: 1 }, 'the messages in the spool')
      // Alice moves to 109: the same mailbox, at the same number, now reached at 109; 101 has none. Nothing of it is
      // written in Wazo: wazo-sysconfd reloads nothing of Asterisk for it.
      const moving = new Date().toISOString()
      aliceEntry.ipPhone = '109'
      await directorySync.run()
      await rowsAre({ 109: `${alices}@${context}`, 101: undefined }, "Alice's mailbox at 109, none at 101")
      await theirs('amartin', '109', '+33639980041')
      // Alice and Claire swap 109 and 108: each keeps hers.
      aliceEntry.ipPhone = '108'
      claire.ipPhone = '109'
      await directorySync.run()
      await rowsAre({ 108: `${alices}@${context}`, 109: `${claires}@${context}` }, 'the mailboxes once they swapped')
      await theirs('amartin', '108', '+33639980041')
      await theirs('cpetit', '109', '+33639980042')
      await sleep(2_000)
      expectEqual(reloadsSince(moving), [], 'what wazo-sysconfd reloaded of Asterisk for the moves and the swap')
      expectEqual([(await wazoOf('amartin')).name, (await wazoOf('cpetit')).name], ['TwakePhone', 'TwakePhone'], 'the names of the mailboxes once they swapped')
      // Nothing moved in the spool: each one's folder where it was, those under 108 and 109 untouched.
      await spoolIs({ [alices]: 1, [claires]: 1, 108: 1, 109: 1 }, 'the messages in the spool once they swapped')
      // Claire leaves: no extension sends a call to her mailbox, set aside with her message (the retention period
      // applies to it as to any); her erasure takes it.
      const leaving = new Date().toISOString()
      people.splice(people.indexOf(claire), 1)
      await directorySync.run()
      await rowsAre({ 109: undefined }, 'no mailbox at 109 once Claire left')
      await nameIs('cpetit', 'TwakePhone aside ', "Claire's mailbox, set aside in Wazo")
      await theirs('cpetit', '109', '+33639980042')
      await sleep(2_000)
      // A change of the mailbox only: its module reloaded (what else wazo-confd asks for with it is said here).
      const aside = reloadsSince(leaving)
      console.log(`     wazo-sysconfd, for a mailbox set aside: ${aside.join(', ') || 'nothing'}`)
      if (!aside.includes('voicemail reload')) throw new Error(`what wazo-sysconfd reloaded for a mailbox set aside: ${JSON.stringify(aside)}`)
      // She left: an administrator has her messages erased, by the Gateway that writes the mailboxes, at its round.
      alice = await open('amartin', 'Alice Martin')
      try {
        const admin = await asPerson(alice)
        expectEqual((await admin('POST', '/admin/voicemail/erase', { userId: 'jdupont' })).json().code, 'VOICEMAIL_ERASE_HOLDER', 'the erasure of the messages of someone who holds an extension, asked by an administrator')
        expectEqual((await admin('POST', '/admin/voicemail/erase', { userId: 'cpetit' })).statusCode, 202, 'the erasure of the messages of Claire, who left, asked by an administrator')
        await spoolIs({ [claires]: 0 }, "Claire's messages in the spool after her erasure")
        expectEqual(await wazo.listMessages({ userId: 'cpetit', extension: '109' }), [], "Claire's messages after her erasure")
      } finally {
        await signOut(alice)
      }
    } finally {
      await wazo.eraseMessages({ userId: 'amartin' }).catch(() => 0)
      await wazo.eraseMessages({ userId: 'cpetit' }).catch(() => 0)
      // What this step put under 108 and 109, gone (the dev stack keeps no copy of a test's).
      try {
        inAsterisk('sh', '-c', `rm -rf ${SPOOL}/108 ${SPOOL}/109`)
      } catch {
        // Nothing there.
      }
      aliceEntry.ipPhone = '101'
      if (people.includes(claire)) people.splice(people.indexOf(claire), 1)
      await directorySync.run()
      await until('Alice back at 101, nobody at 108 and 109', async () => {
        const rows = (await mailboxRows()).map(r => r.extension)
        return rows.includes('101') && !rows.includes('108') && !rows.includes('109') ? rows : null
      }, { timeout: 30_000 })
    }
  })
  await step('the directory now shows Alice offline, and Bob available', async () => {
    await presenceIs(jean.page, 'Martin', '101', 'Hors ligne')
    await presenceIs(jean.page, 'Durand', '103', 'Disponible')
  })
  await step('the Gateway stops: the rows of push_targets it kept alive are over at once (no call waits for a browser nobody will wake), not a row another Gateway keeps alive', async () => {
    await registry.forTenant(TENANT).setWakeableOne({ extension: '102', userId: 'jdupont' }, true)
    await db.query("INSERT INTO push_targets (extension, tenant_id, holder, alive_until) VALUES ('149', $1, 'another-gateway', now() + interval '1 hour')", [TENANT])
    try {
      const alive = async () => (await db.query("SELECT extension FROM push_targets WHERE tenant_id = $1 AND alive_until > now() ORDER BY extension", [TENANT])).rows.map(r => r.extension)
      expectEqual(await alive(), ['102', '149'], 'rows alive while the Gateway runs')
      gatewayClosed = true
      await gateway.close()
      expectEqual(await alive(), ['149'], 'rows alive once the Gateway stopped')
    } finally {
      await db.query("DELETE FROM push_targets WHERE extension = '149'")
    }
  })
} catch (err) {
  failed = true
  console.error(err)
  for (const who of [alice, jean, jean2, bob, desk]) {
    if (!who || who.page.isClosed()) continue
    console.log(`[${who.name}] url:`, who.page.url())
    console.log(`[${who.name}] text:`, (await who.page.locator('body').innerText().catch(() => '')).slice(0, 600))
    console.log(`[${who.name}] calls:`, JSON.stringify(await calls(who.page).catch(() => null)))
    await who.page.screenshot({ path: fileURLToPath(new URL(`../dist/sip-e2e-failure-${who.name.split(' ')[0]}.png`, import.meta.url)) }).catch(() => {})
  }
} finally {
  await browser.close()
  await web.stop()
  if (!gatewayClosed) await gateway.close()
  await oidc.stop()
  await ldap.stop()
  await relay.stop()
  await pushService.stop()
  await dtmf?.stop()
  await operator.close()
  await operator2.close()
  await receiver.stop()
  await wazo.close()
  for (const r of wazoRelays) await r.stop()
  try {
    execFileSync('docker', ['compose', '-f', fileURLToPath(new URL('../../../docker/docker-compose.sip.yml', import.meta.url)), 'exec', '-T', 'wazo-asterisk', 'asterisk', '-rx', 'logger remove channel twake-e2e-trace'], { stdio: 'ignore', timeout: 30_000 })
  } catch {
    // Not there.
  }
  await db.end()
}
process.exit(failed ? 1 : 0)
