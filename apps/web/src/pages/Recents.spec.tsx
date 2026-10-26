// @vitest-environment jsdom
import { AlertProvider } from '@linagora/twake-mui'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact, HistoryItem } from '@twake/telephony-client'
import { forgetContactsByNumber } from '../contactsByNumber.js'
import type { useGateway } from '../gateway.js'
import type { usePhone } from '../softphone.js'
import { byDay, dayLabel, Recents } from './Recents.js'

type Gateway = ReturnType<typeof useGateway>
let gateway: Pick<Gateway, 'client' | 'me' | 'onEvent' | 'onConnected'>
let phone: Pick<ReturnType<typeof usePhone>, 'state' | 'calls' | 'call'>
const navigate = vi.fn()
vi.mock('../gateway.js', () => ({ useGateway: () => gateway }))
vi.mock('../softphone.js', () => ({ usePhone: () => phone }))
vi.mock('react-router-dom', async () => ({ ...(await vi.importActual('react-router-dom')), useNavigate: () => navigate }))
const i18n = { lang: 'fr', t: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${Object.values(vars).join(' | ')}` : key) }
vi.mock('../i18n/useT.js', () => ({ useT: () => i18n }))

const now = new Date('2026-10-26T15:00:00')
const item = (id: string, remoteNumber: string, extra: Partial<HistoryItem> = {}): HistoryItem =>
  ({ id, remoteNumber, direction: 'outbound', startedAt: '2026-10-26T14:12:07', ...extra }) as HistoryItem
const jean: Contact = { id: 'jdupont', displayName: 'Jean Dupont', numbers: [{ type: 'extension', number: '102' }] }

describe('the days of the Récents', () => {
  const t = (k: string) => k
  it('says today, yesterday, then the date', () => {
    expect(dayLabel('2026-10-26T08:00:00', now, 'fr', t)).toBe('recents.today')
    expect(dayLabel('2026-10-25T23:59:00', now, 'fr', t)).toBe('recents.yesterday')
    expect(dayLabel('2026-10-20T10:00:00', now, 'fr', t)).toMatch(/20 octobre 2026/)
    // A call a few seconds ahead of this clock is today; a time in UTC is placed in the local day.
    expect(dayLabel('2026-10-26T15:00:30', now, 'fr', t)).toBe('recents.today')
    const lateUtc = new Date(Date.UTC(2026, 9, 25, 23, 30))
    expect(dayLabel(lateUtc.toISOString(), now, 'fr', t)).toBe(lateUtc.getDate() === 26 ? 'recents.today' : 'recents.yesterday')
  })
  it('keeps the order and puts the calls of a day together', () => {
    const items = [{ startedAt: 'a1' }, { startedAt: 'a2' }, { startedAt: 'b1' }]
    expect(byDay(items, iso => iso[0]!).map(g => [g.label, g.items.length])).toEqual([
      ['a', 2],
      ['b', 1]
    ])
  })
})

describe('the Récents page', () => {
  let root: Root
  let host: HTMLDivElement
  let actEnvironment: unknown
  const call = vi.fn(async (_target: string) => undefined)
  const searchDirectory = vi.fn(async (q: string) => ({ items: q === '102' ? [jean] : [], truncated: false }))
  const rows = () => [...host.querySelectorAll('[data-testid="recents"] [role="button"]')] as HTMLElement[]
  const button = (name: RegExp) => [...host.querySelectorAll('button')].find(b => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))

  const render = async (items: HistoryItem[]) => {
    gateway = {
      client: { getHistory: async () => ({ items }), searchDirectory } as unknown as Gateway['client'],
      me: { extension: '101' } as Gateway['me'],
      onEvent: () => () => undefined,
      onConnected: listener => {
        void Promise.resolve().then(listener)
        return () => undefined
      }
    }
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AlertProvider>
            <Recents />
          </AlertProvider>
        </MemoryRouter>
      )
    )
    await act(() => vi.advanceTimersByTimeAsync(0))
  }

  beforeEach(() => {
    actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({ now, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    forgetContactsByNumber()
    call.mockReset()
    navigate.mockReset()
    searchDirectory.mockClear()
    phone = { state: 'registered', calls: [], call } as unknown as typeof phone
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = actEnvironment
  })

  it('makes each row call back, but a hidden number and one\'s own conference, named by who, what and when', async () => {
    await render([item('a', '103'), item('b', 'anonymous', { direction: 'inbound' }), item('c', '101', { conference: true }), item('d', '104', { conference: true })])
    expect(rows().map(r => r.getAttribute('aria-label')?.split(' | ').slice(0, 2).join(' | '))).toEqual(['recents.callBack 103 | recents.outbound', 'recents.callBack 104 | recents.conference'])
    // Nothing to copy of a hidden number or of one's own conference.
    expect([...host.querySelectorAll('button')].filter(b => b.getAttribute('aria-label')?.startsWith('actions.copyNumberWhen')).map(b => b.getAttribute('aria-label')?.split(' | ')[0])).toEqual([
      'actions.copyNumberWhen 103',
      'actions.copyNumberWhen 104'
    ])
  })

  it('calls from the browser when the softphone is registered and free, else fills the keypad in', async () => {
    await render([item('a', '103')])
    await act(async () => rows()[0]!.click())
    expect(call).toHaveBeenCalledWith('103')
    expect(navigate).not.toHaveBeenCalled()
    phone = { state: 'registered', calls: [{}], call } as unknown as typeof phone
    await render([item('a', '103')])
    await act(async () => rows()[0]!.click())
    expect(call).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/?number=103')
  })

  it('shows the name and the photo the directory has for a number, with a link to the card', async () => {
    await render([item('a', '102'), item('b', '103')])
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(host.querySelector('li strong')!.textContent).toBe('Jean Dupont')
    expect(host.querySelector('[data-testid="recent-number"]')!.textContent).toBe('102')
    expect(rows()[0]!.getAttribute('aria-label')).toMatch(/^recents\.callBack Jean Dupont \(102\) \| /)
    expect(host.querySelector('a[href="/directory/jdupont"]')!.getAttribute('aria-label')).toBe('actions.openCard Jean Dupont')
    // Each number asked once.
    expect(searchDirectory.mock.calls.map(c => c[0])).toEqual(['102', '103'])
  })

  it('groups the calls by day, and shows only the missed ones when asked', async () => {
    await render([item('a', '103'), item('b', '104', { missed: true, direction: 'inbound', startedAt: '2026-10-25T09:00:00' })])
    expect([...host.querySelectorAll('h2')].map(h => h.textContent)).toEqual(['recents.today', 'recents.yesterday'])
    await act(async () => button(/^recents\.missedFilter$/)!.click())
    expect([...host.querySelectorAll('[data-testid="recent-number"]')].map(n => n.textContent)).toEqual(['104'])
    expect([...host.querySelectorAll('h2')].map(h => h.textContent)).toEqual(['recents.yesterday'])
  })

  it('says when no call was missed', async () => {
    await render([item('a', '103')])
    await act(async () => button(/^recents\.missedFilter$/)!.click())
    expect(host.textContent).toContain('recents.noMissed')
  })
})
