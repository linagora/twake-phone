// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryItem } from '@twake/telephony-client'
import type { useGateway } from '../gateway.js'
import type { usePhone } from '../softphone.js'
import { Recents } from './Recents.js'

type Gateway = ReturnType<typeof useGateway>
let gateway: Pick<Gateway, 'client' | 'me' | 'onEvent' | 'onConnected'>
let phone: Pick<ReturnType<typeof usePhone>, 'state' | 'calls' | 'call'>
const navigate = vi.fn()
vi.mock('../gateway.js', () => ({ useGateway: () => gateway }))
vi.mock('../softphone.js', () => ({ usePhone: () => phone }))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
const i18n = { lang: 'fr', t: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${Object.values(vars).join(' | ')}` : key) }
vi.mock('../i18n/useT.js', () => ({ useT: () => i18n }))

const item = (id: string, remoteNumber: string, extra: Partial<HistoryItem> = {}): HistoryItem =>
  ({ id, remoteNumber, direction: 'outbound', startedAt: '2026-10-18T02:12:07.000Z', ...extra }) as HistoryItem

describe('the Récents page: calling back', () => {
  let root: Root
  let host: HTMLDivElement
  let actEnvironment: unknown
  const call = vi.fn(async (_target: string) => undefined)
  const buttons = () => [...host.querySelectorAll('li button')] as HTMLButtonElement[]

  const render = async (items: HistoryItem[]) => {
    gateway = {
      client: { getHistory: async () => ({ items }) } as unknown as Gateway['client'],
      me: { extension: '102' } as Gateway['me'],
      onEvent: () => () => undefined,
      onConnected: listener => {
        void Promise.resolve().then(listener)
        return () => undefined
      }
    }
    await act(async () => root.render(<Recents />))
    await act(() => vi.advanceTimersByTimeAsync(0))
  }

  beforeEach(() => {
    actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    call.mockReset()
    navigate.mockReset()
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

  it('offers « Rappeler » on each call but a hidden number and one\'s own conference, named by who and when', async () => {
    await render([item('a', '101'), item('b', 'anonymous', { direction: 'inbound' }), item('c', '102', { conference: true }), item('d', '103', { conference: true })])
    expect(buttons().map(b => b.getAttribute('aria-label')?.split(' | ')[0])).toEqual(['recents.callBackWho 101', 'recents.callBackWho 103'])
  })

  it('calls from the browser when the softphone is registered and free', async () => {
    await render([item('a', '101')])
    await act(async () => buttons()[0]!.click())
    expect(call).toHaveBeenCalledWith('101')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('fills the dialer in when the softphone cannot call, or is in a call', async () => {
    phone = { state: 'registered', calls: [{}], call } as unknown as typeof phone
    await render([item('a', '101')])
    await act(async () => buttons()[0]!.click())
    expect(call).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/?number=101')
  })

  it('says why the call failed', async () => {
    call.mockRejectedValueOnce(new Error('boom'))
    await render([item('a', '101')])
    await act(async () => buttons()[0]!.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('dialer.failed')
  })
})
