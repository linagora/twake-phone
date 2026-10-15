import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Presence } from '@twake/telephony-types'
import { PresenceSync, type PresencePage, type PresenceState } from './presenceSync.js'

const p = (status: Presence['status']): Presence => ({ status, source: 'telephony' })
const page = (items: Record<string, Presence['status']>, realtime = true): PresencePage => ({ realtime, items: Object.entries(items).map(([extension, status]) => ({ extension, presence: p(status) })) })
const flat = (s: PresenceState | undefined) => (s ? [...s.items].map(([ext, pr]) => `${ext}:${pr.status}`).sort() : [])

/** A Gateway whose answers to getPresences the test settles one by one. */
const gateway = () => {
  const asked: { resolve: (p: PresencePage) => void; reject: (e: Error) => void }[] = []
  const getPresences = () => new Promise<PresencePage>((resolve, reject) => asked.push({ resolve, reject }))
  return { asked, getPresences }
}

describe('PresenceSync', () => {
  afterEach(() => vi.useRealTimers())

  it('reads the list again when the stream reopens: what changed while it was closed is not kept', async () => {
    const gw = gateway()
    let state: PresenceState | undefined
    const sync = new PresenceSync(gw.getPresences, s => (state = s))
    sync.load()
    gw.asked[0]!.resolve(page({ '101': 'available', '102': 'busy' }))
    await Promise.resolve()
    expect(flat(state)).toEqual(['101:available', '102:busy'])
    // The WebSocket was closed a while: 102's end of call was never heard. Reopened: read again.
    sync.load()
    gw.asked[1]!.resolve(page({ '101': 'available', '102': 'available' }))
    await Promise.resolve()
    expect(flat(state)).toEqual(['101:available', '102:available'])
    sync.stop()
  })

  it('keeps a change heard while a list is on its way, and reads once more after it however often it was asked meanwhile', async () => {
    const gw = gateway()
    let state: PresenceState | undefined
    const sync = new PresenceSync(gw.getPresences, s => (state = s))
    sync.load()
    sync.changed('101', p('busy'))
    gw.asked[0]!.resolve(page({ '101': 'available', '103': 'offline' }))
    await Promise.resolve()
    expect(flat(state)).toEqual(['101:busy', '103:offline'])
    // A burst of reconnections: one read on its way, one more after it, not one each.
    sync.load()
    sync.load()
    sync.load()
    expect(gw.asked).toHaveLength(2)
    gw.asked[1]!.resolve(page({ '101': 'away' }))
    await Promise.resolve()
    expect(flat(state)).toEqual(['101:away'])
    expect(gw.asked).toHaveLength(3)
    gw.asked[2]!.resolve(page({ '101': 'dnd' }))
    await Promise.resolve()
    expect(flat(state)).toEqual(['101:dnd'])
    expect(gw.asked).toHaveLength(3)
    sync.stop()
  })

  it('asks again with a backoff when the Gateway does not answer, and takes a change as proof of realtime', async () => {
    vi.useFakeTimers()
    const gw = gateway()
    let state: PresenceState | undefined
    const sync = new PresenceSync(gw.getPresences, s => (state = s), attempt => 1_000 * (attempt + 1))
    sync.load()
    gw.asked[0]!.reject(new Error('Gateway 502'))
    await vi.advanceTimersByTimeAsync(999)
    expect(gw.asked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gw.asked).toHaveLength(2)
    gw.asked[1]!.reject(new Error('Gateway 502'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(gw.asked).toHaveLength(3)
    // Not subscribed to the SIP server yet: no realtime; its first presence says it is now.
    gw.asked[2]!.resolve(page({}, false))
    await vi.advanceTimersByTimeAsync(0)
    expect(state?.realtime).toBe(false)
    sync.changed('102', p('available'))
    expect(state?.realtime).toBe(true)
    sync.stop()
    sync.load()
    expect(gw.asked).toHaveLength(3)
  })

  it('does not ask again when the Gateway refuses (no telephony on this platform)', async () => {
    vi.useFakeTimers()
    const gw = gateway()
    const sync = new PresenceSync(gw.getPresences, () => undefined, () => 10)
    sync.load()
    gw.asked[0]!.reject(Object.assign(new Error('Gateway 404 on /presence'), { status: 404 }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(gw.asked).toHaveLength(1)
    // The stream reopens: read again, once.
    sync.load()
    expect(gw.asked).toHaveLength(2)
    sync.stop()
  })
})
