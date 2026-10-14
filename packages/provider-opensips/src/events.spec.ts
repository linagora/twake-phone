import { afterEach, describe, expect, it } from 'vitest'
import { OpensipsEvents, parseDlgList, parseUdpUrl, parseUlDump } from './events.js'
import { fakeOpensips } from '../test/fake-opensips.js'

const until = async (what: string, fn: () => boolean, timeout = 3_000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
const quiet = { info: () => undefined, warn: () => undefined }

describe('OpensipsEvents', () => {
  const cleanups: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c()
  })

  it('subscribes to each event with its own address, reads the state once, then delivers what OpenSIPS pushes', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const got: [string, Record<string, unknown>][] = []
    let resyncs = 0
    const statuses: boolean[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_UL_CONTACT_INSERT', 'E_ACC_CDR'], onEvent: (m, p) => got.push([m, p]), onResync: () => void resyncs++, onStatus: s => statuses.push(s), logger: quiet })
    cleanups.push(() => events.stop())
    await events.start()
    expect(events.connected).toBe(true)
    expect(sips.subscriptions.map(s => s.event)).toEqual(['E_UL_CONTACT_INSERT', 'E_ACC_CDR'])
    expect(sips.subscriptions[0]!.socket).toBe(events.address)
    expect(sips.subscriptions[0]!.expire).toBe(120)
    expect(resyncs).toBe(1)
    expect(statuses).toEqual([true])
    sips.push('E_UL_CONTACT_INSERT', { domain: 'location', aor: '101', uri: 'sip:a@x.invalid' })
    await until('the event', () => got.length === 1)
    expect(got[0]).toEqual(['E_UL_CONTACT_INSERT', { domain: 'location', aor: '101', uri: 'sip:a@x.invalid' }])
  })

  it('answers MI calls and reports their errors', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.dump.Domains[0]!.AORs.push({ AOR: '101', Contacts: [{ Contact: 'sip:a@x.invalid', Expires: 3000 }, { Contact: 'sip:old@x.invalid', Expires: 'expired' }] })
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_ACC_CDR'], onEvent: () => undefined, logger: quiet })
    cleanups.push(() => events.stop())
    await events.start()
    expect(parseUlDump(await events.call('ul_dump'))).toEqual([{ aor: '101', contacts: ['sip:a@x.invalid'] }])
    await expect(events.call('nope')).rejects.toThrow(/Method not found/)
    await expect(events.call('ul_dump', [], )).resolves.toBeTruthy()
  })

  it('keeps trying when OpenSIPS does not answer, and resyncs once it is back', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.down = true
    let resyncs = 0
    const statuses: boolean[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_ACC_CDR'], timeoutMs: 50, onEvent: () => undefined, onResync: () => void resyncs++, onStatus: s => statuses.push(s), logger: quiet })
    cleanups.push(() => events.stop())
    await events.start()
    expect(events.connected).toBe(false)
    expect(resyncs).toBe(0)
    sips.state.down = false
    await until('the subscription', () => events.connected, 5_000)
    expect(resyncs).toBe(1)
    expect(statuses).toEqual([true])
    // A failed renewal (OpenSIPS restarting) then a successful one: resynced again, without duplicate subscriptions meanwhile.
    sips.state.down = true
    await events['renew']()
    expect(events.connected).toBe(false)
    sips.state.down = false
    await until('the resubscription', () => events.connected, 5_000)
    expect(resyncs).toBe(2)
    expect(statuses).toEqual([true, false, true])
  })

  it('refuses an event OpenSIPS does not know, and stops cleanly', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const warnings: string[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_NOPE'], onEvent: () => undefined, logger: { info: () => undefined, warn: m => warnings.push(m) } })
    await events.start()
    expect(events.connected).toBe(false)
    expect(warnings[0]).toMatch(/Event not found/)
    events.stop()
    await expect(events.call('ul_dump')).rejects.toThrow(/not started/)
  })

  it('reads the addresses it is given', () => {
    expect(parseUdpUrl('udp:127.0.0.1:8880', 'x')).toEqual({ host: '127.0.0.1', port: 8880 })
    expect(parseUdpUrl('udp://[::1]:8880', 'x')).toEqual({ host: '::1', port: 8880 })
    expect(() => parseUdpUrl('tcp:127.0.0.1:8880', 'MI')).toThrow(/MI must be udp:host:port/)
    expect(() => new OpensipsEvents({ miUrl: 'udp:127.0.0.1:1', listen: 'nope:x', events: ['E'], onEvent: () => undefined })).toThrow(/host\[:port\]/)
    expect(() => new OpensipsEvents({ miUrl: 'udp:127.0.0.1:1', events: [], onEvent: () => undefined })).toThrow(/nothing to subscribe/)
  })

  it('reads the dialogs OpenSIPS lists', () => {
    expect(parseDlgList({ Dialogs: [{ ID: '1:2', state: 4, timestart: 1792002800, callid: 'c1', from_uri: 'sip:101@127.0.0.1', to_uri: 'sip:102@127.0.0.1' }, { state: 4 }] })).toEqual([
      { callid: 'c1', state: 4, caller: '101', callee: '102', startedAt: '2026-10-14T18:33:20.000Z' }
    ])
    expect(parseDlgList(null)).toEqual([])
  })
})
