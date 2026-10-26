// Smoke test of a deployed pilot (docker/pilot, demo profile): two people sign in through the demo Keycloak, find each
// other in the demo directory with their presence, call each other through OpenSIPS and rtpengine with audio both
// ways, and see the call in their history. Nothing runs in this process but the browser: it only talks to the
// deployment, as the pilot's users will. Run it on the pilot machine after `docker compose up`, or from any machine
// that reaches it (the media ports included).
//
//   PILOT_URL            https://<DOMAIN> of the deployment (required)
//   ALICE_PASSWORD       Alice's and Bob's passwords, from docker/pilot/.env (required)
//   BOB_PASSWORD
//   PILOT_RESOLVE        an IP the browser uses for DOMAIN instead of the DNS (a test without a public name)
//   PILOT_INSECURE=1     accept the certificate (TLS=internal)
//   BROWSER              chromium (default), firefox or msedge
//   PLAYWRIGHT_CHROMIUM  a Chromium binary to use instead of Playwright's (PLAYWRIGHT_FIREFOX likewise)
import { chromium, firefox } from 'playwright-core'

const need = name => {
  if (!process.env[name]) throw new Error(`${name} is required (see the header of ${new URL(import.meta.url).pathname})`)
  return process.env[name]
}
const PILOT_URL = new URL(need('PILOT_URL')).origin
const PASSWORDS = { alice: need('ALICE_PASSWORD'), bob: need('BOB_PASSWORD') }
const RESOLVE = process.env.PILOT_RESOLVE
const INSECURE = process.env.PILOT_INSECURE === '1'
const BROWSER = process.env.BROWSER ?? 'chromium'
const host = new URL(PILOT_URL).hostname

const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), err => { console.log(`FAIL ${name}`); throw err })
const until = async (what, fn, { timeout = 15_000, every = 250 } = {}) => {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, every))
  }
}

const media = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
const browser = BROWSER === 'firefox'
  ? await firefox.launch({
      ...(process.env.PLAYWRIGHT_FIREFOX ? { executablePath: process.env.PLAYWRIGHT_FIREFOX } : {}),
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
        ...(RESOLVE ? { 'network.dns.forceResolve': RESOLVE } : {})
      }
    })
  : await chromium.launch({
      ...(BROWSER === 'msedge' ? { channel: 'msedge' } : process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
      // No proxy for the pilot: the browser must reach its media ports directly, as a user's would.
      args: [...media, '--no-proxy-server', ...(RESOLVE ? [`--host-resolver-rules=MAP ${host} ${RESOLVE}`] : [])]
    })

/** Signs in through the demo Keycloak and waits for the softphone to be registered. */
const open = async (login, name) => {
  const context = await browser.newContext({ locale: 'fr-FR', ignoreHTTPSErrors: INSECURE })
  const page = await context.newPage()
  page.on('pageerror', err => console.log(`[${name}] page error:`, err.message))
  page.on('console', msg => { if (msg.type() === 'error') console.log(`[${name}] browser error:`, msg.text()) })
  await page.goto(`${PILOT_URL}/`)
  await page.getByRole('button', { name: 'Se connecter' }).click()
  await page.waitForURL(`${PILOT_URL}/auth/**`)
  await page.locator('#username').fill(login)
  await page.locator('#password').fill(PASSWORDS[login])
  await page.locator('#kc-login').click()
  await page.waitForURL(`${PILOT_URL}/`)
  await page.getByTestId('who').getByText(name).waitFor()
  await page.getByTestId('phone-state').getByText('En ligne').waitFor({ timeout: 20_000 })
  return { page, context, name }
}
const presenceIs = async (page, query, extension, status) => {
  await page.getByRole('link', { name: 'Clavier' }).click()
  await page.getByLabel('Rechercher').fill(query)
  await page.getByTestId(`presence-${extension}`).filter({ hasText: status }).waitFor({ timeout: 10_000 })
}
const stats = page => page.evaluate(() => window.twakephone.stats())

let failed = false
try {
  let alice, bob
  await step('Alice and Bob sign in through the identity provider; their browsers register to OpenSIPS', async () => {
    alice = await open('alice', 'Alice Martin')
    bob = await open('bob', 'Bob Durand')
  })
  await step('the directory finds Bob with his extension and presence; Alice administers, Bob does not', async () => {
    await presenceIs(alice.page, 'Bob', '102', 'Disponible')
    await alice.page.getByRole('link', { name: 'Administration' }).waitFor()
    if (await bob.page.getByRole('link', { name: 'Administration' }).count()) throw new Error('Bob sees the administration')
  })
  await step('Alice calls Bob, who answers: audio flows both ways through rtpengine, presence shows the call', async () => {
    await alice.page.getByRole('link', { name: 'Clavier' }).click()
    await alice.page.getByLabel('Numéro à appeler').fill('102')
    await alice.page.getByRole('button', { name: 'Appeler' }).click()
    await bob.page.getByTestId('incoming-call').getByText('Alice Martin (101)').waitFor({ timeout: 20_000 })
    await bob.page.getByTestId('incoming-call').getByRole('button', { name: 'Répondre' }).click()
    await bob.page.getByText('En communication avec Alice Martin (101)').waitFor()
    for (const who of [alice, bob]) {
      await until(`audio both ways for ${who.name}`, async () => {
        const [s] = await stats(who.page)
        return s && s.packetsReceived > 50 && s.packetsSent > 50
      }, { timeout: 20_000 })
    }
    await presenceIs(bob.page, 'Alice', '101', 'En communication')
  })
  await step('Alice hangs up: both are available again, the call is in Bob\'s history', async () => {
    await alice.page.getByRole('button', { name: 'Raccrocher' }).click()
    await presenceIs(bob.page, 'Alice', '101', 'Disponible')
    await bob.page.getByRole('link', { name: 'Récents' }).click()
    await until('the call in Bob\'s history', async () => (await bob.page.locator('[data-testid=recents] li').filter({ hasText: '101' }).count()) > 0)
  })
  await step('the identity provider\'s administration and account console are not served on the Internet', async () => {
    for (const path of ['/auth/admin/', '/auth/realms/master/', '/auth/realms/twakephone/account']) {
      const res = await alice.page.request.get(`${PILOT_URL}${path}`, { maxRedirects: 0 })
      if (res.status() !== 404) throw new Error(`${path} answers ${res.status()}, expected 404`)
    }
  })
  await step('Alice signs out', async () => {
    await alice.page.getByRole('button', { name: 'Se déconnecter' }).click()
    await alice.page.getByRole('button', { name: 'Se connecter' }).waitFor({ timeout: 20_000 })
  })
} catch (err) {
  failed = true
  console.error(err)
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
