// End to end of steps 3 to 5 (calls, transfers, what the Gateway hears from OpenSIPS, forwards and "do not
// disturb", ring groups, calls to someone without a window of the app): people call and transfer each other from
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
//   OPENSIPS_DB_URL      the database auth_db reads (default postgres://twake:twake@127.0.0.1:54320/twake)
//   OPENSIPS_MI_URL      the MI socket of OpenSIPS, where the Gateway subscribes to its events (default udp:127.0.0.1:8880)
//   RTPENGINE_DTMF_LOG   where rtpengine reports the tones it sees (default 127.0.0.1:22223); "off" skips the check
//   SIP_E2E_PRESENCE_MS  how long a presence change may take to show in the directory (default 3000; raise it on a loaded runner)
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer, connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { chromium, firefox } from 'playwright-core'
import { buildApp } from '../../gateway/dist/app.js'
import { WebPush } from '../../gateway/dist/push.js'
import { JwtAuthenticator } from '../../gateway/dist/auth.js'
import { DirectorySync } from '../../gateway/dist/directory-sync.js'
import { DEFAULT_ATTRIBUTES, LdapDirectory } from '../../gateway/dist/ldap-directory.js'
import { storedOpensipsFactory } from '../../gateway/dist/providers.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { MemoryStore } from '../../gateway/dist/store/memory.js'
import { BASE_DN, PEOPLE, READER_DN, READER_PASSWORD, startLdapMock } from '../../gateway/test/ldap-mock.mjs'
import { startPushService } from '../../gateway/test/push-service.mjs'
import { startOidcMock } from './oidc-mock.mjs'
import { serveApp } from '../server/serve.mjs'
import { sipUa } from './sip-ua.mjs'

const AUDIENCE = 'twakephone-gateway'
const RESOURCE = 'https://gateway.twakephone.test'
const SIP_WSS_URL = process.env.SIP_WSS_URL ?? 'wss://127.0.0.1:8089'
const SIP_DOMAIN = process.env.SIP_DOMAIN ?? new URL(SIP_WSS_URL).hostname
const OPENSIPS_DB_URL = process.env.OPENSIPS_DB_URL ?? 'postgres://twake:twake@127.0.0.1:54320/twake'
const OPENSIPS_MI_URL = process.env.OPENSIPS_MI_URL ?? 'udp:127.0.0.1:8880'
// OpenSIPS's UDP socket, for the user agents of this process (sip-ua.mjs): on this host.
const SIP_UDP = process.env.SIP_UDP ?? '127.0.0.1:5060'
const DTMF_LOG = process.env.RTPENGINE_DTMF_LOG ?? '127.0.0.1:22223'
const TENANT = 'e2e'
const BROWSER = process.env.BROWSER ?? 'chromium'
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
/** Scalars by value, arrays by content (in order). */
const expectEqual = (actual, expected, what) => {
  const same = Array.isArray(expected) ? Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected) : actual === expected
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
const startRelay = (targetHost, targetPort, port) =>
  new Promise((resolve, reject) => {
    const sockets = new Set()
    const pairs = []
    const server = createServer(client => {
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
        /** Drops the SIP server's side of the n-th connection only: the browser keeps its socket and suspects nothing. */
        cutUpstream: n => {
          const pair = pairs[n]
          if (!pair) throw new Error(`no relayed connection ${n}`)
          pair.upstream.removeAllListeners('close')
          pair.upstream.removeAllListeners('error')
          pair.client.unpipe(pair.upstream)
          pair.upstream.destroy()
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

const [APP_PORT, OIDC_PORT, GATEWAY_PORT, RELAY_PORT] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
const appOrigin = `http://127.0.0.1:${APP_PORT}`
const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`
const wss = new URL(SIP_WSS_URL)
const relay = await startRelay(wss.hostname, Number(wss.port || (wss.protocol === 'wss:' ? 443 : 80)), RELAY_PORT)
const relayUrl = `${wss.protocol}//127.0.0.1:${RELAY_PORT}${wss.pathname === '/' ? '' : wss.pathname}`
const dtmf = listenDtmf(DTMF_LOG)

process.env.LOG_LEVEL ??= 'warn'
process.env.CORS_ORIGINS = appOrigin
process.env.DEFAULT_TENANT = TENANT

const oidc = await startOidcMock({ port: OIDC_PORT, appOrigin, audience: AUDIENCE, resource: RESOURCE })
const auth = new JwtAuthenticator({ jwksUrl: oidc.jwksUrl, issuer: oidc.issuer, audience: AUDIENCE, defaultTenant: TENANT, rolesClaim: 'roles' })
const store = new MemoryStore()
// What an administrator (or the LDAP synchronisation) would have set: who has which extension.
await store.upsertMapping({ tenantId: TENANT, userId: 'amartin', extension: '101', displayName: 'Alice Martin' })
await store.upsertMapping({ tenantId: TENANT, userId: 'jdupont', extension: '102', displayName: 'Jean Dupont' })
await store.upsertMapping({ tenantId: TENANT, userId: 'bdurand', extension: '103', displayName: 'Bob Durand' })
// The reception desk: an extension nobody registers, that a forward can target.
await store.upsertMapping({ tenantId: TENANT, userId: 'accueil', extension: '104', displayName: 'Accueil' })
// What `OPENSIPS_WS_URL` and `OPENSIPS_MI_URL` make the Gateway store at startup, pointed at the relay.
await store.upsertProvider({ tenantId: TENANT, type: 'opensips', config: { websocketUrl: relayUrl, domain: SIP_DOMAIN, subscriberDbUrlRef: 'env:OPENSIPS_DB_URL', events: { miUrl: OPENSIPS_MI_URL } } })
const key = randomBytes(32)
const registry = new ProviderRegistry(await store.listProviders(), [storedOpensipsFactory({ store, key, env: { OPENSIPS_DB_URL } })])
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
const gateway = await buildApp(registry, { auth, store, contacts, directorySync, push, admin: { adminRole: 'twakephone-admin', adminUsers: new Set() } })
registry.startAll()
await gateway.listen({ host: '127.0.0.1', port: GATEWAY_PORT })
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
await db.query("DELETE FROM call_groups WHERE number IN ('200', '105', '106', '210')")
// Nor the account an older Gateway would have left (106), which this run writes by hand.
await db.query("DELETE FROM subscriber WHERE username = '106'")
// Nor anyone left to wake by an interrupted run (step 5): the Gateway writes the rows of this run's subscriptions.
await db.query("DELETE FROM push_targets WHERE extension IN ('101', '102', '103', '104', '105')")

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
  await step('Alice calls Jean and gives up while it rings: a missed call for Jean, in his Récents and in missed_calls (487)', async () => {
    await dial(alice.page, '102')
    await jean.page.getByTestId('incoming-call').waitFor()
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByTestId('incoming-call').waitFor({ state: 'hidden' })
    expectEqual((await recents(jean.page, 4))[0], '101: Manqué', "Jean's newest recent call")
    expectEqual((await recents(alice.page, 5)).slice(0, 2), ['102: Sortant', '102: Entrant'], "Alice's newest recent calls")
    const missed = await db.query("SELECT caller, callee, sip_code FROM missed_calls WHERE sip_code = '487' AND id > $1", [since.missed_calls])
    expectEqual(missed.rows.map(r => `${r.caller}>${r.callee}`), ['101>102'], 'cancelled call in missed_calls')
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
    await alice.page.getByRole('link', { name: 'Administration' }).click()
    await alice.page.getByRole('heading', { level: 2, name: "Groupes d'appel" }).waitFor()
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
    await alice.page.getByRole('alert').filter({ hasText: 'Ce numéro est déjà pris' }).waitFor()
    // An account an older Gateway left in subscriber (nobody's extension any more): OpenSIPS would route 106 as an
    // extension, so no group gets it either (the provider checks subscriber).
    await db.query("INSERT INTO subscriber (username, domain, password, ha1, ha1_sha256, ha1_sha512t256) VALUES ('106', '', '', 'x', 'x', 'x') ON CONFLICT DO NOTHING")
    expectEqual(await save('106'), '409 GROUP_NUMBER_TAKEN', 'creating group 106')
    await alice.page.getByRole('alert').filter({ hasText: 'Ce numéro est déjà pris' }).waitFor()
    expectEqual((await db.query("SELECT 1 FROM call_groups WHERE number = '106'")).rows.length, 0, 'call_groups rows of 106')
    expectEqual(await save('200'), '201', 'creating group 200')
    await alice.page.getByRole('status').filter({ hasText: 'Groupe 200 enregistré.' }).waitFor()
    await alice.page.getByRole('list', { name: 'Groupes existants' }).getByText('101, 102, 103').waitFor()
    // The creation form again, with the same number: refused, the group stays as it was.
    expectEqual(await save('200', 'Autre chose'), '409 GROUP_EXISTS', 'creating group 200 again')
    await alice.page.getByRole('alert').filter({ hasText: 'Un groupe de votre organisation a déjà ce numéro' }).waitFor()
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
  await step('OpenSIPS shows the name the directory gives: Bob, renamed in the directory, calls Alice as Robert Durand once Alice synchronised it from Administration (POST /admin/directory/sync); the accounts of the extensions nobody holds now go, not the one the Gateway did not write (106)', async () => {
    const bobEntry = people.find(p => p.uid === 'bdurand')
    const nameOf103 = async () => (await db.query("SELECT display_name FROM display_names WHERE extension = '103'")).rows[0]?.display_name
    bobEntry.cn = 'Robert Durand'
    try {
      await synchronise(alice)
      await until('the new name in display_names', async () => (await nameOf103()) === 'Robert Durand')
      // Nobody holds 131 to 134 any more: the accounts the Gateway wrote for them go. 106, written by hand (no
      // holder), stays: the Gateway removes only what it wrote.
      await until('the accounts of 131 to 134 to go', async () => (await db.query("SELECT 1 FROM subscriber WHERE username IN ('131', '132', '133', '134')")).rows.length === 0)
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
    await alice.page.getByRole('link', { name: 'Administration' }).click()
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
    await alice.page.getByRole('link', { name: 'Administration' }).click()
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
    await who.page.close({ runBeforeUnload: true })
    // Closed, the page tries to unregister (pagehide, best effort: the REGISTER is challenged once the page is gone).
    // What it leaves is a registration on a closed WebSocket, as a tab closed or a laptop put to sleep does: OpenSIPS
    // cannot reach it, the call is held for the browser to wake. A moment for the relay to close its side.
    await sleep(1_000)
  }
  /** The notifications the service worker of `who`'s browser shows (Chromium and Edge). */
  const notificationsOf = async who => {
    const [sw] = who.context.serviceWorkers()
    return sw ? sw.evaluate(() => self.registration.getNotifications().then(ns => ns.map(n => ({ title: n.title, body: n.body, url: n.data?.url })))) : []
  }
  /**
   * Hands `text` (a decrypted push) to the service worker of `who`'s browser, as its push service would (DevTools).
   * Resolves with what DevTools reports of the worker (its states and errors), for a failure to say what happened.
   */
  const deliverPush = async (who, text) => {
    const cdp = await who.context.newCDPSession(who.blank)
    const ids = new Map()
    const seen = []
    cdp.on('ServiceWorker.workerRegistrationUpdated', e => {
      for (const r of e.registrations) ids.set(r.scopeURL, r.registrationId)
    })
    cdp.on('ServiceWorker.workerVersionUpdated', e => {
      for (const v of e.versions) seen.push(`${v.status} ${v.runningStatus}`)
    })
    cdp.on('ServiceWorker.workerErrorReported', e => seen.push(`error: ${e.errorMessage.errorMessage}`))
    await cdp.send('ServiceWorker.enable')
    const registrationId = await until('the service worker of the app', async () => ids.get(`${appOrigin}/`))
    // What the worker does with the push, for a failure to say (kept in the worker while it runs).
    for (const w of who.context.serviceWorkers()) {
      await w.evaluate(() => {
        const log = (self.__e2e = [])
        self.addEventListener('push', e => log.push(`push ${e.data ? e.data.text().length : 'without data'}`))
        self.addEventListener('notificationclose', e => log.push(`closed ${e.notification.title}`))
        const show = self.registration.showNotification.bind(self.registration)
        self.registration.showNotification = (title, options) => {
          log.push(`show ${title}`)
          return show(title, options).then(
            () => self.registration.getNotifications().then(ns => log.push(`shown, ${ns.length} listed`)),
            e => (log.push(`refused ${e.name} ${e.message}`), Promise.reject(e))
          )
        }
      }).catch(e => seen.push(`not watched: ${e.message}`))
    }
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: appOrigin, registrationId, data: text })
    return { seen, detach: () => cdp.detach().catch(() => undefined) }
  }
  /** Opens the app at `path` in `who`'s browser, as a click on the notification does: it signs in by itself. */
  const openFromNotification = async (who, login, path) => {
    const page = await who.context.newPage()
    await page.route(/fonts\.g(static|oogleapis)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
    page.on('pageerror', err => console.log(`[${who.name}] page error:`, err.message))
    await page.goto(`${appOrigin}${path}`)
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
  await step(`the notification ${PUSH_TO_WORKER ? 'the service worker shows says Alice calls; clicked, it opens' : 'opens'} TwakePhone on the call: Jean signs in by himself, his softphone registers and rings in the same call, he answers and they hear each other`, async () => {
    let path = `/?call=${encodeURIComponent(woken.data.callId)}`
    if (PUSH_TO_WORKER) {
      const delivered = await deliverPush(jean, woken.text)
      const [shown] = await until('the notification', async () => {
        const all = await notificationsOf(jean)
        return all.length ? all : null
      }).catch(async err => {
        const workers = jean.context.serviceWorkers()
        // Whether the worker can show a notification at all, asked to show one itself.
        const probe = await workers[0]
          ?.evaluate(() =>
            self.registration
              .showNotification('probe', { tag: 'probe' })
              .then(() => self.registration.getNotifications().then(ns => `shown, ${ns.length} listed`))
              .catch(e => `refused: ${e.name} ${e.message}`)
              .then(r => `${Notification.permission}; ${r}; ${navigator.userAgent}`)
          )
          .catch(e => `not asked: ${e.message}`)
        const log = await workers[0]?.evaluate(() => JSON.stringify(self.__e2e ?? null)).catch(e => `not read: ${e.message}`)
        throw new Error(`${err.message}; workers: ${JSON.stringify(workers.map(w => w.url()))}; DevTools: ${delivered.seen.join(', ')}; worker: ${log}; probe: ${probe}`)
      })
      await delivered.detach()
      expectEqual(`${shown.title} | ${shown.body}`, 'Appel de Alice Martin (101) | Cliquez pour répondre dans TwakePhone.', 'the notification')
      path = shown.url
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
  await step('nobody opens the notification, Jean forwards on no answer after 5 s: Bob rings after those 5 s, not later; a missed call for Jean, whose notification says so', async () => {
    await setForwarding(jean, { noAnswer: '103', delay: '5' })
    await leaveApp(jean)
    const started = new Date().toISOString()
    const missedFrom = await lastId('missed_calls')
    const dialled = Date.now()
    await dial(alice.page, '102')
    const { data } = await pushFor('call')
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
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await until('the call given up in missed_calls', async () => ((await missedSince(missedFrom)).length ? true : null), { timeout: 5_000 })
    expectEqual(await missedSince(missedFrom), ['101>102 487'], 'missed_calls rows of the call given up while it waited')
    const dialled = Date.now()
    const ended = await dialUntilEnded(alice.page, '102')
    // 404 when nothing of Jean is registered, 477 for the registrations his closed windows left: unreachable either way.
    if (!['404 unavailable', '477 unavailable'].includes(`${ended.endStatus} ${ended.endReason}`)) throw new Error(`the call to 102 ended ${ended.endStatus} ${ended.endReason}, unreachable expected`)
    if (Date.now() - dialled > 5_000) throw new Error('the call to 102 waited: nobody can be woken any more')
  })
  await step('Jean opens TwakePhone again for what follows', async () => {
    await jean.context.close()
    jean = await open('jdupont', 'Jean Dupont')
    await phoneState(jean.page).getByText('En ligne').waitFor({ timeout: 20_000 })
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
  await step('the directory now shows Alice offline, and Bob available', async () => {
    await presenceIs(jean.page, 'Martin', '101', 'Hors ligne')
    await presenceIs(jean.page, 'Durand', '103', 'Disponible')
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
  await gateway.close()
  await oidc.stop()
  await ldap.stop()
  await relay.stop()
  await pushService.stop()
  await dtmf?.stop()
  await db.end()
}
process.exit(failed ? 1 : 0)
