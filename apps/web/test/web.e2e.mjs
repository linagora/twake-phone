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
import { BASE_DN, READER_DN, READER_PASSWORD, startLdapMock } from '../../gateway/test/ldap-mock.mjs'
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

const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), err => { console.log(`FAIL ${name}`); throw err })
const expectEqual = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

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
const platform = { trunks: [], dids: [], groups: [], outbound: null }
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
    getTrunkStatus: async () => platform.trunks.map(t => ({ id: t.id, ...(t.auth === 'register' ? { registration: { state: 'registered' } } : {}), servers: (t.proxies ?? [t.domain]).map(address => ({ address, state: 'up' })) })),
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
    // No event ever: nobody calls on this platform.
    subscribe: async function* () {
      await new Promise(() => {})
      yield* []
    }
  })
}
const gateway = await buildApp(new ProviderRegistry(providers, [memoryPlatform]), { auth, store, contacts, directorySync, secretsKey: randomBytes(32), admin: { adminRole: 'twakephone-admin', adminUsers: new Set() } })
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
  await step('the dialer explains that calling is not configured on this platform', async () => {
    await page.getByRole('link', { name: 'Clavier' }).click()
    await page.getByText(/pas encore disponible/).waitFor()
    await page.getByRole('button', { name: '5' }).click()
    expectEqual(await page.getByLabel('Numéro à appeler').inputValue(), '5', 'keypad input')
  })
  await step('the directory finds Jean Dupont by "dup", with his number and department', async () => {
    await page.getByRole('link', { name: 'Annuaire' }).click()
    await page.getByText('Aucun favori pour l\'instant').waitFor()
    await page.getByLabel('Rechercher').fill('dup')
    const list = page.locator('ul.contacts')
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
  })
  await step('a favourite survives a reload, because the Gateway keeps it', async () => {
    await page.getByLabel('Rechercher').fill('dup')
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/me/favorites/jdupont'))
    const star = page.getByRole('button', { name: 'Favori : Jean Dupont' })
    expectEqual(await star.getAttribute('aria-pressed'), 'false', 'aria-pressed before')
    await star.click()
    expectEqual((await saved).status(), 204, 'favourite saved by the Gateway')
    await page.locator('button[aria-label="Favori : Jean Dupont"][aria-pressed="true"]:not([disabled])').waitFor()
    await page.reload()
    await page.getByRole('heading', { level: 2, name: 'Favoris' }).waitFor()
    await page.getByRole('link', { name: 'Jean Dupont', exact: true }).waitFor()
    expectEqual(await page.getByRole('button', { name: 'Favori : Jean Dupont' }).getAttribute('aria-pressed'), 'true', 'aria-pressed after reload')
  })
  await step('the contact card lists every number, and Call sends it to the dialer', async () => {
    await page.getByRole('link', { name: 'Jean Dupont', exact: true }).click()
    await page.getByRole('heading', { level: 1, name: 'Jean Dupont' }).waitFor()
    expectEqual(await page.title(), 'Jean Dupont – TwakePhone', 'document title')
    await page.getByText('Technicien · Support').waitFor()
    await page.getByText('Mobile').waitFor()
    await page.getByRole('link', { name: /Appeler le .*6.12.34.56.01/ }).click()
    await page.getByRole('heading', { level: 1, name: 'Clavier' }).waitFor()
    const typed = await page.getByLabel('Numéro à appeler').inputValue()
    expectEqual(typed.replace(/\s/g, ''), '+33612345601', 'number sent to the dialer')
    expectEqual(new URL(page.url()).search, '', 'address bar cleaned')
  })
  await step('removing the favourite empties the list', async () => {
    await page.getByRole('link', { name: 'Annuaire' }).click()
    const removed = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith('/me/favorites/jdupont'))
    await page.getByRole('button', { name: 'Favori : Jean Dupont' }).click()
    expectEqual((await removed).status(), 204, 'favourite removed by the Gateway')
    await page.getByText('Aucun favori pour l\'instant').waitFor()
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
      ['POST', '/admin/alerts/1/acknowledge']
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
    for (const expected of ["script-src 'self'", `connect-src 'self' ${gatewayUrl} ${gatewayUrl.replace('http', 'ws')} ${oidc.issuer}`, "frame-ancestors 'none'"]) {
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
}
process.exit(failed ? 1 : 0)
