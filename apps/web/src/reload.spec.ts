import { afterEach, describe, expect, it, vi } from 'vitest'
import { Reloader } from './reload.js'

describe('Reloader', () => {
  afterEach(() => vi.useRealTimers())

  it('retries an outage with a growing backoff, tries at once when asked meanwhile, and gives up on a refusal', async () => {
    vi.useFakeTimers()
    const asked: { resolve: (v: number) => void; reject: (e: Error) => void }[] = []
    const got: number[] = []
    const errors: unknown[] = []
    const r = new Reloader(
      () => new Promise<number>((resolve, reject) => asked.push({ resolve, reject })),
      v => got.push(v),
      e => errors.push(e),
      attempt => 1_000 * 2 ** attempt
    )
    r.request()
    asked[0]!.reject(new Error('Gateway 503'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(asked).toHaveLength(2)
    asked[1]!.reject(new TypeError('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(asked).toHaveLength(2)
    // The stream is established again meanwhile: no need to wait out the backoff.
    r.request()
    expect(asked).toHaveLength(3)
    asked[2]!.resolve(7)
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toEqual([7])
    // The retry that was due is not run on top.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(asked).toHaveLength(3)
    r.request()
    asked[3]!.reject(Object.assign(new Error('Gateway 401'), { status: 401 }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked).toHaveLength(4)
    expect(errors).toHaveLength(3)
    r.stop()
    r.request()
    expect(asked).toHaveLength(4)
  })
})
