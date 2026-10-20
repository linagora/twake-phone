// End to end: a real browser signs in through an OpenID provider, the app shows who the Gateway says you are,
// and signing out brings the sign-in page back. No Docker: the provider, the Gateway and the app run in this process.
// The app is served by its production server (apps/web/server), so the policy it ships with is the one tested.
import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { buildApp } from '../../gateway/dist/app.js'
import { JwtAuthenticator } from '../../gateway/dist/auth.js'
import { DirectorySync } from '../../gateway/dist/directory-sync.js'
import { DEFAULT_ATTRIBUTES, LdapDirectory } from '../../gateway/dist/ldap-directory.js'
import { ProviderRegistry } from '../../gateway/dist/registry.js'
import { MemoryStore } from '../../gateway/dist/store/memory.js'
import { parseNetworks } from '../../gateway/dist/webhook-delivery.js'
import { BASE_DN, READER_DN, READER_PASSWORD, startLdapMock } from '../../gateway/test/ldap-mock.mjs'
import { startWebhookReceiver } from '../../gateway/test/webhook-receiver.mjs'
import { OvhOperator } from '../../../packages/provider-ovh/dist/index.js'
import { startFakeOvh } from '../../../packages/provider-ovh/test/fake-ovh.mjs'
import { startOidcMock } from './oidc-mock.mjs'
import { serveApp } from '../server/serve.mjs'

const AUDIENCE = 'twakephone-gateway'
const RESOURCE = 'https://gateway.twakephone.test'

/** A free TCP port: the provider needs its issuer URL before it listens, so ports are picked up front. */
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

/** Screenshots for a review, into the folder E2E_SHOTS names (none without it). */
const shot = (page, name) => (process.env.E2E_SHOTS ? page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true }) : undefined)
const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), err => { console.log(`FAIL ${name}`); throw err })
const expectEqual = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
/** Waits until `check` holds (read again every 100 ms), or fails naming `what`. */
const until = async (check, what, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return
  throw new Error(`${what}: not within ${ms} ms`)
}
/** A date as OVH writes them: ISO 8601 to the second, with the offset of Paris in summer. */
const ovhDate = ms => new Date(ms + 2 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '+02:00')

const [APP_PORT, OIDC_PORT, GATEWAY_PORT, OTHER_PORT] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
const appOrigin = `http://127.0.0.1:${APP_PORT}`
const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`

process.env.LOG_LEVEL ??= 'warn'
process.env.CORS_ORIGINS = appOrigin
process.env.DEFAULT_TENANT = 'e2e'

const oidc = await startOidcMock({ port: OIDC_PORT, appOrigin, audience: AUDIENCE, resource: RESOURCE })
const ldap = await startLdapMock()
// The provider's "roles" claim says who administers the platform (JWT_ROLES_CLAIM=roles, ADMIN_ROLE=twakephone-admin).
const auth = new JwtAuthenticator({ jwksUrl: oidc.jwksUrl, issuer: oidc.issuer, audience: AUDIENCE, defaultTenant: 'e2e', rolesClaim: 'roles' })
// The directory's ipPhone attribute holds the extension (LDAP_ATTR_EXTENSION=ipPhone): the synchronisation copies it.
const contacts = new LdapDirectory({ url: ldap.url, tenantId: 'e2e', bindDn: READER_DN, bindPassword: READER_PASSWORD, baseDn: BASE_DN, userFilter: '(objectClass=inetOrgPerson)', attributes: { ...DEFAULT_ATTRIBUTES, extension: 'ipPhone' } })
const store = new MemoryStore()
const directorySync = new DirectorySync({ store, directory: contacts, tenantId: 'e2e' })
// No telephony platform at first (the dialer says so); the administration steps then give the tenant one, kept in
// memory: what the screens send it is what a SIP server would be handed (trunks with their password, direct
// numbers, rights), and it says its trunks are registered.
const providers = []
const platform = {
  trunks: [],
  dids: [],
  groups: [],
  outbound: null,
  // The trunk servers that answer no probe (step 10a: trunk.degraded).
  probing: new Set(),
  // What the SIP server tells (step 10a: a missed call), in order; `waiting` is the stream waiting for the next one.
  events: [],
  waiting: null,
  tell(extension, event) {
    this.events.push({ extension, event })
    this.waiting?.()
  }
}
const notHere = async () => {
  throw Object.assign(new Error('Not on this platform'), { statusCode: 501 })
}
const memoryPlatform = {
  type: 'e2e-memory',
  create: () => ({
    id: 'e2e-memory',
    getStatus: () => 'CONNECTED',
    getCapabilities: async () => ({
      calling: { outbound: false, inbound: false, answer: false, hangup: false, hold: false, transfer: false, dtmf: false },
      media: { browserAudio: false },
      presence: { read: false, write: false, realtime: false, statuses: [] },
      history: false,
      groups: true,
      trunks: true,
      outboundPolicy: true,
      conference: { dialIn: false, dialOut: false }
    }),
    getPresence: async () => ({ status: 'offline', source: 'system' }),
    setPresence: async () => {},
    syncExtensions: async () => {},
    listGroups: async () => platform.groups,
    setGroup: async group => {
      platform.groups = [...platform.groups.filter(g => g.number !== group.number), group]
    },
    deleteGroup: async number => platform.groups.length !== (platform.groups = platform.groups.filter(g => g.number !== number)).length,
    setTrunks: async (trunks, dids) => {
      platform.trunks = trunks
      platform.dids = dids
    },
    getTrunkStatus: async () => platform.trunks.map(t => ({ id: t.id, ...(t.auth === 'register' ? { registration: { state: 'registered' } } : {}), servers: (t.proxies ?? [t.domain]).map(address => ({ address, state: platform.probing.has(address) ? 'probing' : 'up' })) })),
    setOutboundPolicy: async (policy, profiles, assignments) => {
      platform.outbound = { policy, profiles, assignments }
    },
    originate: notHere,
    answer: notHere,
    hangup: notHere,
    hold: notHere,
    resume: notHere,
    transfer: notHere,
    sendDTMF: notHere,
    close: async () => {},
    // Nobody calls on this platform, save what a step tells (platform.tell).
    subscribe: async function* () {
      for (;;) {
        while (platform.events.length) yield platform.events.shift()
        await new Promise(resolve => (platform.waiting = resolve))
      }
    }
  })
}
// The tool an administrator subscribes to the webhooks (step 10a), on this host: the Gateway may reach it only because
// the operator opens the loopback to deliveries (WEBHOOK_PRIVATE_NETWORKS), allows http (WEBHOOK_ALLOW_HTTP=1) and its
// port (WEBHOOK_PORTS).
const receiver = await startWebhookReceiver()
// The operator of the trunk (step 10b): a fake of the OVHcloud API written from its public documentation (no real
// OVH here), with the keys it was given (made up), one billing account and its line. The Gateway reads it every
// second (10 minutes in production) and reconciles the records of calls at once (5 minutes after their reading).
const OVH_ACCOUNT = 'zz00000-fake-1'
const OVH_LINE = '0033199000100'
const ovh = await startFakeOvh({ accounts: { [OVH_ACCOUNT]: { lines: { [OVH_LINE]: {} } } } })
// The fake answers on the loopback: a URL of a test only (in production, ovh-eu, ovh-ca or ovh-us).
const ovhOperator = new OvhOperator({ ...ovh.credentials, baseUrl: ovh.url, billingAccount: OVH_ACCOUNT })
// What the Gateway logs, kept to be read (review 10b, n°22: never an OVH key in it), and shown as it comes.
const logged = []
const logStream = {
  write: line => {
    logged.push(line)
    process.stdout.write(line)
  }
}
const gateway = await buildApp(new ProviderRegistry(providers, [memoryPlatform]), {
  auth,
  store,
  contacts,
  directorySync,
  secretsKey: randomBytes(32),
  admin: { adminRole: 'twakephone-admin', adminUsers: new Set() },
  webhooks: { policy: { allowHttp: true, ports: [Number(new URL(receiver.url).port)] }, open: parseNetworks('127.0.0.1/32'), retryBaseMs: 300, pollMs: 100 },
  trunkWatchMs: 300,
  operators: new Map([['e2e', ovhOperator]]),
  logStream,
  operatorSyncMs: 1000,
  operatorSettleMs: 0
})
await gateway.listen({ host: '127.0.0.1', port: GATEWAY_PORT })
const web = await serveApp({
  dir: fileURLToPath(new URL('../dist/', import.meta.url)),
  port: APP_PORT,
  // No scope here: the app's default (with offline_access, hence a refresh token) is what gets tested.
  config: { gatewayUrl, oidc: { authority: oidc.issuer, clientId: 'twakephone-web', resource: RESOURCE } }
})
// Another site that tries to embed the app: the policy must refuse it.
const other = await new Promise(resolve => {
  const s = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Embedder</title><h1>Embedder</h1><iframe id="phone" src="${appOrigin}/" title="phone"></iframe>`)
  })
  s.listen(OTHER_PORT, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${OTHER_PORT}`, stop: () => new Promise(r => s.close(r)) }))
})

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) })
// A French browser: the UI must come up in French, and the language switch is exercised below.
const page = await browser.newPage({ locale: 'fr-FR' })
// The provider's dev pages import a Google font: not on the runner's network, and never a reason to slow the test.
await page.route(/fonts\.g(static|oogleapis)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
const cspViolations = []
page.on('pageerror', err => console.log('page error:', err.message))
page.on('console', msg => {
  if (!['error', 'warning'].includes(msg.type())) return
  if (/Content Security Policy/.test(msg.text())) cspViolations.push(msg.text())
  console.log(`browser ${msg.type()}:`, msg.text())
})
page.on('requestfailed', req => { if (!/fonts\.g(static|oogleapis)\.com/.test(req.url())) console.log('request failed:', req.method(), req.url(), req.failure()?.errorText) })
let failed = false
let session = null
try {
  await step('the app comes up in French and sends an anonymous visitor to sign in', async () => {
    await page.goto(`${web.origin}/recents`)
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await page.getByRole('button', { name: 'Sign-in' }).waitFor()
    expectEqual(new URL(page.url()).origin, oidc.issuer, 'sign-in page origin')
  })
  await step('the identity provider authenticates amartin and asks for consent', async () => {
    await page.locator('input[name=login]').fill('amartin')
    await page.locator('input[name=password]').fill('whatever')
    await page.getByRole('button', { name: 'Sign-in' }).click()
    // The consent page is the one with a Continue button: waiting on the URL would match the login page too.
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL(`${appOrigin}/**`)
  })
  await step('the app lands on the page the visitor wanted, as Alice, who has no extension yet', async () => {
    await page.waitForURL(`${appOrigin}/recents`)
    const who = page.getByTestId('who')
    await who.getByText('Alice Martin').waitFor()
    await who.getByText('Aucun poste attribué').waitFor()
    await page.getByRole('heading', { level: 1, name: 'Récents' }).waitFor()
    expectEqual(await page.title(), 'Récents – TwakePhone', 'document title')
    expectEqual(await page.evaluate(() => document.documentElement.lang), 'fr', 'html lang')
  })
  await step('the provider issued a JWT access token for the Gateway, with roles, and a refresh token for silent renewal', async () => {
    const user = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(k => k.startsWith('oidc.user'))
      return key ? JSON.parse(sessionStorage.getItem(key)) : null
    })
    if (!user) throw new Error('no oidc.user entry in sessionStorage')
    session = user
    expectEqual(user.access_token.split('.').length, 3, 'access token segments')
    const payload = JSON.parse(Buffer.from(user.access_token.split('.')[1], 'base64url').toString())
    expectEqual(payload.aud, AUDIENCE, 'access token audience')
    expectEqual(JSON.stringify(payload.roles), JSON.stringify(['staff', 'twakephone-admin']), 'roles claim')
    if (typeof user.refresh_token !== 'string' || !user.refresh_token) throw new Error('no refresh token: offline_access was not granted')
  })
  await step('the administration screen shows the LDAP source and synchronises the accounts: Alice gets extension 101', async () => {
    await page.getByRole('link', { name: 'Administration' }).click()
    await page.getByRole('heading', { level: 1, name: 'Administration' }).waitFor()
    expectEqual(await page.title(), 'Administration – TwakePhone', 'document title')
    await page.getByText(ldap.url).waitFor()
    await page.getByText(BASE_DN).waitFor()
    await page.getByText('Aucune synchronisation depuis').waitFor()
    const accepted = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/admin/directory/sync'))
    await page.getByRole('button', { name: 'Synchroniser maintenant' }).click()
    expectEqual((await accepted).status(), 202, 'synchronisation accepted')
    // The screen follows the run until it ends, then shows the report.
    await page.getByText('Synchronisation terminée.').waitFor()
    await page.getByText('Dernière synchronisation le').waitFor()
    await page.getByText('mpetit : le poste 103 est déjà attribué à bdurand').waitFor()
    const report = (await gateway.inject({ url: '/api/v1/admin/directory', headers: { authorization: `Bearer ${session.access_token}` } })).json().sync.last
    expectEqual(report.seen, 5, 'people seen')
    expectEqual(report.withExtension, 4, 'people with an extension')
    expectEqual(report.created, 3, 'extensions assigned')
    expectEqual(report.conflicts.length, 1, 'conflicts')
    // Alice is among the synchronised accounts: the header follows without a reload, and after one.
    await page.getByTestId('who').getByText('Poste 101').waitFor()
    await page.reload()
    await page.getByTestId('who').getByText('Poste 101').waitFor()
    expectEqual((await gateway.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${session.access_token}` } })).json().extension, '101', 'extension in the Gateway')
    // The second run changes nothing: the synchronisation is idempotent.
    expectEqual((await directorySync.run()).unchanged, 3, 'second run')
  })
  await step('the session survives a reload', async () => {
    await page.reload()
    await page.getByTestId('who').getByText('Alice Martin').waitFor()
  })
  await step('the app stays light on a dark system, even with the `system` mode an earlier version stored', async () => {
    await page.evaluate(() => localStorage.setItem('mui-mode', 'system'))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.reload()
    await page.getByTestId('who').getByText('Alice Martin').waitFor()
    expectEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'colour scheme applied')
    const [r, g, b] = (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).match(/\d+/g).map(Number)
    if (r + g + b < 600) throw new Error(`a dark page: rgb(${r}, ${g}, ${b})`)
    expectEqual(await page.evaluate(() => localStorage.getItem('mui-mode')), null, 'the stored mode forgotten')
    await page.emulateMedia({ colorScheme: 'light' })
  })
  await step('the dialer explains that calling is not configured on this platform', async () => {
    await page.getByRole('link', { name: 'Clavier' }).click()
    await page.getByText(/pas encore disponible/).waitFor()
    await page.getByRole('button', { name: '5', exact: true }).click()
    expectEqual(await page.getByLabel('Numéro à appeler').inputValue(), '5', 'keypad input')
  })
  await step('the directory beside the keypad lists everyone, then finds Jean Dupont by "dup", with his number and department', async () => {
    const list = page.getByTestId('contacts')
    await list.getByRole('link', { name: 'Zoé Lefèvre', exact: true }).waitFor()
    await list.getByRole('link', { name: 'Jean Dupont', exact: true }).waitFor()
    await page.getByLabel('Rechercher').fill('dup')
    await list.getByRole('link', { name: 'Zoé Lefèvre', exact: true }).waitFor({ state: 'detached' })
    await list.getByRole('link', { name: 'Jean Dupont', exact: true }).waitFor()
    await list.getByText(/Support · 102/).waitFor()
    expectEqual(await list.getByRole('listitem').count(), 1, 'number of results')
    await page.getByLabel('Rechercher').fill('support')
    await list.getByRole('link', { name: 'Bob Durand', exact: true }).waitFor()
    expectEqual(await list.getByRole('listitem').count(), 3, 'number of results for "support"')
    await page.getByLabel('Rechercher').fill('zoe')
    await list.getByRole('link', { name: 'Zoé Lefèvre', exact: true }).waitFor()
    await page.getByLabel('Rechercher').fill('01 23 45 67 01')
    await list.getByRole('link', { name: 'Jean Dupont', exact: true }).waitFor()
    expectEqual(await list.getByRole('listitem').count(), 1, 'number of results by number')
    await page.getByLabel('Rechercher').fill('')
    await list.getByRole('link', { name: 'Zoé Lefèvre', exact: true }).waitFor()
    await list.getByRole('listitem').filter({ hasText: 'Jean Dupont' }).hover()
    await shot(page, 'accueil')
  })
  await step('the phone of a row calls the person (to the keypad here, no softphone); a number nobody has is called from the search', async () => {
    await page.getByLabel('Rechercher').fill('dup')
    const row = page.getByTestId('contacts').getByRole('listitem').filter({ hasText: 'Jean Dupont' })
    await row.hover()
    await row.getByRole('button', { name: 'Appeler Jean Dupont' }).click()
    await page.waitForFunction(() => document.querySelector('#number')?.value === '102')
    await page.getByLabel('Rechercher').fill('01 99 00 01 99')
    await page.getByText('Personne ne correspond à « 01 99 00 01 99 ».').waitFor()
    await page.getByRole('button', { name: 'Appeler le 01 99 00 01 99' }).click()
    await page.waitForFunction(() => document.querySelector('#number')?.value.replace(/\s/g, '') === '0199000199')
    expectEqual(new URL(page.url()).search, '', 'address bar cleaned')
  })
  await step('the contact card has no favourite button any more', async () => {
    await page.getByLabel('Rechercher').fill('dup')
    await page.getByTestId('contacts').getByRole('link', { name: 'Jean Dupont', exact: true }).click()
    await page.getByRole('heading', { level: 1, name: 'Jean Dupont' }).waitFor()
    expectEqual(await page.getByRole('button', { name: /^Favori/ }).count(), 0, 'favourite buttons')
  })
  await step('the contact card lists every number, and Call sends it to the dialer', async () => {
    await page.getByRole('heading', { level: 1, name: 'Jean Dupont' }).waitFor()
    expectEqual(await page.title(), 'Jean Dupont – TwakePhone', 'document title')
    await page.getByText('Technicien · Support').waitFor()
    await shot(page, 'fiche')
    await page.getByText('Mobile').waitFor()
    await page.getByRole('button', { name: /Appeler le .*6.12.34.56.01/ }).click()
    await page.getByRole('heading', { level: 1, name: 'Téléphone' }).waitFor()
    const typed = await page.getByLabel('Numéro à appeler').inputValue()
    expectEqual(typed.replace(/\s/g, ''), '+33612345601', 'number sent to the dialer')
    expectEqual(new URL(page.url()).search, '', 'address bar cleaned')
  })
  await step('a link from Twake Chat (/?dial=) fills the dialer with the normalised number and dials nothing', async () => {
    await page.goto(`${appOrigin}/?dial=${encodeURIComponent('06 12 34 56 02')}`)
    await page.getByRole('heading', { level: 1, name: 'Téléphone' }).waitFor()
    await page.waitForFunction(() => document.querySelector('#number')?.value === '+33612345602')
    expectEqual(new URL(page.url()).search, '', 'address bar cleaned')
    // Text that is not a number is refused out loud and never reaches the field
    await page.goto(`${appOrigin}/?dial=${encodeURIComponent('FR123456789')}`)
    await page.getByRole('alert').getByText('ne contient pas un numéro valide').waitFor()
    expectEqual(await page.getByLabel('Numéro à appeler').inputValue(), '', 'field after a refused ?dial=')
  })
  await step('switching the language to English changes the UI, the title and the document language', async () => {
    await page.getByRole('link', { name: 'Réglages' }).click()
    // The audio devices live here too; without a phone on this platform the ringtone cannot be tested.
    await page.getByRole('heading', { level: 2, name: 'Audio' }).waitFor()
    await page.getByLabel('Microphone').waitFor()
    if (!(await page.getByRole('button', { name: 'Tester la sonnerie' }).isDisabled())) throw new Error('the ringtone test must wait for a phone')
    // No telephony platform here: no availability nor forwarding to set, and no error about them either.
    await page.waitForLoadState('networkidle')
    for (const name of ['Disponibilité', "Renvois d'appel"]) expectEqual(await page.getByRole('heading', { level: 2, name }).count(), 0, `no "${name}" section`)
    expectEqual(await page.getByRole('alert').count(), 0, 'no error shown')
    await page.getByLabel("Langue de l'interface").selectOption('en')
    await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor()
    expectEqual(await page.title(), 'Settings – TwakePhone', 'document title')
    expectEqual(await page.evaluate(() => document.documentElement.lang), 'en', 'html lang')
  })
  // Step 7: the administration screens, on a platform that has trunks (the in-memory one above).
  const api = (url, init = {}) => gateway.inject({ url: `/api/v1${url}`, ...init, headers: { authorization: `Bearer ${session.access_token}`, ...(init.headers ?? {}) } })
  const subnav = page.getByRole('navigation', { name: "Rubriques de l'administration" })
  const TRUNK_PASSWORD = randomBytes(12).toString('base64url')
  await step('an administrator adds a trunk from its screen: checked as the Gateway checks it, its password never shown again', async () => {
    providers.push({ tenantId: 'e2e', type: 'e2e-memory', config: {} })
    await page.getByLabel('Interface language').selectOption('fr')
    await page.getByRole('link', { name: 'Administration' }).click()
    await subnav.getByRole('link', { name: 'Trunks', exact: true }).click()
    await page.getByRole('heading', { level: 2, name: 'Trunks' }).waitFor()
    expectEqual(await page.title(), 'Trunks – Administration – TwakePhone', 'document title')
    await page.getByText("Aucun trunk pour l'instant").waitFor()
    // Sent empty: every problem said next to its field, the focus on the first one, nothing sent.
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    await page.getByRole('alert').getByText('Le formulaire a 5 erreurs').waitFor()
    expectEqual(await page.evaluate(() => document.activeElement?.id), 'trunk-id', 'focus on the first field in error')
    expectEqual(await page.getByRole('textbox', { name: 'Identifiant', exact: true }).getAttribute('aria-invalid'), 'true', 'aria-invalid')
    await page.getByRole('textbox', { name: 'Identifiant', exact: true }).fill('operator')
    await page.getByLabel('Nom affiché').fill('Opérateur')
    await page.getByLabel("Domaine SIP de l'opérateur").fill('sip.operator.example')
    await page.getByLabel("Serveurs de l'opérateur").fill('sip1.operator.example, 192.0.2.10:5060')
    await page.getByLabel("Identifiant chez l'opérateur").fill('twake')
    await page.getByLabel('Mot de passe', { exact: true }).fill(TRUNK_PASSWORD)
    await page.getByLabel('Numéro présenté par défaut').fill('01 99 00 01 00')
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    await page.getByRole('status').getByText('Trunk operator enregistré.').waitFor()
    const list = page.getByRole('list', { name: 'Trunks existants' })
    await list.getByText('Opérateur (operator)').waitFor()
    await list.getByText('enregistré (jamais affiché)').waitFor()
    // How it is doing, as the platform says: registered, both servers reachable.
    await list.getByText('Enregistré', { exact: true }).waitFor()
    await list.getByText('Serveur 192.0.2.10:5060 : Joignable').waitFor()
    // The platform got the password; neither the page nor the API ever shows it again.
    expectEqual(platform.trunks[0]?.password, TRUNK_PASSWORD, 'password handed to the platform')
    expectEqual(JSON.stringify(platform.trunks[0]?.proxies), JSON.stringify(['sip1.operator.example', '192.0.2.10:5060']), 'servers')
    expectEqual(platform.trunks[0]?.defaultNumber, '+33199000100', 'default number in E.164')
    if ((await page.content()).includes(TRUNK_PASSWORD)) throw new Error('the password is in the page')
    if ((await api('/admin/trunks')).body.includes(TRUNK_PASSWORD)) throw new Error('the password is in the API')
    // Changed without typing a password: the one kept stays.
    await page.getByRole('button', { name: 'Modifier le trunk operator' }).click()
    expectEqual(await page.getByLabel('Mot de passe', { exact: true }).inputValue(), '', 'password field empty when editing')
    await page.getByLabel("Pays permis à l'international").fill('32')
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    await page.locator('#trunk-countries-error').getByText("ne s'indiquent que si l'international est permis").waitFor()
    await page.getByRole('group', { name: 'Appels permis' }).getByLabel('International').check()
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    await page.getByRole('status').getByText('Trunk operator enregistré.').waitFor()
    expectEqual(platform.trunks[0]?.password, TRUNK_PASSWORD, 'password kept')
    expectEqual(JSON.stringify(platform.trunks[0]?.countries), JSON.stringify(['32']), 'countries')
  })
  await step('then a range of direct numbers to the extensions their last digits name, and one number to an extension', async () => {
    await subnav.getByRole('link', { name: 'Numéros directs' }).click()
    await page.getByRole('heading', { level: 2, name: 'Numéros directs' }).waitFor()
    expectEqual(await page.title(), 'Numéros directs – Administration – TwakePhone', 'document title')
    await page.getByText("Aucun numéro direct pour l'instant.").waitFor()
    expectEqual(await page.getByLabel('Trunk', { exact: true }).inputValue(), 'operator', 'trunk chosen')
    await page.getByRole('textbox', { name: 'Identifiant', exact: true }).fill('staff')
    await page.getByLabel('Numéro (ou premier de la plage)').fill('01 99 00 01 00')
    await page.getByLabel('Dernier numéro de la plage').fill('01 99 00 01 99')
    await page.getByLabel('Le poste qui finit par les derniers chiffres du numéro appelé').check()
    await page.getByRole('button', { name: 'Enregistrer les numéros directs' }).click()
    // 100 to 199 hold 112, 115...: those numbers would never ring anyone inside.
    await page.locator('#did-suffixDigits-error').getByText('112, 114, 115').waitFor()
    expectEqual(await page.evaluate(() => document.activeElement?.id), 'did-suffixDigits', 'focus on the field in error')
    await page.getByLabel('Dernier numéro de la plage').fill('01 99 00 01 09')
    await page.getByRole('button', { name: 'Enregistrer les numéros directs' }).click()
    await page.getByRole('status').getByText('Numéros directs staff enregistrés.').waitFor()
    // One number to an extension nobody holds: the Gateway refuses it, the screen says so on the field.
    await page.getByRole('textbox', { name: 'Identifiant', exact: true }).fill('accueil')
    await page.getByLabel('Numéro (ou premier de la plage)').fill('+33 1 99 00 02 00')
    await page.getByRole('combobox', { name: 'Poste ou groupe', exact: true }).fill('555')
    const refused = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/admin/dids/accueil'))
    await page.getByRole('button', { name: 'Enregistrer les numéros directs' }).click()
    expectEqual((await refused).status(), 400, 'unknown target refused by the Gateway')
    await page.locator('#did-target-error').getByText("ni un poste attribué ni un groupe d'appel").waitFor()
    await page.getByRole('combobox', { name: 'Poste ou groupe', exact: true }).fill('101')
    await page.getByRole('button', { name: 'Enregistrer les numéros directs' }).click()
    await page.getByRole('status').getByText('Numéros directs accueil enregistrés.').waitFor()
    const list = page.getByRole('list', { name: 'Numéros directs existants' })
    await list.getByText('+33199000100 à +33199000109').waitFor()
    await list.getByText('101 (Alice Martin)').waitFor()
    // What the SIP server is handed: the exit of step 7, without a console.
    expectEqual(
      JSON.stringify(platform.dids),
      JSON.stringify([
        { id: 'staff', trunkId: 'operator', first: '+33199000100', last: '+33199000109', suffixDigits: 3 },
        { id: 'accueil', trunkId: 'operator', first: '+33199000200', last: '+33199000200', target: '101' }
      ]),
      'direct numbers handed to the platform'
    )
  })
  await step('a rights profile limited to internal calls, given to Alice; the caps of the organisation checked before they are sent', async () => {
    await subnav.getByRole('link', { name: "Droits d'appel" }).click()
    await page.getByRole('heading', { level: 2, name: 'Nouveau profil' }).waitFor()
    await page.getByRole('textbox', { name: 'Identifiant', exact: true }).fill('interne')
    await page.getByLabel('Nom affiché').fill('Interne')
    await page.locator('#profile-concurrent-mode').selectOption('value')
    await page.getByLabel('Appels simultanés : valeur').fill('1')
    await page.getByRole('button', { name: 'Enregistrer le profil', exact: true }).click()
    await page.getByText('Profil interne enregistré.').waitFor()
    await page.getByLabel('Profil de Alice Martin', { exact: true }).selectOption('interne')
    await page.getByRole('button', { name: 'Appliquer le profil de Alice Martin' }).click()
    await page.getByText('Profil de Alice Martin enregistré.').waitFor()
    expectEqual(JSON.stringify(platform.outbound?.profiles), JSON.stringify([{ id: 'interne', name: 'Interne', allowed: [], caps: { concurrent: 1 } }]), 'profiles handed to the platform')
    expectEqual(JSON.stringify(platform.outbound?.assignments.map(a => a.profileId)), JSON.stringify(['interne']), 'assignment')
    await subnav.getByRole('link', { name: 'Plafonds et seuils' }).click()
    await page.locator('#limits-tenant-concurrent-mode').selectOption('value')
    await page.locator('#limits-tenant-concurrent').fill('0')
    await page.locator('#limits-international-callsPerMinute-mode').selectOption('custom')
    await page.locator('#limits-international-callsPerMinute').fill('9')
    await page.locator('#limits-international-callsPerMinute-critical').fill('3')
    await page.getByRole('button', { name: 'Enregistrer les plafonds et les seuils' }).click()
    await page.getByRole('alert').getByText('Le formulaire a 2 erreurs').waitFor()
    await page.locator('#limits-tenant-concurrent-error').getByText('Un nombre entier de 1 à 1000000').waitFor()
    await page.locator('#limits-international-callsPerMinute-error').getByText("Le seuil d'alerte ne dépasse pas le seuil critique").waitFor()
    expectEqual(await page.evaluate(() => document.activeElement?.id), 'limits-tenant-concurrent', 'focus on the first field in error')
    await page.locator('#limits-tenant-concurrent').fill('10')
    await page.locator('#limits-international-callsPerMinute-critical').fill('12')
    await page.getByRole('button', { name: 'Enregistrer les plafonds et les seuils' }).click()
    await page.getByText('Plafonds et seuils enregistrés.').waitFor()
    expectEqual(JSON.stringify(platform.outbound?.policy), JSON.stringify({ caps: { concurrent: 10 }, fraud: { international: { callsPerMinute: { warning: 9, critical: 12 } } } }), 'policy handed to the platform')
    // The profiles and who has which are kept when the caps change.
    expectEqual(platform.outbound?.assignments.length, 1, 'assignment kept')
  })
  await step('the alerts the SIP server raised are listed, and acknowledged', async () => {
    await store.addAlert({ tenantId: 'e2e', at: new Date().toISOString(), alert: { kind: 'rights', param: 'international', scope: 'user', extension: '101', number: '+442079460123' } })
    await subnav.getByRole('link', { name: 'Alertes' }).click()
    const table = page.getByRole('table', { name: 'Alertes' })
    await table.getByText('Hors des droits, appel refusé').waitFor()
    await table.getByText('101 (Alice Martin)').waitFor()
    await table.getByText('+442079460123').waitFor()
    await page.getByRole('button', { name: /^Acquitter l'alerte International/ }).click()
    await page.getByText('Alerte acquittée.').waitFor()
    await page.getByText('Aucune alerte.').waitFor()
    const acknowledged = (await api('/admin/alerts?state=acknowledged')).json().items
    expectEqual(acknowledged.length, 1, 'acknowledged alerts')
    expectEqual(typeof acknowledged[0].acknowledgedBy, 'string', 'acknowledged by someone')
  })
  await step('an administrator subscribes a tool to the webhooks: its domain allowed first, the secret shown once, a signed test received', async () => {
    await subnav.getByRole('link', { name: 'Webhooks' }).click()
    await page.getByRole('heading', { level: 2, name: 'Webhooks' }).waitFor()
    expectEqual(await page.title(), 'Webhooks – Administration – TwakePhone', 'document title')
    await page.getByText('Aucun abonnement.').waitFor()
    const url = `${receiver.url}/twakephone`
    // Not among the allowed domains: refused before anything is sent, the focus on the address.
    await page.getByLabel('Adresse de réception').fill(url)
    await page.getByRole('button', { name: "Enregistrer l'abonnement" }).click()
    await page.locator('#webhook-url-error').getByText("127.0.0.1 n'est pas parmi les domaines autorisés").waitFor()
    expectEqual(await page.evaluate(() => document.activeElement?.id), 'webhook-url', 'focus on the address')
    await page.getByLabel('Domaines vers lesquels un webhook peut être envoyé').fill('127.0.0.1')
    await page.getByRole('button', { name: 'Enregistrer les domaines' }).click()
    await page.getByRole('status').getByText('Domaines enregistrés (1).').waitFor()
    const events = page.getByRole('group', { name: 'Événements envoyés' })
    expectEqual(await events.getByLabel('Appel manqué').isChecked(), true, 'a missed call ticked by default')
    await events.getByLabel('Trunk dégradé').check()
    await events.getByLabel('Trunk rétabli').check()
    await page.getByLabel('Description').fill('CRM')
    await page.getByRole('button', { name: "Enregistrer l'abonnement" }).click()
    // The secret, shown once, the focus on it: the tool is given it.
    const secretField = page.getByRole('textbox', { name: 'Secret', exact: true })
    await secretField.waitFor()
    const secret = await secretField.inputValue()
    if (!/^whsec_[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error(`unexpected secret ${secret}`)
    expectEqual(await page.evaluate(() => document.activeElement?.id), 'webhook-secret-value', 'focus on the secret')
    receiver.secret = secret
    await page.getByRole('button', { name: "J'ai copié le secret" }).click()
    if ((await page.content()).includes(secret)) throw new Error('the secret is still in the page')
    const listed = await api('/webhooks')
    if (listed.body.includes(secret)) throw new Error('the secret is in the API')
    const list = page.getByRole('list', { name: 'Abonnements' })
    await list.getByText(`${url} (CRM) : Appel manqué, Trunk dégradé, Trunk rétabli.`).waitFor()
    await page.getByRole('button', { name: `Tester l'abonnement ${url}` }).click()
    const test = await receiver.waitFor(e => e?.type === 'webhook.test', 'webhook.test')
    expectEqual(test.verified, true, 'test signature')
    expectEqual(test.path, '/twakephone', 'path')
    expectEqual(test.headers['idempotency-key'], test.event.id, 'idempotency key')
    expectEqual(test.headers['x-twakephone-event'], 'webhook.test', 'event header')
  })
  await step('Jean misses a call: the tool receives a signed call.missed, with the numbers and the person, once', async () => {
    const call = { id: 'e2e-missed-1@192.0.2.10', direction: 'inbound', remoteNumber: '+33639980001', startedAt: new Date(Date.now() - 8000).toISOString() }
    platform.tell('102', { type: 'call.ringing', timestamp: call.startedAt, payload: { call: { ...call, state: 'ringing' } } })
    const endedAt = new Date().toISOString()
    platform.tell('102', { type: 'call.ended', timestamp: endedAt, payload: { call: { ...call, state: 'missed', endedAt } } })
    const missed = await receiver.waitFor(e => e?.type === 'call.missed', 'call.missed')
    expectEqual(missed.verified, true, 'call.missed signature')
    const c = missed.event.call
    expectEqual(JSON.stringify([c.id, c.direction, c.from, c.to, c.user, c.extension, c.outcome, c.duration_sec]), JSON.stringify([call.id, 'inbound', '+33639980001', '102', 'jdupont', '102', 'missed', 0]), 'the missed call')
    expectEqual(missed.event.tenant, 'e2e', 'tenant')
    // Neither the ringing nor the end: not subscribed.
    await new Promise(r => setTimeout(r, 500))
    expectEqual(receiver.received.filter(d => d.event?.type !== 'webhook.test').map(d => d.event?.type).join(), 'call.missed', 'only the missed call')
  })
  // Step 10b: the operator of the trunk, through its API (the fake OVH above).
  const trunkList = page.getByRole('list', { name: 'Trunks existants' })
  const LINE_SET = `Ligne ${OVH_LINE} : renvoi sur indisponibilité vers +33 6 39 98 00 09 ; renvoi après 150 s sans réponse vers +33 6 39 98 00 09 · renvoi de repli en place`
  const okPuts = () => ovh.requests.filter(r => r.method === 'PUT' && r.status === 200)
  await step('the administrator gives the trunk its line at OVH and keeps the fallback there: what OVH has is shown first, OVH is sent the forwards, signed, read back, and the screen says they are in place', async () => {
    await subnav.getByRole('link', { name: 'Trunks', exact: true }).click()
    await page.getByRole('button', { name: 'Modifier le trunk operator' }).click()
    await page.getByRole('textbox', { name: "Lignes chez l'opérateur" }).fill(OVH_LINE)
    // What someone set in the OVH manager: the forward on unavailability to the voicemail.
    Object.assign(ovh.options(OVH_ACCOUNT, OVH_LINE), { forwardBackup: true, forwardBackupNature: 'voicemail' })
    // Offered because this platform has the keys of an OVH application (OVH_* in production).
    await page.getByRole('checkbox', { name: "Tenir le renvoi de repli chez l'opérateur" }).check()
    // A first fallback: what OVH has on the line is read and shown, to be replaced on the administrator's word.
    await page.getByRole('list', { name: "Réglé chez l'opérateur maintenant" }).getByText(`Ligne ${OVH_LINE} : renvoi sur indisponibilité vers la messagerie`).waitFor()
    await page.getByRole('textbox', { name: 'Numéro de repli', exact: true }).fill('06 39 98 00 09')
    expectEqual(await page.getByRole('checkbox', { name: 'Sur indisponibilité (la plateforme ne répond plus)' }).isChecked(), true, 'forward on unavailability by default')
    await page.getByRole('checkbox', { name: 'Sur non-réponse', exact: true }).check()
    // 120 s: the direct number and its fallback inside would not have rung their 60 s each.
    const delay = page.getByRole('textbox', { name: 'Délai avant le renvoi sur non-réponse, en secondes' })
    await delay.fill('120')
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    await page.locator('#trunk-noAnswerAfterSec-error').getByText('Un nombre de secondes de 121 à 600.').waitFor()
    await page.locator('#trunk-replaceConfirmed-error').getByText("Cochez cette case pour remplacer ce qui est réglé chez l'opérateur sur ces lignes.").waitFor()
    expectEqual(ovh.requests.filter(r => r.method === 'PUT').length, 0, 'nothing sent to OVH')
    await page.getByRole('checkbox', { name: "Remplacer ce qui est réglé chez l'opérateur sur ces lignes" }).check()
    // OVH refuses this delay (400 INVALID_PARAMETER): the screen says so, and it is not sent again on its own.
    ovh.state.acceptDelay = sec => sec !== 150
    await delay.fill('150')
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    await page.getByRole('status').getByText('Trunk operator enregistré.').waitFor()
    await trunkList.getByText(`Ligne ${OVH_LINE} : renvoi sur indisponibilité vers la messagerie · l'opérateur n'a pas gardé ce réglage : enregistrez le trunk pour réessayer`).waitFor()
    expectEqual(JSON.stringify(ovh.requests.filter(r => r.method === 'PUT').map(r => r.status)), JSON.stringify([400]), 'refused by OVH')
    await new Promise(r => setTimeout(r, 2500))
    expectEqual(ovh.requests.filter(r => r.method === 'PUT').length, 1, 'not sent again on its own')
    // Taken by OVH this time: saved again, sent again.
    ovh.state.acceptDelay = undefined
    await page.getByRole('button', { name: 'Modifier le trunk operator' }).click()
    await page.getByRole('button', { name: 'Enregistrer le trunk' }).click()
    await page.getByRole('status').getByText('Trunk operator enregistré.').waitFor()
    // What OVH was sent: its forwards on unavailability and on no answer (the options of the line), signed.
    const puts = okPuts()
    expectEqual(puts.length, 1, 'one change at OVH')
    expectEqual(puts[0].path, `/telephony/${OVH_ACCOUNT}/line/${OVH_LINE}/options`, 'the options of the line')
    expectEqual(puts[0].signed, true, 'signed')
    expectEqual(puts[0].status, 200, 'accepted by OVH')
    const forwards = { forwardBackup: true, forwardBackupNature: 'number', forwardBackupNumber: '0033639980009', forwardNoReply: true, forwardNoReplyDelay: 150, forwardNoReplyNature: 'number', forwardNoReplyNumber: '0033639980009' }
    expectEqual(JSON.stringify(puts[0].body), JSON.stringify(forwards), 'the forwards sent')
    const options = ovh.options(OVH_ACCOUNT, OVH_LINE)
    expectEqual(JSON.stringify(Object.fromEntries(Object.keys(forwards).map(k => [k, options[k]]))), JSON.stringify(forwards), 'the forwards OVH has')
    expectEqual(ovh.requests.filter(r => r.path !== '/auth/time' && !r.signed).length, 0, 'every call signed')
    await trunkList.getByText(LINE_SET).waitFor()
    // The keys of the application never leave the Gateway, nor are they logged (review 10b, n°22).
    for (const body of [(await api('/admin/operator')).body, (await api('/admin/trunks')).body, await page.content(), logged.join('')])
      for (const key of [ovh.credentials.applicationKey, ovh.credentials.applicationSecret, ovh.credentials.consumerKey]) if (body.includes(key)) throw new Error('an OVH key is shown')
  })
  await step('changed in the OVH manager, the fallback is put back on its own, and the screen says so', async () => {
    // What a person does in the manager: the forwards off.
    Object.assign(ovh.options(OVH_ACCOUNT, OVH_LINE), { forwardBackup: false, forwardNoReply: false, forwardNoReplyDelay: 20 })
    await until(() => ovh.options(OVH_ACCOUNT, OVH_LINE).forwardBackup && ovh.options(OVH_ACCOUNT, OVH_LINE).forwardNoReplyDelay === 150, 'the fallback put back at OVH')
    expectEqual(okPuts().length, 2, 'put back once')
    await trunkList.getByText(LINE_SET).waitFor()
    await trunkList.getByText("changé chez l'opérateur, remis en place le").waitFor()
    // Then left as it is: nothing more to change.
    await new Promise(r => setTimeout(r, 2500))
    expectEqual(okPuts().length, 2, 'nothing more sent')
    // Said in the log of the Gateway, without a key (the log is read: review 10b, n°22).
    if (!logged.some(l => l.includes('the fallback was changed at the operator, put back as asked'))) throw new Error('the put back is not in the log')
    for (const key of [ovh.credentials.applicationKey, ovh.credentials.applicationSecret, ovh.credentials.consumerKey]) if (logged.join('').includes(key)) throw new Error('an OVH key is logged')
    await subnav.getByRole('link', { name: 'Webhooks' }).click()
    await page.getByRole('heading', { level: 2, name: 'Webhooks' }).waitFor()
  })
  await step('a server of the trunk answers no probe: the tool receives trunk.degraded, once, then trunk.recovered once it answers again', async () => {
    platform.probing.add('192.0.2.10:5060')
    try {
      const degraded = await receiver.waitFor(e => e?.type === 'trunk.degraded', 'trunk.degraded', 20_000)
      expectEqual(degraded.verified, true, 'trunk.degraded signature')
      const t = degraded.event.trunk
      expectEqual(JSON.stringify([t.id, t.name, t.state, t.previous]), JSON.stringify(['operator', 'Opérateur', 'degraded', 'up']), 'the trunk')
      expectEqual(JSON.stringify(t.servers), JSON.stringify([{ address: 'sip1.operator.example', state: 'up' }, { address: '192.0.2.10:5060', state: 'probing' }]), 'its servers')
      // Step 10b: the callers still reach the fallback OVH holds (its number never told).
      expectEqual(JSON.stringify(t.fallback), JSON.stringify({ on_unavailable: 'number', on_no_answer: 'number', no_answer_after_sec: 150 }), 'its fallback at the operator')
      await new Promise(r => setTimeout(r, 3000))
      expectEqual(receiver.received.filter(d => d.event?.type === 'trunk.degraded').length, 1, 'told once')
    } finally {
      platform.probing.clear()
    }
    const recovered = await receiver.waitFor(e => e?.type === 'trunk.recovered', 'trunk.recovered', 20_000)
    expectEqual(recovered.verified, true, 'trunk.recovered signature')
    const t = recovered.event.trunk
    expectEqual(JSON.stringify([t.id, t.state, t.previous]), JSON.stringify(['operator', 'up', 'degraded']), 'the trunk recovered')
    expectEqual(JSON.stringify(t.fallback), JSON.stringify({ on_unavailable: 'number', on_no_answer: 'number', no_answer_after_sec: 150 }), 'its fallback at the operator, recovered')
  })
  await step('a tool that answers 500 is sent the event again until it answers 2xx; the log says so, and a delivery is replayed', async () => {
    const before = receiver.received.length
    receiver.answer = () => 500
    const url = `${receiver.url}/twakephone`
    await page.getByRole('button', { name: `Tester l'abonnement ${url}` }).click()
    await page.getByRole('status').getByText(`Événement de test envoyé à ${url}`).waitFor()
    const first = await receiver.waitFor((e, d) => e?.type === 'webhook.test' && receiver.received.indexOf(d) >= before, 'the second test')
    // Retried with the same event (the same id): answered 2xx this time.
    receiver.answer = () => 204
    await receiver.waitFor((e, d) => e?.id === first.event.id && d !== first, 'the retry')
    await page.getByRole('button', { name: `Journal des envois à ${url}` }).click()
    const log = page.getByRole('table', { name: `Journal des envois à ${url}` })
    await log.waitFor()
    // Read again until the retry's outcome is in.
    for (let i = 0; i < 30 && !(await log.getByText(first.event.id).locator('xpath=ancestor::tr').getByText('Livré').count()); i++) {
      await page.getByRole('button', { name: 'Actualiser le journal' }).click()
      await page.waitForTimeout(200)
    }
    const row = log.getByText(first.event.id).locator('xpath=ancestor::tr')
    await row.getByText('Livré').waitFor()
    await row.getByText('réponse 204').waitFor()
    await row.getByRole('cell', { name: '2', exact: true }).waitFor()
    await log.getByText('Appel manqué').first().waitFor()
    // The missed call sent again: the same event, the same id.
    const missedId = receiver.received.find(d => d.event?.type === 'call.missed').event.id
    const count = receiver.received.filter(d => d.event?.id === missedId).length
    await page.getByRole('button', { name: /^Renvoyer : l'événement Appel manqué du / }).click()
    await page.getByRole('status').getByText('Envoi relancé').waitFor()
    await receiver.waitFor(e => e?.id === missedId && receiver.received.filter(d => d.event?.id === missedId).length > count, 'the replay')
    const replayed = receiver.received.filter(d => d.event?.id === missedId).at(-1)
    expectEqual(replayed.verified, true, 'replay signature')
    expectEqual(replayed.headers['idempotency-key'], missedId, 'replay idempotency key')
  })
  await step("OVH's records of calls are read and reconciled: Alice's missed call confirmed by the operator, a call only OVH received in her history, the counts on the screen", async () => {
    // Alice misses a call (the SIP server tells it); OVH recorded it too, a second later by its clock.
    const call = { id: 'e2e-missed-2@192.0.2.10', direction: 'inbound', remoteNumber: '+33639980001', startedAt: new Date(Date.now() - 6000).toISOString() }
    platform.tell('101', { type: 'call.ringing', timestamp: call.startedAt, payload: { call: { ...call, state: 'ringing' } } })
    const endedAt = new Date().toISOString()
    platform.tell('101', { type: 'call.ended', timestamp: endedAt, payload: { call: { ...call, state: 'missed', endedAt } } })
    const history = async () => (await api('/calls/history')).json().items
    await until(async () => (await history()).some(i => i.id === call.id), 'the missed call in the history')
    ovh.addConsumption(OVH_ACCOUNT, OVH_LINE, { calling: '0033639980001', called: '0033199000101', creationDatetime: ovhDate(Date.parse(call.startedAt) + 1000), duration: 0, wayType: 'incoming' })
    // A call to Alice's direct number twenty minutes ago that only OVH had (the platform could not be reached): OVH
    // forwarded it to the fallback number, two records as OVH writes them, the call in, then its forward.
    const earlier = Date.now() - 20 * 60_000
    const alone = ovh.addConsumption(OVH_ACCOUNT, OVH_LINE, { calling: '0033639980002', called: '0033199000101', creationDatetime: ovhDate(earlier), duration: 42, wayType: 'incoming' })
    ovh.addConsumption(OVH_ACCOUNT, OVH_LINE, { calling: '0033199000101', called: '0033639980009', creationDatetime: ovhDate(earlier + 1000), duration: 41, wayType: 'transfer' })
    // Read by the next round, or when the administrator asks.
    await subnav.getByRole('link', { name: 'Trunks', exact: true }).click()
    const records = page.getByRole('region', { name: "Relevés de l'opérateur" })
    await records.getByRole('button', { name: "Relire l'opérateur maintenant" }).click()
    await records.getByRole('status').getByText("L'opérateur a été relu.").waitFor()
    await until(async () => (await api('/admin/operator')).json().cdrs?.stats.pending === 0 && (await api('/admin/operator')).json().cdrs?.stats.total === 3, 'the records read and settled')
    const stats = (await api('/admin/operator')).json().cdrs.stats
    expectEqual(JSON.stringify(stats), JSON.stringify({ total: 3, matched: 1, orphan: 1, unmatchedInbound: 0, unmatchedOutbound: 0, forwarded: 1, pending: 0, invalid: 0, erased: 0 }), 'what became of the records')
    // All the calls the platform could have had (second review 10b, n°5): the one OVH alone received while it could not
    // be reached, and OVH's forward of it, aside.
    await records.locator('dl > div', { has: page.getByText('Taux de rapprochement', { exact: true }) }).getByRole('definition').getByText(/^100\s%$/).waitFor()
    for (const [label, n] of [["Rapprochés de l'historique", '1'], ["Reçus par l'opérateur seul", '1'], ["Renvoyés par l'opérateur", '1']])
      await records.locator('dl > div', { has: page.getByText(label, { exact: true }) }).getByRole('definition').getByText(n, { exact: true }).waitFor()
    // In the history, as GET /calls/history gives it: where each call is known from.
    const items = await history()
    expectEqual(JSON.stringify(items.find(i => i.id === call.id)?.sources), JSON.stringify(['opensips', 'ovh']), 'the missed call reconciled')
    const orphan = items.find(i => i.id === `ovh:${OVH_LINE}:${alone}`)
    // Forwarded by OVH to the fallback (second review 10b, n°4): missed here, whoever took it there.
    expectEqual(
      JSON.stringify([orphan?.remoteNumber, orphan?.direction, orphan?.durationSec, orphan?.answered, orphan?.missed, orphan?.forwardedToFallback, JSON.stringify(orphan?.sources)]),
      JSON.stringify(['+33639980002', 'inbound', 0, false, true, true, '["ovh"]']),
      'the call only OVH had, forwarded to the fallback'
    )
    expectEqual(items.length, 2, 'the forward is in nobody’s history')
    // And on Alice's screen.
    await page.getByRole('link', { name: 'Récents' }).click()
    const rows = page.locator('[data-testid=recents] > li')
    await rows.filter({ hasText: '+33 6 39 98 00 01' }).getByText("Confirmé par l'opérateur").waitFor()
    const forwarded = rows.filter({ hasText: '+33 6 39 98 00 02' })
    await forwarded.getByText("Reçu par l'opérateur seul").waitFor()
    await forwarded.getByText('Renvoyé au numéro de repli').waitFor()
    await forwarded.getByText('Manqué', { exact: true }).waitFor()
  })
  await step('Récents names a caller the directory knows, by day; the row calls back (to the keypad here, no softphone), Manqués keeps only the missed calls', async () => {
    // Jean (102) called Alice, who answered.
    const call = { id: 'e2e-jean-calls@192.0.2.10', direction: 'inbound', remoteNumber: '102', startedAt: new Date(Date.now() - 4000).toISOString() }
    platform.tell('101', { type: 'call.ringing', timestamp: call.startedAt, payload: { call: { ...call, state: 'ringing' } } })
    platform.tell('101', { type: 'call.connected', timestamp: new Date(Date.now() - 3000).toISOString(), payload: { call: { ...call, state: 'connected' } } })
    const endedAt = new Date().toISOString()
    platform.tell('101', { type: 'call.ended', timestamp: endedAt, payload: { call: { ...call, state: 'ended', endedAt } } })
    await page.getByRole('heading', { level: 2, name: "Aujourd'hui" }).waitFor()
    const jean = page.locator('[data-testid=recents] > li', { hasText: 'Jean Dupont' })
    await jean.getByTestId('recent-number').getByText('102', { exact: true }).waitFor()
    await jean.getByRole('link', { name: 'Fiche de Jean Dupont' }).waitFor()
    // The same icons as in the directory: copy, then the phone.
    expectEqual(JSON.stringify(await jean.locator('button[aria-label]').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label').replace(/ \(.*/, '')))), JSON.stringify(['Copier le 102', 'Appeler le 102']), 'icons of the row')
    await page.getByRole('button', { name: 'Manqués' }).click()
    await page.locator('[data-testid=recents] > li', { hasText: '+33 6 39 98 00 02' }).waitFor()
    await jean.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Tous' }).click()
    await jean.hover()
    await shot(page, 'recents')
    await jean.getByRole('button', { name: /^Rappeler Jean Dupont \(102\) \(Entrant, / }).click()
    await page.getByRole('heading', { level: 1, name: 'Téléphone' }).waitFor()
    expectEqual(await page.getByLabel('Numéro à appeler').inputValue(), '102', 'number sent to the keypad')
  })
  await step('the fallback removed while OVH does not answer: said not removed yet, kept, and removed once OVH answers again, the voicemail of before put back (second review 10b, n°1; third review n°8)', async () => {
    await page.getByRole('link', { name: 'Administration' }).click()
    await subnav.getByRole('link', { name: 'Trunks', exact: true }).click()
    await trunkList.getByText(LINE_SET).waitFor()
    const puts = ovh.requests.filter(r => r.method === 'PUT').length
    ovh.state.down = true
    try {
      await trunkList.getByRole('button', { name: "Retirer le renvoi de repli du trunk operator chez l'opérateur" }).click()
      // What it puts back is said before (third review 10b, n°8): what OVH had before the platform took the line.
      await trunkList
        .getByRole('group', { name: `Retirer le renvoi de repli des lignes du trunk operator chez l'opérateur ? La plateforme ne le tiendra plus. Ligne ${OVH_LINE} : ses renvois d'avant la plateforme seront remis (renvoi sur indisponibilité vers la messagerie).` })
        .waitFor()
      await trunkList.getByRole('button', { name: 'Oui, retirer' }).click()
      await page.getByRole('alert').getByText(`Le trunk operator ne tient plus de renvoi de repli, mais l'opérateur ne l'a pas encore retiré de ${OVH_LINE} : la plateforme réessaie à chaque relevé.`).waitFor()
      expectEqual(ovh.options(OVH_ACCOUNT, OVH_LINE).forwardBackup, true, 'still at OVH')
      const status = (await api('/admin/operator')).json()
      expectEqual(JSON.stringify(status.removals?.map(r => [r.line, r.trunkId])), JSON.stringify([[OVH_LINE, 'operator']]), 'the removal kept')
      // Shown, with the button to try again, whatever a round reads meanwhile.
      await page.getByRole('list', { name: "Renvois pas encore retirés chez l'opérateur" }).getByText(new RegExp(`^Ligne ${OVH_LINE} : à retirer depuis le`)).waitFor()
      await trunkList.getByRole('button', { name: "Retirer le renvoi de repli du trunk operator chez l'opérateur" }).waitFor()
      await new Promise(r => setTimeout(r, 2500))
      expectEqual(ovh.options(OVH_ACCOUNT, OVH_LINE).forwardBackup, true, 'nothing done while OVH is down')
    } finally {
      ovh.state.down = false
    }
    // OVH back: the next round removes it, puts back the voicemail OVH had before, reads it back, and lets the removal go.
    await until(() => ovh.options(OVH_ACCOUNT, OVH_LINE).forwardBackup && ovh.options(OVH_ACCOUNT, OVH_LINE).forwardBackupNature === 'voicemail' && !ovh.options(OVH_ACCOUNT, OVH_LINE).forwardNoReply, 'the fallback removed at OVH, the voicemail put back')
    await until(async () => !(await api('/admin/operator')).json().removals, 'the removal done')
    // Refused while OVH was down, then written once.
    expectEqual(JSON.stringify(ovh.requests.filter(r => r.method === 'PUT').slice(puts).map(r => r.status).filter(s => s === 200)), JSON.stringify([200]), 'written once OVH answers')
    await page.getByRole('button', { name: "Actualiser l'état" }).click()
    await trunkList.getByText(`Ligne ${OVH_LINE} : renvoi sur indisponibilité vers la messagerie · renvoi réglé hors de la plateforme`).waitFor()
    expectEqual(await page.getByRole('list', { name: "Renvois pas encore retirés chez l'opérateur" }).count(), 0, 'no removal shown')
    await page.getByRole('list', { name: 'Retraits des 7 derniers jours' }).getByText(new RegExp(`^Ligne ${OVH_LINE} : renvoi retiré le .*, ses renvois d'avant remis$`)).waitFor()
  })
  await step('in English, the refusals of the Gateway read in English too', async () => {
    await page.getByRole('link', { name: 'Réglages' }).click()
    await page.getByLabel("Langue de l'interface").selectOption('en')
    await page.getByRole('link', { name: 'Administration' }).click()
    await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('link', { name: 'Direct numbers' }).click()
    await page.getByRole('heading', { level: 2, name: 'Direct numbers' }).waitFor()
    expectEqual(await page.title(), 'Direct numbers – Administration – TwakePhone', 'document title')
    await page.getByRole('textbox', { name: 'Identifier', exact: true }).fill('other')
    await page.getByLabel('Number (or first of the range)').fill('+33 1 99 00 03 00')
    await page.getByRole('combobox', { name: 'Extension or group', exact: true }).fill('556')
    await page.getByRole('button', { name: 'Save direct numbers' }).click()
    await page.locator('#did-target-error').getByText('neither an assigned extension nor a ring group').waitFor()
  })
  await step('signing out returns to the sign-in page and forgets the session', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL(`${oidc.issuer}/session/end**`)
    await page.getByRole('button', { name: /yes, sign me out/i }).click()
    await page.waitForURL(`${appOrigin}/`)
    await page.getByRole('button', { name: 'Sign in' }).waitFor()
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('oidc.user')))
    if (stored.length) throw new Error(`session still stored: ${stored.join(', ')}`)
  })
  await step('opened from the notification of a call while the identity provider cannot be reached: the page says why and offers to sign in, it does not wait for good', async () => {
    const unreachable = new RegExp(`^${oidc.issuer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)
    await page.route(unreachable, route => route.abort('connectionrefused'))
    try {
      await page.goto(`${appOrigin}/?call=e2e-call`)
      await page.getByRole('alert').getByText(/^Sign-in failed: /).waitFor()
      await page.getByRole('button', { name: 'Sign in' }).waitFor()
      expectEqual(await page.getByText('Signing in to take the call…').count(), 0, 'the "signing in" status left on the page')
    } finally {
      await page.unroute(unreachable)
    }
  })
  await step('Bob, who is no administrator, sees no administration: neither its link, nor its screens, nor its API', async () => {
    await page.goto(`${appOrigin}/admin/trunks`)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.locator('input[name=login]').fill('bdurand')
    await page.locator('input[name=password]').fill('whatever')
    await page.getByRole('button', { name: 'Sign-in' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL(`${appOrigin}/admin/trunks`)
    await page.getByTestId('who').getByText('Bob Durand').waitFor()
    await page.getByRole('alert').getByText("This screen is for the platform's administrators.").waitFor()
    expectEqual(await page.getByRole('link', { name: 'Administration' }).count(), 0, 'administration link')
    expectEqual(await page.getByRole('navigation', { name: 'Administration sections' }).count(), 0, 'administration navigation')
    expectEqual(await page.getByRole('textbox', { name: 'Identifier', exact: true }).count(), 0, 'trunk form')
    const bob = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(k => k.startsWith('oidc.user'))
      return key ? JSON.parse(sessionStorage.getItem(key)).access_token : null
    })
    for (const [method, url, payload] of [
      ['GET', '/admin/trunks'],
      ['GET', '/admin/trunks/status'],
      ['PUT', '/admin/trunks/operator', { auth: 'ip', domain: 'evil.example', codecs: ['PCMA'], defaultNumber: '+33199000100' }],
      ['DELETE', '/admin/trunks/operator'],
      ['GET', '/admin/dids'],
      ['PUT', '/admin/dids/accueil', { trunkId: 'operator', first: '+33199000200', last: '+33199000200', target: '103' }],
      ['GET', '/admin/outbound'],
      ['PUT', '/admin/outbound', { policy: {}, profiles: [], assignments: [] }],
      ['PUT', '/admin/outbound/users/bdurand', { profileId: null }],
      ['GET', '/admin/users'],
      ['GET', '/admin/alerts'],
      ['POST', '/admin/alerts/1/acknowledge'],
      ['GET', '/webhooks'],
      ['PUT', '/webhooks/domains', { domains: ['evil.example'] }],
      ['POST', '/webhooks', { url: 'https://evil.example/in', events: ['call.missed'] }],
      ['GET', '/admin/operator'],
      ['POST', '/admin/operator/sync'],
      ['POST', '/admin/operator/lines', { lines: ['0033199000100'] }],
      ['DELETE', '/admin/trunks/operator/operator/fallback']
    ]) {
      const res = await gateway.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${bob}` }, ...(payload ? { payload } : {}) })
      expectEqual(res.statusCode, 403, `${method} ${url} as Bob`)
    }
    // Nothing changed on the platform.
    expectEqual(platform.trunks[0]?.domain, 'sip.operator.example', 'trunk untouched')
    expectEqual(platform.dids.length, 2, 'direct numbers untouched')
  })
  await step('the app and the Gateway answer with their security headers', async () => {
    const app = await page.request.get(`${appOrigin}/recents`)
    const csp = app.headers()['content-security-policy'] ?? ''
    for (const expected of ["script-src 'self'", "media-src 'self' blob:", `connect-src 'self' ${gatewayUrl} ${gatewayUrl.replace('http', 'ws')} ${oidc.issuer}`, "frame-ancestors 'none'"]) {
      if (!csp.includes(expected)) throw new Error(`app CSP lacks ${JSON.stringify(expected)}: ${csp}`)
    }
    expectEqual(app.headers()['x-frame-options'], 'DENY', 'app X-Frame-Options')
    expectEqual(app.headers()['x-content-type-options'], 'nosniff', 'app X-Content-Type-Options')
    expectEqual((await page.request.get(`${appOrigin}/config.json`)).headers()['cache-control'], 'no-store', 'config.json cache')
    const api = await page.request.get(`${gatewayUrl}/api/v1/me`)
    expectEqual(api.status(), 401, 'anonymous /me')
    expectEqual(api.headers()['content-security-policy'], "default-src 'none'; frame-ancestors 'none'", 'Gateway CSP')
    expectEqual(api.headers()['cache-control'], 'no-store', 'Gateway cache')
    expectEqual(api.headers()['x-content-type-options'], 'nosniff', 'Gateway X-Content-Type-Options')
  })
  await step('another site cannot embed the app in a frame', async () => {
    const embedder = await browser.newPage()
    const refused = new Promise(resolve => embedder.on('console', msg => /frame-ancestors|X-Frame-Options/i.test(msg.text()) && resolve(msg.text())))
    await embedder.goto(`${other.origin}/`)
    await embedder.getByRole('heading', { name: 'Embedder' }).waitFor()
    const message = await Promise.race([refused, new Promise(r => setTimeout(() => r(null), 5000))])
    if (!message) throw new Error('the browser did not report the refused frame')
    // The frame itself: Playwright reads any frame, whatever its origin. A refused one holds the browser's error page.
    const frame = embedder.frames().find(f => f !== embedder.mainFrame())
    if (!frame) throw new Error('no frame on the embedder page')
    const inside = await frame.evaluate(() => ({ url: location.href, title: document.title, text: document.body?.innerText ?? '' })).catch(() => ({ url: frame.url(), title: '', text: '' }))
    if (/^http/.test(inside.url) && /TwakePhone/.test(inside.text + inside.title)) throw new Error(`the app rendered inside the frame: ${JSON.stringify(inside)}`)
    if (!/^chrome-error:/.test(inside.url)) throw new Error(`unexpected frame state: ${JSON.stringify(inside)}`)
    await embedder.close()
  })
  await step('the built app ran under its Content Security Policy without a violation', async () => {
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '')
    if (!/script-src 'self'/.test(csp)) throw new Error(`no CSP in the built page: ${JSON.stringify(csp)}`)
    if (cspViolations.length) throw new Error(`CSP violations:\n${cspViolations.join('\n')}`)
  })
} catch (err) {
  failed = true
  console.error(err)
  console.log('page url:', page.url())
  console.log('page text:', (await page.locator('body').innerText().catch(() => '')).slice(0, 800))
  await page.screenshot({ path: fileURLToPath(new URL('../dist/e2e-failure.png', import.meta.url)) }).catch(() => {})
} finally {
  await browser.close()
  await web.stop()
  await other.stop()
  await gateway.close()
  await oidc.stop()
  await ldap.stop()
  await receiver.stop()
  await ovh.stop()
}
process.exit(failed ? 1 : 0)
