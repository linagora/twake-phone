import { describe, expect, it } from 'vitest'
import { LIGHT_SCHEME_KEY, MODE_KEY, forgetStoredMode } from './colorMode.js'

const store = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries))
  return { map, storage: { getItem: (k: string) => map.get(k) ?? null, removeItem: (k: string) => void map.delete(k) } }
}

describe('forgetStoredMode', () => {
  it('drops a stored `system` or `dark` mode and a dark scheme for the light mode: the app has no theme setting, it opens light', () => {
    for (const mode of ['system', 'dark']) {
      const { map, storage } = store({ [MODE_KEY]: mode, [LIGHT_SCHEME_KEY]: 'dark' })
      forgetStoredMode(storage)
      expect([...map.keys()]).toEqual([])
    }
  })

  it('keeps light as it is, and copes with refused storage', () => {
    const { map, storage } = store({ [MODE_KEY]: 'light', [LIGHT_SCHEME_KEY]: 'light' })
    forgetStoredMode(storage)
    expect(map.size).toBe(2)
    expect(() =>
      forgetStoredMode({
        getItem: () => {
          throw new Error('SecurityError')
        },
        removeItem: () => undefined
      })
    ).not.toThrow()
  })
})
