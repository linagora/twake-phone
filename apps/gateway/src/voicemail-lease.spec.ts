import { describe, expect, it } from 'vitest'
import { MemoryStore } from './store/memory.js'
import { VoicemailLeases, voicemailRole, type VoicemailWeight } from './voicemail-lease.js'

const quiet = { info: () => {}, warn: () => {}, error: () => {} }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (what: string, fn: () => boolean, timeout = 3_000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await sleep(5)
  }
}

/** A Gateway's leases of the mailboxes of A, at the weight `weight()` says. */
const gateway = (store: Pick<MemoryStore, 'takeWebhookLease' | 'clock'>, holder: string, weight: () => VoicemailWeight, ms = 300) => {
  const leads: number[] = []
  const leases = new VoicemailLeases({ store, holder, ms, tenants: () => [['A', weight()] as const], onLead: () => void leads.push(Date.now()), logger: quiet })
  return { leases, leads }
}

describe('the leases of the mailboxes (third review 11a, n°2, n°3 and n°11)', () => {
  it('lets one Gateway write at a time, and the one that reaches its voicemail server take over without any overlap', async () => {
    const store = new MemoryStore()
    let firstWeight: VoicemailWeight = 2
    const first = gateway(store, 'gw_1', () => firstWeight)
    first.leases.start()
    await until('the first writes', () => first.leases.mayWrite('A') && first.leads.length === 1)
    expect(first.leads).toHaveLength(1)
    // The same weight: the holder keeps it.
    const second = gateway(store, 'gw_2', () => 2)
    second.leases.start()
    const both: number[] = []
    const watch = setInterval(() => {
      if (first.leases.mayWrite('A') && second.leases.mayWrite('A')) both.push(Date.now())
    }, 2)
    await sleep(400)
    expect([first.leases.mayWrite('A'), second.leases.mayWrite('A'), second.leads]).toEqual([true, false, []])
    // The first no longer reaches its voicemail server: the second takes it at once, and writes once the first could
    // no longer.
    firstWeight = 1
    await until('the second writes', () => second.leases.mayWrite('A') && second.leads.length === 1, 2_000)
    expect(first.leases.mayWrite('A')).toBe(false)
    expect(second.leads).toHaveLength(1)
    // The first, back at 2, does not take it back.
    firstWeight = 2
    await sleep(300)
    clearInterval(watch)
    expect(both).toEqual([])
    expect([first.leases.mayWrite('A'), second.leases.mayWrite('A'), first.leads.length]).toEqual([false, true, 1])
    await first.leases.stop()
    await second.leases.stop()
  })

  it('takes no lease for a tenant it has no voicemail server for', async () => {
    const store = new MemoryStore()
    const none = gateway(store, 'gw_1', () => undefined)
    none.leases.start()
    await sleep(200)
    expect([none.leases.mayWrite('A'), none.leads]).toEqual([false, []])
    expect(await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 300, 0)).toBeTruthy()
    await none.leases.stop()
  })

  it('gives the lease back when it stops, and writes nothing more from then on', async () => {
    const store = new MemoryStore()
    const first = gateway(store, 'gw_1', () => 2, 3_000)
    first.leases.start()
    await until('the first writes', () => first.leases.mayWrite('A'))
    await first.leases.stop()
    expect(first.leases.mayWrite('A')).toBe(false)
    // Another one takes it at once, at the lowest weight (its window from a third of the lease later).
    const lease = await store.takeWebhookLease(voicemailRole('A'), 'gw_2', 3_000, 0)
    expect(lease).toBeTruthy()
  })

  it('writes nothing once its window closes, its renewals failing (the store out of reach)', async () => {
    const store = new MemoryStore()
    let reachable = true
    const flaky = {
      clock: () => (reachable ? store.clock() : Promise.reject(new Error('store down'))),
      takeWebhookLease: (...a: Parameters<MemoryStore['takeWebhookLease']>) => store.takeWebhookLease(...a)
    }
    const g = gateway(flaky, 'gw_1', () => 2)
    g.leases.start()
    await until('it writes', () => g.leases.mayWrite('A'))
    reachable = false
    await until('it no longer writes', () => !g.leases.mayWrite('A'), 400)
    reachable = true
    await until('it writes again', () => g.leases.mayWrite('A') && g.leads.length === 2, 1_000)
    expect(g.leads).toHaveLength(2)
    await g.leases.stop()
  })
})
