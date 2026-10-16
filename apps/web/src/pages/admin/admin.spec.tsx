// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminAlert, DidRange, OutboundSettings, Trunk } from '@twake/telephony-client'
import type { useGateway } from '../../gateway.js'
import { I18nProvider, useT } from '../../i18n/useT.js'
import { Admin } from './Admin.js'
import { ALERTS_REFRESH_MS, Alerts } from './Alerts.js'
import { Limits } from './Limits.js'
import { Numbers } from './Numbers.js'
import { Rights } from './Rights.js'
import { RingGroups } from './RingGroups.js'
import { STATUS_POLL_MS, Trunks } from './Trunks.js'

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
    expect(links.map(a => a.textContent)).toEqual(['Comptes', 'Trunks', 'Numéros directs', "Groupes d'appel", "Droits d'appel", 'Plafonds et seuils', 'Alertes'])
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
    expect(setUserProfile).toHaveBeenCalledWith('alice', 'national')
    // The page shows the setting that assignment made: Bob has no profile any more, and it says the setting changed.
    expect(ofBob().value).toBe('')
    expect(text()).toContain('Profil de Alice enregistré. Un autre administrateur avait modifié ces réglages entre-temps')
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

  it('refuses a profile too many before sending (review 7 n°14)', async () => {
    const setOutbound = vi.fn()
    admin({ getOutbound: vi.fn(async () => outbound({ profiles: Array.from({ length: 32 }, (_, i) => ({ id: `p${i}`, allowed: [] })) })), setOutbound })
    await render('/admin/rights', <Rights />)
    type($('#profile-id'), 'one-more')
    await submit($('#profile-id')!.closest('form'))
    expect(setOutbound).not.toHaveBeenCalled()
    expect(text()).toContain('32 profils au plus')
  })

  it('sends the caps with the version read; changed meanwhile, keeps what was typed and names what changed (review 7 n°1; review 7 bis n°6)', async () => {
    const getOutbound = vi.fn(async () => outbound({ policy: { caps: { concurrent: 5 } } }))
    const setOutbound = vi.fn(async (): Promise<OutboundSettings> => {
      throw refused(409, 'OUTBOUND_STALE', 'the outbound setting changed since it was read')
    })
    admin({ getOutbound, setOutbound })
    await render('/admin/limits', <Limits />)
    expect(($('#limits-tenant-concurrent') as HTMLInputElement).value).toBe('5')
    getOutbound.mockResolvedValueOnce(outbound({ version: 'v2', policy: { caps: { concurrent: 3 } }, assignments: [{ userId: 'alice', profileId: 'national' }] }))
    type($('#limits-tenant-concurrent'), '7')
    await submit($('form'))
    await flush()
    expect(setOutbound).toHaveBeenCalledWith({ policy: { caps: { concurrent: 7 } }, profiles: outbound().profiles, assignments: [], version: 'v1' })
    const said = $('[role="alert"]')?.textContent
    expect(said).toContain('Un autre administrateur a modifié ces réglages')
    // What the other administrator changed is named, nothing else.
    expect(said).toContain("il a changé : Plafonds de l'organisation : Appels simultanés.")
    expect(said).not.toContain('Minutes par jour')
    // What was typed stays; saved again, it goes with the version now read, and what was changed elsewhere stays.
    expect(($('#limits-tenant-concurrent') as HTMLInputElement).value).toBe('7')
    setOutbound.mockResolvedValueOnce(outbound({ version: 'v3', policy: { caps: { concurrent: 7 } }, assignments: [{ userId: 'alice', profileId: 'national' }] }))
    await submit($('form'))
    expect(setOutbound).toHaveBeenLastCalledWith({ policy: { caps: { concurrent: 7 } }, profiles: outbound().profiles, assignments: [{ userId: 'alice', profileId: 'national' }], version: 'v2' })
    // Changed meanwhile elsewhere only (who has which profile): said so, what was typed kept.
    setOutbound.mockRejectedValueOnce(refused(409, 'OUTBOUND_STALE', 'the outbound setting changed since it was read'))
    getOutbound.mockResolvedValueOnce(outbound({ version: 'v4', policy: { caps: { concurrent: 7 } }, assignments: [] }))
    type($('#limits-tenant-concurrent'), '8')
    await submit($('form'))
    await flush()
    expect($('[role="alert"]')?.textContent).toContain('pas les plafonds ni les seuils')
    expect(($('#limits-tenant-concurrent') as HTMLInputElement).value).toBe('8')
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
})
