// End to end of step 3 (3a calls, 3b transfers): people call and transfer each other from their browsers through
// OpenSIPS and rtpengine. The SIP stack is the only thing outside this process (docker/docker-compose.sip.yml, or
// OpenSIPS and rtpengine started by hand); the identity provider, the Gateway (with the OpenSIPS provider) and the
// app run here, and three browser contexts with a simulated microphone play Alice (101), Jean (102) and Bob (103).
//
//   BROWSER              chromium (default), firefox or msedge (Edge installed on the machine, as Playwright finds it)
//   PLAYWRIGHT_CHROMIUM  a Chromium binary to use instead of Playwright's (PLAYWRIGHT_FIREFOX likewise)
//   SIP_WSS_URL          WSS socket of OpenSIPS (default wss://127.0.0.1:8089)
//   SIP_DOMAIN           SIP domain and digest realm (default: the host of SIP_WSS_URL)
//   OPENSIPS_DB_URL      the database auth_db reads (default postgres://twake:twake@127.0.0.1:54320/twake)
//   RTPENGINE_DTMF_LOG   where rtpengine reports the tones it sees (default 127.0.0.1:22223); "off" skips the check
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer, connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { chromium, firefox } from 'playwright-core'
import { buildApp } from '../../gateway/dist/app.js'
import { JwtAuthenticator } from '../../gateway/dist/auth.js'
import { storedOpensipsFactory } from '../../gateway/dist/providers.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { MemoryStore } from '../../gateway/dist/store/memory.js'
import { startOidcMock } from './oidc-mock.mjs'
import { serveApp } from '../server/serve.mjs'

const AUDIENCE = 'twakephone-gateway'
const RESOURCE = 'https://gateway.twakephone.test'
const SIP_WSS_URL = process.env.SIP_WSS_URL ?? 'wss://127.0.0.1:8089'
const SIP_DOMAIN = process.env.SIP_DOMAIN ?? new URL(SIP_WSS_URL).hostname
const OPENSIPS_DB_URL = process.env.OPENSIPS_DB_URL ?? 'postgres://twake:twake@127.0.0.1:54320/twake'
const DTMF_LOG = process.env.RTPENGINE_DTMF_LOG ?? '127.0.0.1:22223'
const TENANT = 'e2e'
const BROWSER = process.env.BROWSER ?? 'chromium'

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
const expectEqual = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
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
// What `OPENSIPS_WS_URL` makes the Gateway store at startup, pointed at the relay.
await store.upsertProvider({ tenantId: TENANT, type: 'opensips', config: { websocketUrl: relayUrl, domain: SIP_DOMAIN, subscriberDbUrlRef: 'env:OPENSIPS_DB_URL' } })
const key = randomBytes(32)
const registry = new ProviderRegistry(await store.listProviders(), [storedOpensipsFactory({ store, key, env: { OPENSIPS_DB_URL } })])
const gateway = await buildApp(registry, { auth, store, admin: { adminRole: 'twakephone-admin', adminUsers: new Set() } })
await gateway.listen({ host: '127.0.0.1', port: GATEWAY_PORT })
const web = await serveApp({
  dir: fileURLToPath(new URL('../dist/', import.meta.url)),
  port: APP_PORT,
  config: { gatewayUrl, oidc: { authority: oidc.issuer, clientId: 'twakephone-web', resource: RESOURCE } },
  // CONNECT_SRC in production: the SIP WebSocket is not on the Gateway's origin.
  policy: { connectSrc: [new URL(relayUrl).origin] }
})
const db = new pg.Pool({ connectionString: OPENSIPS_DB_URL, max: 1 })

// A microphone that produces a tone, no permission prompt, sound allowed without a gesture, OpenSIPS's self-signed
// certificate accepted (Firefox: through the context's ignoreHTTPSErrors).
const browser =
  BROWSER === 'firefox'
    ? await firefox.launch({
        ...(process.env.PLAYWRIGHT_FIREFOX ? { executablePath: process.env.PLAYWRIGHT_FIREFOX } : {}),
        firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0, 'media.setsinkid.enabled': true }
      })
    : await chromium.launch({
        ...(BROWSER === 'msedge' ? { channel: 'msedge' } : process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required']
      })
console.log(`browser: ${BROWSER} ${browser.version()}`)

/** One person in their own browser context: signs in, lands on the dialer. */
const open = async (login, name) => {
  const context = await browser.newContext({ locale: 'fr-FR', ignoreHTTPSErrors: true })
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
const stats = page => page.evaluate(() => window.twakephone.stats())
const soundBlocked = page => page.evaluate(() => window.twakephone.soundBlocked)
/** Signs out from this page (unregisters its softphone first) and closes its context. */
const signOut = async who => {
  await who.page.getByRole('button', { name: 'Se déconnecter' }).click()
  await who.page.waitForURL(`${oidc.issuer}/session/end**`)
  await who.page.getByRole('button', { name: /yes, sign me out/i }).click()
  await who.page.waitForURL(`${appOrigin}/`)
  await who.page.getByRole('button', { name: 'Se connecter' }).waitFor()
  await who.context.close()
}
const dial = async (page, number) => {
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
const transferButton = page => page.getByRole('button', { name: 'Transférer', exact: true })
const transferTarget = page => page.getByLabel('Transférer à (poste ou numéro)')
/** Alice calls Jean, who answers. */
const aliceCallsJean = async (alice, jean) => {
  await dial(alice.page, '102')
  await jean.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
  await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
  await alice.page.getByText('En communication avec 102').waitFor()
}

let failed = false
let alice
let jean
let bob
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
    jean = await open('jdupont', 'Jean Dupont')
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
    await alice.page.getByText('En communication avec 102').waitFor()
    await jean.page.getByText('En communication avec Alice Martin (101)').waitFor()
    expectEqual((await calls(alice.page))[0].direction, 'outbound', 'Alice call direction')
    expectEqual((await calls(jean.page))[0].direction, 'inbound', 'Jean call direction')
  })
  await step('RTP flows both ways through rtpengine', async () => {
    await bothHearEachOther(alice, jean)
  })
  await step('Alice puts Jean on hold: Jean is told, then she resumes and audio flows again', async () => {
    await alice.page.getByRole('button', { name: 'Mettre en attente' }).click()
    await alice.page.getByText('102 en attente').waitFor()
    await jean.page.getByText('Votre correspondant vous a mis en attente.').waitFor()
    expectEqual((await calls(jean.page))[0].remoteHold, true, 'remoteHold on Jean side')
    await alice.page.getByRole('button', { name: 'Reprendre' }).click()
    await alice.page.getByText('En communication avec 102').waitFor()
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
    await alice.page.getByText('Appel avec 102 terminé.').waitFor()
    expectEqual((await calls(alice.page)).length, 0, 'calls left on Alice side')
  })
  await step('Alice chooses a microphone and outputs in the settings: the next call uses them, the ringtone can be tested', async () => {
    await alice.page.getByRole('link', { name: 'Réglages' }).click()
    await alice.page.getByRole('heading', { level: 2, name: 'Audio' }).waitFor()
    // The browsers' simulated devices: Chromium and Edge list several, Firefox one microphone and no output.
    const options = async label => (await alice.page.getByLabel(label).locator('option').all()).length - 1
    const pick = async (label, index) => {
      const n = await options(label)
      if (n <= index) return null
      await alice.page.getByLabel(label).selectOption({ index: index + 1 })
      return alice.page.getByLabel(label).inputValue()
    }
    const microphone = await pick('Microphone', 1)
    const canChooseOutput = await alice.page.evaluate(() => 'setSinkId' in HTMLMediaElement.prototype)
    const output = canChooseOutput ? await pick('Sortie de la voix', 1) : null
    if (canChooseOutput) await pick('Sortie de la sonnerie', 2)
    console.log(`     devices: microphone ${microphone ?? 'default'}, output ${output ?? 'default'}`)
    const chosen = await alice.page.evaluate(() => window.twakephone.devices)
    if (microphone) expectEqual(chosen.microphoneId, microphone, 'microphone kept')
    await alice.page.getByRole('button', { name: 'Tester la sonnerie' }).click()
    await alice.page.getByTestId('ringer').waitFor({ state: 'attached' })
    expectEqual(await soundBlocked(alice.page), false, 'sound blocked during the ringtone test')
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
      await who.page.getByTestId('ringer').waitFor({ state: 'attached' })
      expectEqual(await soundBlocked(who.page), false, `sound blocked while ringing (${who === alice ? 'first' : 'second'} window)`)
    }
    await alice2.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await jean.page.getByText('En communication avec 101').waitFor()
    await alice.page.getByText('Appel de Jean Dupont (102) pris sur un autre poste ou abandonné.').waitFor()
    expectEqual((await calls(alice.page)).length, 0, 'calls left in the first window')
    await bothHearEachOther(alice2, jean)
    await alice2.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec 101 terminé.').waitFor()
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
    await alice.page.getByText('En communication avec 103').waitFor()
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
    await consultation.getByText('En communication avec 103').waitFor()
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
    await jean.page.getByTestId('consultation').getByText('En communication avec 103').waitFor()
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByRole('status').getByText('Appel avec 103 terminé.').waitFor()
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
    await consultation.getByText('En communication avec 103').waitFor()
    await consultation.getByRole('button', { name: 'Transférer Alice Martin (101) à 103' }).click()
    await jean.page.getByText('Appel avec Alice Martin (101) transféré.').waitFor({ timeout: 20_000 })
    await until('Jean has no call left', async () => (await calls(jean.page)).length === 0)
    await alice.page.getByText('En communication avec 103').waitFor()
    await bob.page.getByText('En communication avec Alice Martin (101)').waitFor()
    await until('Bob has one call, the one with Alice, which took the place of the one with Jean', async () => {
      const c = await calls(bob.page)
      return c.length === 1 && c[0].replacedCallId && c[0].remoteNumber === '101' ? c : null
    })
    await until('Alice has only her call with Bob', async () => (await calls(alice.page)).length === 1)
    await bothHearEachOther(alice, bob)
    await bob.page.getByRole('button', { name: 'Raccrocher' }).click()
    await alice.page.getByText('Appel avec 103 terminé.').waitFor()
  })
  await step('a registration left on a dead connection (the first one, Alice): the caller is told unreachable, not an error', async () => {
    relay.cutUpstream(0)
    await sleep(500)
    await dial(jean.page, '101')
    const ended = await until('the call to 101 to end', () => lastEnded(jean.page), { timeout: 20_000 })
    // 477 "Send failed": OpenSIPS could not reach the contact; the person reads the same as for nobody registered.
    expectEqual(`${ended.endStatus} ${ended.endReason}`, '477 unavailable', 'how the call to a dead contact ended')
    await jean.page.getByText('101 est injoignable.').waitFor()
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
    await jean.page.getByText('En communication avec 101').waitFor()
    await bothHearEachOther(alice, jean)
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await jean.page.getByText('Appel avec 101 terminé.').waitFor()
  })
  await step('Alice signs out, which unregisters her: a call to 101 is now unreachable', async () => {
    await signOut(alice)
    await dial(jean.page, '101')
    const ended = await until('the call to 101 to end', () => lastEnded(jean.page), { timeout: 20_000 })
    // 404: no contact left for 101. A registration left behind would have given 480 (dead contact) or rung.
    expectEqual(`${ended.endStatus} ${ended.endReason}`, '404 unavailable', 'how the call to 101 ended after Alice signed out')
    await jean.page.getByText('101 est injoignable.').waitFor()
  })
} catch (err) {
  failed = true
  console.error(err)
  for (const who of [alice, jean, bob]) {
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
  await relay.stop()
  await dtmf?.stop()
  await db.end()
}
process.exit(failed ? 1 : 0)
