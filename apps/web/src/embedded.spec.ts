import { describe, expect, it } from 'vitest'
import type { SoftCall } from '@twake/softphone'
import { COMMAND_MESSAGE, DIAL_MESSAGE, commandOf, dialRequestOf, isFramed, summaryOf } from './embedded.js'

describe('dialRequestOf', () => {
  const parent = {}

  it('turns a number posted by the parent into the ?dial= path, encoded, with the id to answer', () => {
    expect(dialRequestOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: '+33 6 12', id: 'r1' } }, parent)).toEqual({ path: '/?dial=%2B33%206%2012', id: 'r1' })
  })

  it('ignores another sender, another type, a number that is not text, empty or too long', () => {
    expect(dialRequestOf({ source: {} as MessageEventSource, data: { type: DIAL_MESSAGE, number: '102', id: 'r' } }, parent)).toBeNull()
    expect(dialRequestOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: '102' } }, parent)).toBeNull()
    expect(dialRequestOf({ source: parent as MessageEventSource, data: { type: 'other', number: '102' } }, parent)).toBeNull()
    expect(dialRequestOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: 102 } }, parent)).toBeNull()
    expect(dialRequestOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: '' } }, parent)).toBeNull()
    expect(dialRequestOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: '1'.repeat(41) } }, parent)).toBeNull()
    expect(dialRequestOf({ source: parent as MessageEventSource, data: null }, parent)).toBeNull()
  })
})

describe('isFramed', () => {
  it('says whether the window is its own top, and framed when the top cannot be read', () => {
    const top = {} as Window
    expect(isFramed({ self: top, top } as unknown as Window)).toBe(false)
    expect(isFramed({ self: {}, top } as unknown as Window)).toBe(true)
    const guarded = Object.defineProperty({ self: {} }, 'top', { get: () => { throw new Error('cross-origin') } })
    expect(isFramed(guarded as unknown as Window)).toBe(true)
  })
})

describe('the calls the frame tells its parent (ADR 0034)', () => {
  const call = (c: Partial<SoftCall>) => ({ id: 'c1', direction: 'inbound', state: 'ringing', remoteNumber: '+33612345678', remoteName: '', ...c }) as SoftCall

  it('says the calls under way, by id, number and name, and nothing of an ended one or a hidden name', () => {
    expect(summaryOf([call({ remoteName: 'Camille' }), call({ id: 'c2', state: 'ended' }), call({ id: 'c3', direction: 'outbound', state: 'connected', remoteName: 'anonymous' })])).toEqual([
      { id: 'c1', direction: 'inbound', state: 'ringing', remoteNumber: '+33612345678', remoteName: 'Camille' },
      { id: 'c3', direction: 'outbound', state: 'connected', remoteNumber: '+33612345678' }
    ])
  })

  it('takes an order from the parent, at its origin, among answer, reject and hangup only', () => {
    const parent = {}
    const origin = 'https://alice-phone.example.org'
    const ok = { source: parent as MessageEventSource, origin, data: { type: COMMAND_MESSAGE, callId: 'c1', action: 'hangup' } }
    expect(commandOf(ok, parent, origin)).toEqual({ callId: 'c1', action: 'hangup' })
    expect(commandOf({ ...ok, source: {} as MessageEventSource }, parent, origin)).toBeNull()
    expect(commandOf({ ...ok, origin: 'https://evil.example' }, parent, origin)).toBeNull()
    expect(commandOf({ ...ok, data: { ...ok.data, action: 'transfer' } }, parent, origin)).toBeNull()
    expect(commandOf({ ...ok, data: { ...ok.data, callId: 1 } }, parent, origin)).toBeNull()
    expect(commandOf({ ...ok, data: { ...ok.data, type: 'other' } }, parent, origin)).toBeNull()
  })
})
