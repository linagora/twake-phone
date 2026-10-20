// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminAlert, DidRange, EmergencySite, OutboundSettings, Trunk, WebhookDelivery, WebhookSubscription } from '@twake/telephony-client'
import type { useGateway } from '../../gateway.js'
import { I18nProvider, useT } from '../../i18n/useT.js'
import { Admin } from './Admin.js'
import { CallFlows } from './CallFlows.js'
import { ALERTS_REFRESH_MS, Alerts } from './Alerts.js'
import { Limits } from './Limits.js'
import { Numbers } from './Numbers.js'
import { Rights } from './Rights.js'
import { RingGroups } from './RingGroups.js'
import { Sites } from './Sites.js'
import { STATUS_POLL_MS, Trunks } from './Trunks.js'
import { Webhooks } from './Webhooks.js'

type Gateway = ReturnType<typeof useGateway>
let gateway: Pick<Gateway, 'client' | 'me' | 'meError'>
vi.mock('../../gateway.js', () => ({ useGateway: () => gateway }))

const refused = (status: number, code: string, detail: string) => Object.assign(new Error(detail), { status, code, detail })
const flush = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))
/** Past the moment the trunk form waits for the typing to stop before reading the operator's lines again. */
const settle = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 350)))

/** Types into a field as a person does: React hears the input event. */
const type = (el: Element | null, value: string) => {
  const input = el as HTMLInputElement
  // React keeps its own copy of the value: the prototype's setter goes around it, as typing does.
  const { set } = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') as { set: (this: HTMLInputElement, v: string) => void }
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click())
/** Picks an option of a list as a person does. */
const choose = (el: Element | null, value: string) => {
  const select = el as HTMLSelectElement
  const { set } = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value') as { set: (this: HTMLSelectElement, v: string) => void }
  act(() => {
    set.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const key = (el: Element | null, name: string) => act(() => void (el as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })))
/** A button of the screen by its text. */
const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find(b => b.textContent === text)
/** Switches the language, as the menu of the app does. */
const LangSwitch = () => {
  const { setLang } = useT()
  return (
    <button type="button" onClick={() => setLang('en')}>
      English
    </button>
  )
}
const submit = (form: Element | null) =>
  act(async () => {
    ;(form as HTMLFormElement).requestSubmit()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })

const trunk: Trunk = { id: 'operator', name: 'Opérateur', auth: 'register', domain: 'sip.operator.example', username: 'login', hasPassword: true, codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }

/** The outbound setting as the Gateway gives it, with the version read. */
const outbound = (over: Partial<OutboundSettings> = {}): OutboundSettings => ({
  policy: {},
  profiles: [{ id: 'national', name: 'National', allowed: ['fixed', 'mobile'] }],
  assignments: [],
  version: 'v1',
  defaults: { fraud: { national: {}, international: {} }, caps: { user: {}, tenant: {} } },
  ...over
})

/** A client with what the administration screens read, each test overriding what it looks at. */
const client = (over: Record<string, unknown> = {}) =>
  ({
    listAdminUsers: vi.fn(async () => ({ items: [{ userId: 'alice', extension: '101', displayName: 'Alice' }] })),
    listGroups: vi.fn(async () => ({ items: [] })),
    listFlows: vi.fn(async () => ({ items: [] })),
    createFlow: vi.fn(),
    setFlow: vi.fn(),
    deleteFlow: vi.fn(),
    listTrunks: vi.fn(async () => ({ items: [trunk] })),
    getTrunkStatus: vi.fn(async () => ({ available: true, items: [{ id: 'operator', registration: { state: 'registered' }, servers: [{ address: 'sip.operator.example', state: 'up' }] }] })),
    setTrunk: vi.fn(),
    deleteTrunk: vi.fn(),
    getOperatorStatus: vi.fn(async () => ({ configured: false })),
    syncOperator: vi.fn(),
    readOperatorLines: vi.fn(async () => ({ items: [] })),
    removeOperatorFallback: vi.fn(),
    abandonOperatorRemoval: vi.fn(),
    listDids: vi.fn(async () => ({ items: [] as DidRange[] })),
    setDid: vi.fn(),
    deleteDid: vi.fn(),
    listSites: vi.fn(async () => ({ items: [] as EmergencySite[] })),
    setSite: vi.fn(),
    deleteSite: vi.fn(),
    listAlerts: vi.fn(),
    acknowledgeAlert: vi.fn(),
    getOutbound: vi.fn(async () => outbound()),
    setOutbound: vi.fn(),
    setUserProfile: vi.fn(),
    createGroup: vi.fn(),
    setGroup: vi.fn(),
    deleteGroup: vi.fn(),
    ...over
  }) as unknown as Gateway['client']

describe('the administration screens (step 7)', () => {
  let root: Root
  let host: HTMLDivElement
  const render = async (path: string, element: React.ReactNode) => {
    await act(async () =>
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/admin" element={<Admin />}>
                <Route path="*" element={element} />
                <Route index element={element} />
              </Route>
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      )
    )
    await flush()
  }
  const $ = (selector: string) => host.querySelector(selector)
  const text = () => host.textContent ?? ''

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.setItem('twakephone.lang', 'fr')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows nothing of the administration to one who is not an administrator, and reads nothing for them', async () => {
    const listTrunks = vi.fn()
    gateway = { client: client({ listTrunks }), me: { id: 'bob', displayName: 'Bob', features: { admin: false } }, meError: null }
    await render('/admin/trunks', <Trunks />)
    expect(text()).toContain('réservé aux administrateurs')
    expect($('nav')).toBeNull()
    expect(listTrunks).not.toHaveBeenCalled()
  })

  it('gives an administrator a navigation between its parts, the current one marked', async () => {
    gateway = { client: client(), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/trunks', <Trunks />)
    const links = [...host.querySelectorAll('nav a')]
    expect(links.map(a => a.textContent)).toEqual(['Comptes', 'Trunks', 'Numéros directs', 'Sites', "Groupes d'appel", "Parcours d'appel", "Droits d'appel", 'Plafonds et seuils', 'Alertes', 'Webhooks'])
    expect(links.find(a => a.getAttribute('aria-current') === 'page')?.textContent).toBe('Trunks')
    // The trunk, how it is doing, and its password never shown.
    expect(text()).toContain('Opérateur (operator)')
    expect(text()).toContain('Enregistré')
    expect(text()).toContain('enregistré (jamais affiché)')
  })

  it('says what is wrong next to each field before sending, the focus on the first one', async () => {
    const setTrunk = vi.fn()
    gateway = { client: client({ setTrunk }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/trunks', <Trunks />)
    await submit($('form'))
    expect(setTrunk).not.toHaveBeenCalled()
    expect($('[role="alert"]')?.textContent).toContain('erreurs')
    expect(document.activeElement?.id).toBe('trunk-id')
    expect($('#trunk-id')?.getAttribute('aria-invalid')).toBe('true')
    expect($('#trunk-id')?.getAttribute('aria-describedby')).toContain('trunk-id-error')
    expect($('#trunk-domain-error')?.textContent).toContain('nom de domaine')
  })

  it("sends a valid trunk, and puts the Gateway's refusal on the field it names", async () => {
    const setTrunk = vi.fn(async () => {
      throw refused(400, 'TRUNK_INVALID', 'domain: the operator’s SIP domain')
    })
    gateway = { client: client({ setTrunk }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/trunks', <Trunks />)
    type($('#trunk-id'), 'second')
    type($('#trunk-domain'), 'sip.other.example')
    type($('#trunk-username'), 'user')
    type($('#trunk-password'), 'pa55')
    type($('#trunk-defaultNumber'), '01 99 00 02 00')
    await submit($('form'))
    await flush()
    expect(setTrunk).toHaveBeenCalledWith('second', expect.objectContaining({ domain: 'sip.other.example', password: 'pa55', defaultNumber: '+33199000200' }))
    expect($('#trunk-domain-error')?.textContent).toContain('nom de domaine')
    expect(document.activeElement?.id).toBe('trunk-domain')
  })

  it('asks before deleting a trunk, and deletes nothing when told no', async () => {
    const deleteTrunk = vi.fn()
    gateway = { client: client({ deleteTrunk }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/trunks', <Trunks />)
    click($('[aria-label="Supprimer le trunk operator"]'))
    expect($('[role="group"]')?.getAttribute('aria-label')).toBe('Supprimer le trunk operator et ses numéros directs ?')
    click([...host.querySelectorAll('[role="group"] button')].find(b => b.textContent === 'Non, garder'))
    expect(deleteTrunk).not.toHaveBeenCalled()
  })

  it('refuses a range of direct numbers ending with emergency numbers, and shows a target the Gateway does not know', async () => {
    const setDid = vi.fn(async () => {
      throw refused(400, 'DID_TARGET', 'target: 555 is neither an extension nor a group')
    })
    gateway = { client: client({ setDid }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/numbers', <Numbers />)
    expect(($('#did-trunkId') as HTMLSelectElement).value).toBe('operator')
    type($('#did-id'), 'staff')
    type($('#did-first'), '+33199000100')
    type($('#did-last'), '+33199000199')
    click($('input[name="did-mode"][value="suffix"]'))
    await submit($('form'))
    expect(setDid).not.toHaveBeenCalled()
    expect($('#did-suffixDigits-error')?.textContent).toContain('112')
    click($('input[name="did-mode"][value="target"]'))
    type($('#did-last'), '')
    type($('#did-target'), '555')
    await submit($('form'))
    await flush()
    expect(setDid).toHaveBeenCalledWith({ id: 'staff', trunkId: 'operator', first: '+33199000100', last: '+33199000100', target: '555' })
    expect($('#did-target-error')?.textContent).toContain("ni un poste attribué ni un groupe")
  })

  it('sets a site for the emergency calls: its address, a number of its trunk, its people; and puts the Gateway\'s refusal of the number on the form (step 6c)', async () => {
    const setSite = vi.fn(async () => {
      throw refused(400, 'SITE_NUMBER', 'number: +33199000999 is neither a direct number of the trunk operator nor its default number')
    })
    gateway = { client: client({ setSite }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/sites', <Sites />)
    expect(text()).toContain('Aucun site pour l\'instant.')
    expect(($('#site-trunkId') as HTMLSelectElement).value).toBe('operator')
    // Nothing is sent while a field is wrong, each in words.
    await submit($('form'))
    expect(setSite).not.toHaveBeenCalled()
    expect($('#site-id-error')?.textContent).toContain('lettres minuscules')
    expect($('#site-address-error')).not.toBeNull()
    expect($('#site-number-error')?.textContent).toContain('+33 1 99 00 03 50')
    type($('#site-id'), 'paris')
    type($('#site-name'), 'Paris')
    type($('#site-address'), '1 rue de Rivoli, 75001 Paris')
    type($('#site-number'), '+33 1 99 00 09 99')
    click($('#site-members'))
    await submit($('form'))
    await flush()
    expect(setSite).toHaveBeenCalledWith({ id: 'paris', name: 'Paris', address: '1 rue de Rivoli, 75001 Paris', trunkId: 'operator', number: '+33199000999', members: ['alice'] })
    expect($('#site-number-error')?.textContent).toContain('ni un numéro direct de ce trunk ni son numéro par défaut')
  })

  it('lists the sites with their trunk, number and people, and says it all in English too (step 6c)', async () => {
    const paris: EmergencySite = { id: 'paris', name: 'Paris', address: '1 rue de Rivoli, 75001 Paris', trunkId: 'operator', number: '+33199000350', members: ['alice'] }
    const deleteSite = vi.fn(async () => undefined)
    const listSites = vi.fn(async () => ({ items: [paris] }))
    gateway = { client: client({ listSites, deleteSite }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await act(async () =>
      root.render(
        <I18nProvider>
          <LangSwitch />
          <MemoryRouter initialEntries={['/admin/sites']}>
            <Sites />
          </MemoryRouter>
        </I18nProvider>
      )
    )
    await flush()
    expect($('ul[aria-label="Sites existants"]')?.textContent).toContain('+33 1 99 00 03 50')
    expect(text()).toContain('1 rue de Rivoli, 75001 Paris')
    expect(text()).toContain('1 personne')
    expect(text()).not.toContain('1 personnes')
    click(button(host, 'English'))
    expect($('ul[aria-label="Existing sites"]')).not.toBeNull()
    expect(text()).toContain('Postal address')
    // Edited, the people are those it has; removed, the list is read again.
    click($('button[aria-label="Edit site paris"]'))
    expect(($('#site-members') as HTMLInputElement).checked).toBe(true)
    expect(($('#site-id') as HTMLInputElement).disabled).toBe(true)
    click($('button[aria-label="Delete site paris"]'))
    click(button(host, 'Yes, delete'))
    await flush()
    expect(deleteSite).toHaveBeenCalledWith('paris')
    expect(listSites.mock.calls.length).toBeGreaterThan(1)
  })

  it('searches the people of a site without losing those it hides, and drops the one who left the directory (step 6c, review n°5, n°7)', async () => {
    const users = [
      { userId: 'alice', extension: '101', displayName: 'Alice' },
      { userId: 'bob', extension: '102', displayName: 'Bob' }
    ]
    const setSite = vi.fn(async (site: EmergencySite) => site)
    const left: EmergencySite = { id: 'paris', name: 'Paris', address: '1 rue de Rivoli', trunkId: 'operator', number: '+33199000350', members: ['alice', 'gone'] }
    gateway = { client: client({ setSite, listAdminUsers: vi.fn(async () => ({ items: users })), listSites: vi.fn(async () => ({ items: [left] })) }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/sites', <Sites />)
    expect(text()).toContain('2 personnes')
    click($('button[aria-label="Modifier le site paris"]'))
    type($('#site-search'), 'bo')
    // Enter in the search is no save: the key is taken (a browser submits the form on it otherwise).
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => void $('#site-search')!.dispatchEvent(enter))
    expect(enter.defaultPrevented).toBe(true)
    expect(setSite).not.toHaveBeenCalled()
    expect([...host.querySelectorAll('#site-members-bob, #site-members')].length).toBe(1)
    expect(text()).not.toContain('Alice (101)')
    click($('#site-members'))
    type($('#site-search'), 'zzz')
    expect(text()).toContain('Personne ne correspond.')
    type($('#site-search'), '')
    await submit($('form'))
    await flush()
    // Alice stays though the search hid her, Bob is added, whoever is gone is not sent.
    expect(setSite).toHaveBeenCalledWith(expect.objectContaining({ id: 'paris', members: ['alice', 'bob'] }))
  })

  it('lists the alerts to handle, and takes an acknowledged one off the list', async () => {
    const alert: AdminAlert = { id: '7', kind: 'fraud-warning', param: 'callsPerMinute', scope: 'user', value: 8, threshold: 6, extension: '101', number: '+33612345678', at: '2026-10-16T08:00:00.000Z', lastAt: '2026-10-16T08:05:00.000Z', count: 3, first: { value: 7 } }
    const listAlerts = vi.fn(async () => ({ items: [alert] }))
    const acknowledgeAlert = vi.fn(async () => ({ ...alert, acknowledgedAt: '2026-10-16T09:00:00.000Z', acknowledgedBy: 'alice' }))
    gateway = { client: client({ listAlerts, acknowledgeAlert }), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
    await render('/admin/alerts', <Alerts />)
    expect(listAlerts).toHaveBeenCalledWith({ limit: 25, state: 'open' })
    expect(text()).toContain('Appels par minute : 8 pour 6')
    expect(text()).toContain('101 (Alice)')
    click([...host.querySelectorAll('button')].find(b => b.textContent === 'Acquitter'))
    await flush()
    expect(acknowledgeAlert).toHaveBeenCalledWith('7', '2026-10-16T08:05:00.000Z', 3)
    expect(text()).toContain('Aucune alerte.')
    expect(text()).toContain('Alerte acquittée.')
  })

  const admin = (over: Record<string, unknown> = {}) => {
    gateway = { client: client(over), me: { id: 'alice', displayName: 'Alice', features: { admin: true } }, meError: null }
  }

  it('names the alerts of the mailboxes in words, and lets each be picked as a cause', async () => {
    const at = { at: '2026-10-18T08:00:00.000Z', lastAt: '2026-10-18T08:05:00.000Z', count: 1 }
    const listAlerts = vi.fn(async () => ({
      items: [
        { id: '8', kind: 'voicemail', param: 'boxes-refused', scope: 'tenant', value: 2, ...at, first: { value: 2 } },
        { id: '9', kind: 'voicemail', param: 'hidden-calls', scope: 'tenant', value: 5, threshold: 5, extension: '101', ...at, first: { value: 5 } },
        { id: '10', kind: 'voicemail', param: 'held-back', scope: 'tenant', value: 6, threshold: 6, waiting: 6, noneReached: true, ...at, first: { value: 6 } }
      ] as AdminAlert[]
    }))
    admin({ listAlerts })
    await render('/admin/alerts', <Alerts />)
    expect(text()).toContain('Des boîtes vocales que le serveur de messagerie refuse toujours de créer ou de modifier (combien) : 2')
    expect(text()).toContain("Les appelants sans numéro ont atteint leur plafond d'appels simultanés vers cette boîte : 5 pour 5")
    // A set-aside held back: who waits for a mailbox, and the voicemail off for everyone, said.
    expect(text()).toContain("(le temps de la retenue ne compte pas) : 6 pour 6 ; 6 nouveau(x) titulaire(s) sans boîte jusqu'à la levée ; messagerie coupée pour tout le tenant : aucun poste ne joint de boîte")
    const causes = [...host.querySelectorAll('option')].map(o => o.value)
    for (const param of ['sync-failing', 'flows-failing', 'sync-fenced', 'boxes-refused', 'hidden-calls', 'hidden-hour', 'hidden-all', 'calls-all', 'held-back', 'held-back-remove']) expect(causes).toContain(param)
  })

  it('puts the focus back on the delete button when told no or Escape, and on what is said once deleted (review 7 n°3)', async () => {
    const deleteTrunk = vi.fn(async () => [])
    admin({ deleteTrunk })
    await render('/admin/trunks', <Trunks />)
    const del = () => $('[aria-label="Supprimer le trunk operator"]')
    click(del())
    click(button(host, 'Non, garder'))
    expect(document.activeElement).toBe(del())
    click(del())
    expect(document.activeElement?.textContent).toBe('Oui, supprimer')
    key(document.activeElement, 'Escape')
    expect($('[role="group"]')).toBeNull()
    expect(document.activeElement).toBe(del())
    click(del())
    click(button(host, 'Oui, supprimer'))
    await flush()
    expect(deleteTrunk).toHaveBeenCalledWith('operator')
    expect(document.activeElement?.getAttribute('role')).toBe('status')
    expect(document.activeElement?.textContent).toBe('Trunk operator supprimé.')
  })

  it('reads the state of the trunks again after each answer, never in a hidden tab, and no more once gone (review 7 n°5)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    try {
      const answers: ((v: unknown) => void)[] = []
      const getTrunkStatus = vi.fn(() => new Promise(resolve => answers.push(resolve)))
      admin({ getTrunkStatus })
      const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
      await act(async () =>
        root.render(
          <I18nProvider>
            <MemoryRouter initialEntries={['/admin/trunks']}>
              <Trunks />
            </MemoryRouter>
          </I18nProvider>
        )
      )
      await wait(0)
      expect(getTrunkStatus).toHaveBeenCalledTimes(1)
      // No answer yet: no second read, however long it takes.
      await wait(STATUS_POLL_MS * 4)
      expect(getTrunkStatus).toHaveBeenCalledTimes(1)
      answers[0]!({ available: true, items: [] })
      await wait(STATUS_POLL_MS - 100)
      expect(getTrunkStatus).toHaveBeenCalledTimes(1)
      await wait(200)
      expect(getTrunkStatus).toHaveBeenCalledTimes(2)
      answers[1]!({ available: true, items: [] })
      await wait(0)
      // Hidden: nothing read; shown again: read at once.
      hidden = true
      act(() => void document.dispatchEvent(new Event('visibilitychange')))
      await wait(STATUS_POLL_MS * 10)
      expect(getTrunkStatus).toHaveBeenCalledTimes(2)
      hidden = false
      act(() => void document.dispatchEvent(new Event('visibilitychange')))
      await wait(0)
      expect(getTrunkStatus).toHaveBeenCalledTimes(3)
      answers[2]!({ available: true, items: [] })
      await wait(0)
      // The screen gone: nothing more.
      await act(async () => root.render(<></>))
      await wait(STATUS_POLL_MS * 10)
      expect(getTrunkStatus).toHaveBeenCalledTimes(3)
    } finally {
      delete (document as { hidden?: boolean }).hidden
      vi.useRealTimers()
    }
  })

  it('empties the password typed when its removal is asked, and sends the removal (review 7 n°6), the warning sign not read', async () => {
    const setTrunk = vi.fn(async () => trunk)
    admin({ setTrunk })
    await render('/admin/trunks', <Trunks />)
    click($('[aria-label="Modifier le trunk operator"]'))
    await flush()
    type($('#trunk-password'), 'typed-by-mistake')
    click($('#trunk-remove-password'))
    expect(($('#trunk-password') as HTMLInputElement).value).toBe('')
    // Removing the password of a trunk that registers: refused before sending, the sign before the words hidden.
    await submit($('form'))
    expect(setTrunk).not.toHaveBeenCalled()
    const error = $('#trunk-password-error')
    expect(error?.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚠ ')
    expect(error?.textContent).toMatch(/^⚠ /)
    click($('input[name="trunk-auth"][value="ip"]'))
    await submit($('form'))
    await flush()
    expect(setTrunk).toHaveBeenCalledWith('operator', expect.objectContaining({ auth: 'ip', password: null }))
  })

  it('keeps the fallback at the operator from the trunk form, checks its delay, and shows each line and the records (step 10b)', async () => {
    const setTrunk = vi.fn(async () => trunk)
    const forward = { nature: 'number' as const, number: '+33639980001' }
    const status = {
      configured: true,
      operator: 'ovh',
      trunks: [
        {
          id: 'operator',
          lines: [
            { line: '0033199000100', managed: true, inSync: true, readAt: '2026-10-17T10:00:00.000Z', restoredAt: '2026-10-17T10:00:00.000Z', forwards: { onUnavailable: forward, onNoAnswer: { ...forward, afterSec: 150 } } },
            // Each forward as it is (review 10b, n°4): the voicemail, two numbers.
            { line: '0033199000200', managed: false, readAt: '2026-10-17T10:00:00.000Z', forwards: { onUnavailable: { nature: 'voicemail' as const }, onNoAnswer: { nature: 'number' as const, number: '+33639980002', afterSec: 30 } } },
            { line: '0033199000300', managed: true, inSync: false, error: 'refused' as const, rejected: true as const, readAt: '2026-10-17T10:00:00.000Z', forwards: {} },
            { line: '0033199000400', managed: true, inSync: false, error: 'conflict' as const, readAt: '2026-10-17T10:00:00.000Z', forwards: {} }
          ]
        }
      ],
      cdrs: { readAt: '2026-10-17T10:00:00.000Z', read: 3, lines: [{ line: '0033199000999', error: 'not-found' as const }], since: '2026-10-10T10:00:00.000Z', stats: { total: 7, matched: 1, orphan: 1, unmatchedInbound: 1, unmatchedOutbound: 0, forwarded: 1, pending: 0, invalid: 1, erased: 2 } }
    }
    const syncOperator = vi
      .fn()
      .mockRejectedValueOnce(refused(429, 'OPERATOR_RATE', 'The operator was read a moment ago: wait a minute'))
      .mockRejectedValueOnce(refused(502, 'OPERATOR_ROUND', 'The operator could not be read'))
    const readOperatorLines = vi.fn(async () => ({ items: [{ line: '0033199000100', forwards: { onUnavailable: { nature: 'voicemail' as const } } }] }))
    admin({ setTrunk, getOperatorStatus: vi.fn(async () => status), syncOperator, readOperatorLines })
    await render('/admin/trunks', <Trunks />)
    const line = $('[aria-label="Lignes chez l\'opérateur"]')?.textContent
    expect(line).toContain('Ligne 0033199000100 : renvoi sur indisponibilité vers +33 6 39 98 00 01 ; renvoi après 150 s sans réponse vers +33 6 39 98 00 01 · renvoi de repli en place')
    expect(line).toContain("changé chez l'opérateur, remis en place le")
    expect(line).toContain('Ligne 0033199000200 : renvoi sur indisponibilité vers la messagerie ; renvoi après 30 s sans réponse vers +33 6 39 98 00 02 · renvoi réglé hors de la plateforme')
    expect(line).toContain("Ligne 0033199000300 : aucun renvoi · l'opérateur n'a pas gardé ce réglage : enregistrez le trunk pour réessayer")
    expect(line).toContain('Ligne 0033199000400 : aucun renvoi · deux trunks demandent deux renvois différents sur cette ligne')
    const records = $('[aria-labelledby="operator"]')?.textContent
    expect(records).toContain("Reçus par l'opérateur seul1")
    expect(records).toContain("Ligne 0033199000999 : ligne inconnue de l'opérateur")
    expect(records).toContain('Illisibles1')
    expect(records).toContain('Effacés avec un historique2')
    // Of the calls OVH recorded, those the platform could have had (second review 10b, n°5: the orphan, its forward, the
    // erased and the unreadable aside): one in two reconciled.
    expect(records).toMatch(/Taux de rapprochement50\s%/)
    click(button(host, "Relire l'opérateur maintenant"))
    await flush()
    expect(syncOperator).toHaveBeenCalledTimes(1)
    expect($('[aria-labelledby="operator"]')?.textContent).toContain('patientez une minute')
    // A round that failed is said so (n°6), never as read.
    click(button(host, "Relire l'opérateur maintenant"))
    await flush()
    expect(syncOperator).toHaveBeenCalledTimes(2)
    expect($('[aria-labelledby="operator"] [role="alert"]')?.textContent).toBe("L'opérateur n'a pas pu être relu, ou pas à temps : les chiffres affichés sont ceux du relevé précédent.")

    click($('[aria-label="Modifier le trunk operator"]'))
    await flush()
    type($('#trunk-operatorLines'), '0033199000100')
    click($('#trunk-fallbackManaged'))
    await settle()
    // A first fallback: what OVH has on the line now, read and shown, replaced on the administrator's word (review 10b,
    // n°13), and said once read (second review n°17).
    expect(readOperatorLines).toHaveBeenCalledWith(['0033199000100'])
    expect($('[aria-label="Réglé chez l\'opérateur maintenant"]')?.textContent).toBe('Ligne 0033199000100 : renvoi sur indisponibilité vers la messagerie')
    expect($('[aria-label="Réglé chez l\'opérateur maintenant"]')?.parentElement?.getAttribute('role')).toBe('status')
    // Unavailability by default; on no answer, the delay must leave the 120 s of the inside first.
    expect(($('#trunk-onUnavailable') as HTMLInputElement).checked).toBe(true)
    click($('#trunk-onNoAnswer'))
    type($('#trunk-noAnswerAfterSec'), '120')
    await submit($('form'))
    expect(setTrunk).not.toHaveBeenCalled()
    expect($('#trunk-replaceConfirmed-error')?.textContent).toContain('Cochez cette case pour remplacer')
    expect($('#trunk-operatorNumber-error')?.textContent).toContain('format international')
    expect($('#trunk-noAnswerAfterSec-error')?.textContent).toContain('de 121 à 600')
    expect(document.activeElement?.id).toBe('trunk-replaceConfirmed')
    click($('#trunk-replaceConfirmed'))
    type($('#trunk-operatorNumber'), '06 39 98 00 01')
    type($('#trunk-noAnswerAfterSec'), '150')
    await submit($('form'))
    await flush()
    expect(setTrunk).toHaveBeenCalledWith('operator', expect.objectContaining({ operator: { lines: ['0033199000100'], fallback: { number: '+33639980001', onUnavailable: true, noAnswerAfterSec: 150 } } }))
  })

  it('removes the fallback a trunk keeps at the operator on demand, once confirmed, and says it goes with the trunk (review 10b, n°13)', async () => {
    const managed: Trunk = { ...trunk, operator: { lines: ['0033199000100'], fallback: { number: '+33639980001', onUnavailable: true } } }
    const removeOperatorFallback = vi
      .fn()
      .mockResolvedValueOnce({ trunk: { ...trunk, operator: { lines: ['0033199000100'] } }, pending: [] })
      .mockResolvedValueOnce({ trunk: { ...trunk, operator: { lines: ['0033199000100'] } }, pending: [{ line: '0033199000100', since: '2026-10-17T10:00:00.000Z', error: 'unreachable' }] })
    // What was there before the platform took the line (third review 10b, n°8): put back, and said so first.
    const status = {
      configured: true,
      operator: 'ovh',
      trunks: [{ id: 'operator', lines: [{ line: '0033199000100', managed: true, inSync: true, original: { onNoAnswer: { nature: 'voicemail' as const, afterSec: 20 } } }] }],
      cdrs: { since: '2026-10-10T10:00:00.000Z', stats: { total: 0, matched: 0, orphan: 0, unmatchedInbound: 0, unmatchedOutbound: 0, forwarded: 0, pending: 0, invalid: 0, erased: 0 } }
    }
    admin({ listTrunks: vi.fn(async () => ({ items: [managed] })), getOperatorStatus: vi.fn(async () => status), removeOperatorFallback })
    await render('/admin/trunks', <Trunks />)
    click($('[aria-label="Supprimer le trunk operator"]'))
    expect($('[role="group"]')?.getAttribute('aria-label')).toBe(
      "Supprimer le trunk operator et ses numéros directs ? Le renvoi de repli qu'il tient chez l'opérateur sera retiré de ses lignes. Ligne 0033199000100 : ses renvois d'avant la plateforme seront remis (renvoi après 20 s sans réponse vers la messagerie)."
    )
    click(button(host, 'Non, garder'))
    click($('[aria-label="Retirer le renvoi de repli du trunk operator chez l\'opérateur"]'))
    expect($('[role="group"]')?.getAttribute('aria-label')).toBe(
      "Retirer le renvoi de repli des lignes du trunk operator chez l'opérateur ? La plateforme ne le tiendra plus. Ligne 0033199000100 : ses renvois d'avant la plateforme seront remis (renvoi après 20 s sans réponse vers la messagerie)."
    )
    expect(removeOperatorFallback).not.toHaveBeenCalled()
    click(button(host, 'Oui, retirer'))
    await flush()
    expect(removeOperatorFallback).toHaveBeenCalledWith('operator')
    expect(document.activeElement?.textContent).toBe("Le renvoi de repli du trunk operator a été retiré chez l'opérateur.")
    // Not done yet at the operator (second review 10b, n°1): said so, never as removed.
    click($('[aria-label="Retirer le renvoi de repli du trunk operator chez l\'opérateur"]'))
    click(button(host, 'Oui, retirer'))
    await flush()
    expect(removeOperatorFallback).toHaveBeenCalledTimes(2)
    expect(document.activeElement?.getAttribute('role')).toBe('alert')
    expect(document.activeElement?.textContent).toBe("Le trunk operator ne tient plus de renvoi de repli, mais l'opérateur ne l'a pas encore retiré de 0033199000100 : la plateforme réessaie à chaque relevé.")
    // Editing a trunk that keeps one already: nothing more to confirm, unless a line is added (n°9).
    click($('[aria-label="Modifier le trunk operator"]'))
    await flush()
    expect($('#trunk-replaceConfirmed')).toBeNull()
  })

  it('reads, shows and asks before replacing what is set on a line added to a trunk that keeps a fallback, and says what the lines dropped lose (second review 10b, n°8, n°9)', async () => {
    const managed: Trunk = { ...trunk, operator: { lines: ['0033199000100'], fallback: { number: '+33639980001', onUnavailable: true } } }
    const status = { configured: true, operator: 'ovh', trunks: [{ id: 'operator', lines: [{ line: '0033199000100', managed: true, inSync: true }] }] }
    const readOperatorLines = vi.fn(async (lines: string[]) => ({ items: lines.map(line => ({ line, forwards: { onUnavailable: { nature: 'voicemail' as const } } })) }))
    const setTrunk = vi.fn(async () => managed)
    admin({ listTrunks: vi.fn(async () => ({ items: [managed] })), getOperatorStatus: vi.fn(async () => status), readOperatorLines, setTrunk })
    await render(
      '/admin/trunks',
      <>
        <LangSwitch />
        <Trunks />
      </>
    )
    click($('[aria-label="Modifier le trunk operator"]'))
    await settle()
    expect(readOperatorLines).not.toHaveBeenCalled()
    type($('#trunk-operatorLines'), '0033199000100, 0033199000200')
    await settle()
    // Only the line added is read, shown and to be confirmed.
    expect(readOperatorLines).toHaveBeenCalledTimes(1)
    expect(readOperatorLines).toHaveBeenCalledWith(['0033199000200'])
    expect($('[aria-label="Réglé chez l\'opérateur maintenant"]')?.textContent).toBe('Ligne 0033199000200 : renvoi sur indisponibilité vers la messagerie')
    expect(host.textContent).toContain("Réglé chez l'opérateur maintenant, sur les lignes que ce trunk ne tient pas encore")
    type($('#trunk-operatorNumber'), '06 39 98 00 01')
    await submit($('form'))
    expect(setTrunk).not.toHaveBeenCalled()
    expect($('#trunk-replaceConfirmed-error')?.textContent).toContain('Cochez cette case pour remplacer')
    click($('#trunk-replaceConfirmed'))
    // Another line instead: read again, and the word given no longer holds.
    type($('#trunk-operatorLines'), '0033199000300')
    await settle()
    expect(readOperatorLines).toHaveBeenLastCalledWith(['0033199000300'])
    expect($('[aria-label="Réglé chez l\'opérateur maintenant"]')?.textContent).toBe('Ligne 0033199000300 : renvoi sur indisponibilité vers la messagerie')
    expect(($('#trunk-replaceConfirmed') as HTMLInputElement).checked).toBe(false)
    // The line dropped loses the forward, said before saving.
    expect(host.textContent).toContain("À l'enregistrement, le renvoi de repli que ce trunk tient sera retiré chez l'opérateur de : 0033199000100.")
    click($('#trunk-replaceConfirmed'))
    await submit($('form'))
    await flush()
    expect(setTrunk).toHaveBeenCalledWith('operator', expect.objectContaining({ operator: { lines: ['0033199000300'], fallback: { number: '+33639980001', onUnavailable: true } } }))
    // Unticked, what is set there stays: said so.
    click($('[aria-label="Modifier le trunk operator"]'))
    await flush()
    click($('#trunk-fallbackManaged'))
    expect(host.textContent).toContain("Décoché, le renvoi posé reste chez l'opérateur sur 0033199000100 : « Retirer le renvoi chez l'opérateur », dans la liste des trunks, l'enlève.")
    // The separator in the words of each language (n°17).
    click(button(host, 'English'))
    await flush()
    expect($('[aria-label="Lines at the operator"]')?.textContent).toMatch(/^Line 0033199000100: /)
  })

  it('offers to remove what is left at the operator once a trunk no longer asks a fallback, and shows the removals owed (second review 10b, n°1, n°8)', async () => {
    const left: Trunk = { ...trunk, operator: { lines: ['0033199000100'] } }
    const quiet: Trunk = { ...trunk, id: 'quiet', operator: { lines: ['0033199000200'] } }
    const status = {
      configured: true,
      operator: 'ovh',
      trunks: [
        { id: 'operator', lines: [{ line: '0033199000100', managed: false, readAt: '2026-10-17T10:00:00.000Z', forwards: { onUnavailable: { nature: 'number' as const, number: '+33639980001' } } }] },
        { id: 'quiet', lines: [{ line: '0033199000200', managed: false, readAt: '2026-10-17T10:00:00.000Z', forwards: {} }] }
      ],
      removals: [{ line: '0033199000900', since: '2026-10-17T10:00:00.000Z', trunkId: 'gone', error: 'unreachable' as const }],
      cdrs: { since: '2026-10-10T10:00:00.000Z', stats: { total: 0, matched: 0, orphan: 0, unmatchedInbound: 0, unmatchedOutbound: 0, forwarded: 0, pending: 0, invalid: 0, erased: 0 } }
    }
    const deleteTrunk = vi.fn(async () => [{ line: '0033199000200', since: '2026-10-17T10:00:00.000Z' }])
    admin({ listTrunks: vi.fn(async () => ({ items: [left, quiet] })), getOperatorStatus: vi.fn(async () => status), deleteTrunk })
    await render('/admin/trunks', <Trunks />)
    // A forward left there, read: it can be removed; none on the other trunk's line: nothing to remove.
    click($('[aria-label="Retirer le renvoi de repli du trunk operator chez l\'opérateur"]'))
    expect($('[role="group"]')?.getAttribute('aria-label')).toBe("Retirer les renvois posés chez l'opérateur sur les lignes du trunk operator ? Ceux qu'un autre trunk tient restent.")
    click(button(host, 'Non, garder'))
    expect($('[aria-label="Retirer le renvoi de repli du trunk quiet chez l\'opérateur"]')).toBeNull()
    // The removals owed, a deleted trunk's too.
    expect($('[aria-label="Renvois pas encore retirés chez l\'opérateur"]')?.textContent).toMatch(
      /^Ligne 0033199000900 : à retirer depuis le 17\/10\/2026 .* · l'API de l'opérateur ne répond pas · Ligne 0033199000900 : ses renvois d'avant la plateforme ne sont pas connus, ils ne seront pas remis\. Abandonner$/
    )
    // Deleted, its forward not removed yet: said so.
    click($('[aria-label="Supprimer le trunk quiet"]'))
    click(button(host, 'Oui, supprimer'))
    await flush()
    expect(deleteTrunk).toHaveBeenCalledWith('quiet')
    expect(document.activeElement?.textContent).toBe("Trunk quiet supprimé. L'opérateur n'a pas encore retiré son renvoi de repli de 0033199000200 : la plateforme réessaie à chaque relevé.")
  })

  it('lets a removal go once confirmed, shows what became of the last ones, and says a line dropped not removed yet (third review 10b, n°2, n°4, n°8, n°11)', async () => {
    const managed: Trunk = { ...trunk, operator: { lines: ['0033199000100', '0033199000200', '0033199000300'], fallback: { number: '+33639980001', onUnavailable: true } } }
    const status = {
      configured: true,
      operator: 'ovh',
      trunks: [
        {
          id: 'operator',
          lines: [
            { line: '0033199000100', managed: true, inSync: true },
            { line: '0033199000200', managed: true, inSync: true, original: { onNoAnswer: { nature: 'other' as const, afterSec: 20 } } },
            { line: '0033199000300', managed: true, inSync: true, original: {} }
          ]
        }
      ],
      removals: [{ line: '0033199000900', since: '2026-10-17T10:00:00.000Z', trunkId: 'gone', error: 'not-found' as const, original: { onUnavailable: { nature: 'voicemail' as const } } }],
      closedRemovals: [
        { line: '0033199000800', at: '2026-10-17T11:00:00.000Z', outcome: 'changed' as const, trunkId: 'gone' },
        { line: '0033199000700', at: '2026-10-17T10:30:00.000Z', outcome: 'done' as const, restored: true as const }
      ],
      cdrs: { since: '2026-10-10T10:00:00.000Z', stats: { total: 0, matched: 0, orphan: 0, unmatchedInbound: 0, unmatchedOutbound: 0, forwarded: 0, pending: 0, invalid: 0, erased: 0 } }
    }
    const abandonOperatorRemoval = vi.fn(async () => undefined)
    const setTrunk = vi.fn(async () => ({ ...managed, pending: [{ line: '0033199000300', since: '2026-10-17T12:00:00.000Z', error: 'unreachable' }] }))
    admin({ listTrunks: vi.fn(async () => ({ items: [managed] })), getOperatorStatus: vi.fn(async () => status), abandonOperatorRemoval, setTrunk })
    await render('/admin/trunks', <Trunks />)
    // What is put back, what cannot be, what is not known; nothing said of a line that had none.
    click($('[aria-label="Retirer le renvoi de repli du trunk operator chez l\'opérateur"]'))
    expect($('[role="group"]')?.getAttribute('aria-label')).toBe(
      "Retirer le renvoi de repli des lignes du trunk operator chez l'opérateur ? La plateforme ne le tiendra plus. Ligne 0033199000100 : ses renvois d'avant la plateforme ne sont pas connus, ils ne seront pas remis. Ligne 0033199000200 : ses renvois d'avant la plateforme (renvoi après 20 s sans réponse vers une autre destination) vont où elle ne sait pas écrire, ils ne seront pas remis."
    )
    click(button(host, 'Non, garder'))
    expect($('[aria-label="Renvois pas encore retirés chez l\'opérateur"]')?.textContent).toContain("Ligne 0033199000900 : ses renvois d'avant la plateforme seront remis (renvoi sur indisponibilité vers la messagerie).")
    expect($('[aria-label="Retraits des 7 derniers jours"]')?.textContent).toMatch(/^Ligne 0033199000800 : changée dans le manager de l'opérateur depuis la demande, laissée telle quelle le 17\/10\/2026 .*Ligne 0033199000700 : renvoi retiré le 17\/10\/2026 .*, ses renvois d'avant remis$/)
    // Let go, once confirmed.
    click($('[aria-label="Abandonner le retrait du renvoi de la ligne 0033199000900"]'))
    expect($('[role="group"]')?.getAttribute('aria-label')).toBe("Abandonner le retrait du renvoi de la ligne 0033199000900 ? La plateforme n'y écrira plus rien, et ce qui y est réglé chez l'opérateur reste.")
    expect(abandonOperatorRemoval).not.toHaveBeenCalled()
    click(button(host, 'Oui, abandonner'))
    await flush()
    expect(abandonOperatorRemoval).toHaveBeenCalledWith('0033199000900')
    expect(document.activeElement?.textContent).toBe("Retrait de la ligne 0033199000900 abandonné : ce qui y est réglé chez l'opérateur reste.")
    // Saved, a line dropped whose fallback the operator did not remove yet: said so, never as saved alone.
    click($('[aria-label="Modifier le trunk operator"]'))
    await flush()
    type($('#trunk-operatorLines'), '0033199000100, 0033199000200')
    await submit($('form'))
    await flush()
    expect(setTrunk).toHaveBeenCalled()
    expect(host.textContent).toContain("Trunk operator enregistré. L'opérateur n'a pas encore retiré son renvoi de repli de 0033199000300 : la plateforme réessaie à chaque relevé.")
  })

  it('says what a removal puts back on a trunk unticked too, what the rules of the platform keep it from putting back, and that it was not (fourth review 10b, n°3, n°4, n°7)', async () => {
    // Unticked: the fallback left at the operator, the forwards of before kept.
    const left: Trunk = { ...trunk, operator: { lines: ['0033199000100', '0033199000200', '0033199000300'] } }
    const status = {
      configured: true,
      operator: 'ovh',
      trunks: [
        {
          id: 'operator',
          lines: [
            { line: '0033199000100', managed: false, readAt: '2026-10-17T10:00:00.000Z', forwards: { onUnavailable: { nature: 'number' as const, number: '+33639980001' } }, original: { onNoAnswer: { nature: 'voicemail' as const, afterSec: 20 } } },
            { line: '0033199000200', managed: false, readAt: '2026-10-17T10:00:00.000Z', forwards: {}, original: { onUnavailable: { nature: 'number' as const, number: '+33199000101' } }, originalRefused: 'loop' as const },
            { line: '0033199000300', managed: false, readAt: '2026-10-17T10:00:00.000Z', forwards: {} }
          ]
        }
      ],
      removals: [{ line: '0033199000900', since: '2026-10-17T10:00:00.000Z', original: { onUnavailable: { nature: 'number' as const, number: '+33899000000' } }, originalRefused: 'outbound' as const }],
      closedRemovals: [
        { line: '0033199000800', at: '2026-10-17T11:00:00.000Z', outcome: 'done' as const, unrestored: 'refused' as const },
        { line: '0033199000700', at: '2026-10-17T10:30:00.000Z', outcome: 'done' as const, unrestored: 'loop' as const }
      ],
      cdrs: { since: '2026-10-10T10:00:00.000Z', stats: { total: 0, matched: 0, orphan: 0, unmatchedInbound: 0, unmatchedOutbound: 0, forwarded: 0, pending: 0, invalid: 0, erased: 0 } }
    }
    admin({ listTrunks: vi.fn(async () => ({ items: [left] })), getOperatorStatus: vi.fn(async () => status) })
    await render('/admin/trunks', <Trunks />)
    click($('[aria-label="Retirer le renvoi de repli du trunk operator chez l\'opérateur"]'))
    expect($('[role="group"]')?.getAttribute('aria-label')).toBe(
      "Retirer les renvois posés chez l'opérateur sur les lignes du trunk operator ? Ceux qu'un autre trunk tient restent. Ligne 0033199000100 : ses renvois d'avant la plateforme seront remis (renvoi après 20 s sans réponse vers la messagerie). Ligne 0033199000200 : ses renvois d'avant la plateforme (renvoi sur indisponibilité vers +33 1 99 00 01 01) ne seront pas remis : ils ramèneraient les appels vers la plateforme."
    )
    click(button(host, 'Non, garder'))
    expect($('[aria-label="Renvois pas encore retirés chez l\'opérateur"]')?.textContent).toContain("ne seront pas remis : ils vont vers un numéro que son trunk n'appelle pas.")
    expect($('[aria-label="Retraits des 7 derniers jours"]')?.textContent).toMatch(
      /^Ligne 0033199000800 : renvoi retiré le 17\/10\/2026 .*, ses renvois d'avant non remis \(l'opérateur ne les a pas gardés tels quels\)Ligne 0033199000700 : renvoi retiré le 17\/10\/2026 .*, ses renvois d'avant non remis \(ils ramèneraient les appels vers la plateforme\)$/
    )
  })

  it('offers no fallback at the operator without one, and puts the refusal of a direct number on the form (step 10b)', async () => {
    const setTrunk = vi.fn(async () => {
      throw refused(409, 'OPERATOR_FALLBACK_LOOP', 'operator.fallback.number: +33199000101 is one of the direct numbers of this platform')
    })
    admin({ setTrunk })
    await render('/admin/trunks', <Trunks />)
    expect($('#operator')).toBeNull()
    expect(($('#trunk-fallbackManaged') as HTMLInputElement).disabled).toBe(true)
    expect($('#trunk-fallbackManaged-hint')?.textContent).toContain("Aucun accès à l'API de l'opérateur")
    // Lines alone: their records are reconciled, the fallback left as it is there.
    click($('[aria-label="Modifier le trunk operator"]'))
    await flush()
    type($('#trunk-operatorLines'), '0033199000100, 0033199000100')
    await submit($('form'))
    expect($('#trunk-operatorLines-error')?.textContent).toContain('sans doublon')
    type($('#trunk-operatorLines'), '0033199000100')
    await submit($('form'))
    await flush()
    expect(setTrunk).toHaveBeenCalledWith('operator', expect.objectContaining({ operator: { lines: ['0033199000100'] } }))
    expect(text()).toContain('numéro direct de la plateforme')
  })

  it("shows the whole setting an assignment made, another administrator's change included, and sends that with its version (review 7 n°1, 11; review 7 bis n°1)", async () => {
    // Bob has "national" when the page opens; another administrator then takes it from him.
    const getOutbound = vi.fn(async () => outbound({ assignments: [{ userId: 'bob', profileId: 'national' }] }))
    const setUserProfile = vi.fn(async () => ({ userId: 'alice', profileId: 'national', ...outbound({ version: 'v2', assignments: [{ userId: 'alice', profileId: 'national' }] }) }))
    const setOutbound = vi.fn(async (): Promise<OutboundSettings> => {
      throw refused(409, 'OUTBOUND_STALE', 'the outbound setting changed since it was read')
    })
    const listAdminUsers = vi.fn(async () => ({ items: [{ userId: 'alice', extension: '101', displayName: 'Alice' }, { userId: 'bob', extension: '102', displayName: 'Bob' }] }))
    admin({ getOutbound, setUserProfile, setOutbound, listAdminUsers })
    await render('/admin/rights', <Rights />)
    // The default profile, when none: what the trunks allow; a person without a profile: the default one.
    expect(($('#rights-default') as HTMLSelectElement).options[0]!.textContent).toBe('Aucun : ce que le trunk permet')
    const ofAlice = $('select[aria-label="Profil de Alice"]') as HTMLSelectElement
    const ofBob = () => $('select[aria-label="Profil de Bob"]') as HTMLSelectElement
    expect(ofAlice.options[0]!.textContent).toBe('Profil par défaut')
    expect(ofBob().value).toBe('national')
    choose(ofAlice, 'national')
    click($('[aria-label="Appliquer le profil de Alice"]'))
    await flush()
    expect(setUserProfile).toHaveBeenCalledWith('alice', 'national', 'v1')
    // The page shows the setting that assignment made: Bob has no profile any more.
    expect(ofBob().value).toBe('')
    expect(text()).toContain('Profil de Alice enregistré.')
    // The next whole change is made from that setting and goes with its version: Bob's change stays.
    getOutbound.mockResolvedValueOnce(outbound({ version: 'v3', profiles: [...outbound().profiles, { id: 'world', allowed: ['fixed', 'mobile', 'international'] }], assignments: [{ userId: 'alice', profileId: 'world' }] }))
    choose($('#rights-default'), 'national')
    await submit($('#rights-default')!.closest('form'))
    await flush()
    expect(setOutbound).toHaveBeenCalledWith({ policy: { defaultProfile: 'national' }, profiles: outbound().profiles, assignments: [{ userId: 'alice', profileId: 'national' }], version: 'v2' })
    expect(getOutbound).toHaveBeenCalledTimes(2)
    expect($('[role="alert"]')?.textContent).toContain('Un autre administrateur a modifié ces réglages')
    // What it is now: the profile the other administrator added, and nothing of the change refused.
    expect(text()).toContain('world')
    expect(($('#rights-default') as HTMLSelectElement).value).toBe('')
    setOutbound.mockResolvedValueOnce(outbound({ version: 'v4', policy: { defaultProfile: 'world' } }))
    choose($('#rights-default'), 'world')
    await submit($('#rights-default')!.closest('form'))
    await flush()
    expect(setOutbound).toHaveBeenLastCalledWith(expect.objectContaining({ policy: { defaultProfile: 'world' }, version: 'v3' }))
  })

  const world = { id: 'world', name: 'Monde', allowed: ['fixed', 'mobile', 'international'] } as OutboundSettings['profiles'][number]
  const withWorld = (over: Partial<OutboundSettings> = {}) => outbound({ profiles: [...outbound().profiles, world], ...over })
  /** World as B left it: without international calls. */
  const restricted = { ...world, allowed: ['fixed', 'mobile'] } as OutboundSettings['profiles'][number]

  it('shows the profile being changed as an assignment left it, and sends what is typed on that one, with its version (review 7 ter, n°1)', async () => {
    const setUserProfile = vi.fn(async () => ({ userId: 'alice', profileId: 'national', ...withWorld({ version: 'v2', profiles: [outbound().profiles[0]!, restricted], assignments: [{ userId: 'alice', profileId: 'national' }] }) }))
    const setOutbound = vi.fn(async () => withWorld({ version: 'v3' }))
    admin({ getOutbound: vi.fn(async () => withWorld()), setUserProfile, setOutbound })
    await render('/admin/rights', <Rights />)
    // A opens "world", types a name; B meanwhile takes international calls from it; A gives Alice a profile.
    click($('[aria-label="Modifier le profil world"]'))
    await flush()
    expect(($('#profile-allowed-international') as HTMLInputElement).checked).toBe(true)
    type($('#profile-name'), 'Monde entier')
    choose($('select[aria-label="Profil de Alice"]'), 'national')
    click($('[aria-label="Appliquer le profil de Alice"]'))
    await flush()
    // The form shows "world" as it is now, and says what was typed is gone.
    expect(($('#profile-allowed-international') as HTMLInputElement).checked).toBe(false)
    expect(($('#profile-name') as HTMLInputElement).value).toBe('Monde')
    expect(text()).toContain('Le profil world a été modifié par un autre administrateur pendant que vous le modifiiez')
    // Renamed again and saved: international stays out, with the version the assignment gave.
    type($('#profile-name'), 'Monde entier')
    await submit($('#profile-name')!.closest('form'))
    await flush()
    expect(setOutbound).toHaveBeenCalledWith(expect.objectContaining({ version: 'v2', profiles: [outbound().profiles[0], { ...restricted, name: 'Monde entier' }] }))
  })

  it('after a refusal for a setting changed meanwhile, shows the profile being changed as it is now, never sends it as it was (review 7 ter, n°1)', async () => {
    const getOutbound = vi.fn(async () => withWorld())
    const setOutbound = vi.fn(async (): Promise<OutboundSettings> => {
      throw refused(409, 'OUTBOUND_STALE', 'the outbound setting changed since it was read')
    })
    admin({ getOutbound, setOutbound })
    await render('/admin/rights', <Rights />)
    click($('[aria-label="Modifier le profil world"]'))
    await flush()
    type($('#profile-name'), 'Monde entier')
    getOutbound.mockResolvedValueOnce(withWorld({ version: 'v2', profiles: [outbound().profiles[0]!, restricted] }))
    await submit($('#profile-name')!.closest('form'))
    await flush()
    expect(setOutbound).toHaveBeenCalledWith(expect.objectContaining({ version: 'v1', profiles: [outbound().profiles[0], { ...world, name: 'Monde entier' }] }))
    expect(($('#profile-allowed-international') as HTMLInputElement).checked).toBe(false)
    expect(($('#profile-name') as HTMLInputElement).value).toBe('Monde')
    // Sent again: what it is now, with the version now read.
    setOutbound.mockResolvedValueOnce(withWorld({ version: 'v3', profiles: [outbound().profiles[0]!, restricted] }))
    await submit($('#profile-name')!.closest('form'))
    await flush()
    expect(setOutbound).toHaveBeenLastCalledWith(expect.objectContaining({ version: 'v2', profiles: [outbound().profiles[0], restricted] }))
    expect(text()).toContain('Profil world enregistré.')
  })

  it('says a profile being changed was deleted meanwhile, and never that it was saved (review 7 ter, n°6)', async () => {
    const getOutbound = vi.fn(async () => withWorld())
    const setOutbound = vi.fn(async (): Promise<OutboundSettings> => {
      throw refused(409, 'OUTBOUND_STALE', 'the outbound setting changed since it was read')
    })
    admin({ getOutbound, setOutbound })
    await render('/admin/rights', <Rights />)
    click($('[aria-label="Modifier le profil world"]'))
    await flush()
    type($('#profile-name'), 'Monde entier')
    getOutbound.mockResolvedValueOnce(outbound({ version: 'v2' }))
    await submit($('#profile-name')!.closest('form'))
    await flush()
    expect($('[role="alert"]')?.textContent).toContain('Le profil world que vous modifiiez a été supprimé par un autre administrateur')
    expect(text()).not.toContain('Profil world enregistré')
    // The form is a new profile's again.
    expect(($('#profile-id') as HTMLInputElement).disabled).toBe(false)
    expect(($('#profile-id') as HTMLInputElement).value).toBe('')
    expect(setOutbound).toHaveBeenCalledTimes(1)
  })

  it("gives a person a profile from the version shown; changed since, refused and the page read again (review 7 ter, n°3)", async () => {
    const getOutbound = vi.fn(async () => outbound())
    const setUserProfile = vi.fn(async () => Promise.reject(refused(409, 'OUTBOUND_STALE', 'the outbound setting changed since it was read')))
    admin({ getOutbound, setUserProfile })
    await render('/admin/rights', <Rights />)
    getOutbound.mockResolvedValueOnce(outbound({ version: 'v2', assignments: [{ userId: 'alice', profileId: 'national' }] }))
    choose($('select[aria-label="Profil de Alice"]'), 'national')
    click($('[aria-label="Appliquer le profil de Alice"]'))
    await flush()
    expect(setUserProfile).toHaveBeenCalledWith('alice', 'national', 'v1')
    expect(getOutbound).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Un autre administrateur a modifié ces réglages')
    expect(($('select[aria-label="Profil de Alice"]') as HTMLSelectElement).value).toBe('national')
  })

  it('refuses a profile too many before sending (review 7 n°14)', async () => {
    const setOutbound = vi.fn()
    admin({ getOutbound: vi.fn(async () => outbound({ profiles: Array.from({ length: 32 }, (_, i) => ({ id: `p${i}`, allowed: [] })) })), setOutbound })
    await render('/admin/rights', <Rights />)
    type($('#profile-id'), 'one-more')
    await submit($('#profile-id')!.closest('form'))
    expect(setOutbound).not.toHaveBeenCalled()
    expect(text()).toContain('32 profils au plus')
  })

  it('sends the caps with the version read; changed meanwhile, shows them as they are now and says what was typed, never sending it (review 7 n°1; review 7 ter n°2)', async () => {
    // A opens the page: 10 calls at once for the organisation.
    const getOutbound = vi.fn(async () => outbound({ policy: { caps: { concurrent: 10 } } }))
    const setOutbound = vi.fn(async (): Promise<OutboundSettings> => {
      throw refused(409, 'OUTBOUND_STALE', 'the outbound setting changed since it was read')
    })
    admin({ getOutbound, setOutbound })
    await render('/admin/limits', <Limits />)
    expect(($('#limits-tenant-concurrent') as HTMLInputElement).value).toBe('10')
    // B lowers it to 2 during an incident; A, who did not see it, sets the daily calls of those without a profile.
    getOutbound.mockResolvedValueOnce(outbound({ version: 'v2', policy: { caps: { concurrent: 2 } }, assignments: [{ userId: 'alice', profileId: 'national' }] }))
    choose($('#limits-user-dailyCalls-mode'), 'value')
    type($('#limits-user-dailyCalls'), '50')
    await submit($('form'))
    await flush()
    expect(setOutbound).toHaveBeenCalledWith({ policy: { caps: { concurrent: 10 }, userCaps: { dailyCalls: 50 } }, profiles: outbound().profiles, assignments: [], version: 'v1' })
    const said = $('[role="alert"]')?.textContent
    expect(said).toContain('Un autre administrateur a modifié ces réglages')
    expect(said).toContain('Vous aviez saisi : Plafonds des personnes sans profil : Appels par jour = 50.')
    // The form is the setting as it is now, B's cap included; nothing typed before goes with the new version.
    expect(($('#limits-tenant-concurrent') as HTMLInputElement).value).toBe('2')
    expect(($('#limits-user-dailyCalls-mode') as HTMLSelectElement).value).toBe('default')
    setOutbound.mockResolvedValueOnce(outbound({ version: 'v3', policy: { caps: { concurrent: 2 }, userCaps: { dailyCalls: 50 } } }))
    choose($('#limits-user-dailyCalls-mode'), 'value')
    type($('#limits-user-dailyCalls'), '50')
    await submit($('form'))
    expect(setOutbound).toHaveBeenLastCalledWith({ policy: { caps: { concurrent: 2 }, userCaps: { dailyCalls: 50 } }, profiles: outbound().profiles, assignments: [{ userId: 'alice', profileId: 'national' }], version: 'v2' })
  })

  const seen: AdminAlert = { id: '7', kind: 'fraud-critical', param: 'callsPerMinute', scope: 'user', value: 8, threshold: 6, extension: '101', number: '+33612345678', at: '2026-10-16T08:00:00.000Z', lastAt: '2026-10-16T08:05:00.000Z', count: 3, first: { value: 7 } }

  it('acknowledges an alert as it was seen; repeated since, shows it again instead, the focus on what is said (review 7 n°2, 3)', async () => {
    const listAlerts = vi.fn(async () => ({ items: [seen] }))
    const acknowledgeAlert = vi.fn(async (): Promise<AdminAlert> => {
      throw refused(409, 'ALERT_CHANGED', 'the alert repeated since')
    })
    admin({ listAlerts, acknowledgeAlert })
    await render('/admin/alerts', <Alerts />)
    listAlerts.mockResolvedValueOnce({ items: [{ ...seen, count: 4, lastAt: '2026-10-16T08:06:00.000Z' }] })
    click(button(host, 'Acquitter'))
    await flush()
    expect(acknowledgeAlert).toHaveBeenCalledWith('7', '2026-10-16T08:05:00.000Z', 3)
    expect(listAlerts).toHaveBeenCalledTimes(2)
    expect(text()).toContain('4 fois depuis')
    expect(document.activeElement?.getAttribute('role')).toBe('alert')
    expect(document.activeElement?.textContent).toContain("s'est répétée depuis son affichage")
    // As seen now: acknowledged, the row gone, the focus on what is said.
    acknowledgeAlert.mockResolvedValueOnce({ ...seen, count: 4, lastAt: '2026-10-16T08:06:00.000Z', acknowledgedAt: '2026-10-16T09:00:00.000Z', acknowledgedBy: 'alice' })
    click(button(host, 'Acquitter'))
    await flush()
    expect(acknowledgeAlert).toHaveBeenLastCalledWith('7', '2026-10-16T08:06:00.000Z', 4)
    expect(text()).toContain('Aucune alerte.')
    expect(document.activeElement?.getAttribute('role')).toBe('status')
    expect(document.activeElement?.textContent).toBe('Alerte acquittée.')
  })

  it('says an alert is gone rather than the platform unable, and reads the list again (review 7 n°8)', async () => {
    const listAlerts = vi.fn(async () => ({ items: [seen] }))
    admin({ listAlerts, acknowledgeAlert: vi.fn(async () => Promise.reject(refused(404, 'FST_ERR_NOT_FOUND', 'alert not found'))) })
    await render('/admin/alerts', <Alerts />)
    listAlerts.mockResolvedValueOnce({ items: [] })
    click(button(host, 'Acquitter'))
    await flush()
    expect(listAlerts).toHaveBeenCalledTimes(2)
    expect($('[role="alert"]')?.textContent).toContain("Cette alerte n'existe plus")
    expect(text()).not.toContain('ne permet pas cette action')
    expect(text()).toContain('Aucune alerte.')
  })

  it('reads the alerts shown again on its own, names who acknowledged, and keeps the filter across a change of language (review 7 n°2, 13)', async () => {
    const acknowledged = { ...seen, acknowledgedAt: '2026-10-16T09:00:00.000Z', acknowledgedBy: 'alice' }
    const listAlerts = vi.fn(async () => ({ items: [acknowledged] }))
    admin({ listAlerts })
    await render(
      '/admin/alerts',
      <>
        <LangSwitch />
        <Alerts />
      </>
    )
    expect(text()).toContain('par Alice')
    choose($('#alerts-state'), 'acknowledged')
    await submit($('#alerts-state')!.closest('form'))
    expect(listAlerts).toHaveBeenLastCalledWith({ limit: 25, state: 'acknowledged' })
    click(button(host, 'English'))
    await flush()
    expect(listAlerts).toHaveBeenCalledTimes(2)
    expect(($('#alerts-state') as HTMLSelectElement).value).toBe('acknowledged')
    expect(text()).toContain('by Alice')
    // The button reads the list shown again, with its filter.
    click(button(host, 'Read the alerts again'))
    await flush()
    expect(listAlerts).toHaveBeenCalledTimes(3)
    expect(listAlerts).toHaveBeenLastCalledWith({ limit: 25, state: 'acknowledged' })
  })

  it('reads the first page of alerts again on its own while shown, and no more once more pages are shown (review 7 n°2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const listAlerts = vi.fn(async (filter: { before?: string }) => (filter.before ? { items: [{ ...seen, id: '6' }] } : { items: [seen], next: 'cursor' }))
      admin({ listAlerts })
      const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
      await act(async () =>
        root.render(
          <I18nProvider>
            <MemoryRouter initialEntries={['/admin/alerts']}>
              <Alerts />
            </MemoryRouter>
          </I18nProvider>
        )
      )
      await wait(0)
      expect(listAlerts).toHaveBeenCalledTimes(1)
      await wait(ALERTS_REFRESH_MS + 10)
      expect(listAlerts).toHaveBeenCalledTimes(2)
      expect(listAlerts).toHaveBeenLastCalledWith({ limit: 25, state: 'open' })
      click(button(host, "Afficher plus d'alertes"))
      await wait(0)
      expect(listAlerts).toHaveBeenCalledTimes(3)
      // The rows would move under the reader: the button reads them again, not the screen.
      await wait(ALERTS_REFRESH_MS * 3)
      expect(listAlerts).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows only the answer of the last read asked: a read on its own answered late never replaces a filter or a page asked since (review 7 bis, n°4)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const answers: ((v: unknown) => void)[] = []
      const listAlerts = vi.fn(() => new Promise(resolve => answers.push(resolve)))
      admin({ listAlerts })
      const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
      const send = (form: Element | null | undefined) => act(async () => void (form as HTMLFormElement).requestSubmit())
      const rows = () => host.querySelectorAll('tbody tr').length
      await act(async () =>
        root.render(
          <I18nProvider>
            <MemoryRouter initialEntries={['/admin/alerts']}>
              <Alerts />
            </MemoryRouter>
          </I18nProvider>
        )
      )
      answers[0]!({ items: [seen], next: 'cursor' })
      await wait(0)
      // Read again on its own, answered late: another filter asked and answered meanwhile stays shown.
      await wait(ALERTS_REFRESH_MS + 10)
      expect(listAlerts).toHaveBeenCalledTimes(2)
      choose($('#alerts-state'), 'acknowledged')
      await send($('#alerts-state')!.closest('form'))
      expect(listAlerts).toHaveBeenCalledTimes(3)
      answers[2]!({ items: [{ ...seen, id: '5', acknowledgedAt: '2026-10-16T09:00:00.000Z', acknowledgedBy: 'alice' }] })
      await wait(0)
      answers[1]!({ items: [seen], next: 'cursor' })
      await wait(0)
      expect(text()).toContain('par Alice')
      expect(button(host, 'Acquitter')).toBeUndefined()
      // The next page asked while the first is read again on its own: the late first page does not take it away.
      choose($('#alerts-state'), 'open')
      await send($('#alerts-state')!.closest('form'))
      answers[3]!({ items: [seen], next: 'cursor' })
      await wait(0)
      await wait(ALERTS_REFRESH_MS + 10)
      expect(listAlerts).toHaveBeenCalledTimes(5)
      click(button(host, "Afficher plus d'alertes"))
      expect(listAlerts).toHaveBeenCalledTimes(6)
      answers[5]!({ items: [{ ...seen, id: '6' }] })
      await wait(0)
      expect(rows()).toBe(2)
      answers[4]!({ items: [seen], next: 'cursor' })
      await wait(0)
      expect(rows()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads nothing on its own while the focus is in the list, nor once asked not to (review 7 bis, n°5)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const listAlerts = vi.fn(async () => ({ items: [seen] }))
      admin({ listAlerts })
      const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
      await act(async () =>
        root.render(
          <I18nProvider>
            <MemoryRouter initialEntries={['/admin/alerts']}>
              <Alerts />
            </MemoryRouter>
          </I18nProvider>
        )
      )
      await wait(0)
      expect(listAlerts).toHaveBeenCalledTimes(1)
      // The focus on the button of a row: nothing moves under it, however long.
      act(() => button(host, 'Acquitter')!.focus())
      await wait(ALERTS_REFRESH_MS * 3)
      expect(listAlerts).toHaveBeenCalledTimes(1)
      act(() => (document.activeElement as HTMLElement).blur())
      await wait(ALERTS_REFRESH_MS + 10)
      expect(listAlerts).toHaveBeenCalledTimes(2)
      // Asked not to: nothing more until asked again.
      const auto = () => $('#alerts-auto') as HTMLInputElement
      expect(auto().checked).toBe(true)
      expect(auto().closest('label')?.textContent).toContain('Relire la liste toutes les 30 secondes')
      click(auto())
      expect(auto().checked).toBe(false)
      await wait(ALERTS_REFRESH_MS * 3)
      expect(listAlerts).toHaveBeenCalledTimes(2)
      click(auto())
      await wait(ALERTS_REFRESH_MS + 10)
      expect(listAlerts).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says a group removed meanwhile is gone rather than the platform unable, and reads the list again (review 7 bis, n°11)', async () => {
    const listGroups = vi.fn(async () => ({ items: [{ number: '200', name: 'Accueil', members: ['101'] }] }))
    // As the client says it: no code, the words of the Gateway.
    const setGroup = vi.fn(async () => Promise.reject(Object.assign(new Error('Gateway 404'), { status: 404, detail: 'No such group' })))
    admin({ listGroups, setGroup })
    await render('/admin/groups', <RingGroups />)
    click($('[aria-label="Modifier le groupe 200"]'))
    await flush()
    listGroups.mockResolvedValueOnce({ items: [] })
    await submit($('form'))
    await flush()
    expect(setGroup).toHaveBeenCalled()
    expect(listGroups).toHaveBeenCalledTimes(2)
    expect($('[role="alert"]')?.textContent).toContain("Cet élément n'existe plus")
    expect(text()).not.toContain('ne permet pas cette action')
  })

  it('puts the focus on what is said after an acknowledgement, more pages shown too (review 7 ter, n°7)', async () => {
    const page2 = Array.from({ length: 3 }, (_, i) => ({ ...seen, id: String(20 + i) }))
    const listAlerts = vi.fn(async (filter: { before?: string }) => (filter.before ? { items: page2 } : { items: [seen], next: 'cursor' }))
    const acknowledgeAlert = vi.fn(async () => ({ ...seen, acknowledgedAt: '2026-10-16T09:00:00.000Z', acknowledgedBy: 'alice' }))
    admin({ listAlerts, acknowledgeAlert })
    await render('/admin/alerts', <Alerts />)
    click(button(host, "Afficher plus d'alertes"))
    await flush()
    expect(document.activeElement?.tagName).toBe('TR')
    click(button(host, 'Acquitter'))
    await flush()
    expect(acknowledgeAlert).toHaveBeenCalledWith('7', seen.lastAt, seen.count)
    expect(document.activeElement?.getAttribute('role')).toBe('status')
  })

  it('drops a read made on its own when the focus went into the list meanwhile (review 7 ter, n°8)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const answers: ((v: unknown) => void)[] = []
      const listAlerts = vi.fn(() => new Promise(resolve => answers.push(resolve)))
      admin({ listAlerts })
      const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
      await act(async () =>
        root.render(
          <I18nProvider>
            <MemoryRouter initialEntries={['/admin/alerts']}>
              <Alerts />
            </MemoryRouter>
          </I18nProvider>
        )
      )
      answers[0]!({ items: [seen] })
      await wait(0)
      await wait(ALERTS_REFRESH_MS + 10)
      expect(listAlerts).toHaveBeenCalledTimes(2)
      // The focus goes to the button of the row while the read goes on: its answer would take the row away.
      const ack = button(host, 'Acquitter')!
      act(() => ack.focus())
      answers[1]!({ items: [] })
      await wait(0)
      expect(button(host, 'Acquitter')).toBe(ack)
      expect(document.activeElement).toBe(ack)
    } finally {
      vi.useRealTimers()
    }
  })

  it('checks a ring group before sending, the problems next to their fields, and puts the refusals of the Gateway there (review 7 n°7)', async () => {
    const createGroup = vi.fn(async () => {
      throw refused(409, 'GROUP_EXISTS', 'a group already has this number')
    })
    admin({ createGroup })
    await render('/admin/groups', <RingGroups />)
    type($('#group-number'), '112')
    type($('#group-members'), Array.from({ length: 13 }, (_, i) => String(101 + i)).join(', '))
    await submit($('form'))
    expect(createGroup).not.toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('group-number')
    expect($('#group-number-error')?.textContent).toContain("numéro d'urgence")
    expect($('#group-name')?.getAttribute('aria-describedby')).toBe('group-name-error')
    expect($('#group-members-error')?.textContent).toContain('de 1 à 12 membres')
    type($('#group-number'), '200')
    type($('#group-name'), 'Accueil')
    type($('#group-members'), '101, 102')
    await submit($('form'))
    await flush()
    expect(createGroup).toHaveBeenCalledWith({ number: '200', name: 'Accueil', members: ['101', '102'] })
    expect($('#group-number-error')?.textContent).toContain('Un groupe de votre organisation a déjà ce numéro')
    expect(document.activeElement?.id).toBe('group-number')
  })
  it('lists the call flows with what each does and whether the platform runs it yet, and makes a queue after checking it as the Gateway does (step 11c-2)', async () => {
    const listFlows = vi.fn(async () => ({
      items: [
        { number: '801', name: 'Support', kind: 'queue', members: ['102', '109'], ringSec: 12, waitSec: 90, vacant: ['109'], ready: true },
        { number: '810', name: 'Astreinte', kind: 'sequential', members: ['102'], ringSec: 15, vacant: [], ready: false },
        { number: '800', name: 'Standard', kind: 'menu', choices: { '1': '801', '2': '810' }, ready: true }
      ]
    }))
    const createFlow = vi.fn(async (f: { number: string }) => f)
    admin({ listFlows, createFlow })
    await render('/admin/flows', <CallFlows />)
    const rows = [...host.querySelectorAll('ul[aria-label="Parcours existants"] li')].map(li => li.textContent)
    expect(rows[0]).toContain("801 Support (File d'attente) : 102, 109 (poste libre), 12 s chacun, attente de 90 s au plus — en service")
    expect(rows[1]).toContain('810 Astreinte (Groupe séquentiel) : 102, 15 s chacun — en cours de mise en service')
    expect(rows[2]).toContain('800 Standard (Standard vocal (SVI)) : touches : 1=801, 2=810 — en service')
    // Wrong: the problems next to their fields, nothing sent, the focus on the first.
    choose($('#flow-kind'), 'queue')
    type($('#flow-number'), '112')
    type($('#flow-ringSec'), '2')
    type($('#flow-waitSec'), '5')
    await submit($('form'))
    expect(createFlow).not.toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('flow-number')
    expect($('#flow-number-error')?.textContent).toContain("numéro d'urgence")
    expect($('#flow-name-error')?.textContent).toContain('une ligne')
    expect($('#flow-members-error')?.textContent).toContain('de 1 à 12 membres')
    expect($('#flow-ringSec-error')?.textContent).toContain('de 5 à 60 secondes')
    expect($('#flow-waitSec-error')?.textContent).toContain('de 15 à 600 secondes')
    type($('#flow-number'), '802')
    type($('#flow-name'), 'Accueil')
    type($('#flow-members'), '102, 103')
    type($('#flow-ringSec'), '20')
    type($('#flow-waitSec'), '60')
    await submit($('form'))
    await flush()
    expect(createFlow).toHaveBeenCalledWith({ number: '802', name: 'Accueil', kind: 'queue', members: ['102', '103'], ringSec: 20, waitSec: 60 })
    expect(text()).toContain('Parcours 802 enregistré.')
  })

  it('reads a voice menu as keys and numbers, with a greeting if any, and says what the Gateway refuses next to the field (step 11c-2)', async () => {
    const createFlow = vi.fn(async () => {
      throw refused(400, 'FLOW_CHOICE_TARGET', 'a choice leads to an extension, a sequential group or a queue of your organisation')
    })
    admin({ createFlow })
    await render('/admin/flows', <CallFlows />)
    choose($('#flow-kind'), 'menu')
    // A menu has keys, not members.
    expect($('#flow-members')).toBeNull()
    type($('#flow-number'), '800')
    type($('#flow-name'), 'Standard')
    type($('#flow-choices'), '1=801, 1=802')
    await submit($('form'))
    expect(createFlow).not.toHaveBeenCalled()
    expect($('#flow-choices-error')?.textContent).toContain('1=802')
    type($('#flow-choices'), '1=801, x=102')
    await submit($('form'))
    expect($('#flow-choices-error')?.textContent).toContain('x=102')
    type($('#flow-choices'), '1=801, 2=102')
    type($('#flow-greeting'), 'custom/accueil')
    await submit($('form'))
    await flush()
    expect(createFlow).toHaveBeenCalledWith({ number: '800', name: 'Standard', kind: 'menu', choices: { '1': '801', '2': '102' }, greeting: 'custom/accueil' })
    expect($('#flow-choices-error')?.textContent).toContain('jamais à un autre standard')
    expect(document.activeElement?.id).toBe('flow-choices')
  })

  it('changes a flow keeping its number, removes one once confirmed, says a flow a menu leads to stays, and says the platform has none (step 11c-2)', async () => {
    const flow = { number: '801', name: 'Support', kind: 'queue', members: ['102'], ringSec: 12, waitSec: 90, vacant: [], ready: true }
    const listFlows = vi.fn(async () => ({ items: [flow] }))
    const setFlow = vi.fn(async (f: { number: string }) => f)
    const deleteFlow = vi
      .fn()
      .mockRejectedValueOnce(refused(409, 'FLOW_IN_USE', 'the menu 800 leads to it'))
      .mockResolvedValue(undefined)
    admin({ listFlows, setFlow, deleteFlow })
    await render('/admin/flows', <CallFlows />)
    click($('[aria-label="Modifier le parcours 801"]'))
    await flush()
    expect(($('#flow-number') as HTMLInputElement).disabled).toBe(true)
    expect(($('#flow-waitSec') as HTMLInputElement).value).toBe('90')
    type($('#flow-members'), '102, 103')
    await submit($('form'))
    await flush()
    expect(setFlow).toHaveBeenCalledWith({ number: '801', name: 'Support', kind: 'queue', members: ['102', '103'], ringSec: 12, waitSec: 90 })
    click($('[aria-label="Supprimer le parcours 801"]'))
    click(button(host, 'Oui, supprimer'))
    await flush()
    expect(deleteFlow).toHaveBeenCalledWith('801')
    expect($('[role="alert"]')?.textContent).toContain('Un standard mène à ce parcours')
    click($('[aria-label="Supprimer le parcours 801"]'))
    click(button(host, 'Oui, supprimer'))
    await flush()
    expect(text()).toContain('Parcours 801 supprimé.')
  })

  it('says a platform without lines has no call flows', async () => {
    admin({ listFlows: vi.fn(async () => Promise.reject(Object.assign(new Error('Gateway 501'), { status: 501 }))) })
    await render('/admin/flows', <CallFlows />)
    expect(text()).toContain('ne gère pas les standards vocaux')
    expect($('form')).toBeNull()
  })

  /** Types into a text area as a person does. */
  const typeArea = (el: Element | null, value: string) => {
    const area = el as HTMLTextAreaElement
    const { set } = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') as { set: (this: HTMLTextAreaElement, v: string) => void }
    act(() => {
      set.call(area, value)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const hook: WebhookSubscription = { id: 'wh_00000000000000a1', url: 'https://crm.example.org/in', events: ['call.missed'], description: 'CRM', enabled: true, deliverable: true, createdAt: '2026-10-16T08:00:00.000Z', updatedAt: '2026-10-16T08:00:00.000Z' }
  const webhooksClient = (over: Record<string, unknown> = {}) => ({
    getWebhookDomains: vi.fn(async () => ({ domains: ['crm.example.org'] })),
    setWebhookDomains: vi.fn(async (domains: string[]) => ({ domains })),
    listWebhooks: vi.fn(async () => ({ items: [hook] })),
    createWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    renewWebhookSecret: vi.fn(),
    resumeWebhook: vi.fn(),
    testWebhook: vi.fn(),
    listWebhookDeliveries: vi.fn(async () => ({ items: [] })),
    replayWebhookDelivery: vi.fn(),
    ...over
  })

  it('lists the subscriptions, checks a new one against the allowed domains before sending, and shows its secret once (step 10a)', async () => {
    const createWebhook = vi.fn(async () => ({ ...hook, id: 'wh_00000000000000a2', url: 'https://crm.example.org/v2', events: ['call.missed', 'trunk.degraded'], secret: 'whsec_shown-once' }))
    admin(webhooksClient({ createWebhook }))
    await render('/admin/webhooks', <Webhooks />)
    expect(text()).toContain('https://crm.example.org/in (CRM) : Appel manqué.')
    expect(($('#webhook-domains') as HTMLTextAreaElement).value).toBe('crm.example.org')
    type($('#webhook-url'), 'https://other.example.net/in')
    // A missed call is ticked first: untick it, nothing is left.
    click($('[id="webhook-events-call.missed"]'))
    await submit($('#webhook-url')!.closest('form'))
    expect(createWebhook).not.toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('webhook-url')
    expect($('#webhook-url-error')?.textContent).toContain("other.example.net n'est pas parmi les domaines autorisés")
    expect($('#webhook-events-error')?.textContent).toContain('au moins un événement')
    type($('#webhook-url'), 'https://crm.example.org/v2')
    click($('[id="webhook-events-call.missed"]'))
    click($('[id="webhook-events-trunk.degraded"]'))
    await submit($('#webhook-url')!.closest('form'))
    await flush()
    expect(createWebhook).toHaveBeenCalledWith({ url: 'https://crm.example.org/v2', events: ['call.missed', 'trunk.degraded'], enabled: true })
    // The secret, once, the focus on it; gone once copied.
    expect(($('#webhook-secret-value') as HTMLInputElement).value).toBe('whsec_shown-once')
    expect(document.activeElement?.id).toBe('webhook-secret-value')
    click(button(host, "J'ai copié le secret"))
    expect($('#webhook-secret-value')).toBeNull()
    expect(text()).not.toContain('whsec_shown-once')
  })

  it("puts the Gateway's refusal of an address on its field, and refuses a domain that is none (step 10a)", async () => {
    const createWebhook = vi.fn(async () => {
      throw refused(400, 'WEBHOOK_URL_SCHEME', 'url: https only')
    })
    const setWebhookDomains = vi.fn(async (domains: string[]) => ({ domains }))
    admin(webhooksClient({ createWebhook, setWebhookDomains }))
    await render('/admin/webhooks', <Webhooks />)
    type($('#webhook-url'), 'http://crm.example.org/in')
    await submit($('#webhook-url')!.closest('form'))
    await flush()
    expect($('#webhook-url-error')?.textContent).toContain('Une adresse https.')
    expect(document.activeElement?.id).toBe('webhook-url')

    typeArea($('#webhook-domains'), 'crm.example.org\nintranet')
    await submit($('#webhook-domains')!.closest('form'))
    expect(setWebhookDomains).not.toHaveBeenCalled()
    expect($('#webhook-domains-error')?.textContent).toContain("intranet n'est pas un nom de domaine")
    expect($('#webhook-domains')?.getAttribute('aria-describedby')).toBe('webhook-domains-hint webhook-domains-error')
    typeArea($('#webhook-domains'), 'CRM.example.org, *.hooks.example.net')
    await submit($('#webhook-domains')!.closest('form'))
    await flush()
    expect(setWebhookDomains).toHaveBeenCalledWith(['crm.example.org', '*.hooks.example.net'])
    expect(text()).toContain('Domaines enregistrés (2).')
  })

  it('shows the log of a subscription, what each delivery came to, and replays one (step 10a)', async () => {
    const delivery: WebhookDelivery = { id: `dlv_${'1'.repeat(32)}`, eventId: `evt_${'2'.repeat(32)}`, eventType: 'call.missed', status: 'failed', attempts: 9, createdAt: '2026-10-16T08:00:00.000Z', lastStatus: 503, lastError: 'http' }
    const listWebhookDeliveries = vi.fn(async () => ({ items: [delivery, { ...delivery, id: `dlv_${'3'.repeat(32)}`, status: 'failed' as const, lastStatus: undefined, lastError: 'destination-refused', attempts: 1 }] }))
    const replayWebhookDelivery = vi.fn(async () => ({ ...delivery, status: 'pending', attempts: 0 }))
    admin(webhooksClient({ listWebhookDeliveries, replayWebhookDelivery }))
    await render('/admin/webhooks', <Webhooks />)
    click(host.querySelector('[aria-label="Journal des envois à https://crm.example.org/in"]'))
    await flush()
    expect(listWebhookDeliveries).toHaveBeenCalledWith('wh_00000000000000a1', { limit: 20 })
    expect(document.activeElement?.id).toBe('webhook-log')
    expect(text()).toContain('réponse 503')
    expect(text()).toContain('adresse du réseau interne refusée')
    click(button(host, 'Renvoyer'))
    await flush()
    expect(replayWebhookDelivery).toHaveBeenCalledWith('wh_00000000000000a1', delivery.id)
    expect(text()).toContain('Envoi relancé')
  })

  it('asks before a new secret, says how long the old one still signs, and what the Gateway did of a failing subscriber (review 10a)', async () => {
    const renewWebhookSecret = vi.fn(async () => ({ secret: 'whsec_renewed', previousSecretUntil: '2026-10-17T08:00:00.000Z' }))
    const testWebhook = vi.fn(async () => {
      throw refused(409, 'WEBHOOK_DISABLED', 'This subscription is disabled: enable it first')
    })
    const items: WebhookSubscription[] = [
      hook,
      { ...hook, id: 'wh_00000000000000a3', url: 'https://crm.example.org/paused', failures: 6, pausedUntil: '2026-10-16T09:00:00.000Z' },
      { ...hook, id: 'wh_00000000000000a4', url: 'https://crm.example.org/off', enabled: false, disabledReason: 'failing', failures: 40 }
    ]
    admin(webhooksClient({ renewWebhookSecret, testWebhook, listWebhooks: vi.fn(async () => ({ items })) }))
    await render('/admin/webhooks', <Webhooks />)
    expect(text()).toContain('en pause jusqu')
    expect(text()).toContain('échecs de suite : 6')
    expect(text()).toContain("désactivé après une journée d'échecs")
    click(host.querySelector('[aria-label="Nouveau secret pour https://crm.example.org/in"]'))
    expect(renewWebhookSecret).not.toHaveBeenCalled()
    expect(text()).toContain('Remplacer le secret de https://crm.example.org/in ?')
    click(button(host, 'Générer le nouveau secret'))
    await flush()
    expect(renewWebhookSecret).toHaveBeenCalledWith('wh_00000000000000a1')
    expect(($('#webhook-secret-value') as HTMLInputElement).value).toBe('whsec_renewed')
    expect(text()).toContain("L'ancien secret signe aussi les envois jusqu'au 17/10/2026")
    click(host.querySelector('[aria-label="Tester l\'abonnement https://crm.example.org/in"]'))
    await flush()
    expect(text()).toContain('Cet abonnement est désactivé : réactivez-le d')
  })

  it("names each button by what it shows first, in the list and the log, in French and in English (WCAG 2.5.3, review 10a, second, n°5)", async () => {
    const delivery: WebhookDelivery = { id: `dlv_${'1'.repeat(32)}`, eventId: `evt_${'2'.repeat(32)}`, eventType: 'call.missed', status: 'failed', attempts: 9, createdAt: '2026-10-16T08:00:00.000Z', lastStatus: 503, lastError: 'http' }
    const items: WebhookSubscription[] = [hook, { ...hook, id: 'wh_00000000000000a3', url: 'https://crm.example.org/paused', failures: 6, pausedUntil: '2026-10-16T09:00:00.000Z' }]
    admin(webhooksClient({ listWebhooks: vi.fn(async () => ({ items })), listWebhookDeliveries: vi.fn(async () => ({ items: [delivery] })) }))
    await render(
      '/admin/webhooks',
      <>
        <LangSwitch />
        <Webhooks />
      </>
    )
    // The name of a button holds what it shows, at its start (WCAG 2.5.3, RGAA 6.1 for the links).
    const check = (min: number) => {
      const buttons = [...host.querySelectorAll('.admin-list button, #webhook-log-section table button, table button')]
      expect(buttons.length).toBeGreaterThanOrEqual(min)
      for (const b of buttons) {
        const label = b.getAttribute('aria-label')
        if (label) expect(label.startsWith(b.textContent ?? ''), `${label} / ${b.textContent}`).toBe(true)
      }
    }
    click(host.querySelector('[aria-label="Journal des envois à https://crm.example.org/in"]'))
    await flush()
    expect(host.querySelector('table button')?.getAttribute('aria-label')).toMatch(/^Renvoyer : l'événement Appel manqué du 16\/10\/2026/)
    check(12)
    click(button(host, 'English'))
    await flush()
    expect(host.querySelector('table button')?.textContent).toBe('Send again')
    expect(host.querySelector('table button')?.getAttribute('aria-label')).toMatch(/^Send again: Missed call of /)
    check(12)
  })

  it('resumes a paused subscription, revokes a secret at once, says what was dropped and refuses a port (review 10a, second)', async () => {
    const resumeWebhook = vi.fn(async () => ({ ...hook }))
    const renewWebhookSecret = vi.fn(async () => ({ secret: 'whsec_revoked' }))
    const createWebhook = vi.fn(async () => {
      throw refused(400, 'WEBHOOK_URL_PORT', 'url: port 8080 is not allowed (443, 80)')
    })
    const paused = { ...hook, id: 'wh_00000000000000a3', url: 'https://crm.example.org/paused', failures: 6, pausedUntil: '2026-10-16T09:00:00.000Z', backlog: 12, backlogAt: '2026-10-16T08:30:00.000Z' }
    admin(webhooksClient({ resumeWebhook, renewWebhookSecret, createWebhook, listWebhooks: vi.fn(async () => ({ items: [hook, paused] })) }))
    await render('/admin/webhooks', <Webhooks />)
    expect(text()).toContain('12 événements écartés (trop en attente), le dernier le 16/10/2026')
    // Resume only where something holds it back.
    expect(host.querySelector('[aria-label="Reprendre https://crm.example.org/in"]')).toBeNull()
    click(host.querySelector('[aria-label="Reprendre https://crm.example.org/paused"]'))
    await flush()
    expect(resumeWebhook).toHaveBeenCalledWith('wh_00000000000000a3')
    expect(text()).toContain('https://crm.example.org/paused repris')
    click(host.querySelector('[aria-label="Révoquer le secret de https://crm.example.org/in"]'))
    expect(text()).toContain("arrêter l'ancien tout de suite")
    click(button(host, 'Révoquer et générer un nouveau secret'))
    await flush()
    expect(renewWebhookSecret).toHaveBeenCalledWith('wh_00000000000000a1', { revoke: true })
    expect(($('#webhook-secret-value') as HTMLInputElement).value).toBe('whsec_revoked')
    expect(text()).not.toContain("L'ancien secret signe aussi")
    click(button(host, "J'ai copié le secret"))
    type($('#webhook-url'), 'https://crm.example.org:8080/in')
    await submit($('#webhook-url')!.closest('form'))
    await flush()
    expect($('#webhook-url-error')?.textContent).toContain("Ce port n'est pas autorisé")
  })

  it('says webhooks are not available on a platform without SECRETS_KEY (step 10a)', async () => {
    const no = async () => {
      throw refused(501, '', 'Webhooks are not available on this platform (SECRETS_KEY is not set)')
    }
    admin(webhooksClient({ getWebhookDomains: vi.fn(no), listWebhooks: vi.fn(no) }))
    await render('/admin/webhooks', <Webhooks />)
    expect(text()).toContain('Les webhooks ne sont pas disponibles sur cette plateforme')
  })
})
