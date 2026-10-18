// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelephonyEvent, Voicemail } from '@twake/telephony-types'
import type { useGateway } from '../gateway.js'
import type { usePhone } from '../softphone.js'
import { applyVoicemailEvent, clock, VoicemailPage } from './Voicemail.js'

const v = (id: string, receivedAt: string, unread = true): Voicemail => ({ id, from: '101', receivedAt, durationSec: 7, unread })
const at = '2026-10-18T02:12:07.000Z'

describe('the Messagerie vocale', () => {
  it('puts a new message first, once, and changes or removes one in place', () => {
    const items = [v('b', '2026-10-18T02:00:00.000Z'), v('a', '2026-10-18T01:00:00.000Z')]
    const created = applyVoicemailEvent(items, { type: 'voicemail.created', timestamp: at, payload: { voicemail: v('c', '2026-10-18T02:12:04.000Z') } })
    expect(created.map(i => i.id)).toEqual(['c', 'b', 'a'])
    // Told twice (the list read while the event was on its way): still once.
    expect(applyVoicemailEvent(created, { type: 'voicemail.created', timestamp: at, payload: { voicemail: v('c', '2026-10-18T02:12:04.000Z') } }).map(i => i.id)).toEqual(['c', 'b', 'a'])
    const read = applyVoicemailEvent(created, { type: 'voicemail.updated', timestamp: at, payload: { voicemail: v('b', '2026-10-18T02:00:00.000Z', false) } })
    expect(read.map(i => [i.id, i.unread])).toEqual([['c', true], ['b', false], ['a', true]])
    expect(applyVoicemailEvent(read, { type: 'voicemail.deleted', timestamp: at, payload: { id: 'b' } }).map(i => i.id)).toEqual(['c', 'a'])
    // Any other event changes nothing.
    expect(applyVoicemailEvent(items, { type: 'stream.ready' } as never)).toBe(items)
  })

  it('says how long a message lasts as a clock does', () => {
    expect([clock(0), clock(7), clock(75), clock(600)]).toEqual(['0:00', '0:07', '1:15', '10:00'])
  })
})

type Gateway = ReturnType<typeof useGateway>
let gateway: Pick<Gateway, 'client' | 'onEvent' | 'onConnected'>
let phone: Pick<ReturnType<typeof usePhone>, 'state' | 'calls' | 'call'>
vi.mock('../gateway.js', () => ({ useGateway: () => gateway }))
vi.mock('../softphone.js', () => ({ usePhone: () => phone }))
vi.mock('react-router-dom', () => ({ useNavigate: () => () => undefined }))
// One translator for every render: the key, then the values given.
const i18n = { lang: 'fr', t: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${Object.values(vars).join(' | ')}` : key) }
vi.mock('../i18n/useT.js', () => ({ useT: () => i18n }))

describe('the Messagerie vocale page (review 11a, n°19 and 25)', () => {
  let root: Root
  let host: HTMLDivElement
  let actEnvironment: unknown
  let send: (event: TelephonyEvent) => void
  let connected: () => void
  let lists: (Voicemail[] | Promise<Voicemail[]>)[]
  const listVoicemails = vi.fn(async () => {
    const next = lists.length > 1 ? lists.shift()! : lists[0]!
    return { items: [...(await next)] }
  })
  const getVoicemailAudio = vi.fn(async (_id: string) => new Blob(['RIFF']))
  const markVoicemailRead = vi.fn(async (_id: string) => undefined)
  const deleteVoicemail = vi.fn(async (_id: string) => undefined)
  let made: string[]
  let revoked: string[]

  const flush = () => act(() => vi.advanceTimersByTimeAsync(0))
  const status = () => host.querySelector('[data-testid="voicemail-status"]')!.textContent
  const ids = () => [...host.querySelectorAll('[data-testid="voicemail"]')].map(li => li.getAttribute('data-id'))
  const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)!
  const click = async (label: string) => {
    await act(async () => button(label).click())
    await flush()
  }
  const render = async () => {
    await act(async () => root.render(<VoicemailPage />))
    connected()
    await flush()
  }

  beforeEach(() => {
    actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    lists = [[]]
    made = []
    revoked = []
    listVoicemails.mockClear()
    const client: Partial<Gateway['client']> = { listVoicemails, getVoicemailAudio, markVoicemailRead, deleteVoicemail }
    gateway = {
      client: client as Gateway['client'],
      onEvent: listener => {
        send = event => act(() => listener(event))
        return () => undefined
      },
      onConnected: listener => {
        connected = () => act(() => listener())
        return () => undefined
      }
    }
    phone = { state: 'unregistered', calls: [], call: async () => undefined } as unknown as typeof phone
    vi.stubGlobal('URL', Object.assign(Object.create(URL) as typeof URL, { createObjectURL: () => `blob:m${made.push('x')}`, revokeObjectURL: (u: string) => void revoked.push(u) }))
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

  it('says the duration with its word, in a visually hidden text, the clock hidden from assistive tech', async () => {
    lists = [[v('a', at)]]
    await render()
    const badge = host.querySelector('[data-testid="voicemail"] .badge:not(.missed)')!
    expect(badge.querySelector('.sr-only')!.textContent).toBe('voicemail.durationLabel 0:07')
    expect(badge.querySelector('[aria-hidden="true"]')!.textContent).toBe('0:07')
    expect(badge.querySelector('[aria-label]')).toBeNull()
  })

  it('reads the list again when a message arrives during the first read, and shows it', async () => {
    let first!: (items: Voicemail[]) => void
    lists = [new Promise<Voicemail[]>(resolve => (first = resolve)), [v('b', '2026-10-18T02:13:00.000Z'), v('a', at)]]
    await render()
    send({ type: 'voicemail.created', timestamp: at, payload: { voicemail: v('b', '2026-10-18T02:13:00.000Z') } })
    first([v('a', at)])
    await flush()
    await flush()
    expect(listVoicemails).toHaveBeenCalledTimes(2)
    expect(ids()).toEqual(['b', 'a'])
  })

  it('tells each arrival with its time and the unread count, two from the same caller as two', async () => {
    await render()
    send({ type: 'voicemail.created', timestamp: at, payload: { voicemail: v('a', at) } })
    const once = status()
    expect(once).toMatch(/^voicemail\.arrived 101 \| \d{2}:\d{2} \| 1\s?$/)
    send({ type: 'voicemail.created', timestamp: at, payload: { voicemail: v('b', at) } })
    expect(status()).toMatch(/\| 2\s?$/)
    expect(status()).not.toBe(once)
  })

  it('lets the recording listened to before go when another is', async () => {
    lists = [[v('b', '2026-10-18T02:13:00.000Z'), v('a', at)]]
    await render()
    await click('voicemail.listenTo 101')
    expect(revoked).toEqual([])
    const listens = [...host.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === 'voicemail.listenTo 101')
    await act(async () => listens[1]!.click())
    await flush()
    expect(revoked).toEqual(['blob:m1'])
    act(() => root.unmount())
    expect(revoked).toEqual(['blob:m1', 'blob:m2'])
    root = createRoot(host)
  })

  it('gives the focus on: after « Marquer comme lu », its « Écouter »; after « Supprimer », the next message, the previous one, then the title; and tells what was done', async () => {
    lists = [[{ ...v('c', '2026-10-18T02:14:00.000Z'), from: '103' }, { ...v('b', '2026-10-18T02:13:00.000Z'), from: '102' }, v('a', at)]]
    await render()
    const listenOf = (id: string) => host.querySelector(`[data-id="${id}"] button`)
    await click('voicemail.markReadWho 102')
    expect(document.activeElement).toBe(listenOf('b'))
    expect(status()).toContain('voicemail.markedRead 102')
    await click('voicemail.deleteWho 102')
    expect(ids()).toEqual(['c', 'a'])
    expect(document.activeElement).toBe(listenOf('a'))
    expect(status()).toContain('voicemail.deleted 102')
    await click('voicemail.deleteWho 101')
    expect(document.activeElement).toBe(listenOf('c'))
    await click('voicemail.deleteWho 103')
    expect(ids()).toEqual([])
    expect(document.activeElement).toBe(host.querySelector('h1'))
    expect(status()).toContain('voicemail.deleted 103')
  })
})
