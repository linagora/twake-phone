// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminAlert, DidRange, OutboundSettings, Trunk, WebhookDelivery, WebhookSubscription } from '@twake/telephony-client'
import type { useGateway } from '../../gateway.js'
import { I18nProvider, useT } from '../../i18n/useT.js'
import { Admin } from './Admin.js'
import { ALERTS_REFRESH_MS, Alerts } from './Alerts.js'
import { Limits } from './Limits.js'
import { Numbers } from './Numbers.js'
import { Rights } from './Rights.js'
import { RingGroups } from './RingGroups.js'
import { STATUS_POLL_MS, Trunks } from './Trunks.js'
import { Webhooks } from './Webhooks.js'

type Gateway = ReturnType<typeof useGateway>
let gateway: Pick<Gateway, 'client' | 'me' | 'meError'>
vi.mock('../../gateway.js', () => ({ useGateway: () => gateway }))

const refused = (status: number, code: string, detail: string) => Object.assign(new Error(detail), { status, code, detail })
const flush = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))

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
    listTrunks: vi.fn(async () => ({ items: [trunk] })),
    getTrunkStatus: vi.fn(async () => ({ available: true, items: [{ id: 'operator', registration: { state: 'registered' }, servers: [{ address: 'sip.operator.example', state: 'up' }] }] })),
    setTrunk: vi.fn(),
    deleteTrunk: vi.fn(),
    listDids: vi.fn(async () => ({ items: [] as DidRange[] })),
    setDid: vi.fn(),
    deleteDid: vi.fn(),
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
    expect(links.map(a => a.textContent)).toEqual(['Comptes', 'Trunks', 'Numéros directs', "Groupes d'appel", "Droits d'appel", 'Plafonds et seuils', 'Alertes', 'Webhooks'])
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

  it('puts the focus back on the delete button when told no or Escape, and on what is said once deleted (review 7 n°3)', async () => {
    const deleteTrunk = vi.fn(async () => undefined)
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
    // RGAA 2.5.3: each button's name starts with what it shows.
    const buttons = [...host.querySelectorAll('.admin-list button')]
    expect(buttons.length).toBeGreaterThan(10)
    for (const b of buttons) {
      const label = b.getAttribute('aria-label')
      if (label) expect(label.startsWith(b.textContent ?? ''), `${label} / ${b.textContent}`).toBe(true)
    }
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

  it('says webhooks are not available on a platform without SECRETS_KEY (step 10a)', async () => {
    const no = async () => {
      throw refused(501, '', 'Webhooks are not available on this platform (SECRETS_KEY is not set)')
    }
    admin(webhooksClient({ getWebhookDomains: vi.fn(no), listWebhooks: vi.fn(no) }))
    await render('/admin/webhooks', <Webhooks />)
    expect(text()).toContain('Les webhooks ne sont pas disponibles sur cette plateforme')
  })
})
