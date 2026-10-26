import { describe, expect, it } from 'vitest'
import { MODE_KEY, forgetSystemMode } from './colorMode.js'

const store = (value: string | null) => {
  const map = new Map<string, string>(value === null ? [] : [[MODE_KEY, value]])
  return { map, storage: { getItem: (k: string) => map.get(k) ?? null, removeItem: (k: string) => void map.delete(k) } }
}

describe('forgetSystemMode', () => {
  it('drops the `system` mode an earlier version stored, so the app opens light', () => {
    const { map, storage } = store('system')
    forgetSystemMode(storage)
    expect(map.has(MODE_KEY)).toBe(false)
  })

  it('keeps an explicit choice, and copes with no or refused storage', () => {
    for (const mode of ['light', 'dark']) {
      const { map, storage } = store(mode)
      forgetSystemMode(storage)
      expect(map.get(MODE_KEY)).toBe(mode)
    }
        expect(() =>
      forgetSystemMode({
        getItem: () => {
          throw new Error('SecurityError')
        },
        removeItem: () => undefined
      })
    ).not.toThrow()
  })
})
