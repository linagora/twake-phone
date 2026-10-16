// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminAlert, DidRange, Trunk } from '@twake/telephony-client'
import type { useGateway } from '../../gateway.js'
import { I18nProvider } from '../../i18n/useT.js'
import { Admin } from './Admin.js'
import { Alerts } from './Alerts.js'
import { Numbers } from './Numbers.js'
import { Trunks } from './Trunks.js'

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
const submit = (form: Element | null) =>
  act(async () => {
    ;(form as HTMLFormElement).requestSubmit()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })

const trunk: Trunk = { id: 'operator', name: 'Opérateur', auth: 'register', domain: 'sip.operator.example', username: 'login', hasPassword: true, codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }

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
    expect(acknowledgeAlert).toHaveBeenCalledWith('7')
    expect(text()).toContain('Aucune alerte.')
    expect(text()).toContain('Alerte acquittée.')
  })
})
