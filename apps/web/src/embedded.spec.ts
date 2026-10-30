import { describe, expect, it } from 'vitest'
import { DIAL_MESSAGE, dialPathOf, isFramed } from './embedded.js'

describe('dialPathOf', () => {
  const parent = {}

  it('turns a number posted by the parent into the ?dial= path, encoded', () => {
    expect(dialPathOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: '+33 6 12' } }, parent)).toBe('/?dial=%2B33%206%2012')
  })

  it('ignores another sender, another type, a number that is not text, empty or too long', () => {
    expect(dialPathOf({ source: {} as MessageEventSource, data: { type: DIAL_MESSAGE, number: '102' } }, parent)).toBeNull()
    expect(dialPathOf({ source: parent as MessageEventSource, data: { type: 'other', number: '102' } }, parent)).toBeNull()
    expect(dialPathOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: 102 } }, parent)).toBeNull()
    expect(dialPathOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: '' } }, parent)).toBeNull()
    expect(dialPathOf({ source: parent as MessageEventSource, data: { type: DIAL_MESSAGE, number: '1'.repeat(41) } }, parent)).toBeNull()
    expect(dialPathOf({ source: parent as MessageEventSource, data: null }, parent)).toBeNull()
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
