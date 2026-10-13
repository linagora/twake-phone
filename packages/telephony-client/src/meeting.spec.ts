import { describe, expect, it } from 'vitest'
import { parseMeetingId } from './index.js'

describe('parseMeetingId', () => {
  it('accepts a bare code or a Meet link', () => {
    expect(parseMeetingId('abc-defg-hij')).toBe('abc-defg-hij')
    expect(parseMeetingId(' https://meet.twake.local/abc-defg-hij?x=1 ')).toBe('abc-defg-hij')
    expect(parseMeetingId('https://meet.twake.local/abc-defg-hij/')).toBe('abc-defg-hij')
  })
  it('rejects anything else', () => {
    for (const bad of ['', '  ', 'a', 'has space', '../etc', 'https://meet.twake.local/']) expect(parseMeetingId(bad), bad).toBeNull()
  })
})
