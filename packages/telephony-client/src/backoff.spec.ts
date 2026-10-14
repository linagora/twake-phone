import { describe, expect, it } from 'vitest'
import { backoffDelay } from './backoff.js'

describe('backoffDelay', () => {
  it('grows exponentially up to the cap', () => {
    const max = () => 0.999999
    expect(backoffDelay(0, 500, 30_000, max)).toBeLessThan(500)
    expect(backoffDelay(3, 500, 30_000, max)).toBeLessThan(4000)
    expect(backoffDelay(20, 500, 30_000, max)).toBeLessThan(30_000)
  })
})
