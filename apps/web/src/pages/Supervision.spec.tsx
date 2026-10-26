// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useGateway } from '../gateway.js'
import { CALLS_EVERY_MS, SupervisionPage } from './Supervision.js'

type Gateway = ReturnType<typeof useGateway>
let gateway: Pick<Gateway, 'client' | 'me' | 'meError'>
vi.mock('../gateway.js', () => ({ useGateway: () => gateway }))
// One translator for every render: the key, then the values given.
const i18n = { lang: 'fr', t: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${Object.values(vars).join(' | ')}` : key) }
vi.mock('../i18n/useT.js', () => ({ useT: () => i18n }))

const call = { id: '1792479546.12', extension: '103', peer: '0100', peerName: 'Standard', state: 'up' as const, startedAt: '2026-10-20T10:00:00.000Z', displayName: 'Bob Durand' }
const rec = (id: string, state: 'recording' | 'ready' | 'failed' | 'purged' = 'ready') => ({ id, extension: '103', displayName: 'Bob Durand', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:01:05.000Z', durationSec: 65, state, startedBy: 'amartin' })

describe('the supervision page', () => {
  let root: Root
  let host: HTMLDivElement
  let actEnvironment: unknown
  let calls: (typeof call & { recording?: { id: string; startedAt: string } })[]
  let recordings: ReturnType<typeof rec>[]
  const refused = (status: number, code?: string) => Object.assign(new Error(`Gateway ${status}`), { status, ...(code ? { code } : {}) })
  const client = {
    listSupervisedCalls: vi.fn(async () => ({ items: calls })),
    listRecordings: vi.fn(async () => ({ items: recordings })),
    getSupervisionLog: vi.fn(async () => ({ items: [{ at: '2026-10-20T10:00:00.000Z', actor: 'amartin', actorName: 'Alice Martin', action: 'record-start' as const, extension: '103' }, { at: '2026-10-20T09:00:00.000Z', actor: 'system', action: 'purge' as const }] })),
    startRecording: vi.fn(async (_id: string) => rec('r1', 'recording')),
    stopRecording: vi.fn(async (_id: string) => rec('r1')),
    superviseCall: vi.fn(async (_id: string, _mode: string) => ({ state: 'ringing' as const })),
    getRecordingAudio: vi.fn(async (_id: string) => new Blob(['RIFF'])),
    deleteRecording: vi.fn(async (_id: string) => undefined)
  }
  let made: string[]
  const flush = () => act(() => vi.advanceTimersByTimeAsync(0))
  const render = async (features: { supervision?: boolean; admin?: boolean } = { supervision: true }) => {
    gateway = { client: client as unknown as Gateway['client'], me: { id: 'amartin', displayName: 'Alice', features }, meError: null }
    await act(async () => root.render(<SupervisionPage />))
    await flush()
  }
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent ?? '').startsWith(name))
  const click = async (name: string) => {
    await act(async () => button(name)!.click())
    await flush()
  }
  const said = () => host.querySelector('[data-testid="supervision-status"]')!.textContent
  const problem = () => host.querySelector('[data-testid="supervision-problem"]')?.textContent

  beforeEach(() => {
    actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    calls = [call]
    recordings = [rec('r0')]
    made = []
    for (const f of Object.values(client)) f.mockClear()
    vi.stubGlobal('URL', Object.assign(Object.create(URL) as typeof URL, { createObjectURL: () => `blob:s${made.push('x')}`, revokeObjectURL: () => undefined }))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = actEnvironment
  })

  it('asks nothing of a person the Gateway does not call a supervisor, and says so', async () => {
    await render({ admin: false })
    expect(host.textContent).toContain('supervision.forbidden')
    expect(client.listSupervisedCalls).not.toHaveBeenCalled()
  })

  it('says the platform has none when it answers 501, and that it could not be read otherwise', async () => {
    client.listSupervisedCalls.mockRejectedValueOnce(refused(501))
    await render()
    expect(host.textContent).toContain('supervision.unavailable')
    client.listSupervisedCalls.mockRejectedValueOnce(new Error('network down'))
    await act(async () => root.unmount())
    root = createRoot(host)
    await render()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('supervision.error network down')
  })

  it('lists the calls in progress with the line, the other party and the actions named by the call, the recordings and the journal, and what the notice says', async () => {
    await render()
    const row = host.querySelector('[data-testid="supervision-call"]')!
    expect(row.querySelector('th')!.textContent).toBe('Bob Durand (103)')
    expect(row.textContent).toContain('Standard (01 00)')
    expect(row.textContent).toContain('supervision.stateUp')
    expect([...row.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))).toEqual([
      'supervision.recordFor Bob Durand (103)',
      'supervision.listenFor Bob Durand (103)',
      'supervision.whisperFor Bob Durand (103)',
      'supervision.bargeFor Bob Durand (103)'
    ])
    expect(host.textContent).toContain('supervision.notice')
    const log = [...host.querySelectorAll('[data-testid="supervision-log"] tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))
    expect(log[0]!.slice(1)).toEqual(['Alice Martin', 'supervision.action.record-start', '103'])
    expect(log[1]!.slice(1)).toEqual(['supervision.logSystem', 'supervision.action.purge', ''])
    expect(host.querySelector('[data-testid="supervision-recording"] .MuiListItemText-secondary')!.textContent).toContain('supervision.rec.ready · supervision.recDuration 1:05')
  })

  it('records a call, says so, then offers to stop it once the call is read again as recorded', async () => {
    await render()
    await click('supervision.recordFor')
    expect(client.startRecording).toHaveBeenCalledWith('1792479546.12')
    expect(said()).toContain('supervision.recordingStarted Bob Durand (103)')
    calls = [{ ...call, recording: { id: 'r1', startedAt: call.startedAt } }]
    await act(() => vi.advanceTimersByTimeAsync(CALLS_EVERY_MS))
    expect(host.querySelector('[data-testid="supervision-call"]')!.textContent).toContain('supervision.recordingOn')
    await click('supervision.stopFor')
    expect(client.stopRecording).toHaveBeenCalledWith('1792479546.12')
    expect(said()).toContain('supervision.recordingStopped')
  })

  it('puts the Gateway\'s refusal in words: the call is over, already recorded, the line does not answer', async () => {
    await render()
    for (const [code, key] of [['CALL_GONE', 'supervision.errGone'], ['RECORDING_UNDER_WAY', 'supervision.errUnderWay'], ['SUPERVISION_FAILED', 'supervision.errFailed'], ['SPY_REFUSED', 'supervision.errSpyRefused'], ['OWN_CALL', 'supervision.errOwn'], ['NO_EXTENSION', 'supervision.errNoExtension'], ['WHATEVER', 'supervision.errOther']] as const) {
      client.startRecording.mockRejectedValueOnce(refused(409, code))
      await click('supervision.recordFor')
      expect(problem(), code).toBe(key)
    }
    // The next action starts without the last refusal.
    await click('supervision.recordFor')
    expect(problem()).toBeUndefined()
  })

  it('calls the supervisor\'s line into the call in the mode asked, and says the phone is about to ring', async () => {
    await render()
    await click('supervision.whisperFor')
    expect(client.superviseCall).toHaveBeenCalledWith('1792479546.12', 'whisper')
    expect(said()).toContain('supervision.spyRinging Bob Durand (103)')
    client.superviseCall.mockResolvedValueOnce({ state: 'answered' as never })
    await click('supervision.bargeFor')
    expect(client.superviseCall).toHaveBeenLastCalledWith('1792479546.12', 'barge')
    expect(said()).toContain('supervision.spyAnswered')
    client.superviseCall.mockRejectedValueOnce(refused(409, 'SPY_REFUSED'))
    await click('supervision.listenFor')
    expect(problem()).toBe('supervision.errSpyRefused')
  })

  it('plays a recording that is ready, and gives the others no player', async () => {
    recordings = [rec('r0'), rec('r2', 'failed'), rec('r3', 'purged')]
    await render()
    expect(host.querySelectorAll('[data-testid="supervision-recording"] button')).toHaveLength(1)
    await click('supervision.playFor')
    expect(client.getRecordingAudio).toHaveBeenCalledWith('r0')
    const audio = host.querySelector('[data-testid="supervision-audio"]') as HTMLAudioElement
    expect(audio.getAttribute('src')).toBe('blob:s1')
    expect(audio.getAttribute('aria-label')).toMatch(/^supervision\.player Bob Durand \(103\) \|/)
    client.getRecordingAudio.mockRejectedValueOnce(refused(502))
    await click('supervision.playFor')
    expect(problem()).toBe('supervision.audioFailed')
  })

  it('lets an administrator delete a recording after a confirmation, and a supervisor not', async () => {
    await render({ supervision: true })
    expect(button('supervision.deleteFor')).toBeUndefined()
    await act(async () => root.unmount())
    root = createRoot(host)
    await render({ supervision: true, admin: true })
    await click('supervision.deleteFor')
    expect(client.deleteRecording).not.toHaveBeenCalled()
    expect(host.textContent).toContain('supervision.confirmDelete')
    await click('supervision.keep')
    expect(button('supervision.deleteFor')).toBeDefined()
    await click('supervision.deleteFor')
    await click('supervision.confirm')
    expect(client.deleteRecording).toHaveBeenCalledWith('r0')
    expect(said()).toContain('supervision.deleted')
  })

  it('asks an action once when it is clicked twice, and says so to the buttons of that call', async () => {
    let finish: () => void = () => undefined
    client.startRecording.mockImplementationOnce(() => new Promise(resolve => (finish = () => resolve(rec('r1', 'recording')))))
    await render()
    await act(async () => button('supervision.recordFor')!.click())
    await act(async () => button('supervision.recordFor')!.click())
    expect(client.startRecording).toHaveBeenCalledTimes(1)
    expect(button('supervision.recordFor')!.getAttribute('aria-disabled')).toBe('true')
    expect(button('supervision.listenFor')!.getAttribute('aria-disabled')).toBe('true')
    await act(async () => finish())
    await flush()
    expect(button('supervision.recordFor')!.getAttribute('aria-disabled')).toBeNull()
  })

  it('moves the focus where the person is: the confirmation, then back to « Supprimer » if they keep the recording (or press Escape), the title once it is deleted', async () => {
    await render({ supervision: true, admin: true })
    const active = () => document.activeElement?.textContent
    await click('supervision.deleteFor')
    expect(active()).toBe('supervision.confirm')
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toMatch(/^supervision\.deleteFor/)
    await click('supervision.deleteFor')
    await click('supervision.keep')
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toMatch(/^supervision\.deleteFor/)
    await click('supervision.deleteFor')
    recordings = []
    await click('supervision.confirm')
    expect(document.activeElement).toBe(host.querySelector('h1'))
  })

  it('keeps the list it has and says it may be out of date when a reading fails, and asks nothing of a tab nobody looks at', async () => {
    await render()
    client.listSupervisedCalls.mockRejectedValueOnce(new Error('network down'))
    await act(() => vi.advanceTimersByTimeAsync(CALLS_EVERY_MS))
    expect(host.textContent).toContain('supervision.stale')
    expect(host.querySelector('[data-testid="supervision-call"]')).not.toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(CALLS_EVERY_MS))
    expect(host.textContent).not.toContain('supervision.stale')
    const reads = client.listSupervisedCalls.mock.calls.length
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      await act(() => vi.advanceTimersByTimeAsync(CALLS_EVERY_MS * 3))
      expect(client.listSupervisedCalls.mock.calls.length).toBe(reads)
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState
    }
  })

  it('reads the calls again every few seconds, and stops when the page goes', async () => {
    await render()
    expect(client.listSupervisedCalls).toHaveBeenCalledTimes(1)
    calls = []
    await act(() => vi.advanceTimersByTimeAsync(CALLS_EVERY_MS))
    expect(client.listSupervisedCalls).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('supervision.noCalls')
    await act(async () => root.unmount())
    await act(() => vi.advanceTimersByTimeAsync(CALLS_EVERY_MS * 3))
    expect(client.listSupervisedCalls).toHaveBeenCalledTimes(2)
    root = createRoot(host)
  })
})
