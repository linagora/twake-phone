// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestCall, type IntentsConstructor } from './index.js'

const client = { getStackClient: () => ({ uri: 'https://user1.twake.local' }), getInstanceOptions: () => ({ subdomain: 'flat' }) }

/** A fake cozy-interapp whose service answers with `answer` (or fails). */
const fakeIntents = (answer: unknown) => {
  const start = vi.fn(async (_el: HTMLElement) => {
    if (answer instanceof Error) throw answer
    return answer
  })
  const create = vi.fn((_action: string, _type: string, _data: object) => ({ start }))
  const Intents = class { create = create } as unknown as IntentsConstructor
  return { Intents, create, start }
}

const REGISTRY = Symbol.for('twake.phone.widget')

describe('requestCall in a page that has the widget', () => {
  const withWidget = (dial: (n: string) => Promise<{ handled: boolean }>) => {
    ;(window as unknown as Record<symbol, unknown>)[REGISTRY] = { dial }
  }
  afterEach(() => delete (window as unknown as Record<symbol, unknown>)[REGISTRY])

  it('talks to the widget and creates no intent', async () => {
    const dial = vi.fn(async () => ({ handled: true }))
    withWidget(dial)
    const { Intents, create } = fakeIntents({ handled: true })
    expect(await requestCall({ client, Intents, number: '06 12 34 56 78', openPhone: vi.fn() })).toEqual({ handled: true, via: 'widget' })
    expect(dial).toHaveBeenCalledWith('+33612345678')
    expect(create).not.toHaveBeenCalled()
  })

  it('opens the Phone app, still without a second intent, when the widget cannot dial', async () => {
    withWidget(async () => ({ handled: false }))
    const { Intents, create } = fakeIntents({ handled: true })
    const openPhone = vi.fn()
    expect(await requestCall({ client, Intents, number: '102', openPhone })).toEqual({ handled: true, via: 'app' })
    expect(create).not.toHaveBeenCalled()
    expect(openPhone).toHaveBeenCalled()
  })
})

describe('requestCall', () => {
  it('does not dial text that is not a phone number', async () => {
    const { Intents, create } = fakeIntents({ handled: true })
    const openPhone = vi.fn()
    expect(await requestCall({ client, Intents, number: 'ref-4821', openPhone })).toEqual({ handled: false, reason: 'invalid-number' })
    expect(await requestCall({ client, Intents, number: '0328001234x', openPhone })).toEqual({ handled: false, reason: 'invalid-number' })
    expect(create).not.toHaveBeenCalled()
    expect(openPhone).not.toHaveBeenCalled()
  })

  it('hands a normalised number to Phone through the CALL intent and stays where it is', async () => {
    const { Intents, create } = fakeIntents({ handled: true })
    const openPhone = vi.fn()
    expect(await requestCall({ client, Intents, number: '06 12 34 56 78', openPhone })).toEqual({ handled: true, via: 'phone' })
    expect(create).toHaveBeenCalledWith('CALL', 'io.twake.phone.number', { number: '+33612345678' })
    expect(openPhone).not.toHaveBeenCalled()
    expect(document.body.children).toHaveLength(0) // the relay iframe's container is gone
  })

  it('gives the intent an element that is attached to the page while it runs', async () => {
    const { Intents, start } = fakeIntents({ handled: true })
    start.mockImplementationOnce(async el => {
      expect(document.body.contains(el)).toBe(true)
      return { handled: true }
    })
    await requestCall({ client, Intents, number: '102', openPhone: vi.fn() })
  })

  it('opens the Phone app on the dialer (its frame at ?dial=) when no Phone window took the number', async () => {
    const { Intents } = fakeIntents({ handled: false })
    const openPhone = vi.fn()
    expect(await requestCall({ client, Intents, number: '102', openPhone })).toEqual({ handled: true, via: 'app' })
    expect(openPhone).toHaveBeenCalledWith(expect.stringContaining('#/bridge/?dial=102'))
  })

  it('falls back to the app when the intent itself fails (Phone not installed)', async () => {
    const { Intents } = fakeIntents(new Error('no service'))
    const openPhone = vi.fn()
    expect(await requestCall({ client, Intents, number: '+33612345678', openPhone })).toMatchObject({ handled: true, via: 'app' })
    expect(openPhone).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent('+33612345678')))
  })

  it('reports it when not even the app can be opened', async () => {
    const { Intents } = fakeIntents({ handled: false })
    const openPhone = vi.fn(() => { throw new Error('blocked') })
    expect(await requestCall({ client, Intents, number: '102', openPhone })).toEqual({ handled: false, reason: 'phone-unavailable' })
  })
})
