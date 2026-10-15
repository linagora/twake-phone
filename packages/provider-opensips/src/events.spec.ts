import dgram from 'node:dgram'
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
    expect(parseUlDump(await events.call('ul_dump'), 1_000)).toEqual([{ aor: '101', contacts: [{ uri: 'sip:a@x.invalid', expiresAt: 3_001_000 }] }])
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

  it('survives any datagram: null, an array, a number, a string, garbage, a reply nobody waits for', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const got: string[] = []
    const warnings: string[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_UL_CONTACT_INSERT'], onEvent: m => got.push(m), logger: { info: () => undefined, warn: m => warnings.push(m) } })
    cleanups.push(() => events.stop())
    await events.start()
    for (const raw of ['null', '[]', '1', '"x"', 'true', 'nope', '{"id":null}', '{"id":"unknown","result":1}', '{"method":42}', '{"method":"E_X","params":null}']) sips.send(raw)
    sips.push('E_UL_CONTACT_INSERT', { aor: '101' })
    await until('the event after the junk', () => got.includes('E_UL_CONTACT_INSERT'))
    expect(got).toEqual(['E_X', 'E_UL_CONTACT_INSERT'])
    expect(warnings.filter(w => /not a JSON-RPC object/.test(w))).toHaveLength(5)
    expect(warnings.filter(w => /not JSON/.test(w))).toHaveLength(1)
  })

  it('ignores datagrams that do not come from the MI host, and asks with ids nobody can guess', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const got: string[] = []
    const warnings: string[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_ACC_MISSED_EVENT'], onEvent: m => got.push(m), logger: { info: () => undefined, warn: m => warnings.push(m) } })
    cleanups.push(() => events.stop())
    await events.start()
    // Another host of the loopback network: a forged missed call and a forged MI reply.
    const intruder = dgram.createSocket('udp4')
    await new Promise<void>(r => intruder.bind(0, '127.0.0.2', r))
    cleanups.push(() => new Promise<void>(r => intruder.close(() => r())))
    const [, host, port] = /^udp:(.+):(\d+)$/.exec(events.address!)!
    const pending = events.call('ul_dump')
    const id = sips.requests.at(-1)?.id
    intruder.send(JSON.stringify({ jsonrpc: '2.0', method: 'E_ACC_MISSED_EVENT', params: { callid: 'x', caller: '666', callee: '101' } }), Number(port), host)
    intruder.send(JSON.stringify({ jsonrpc: '2.0', id, result: { Domains: [] } }), Number(port), host)
    sips.push('E_ACC_MISSED_EVENT', { callid: 'real' })
    await until('the genuine event', () => got.length === 1)
    await expect(pending).resolves.toEqual(sips.state.dump)
    expect(warnings.some(w => /ignoring a datagram from 127\.0\.0\.2/.test(w))).toBe(true)
    const ids = sips.requests.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const i of ids) expect(i).toMatch(/^[0-9a-f]{24}$/)
  })

  it('reads the state again when OpenSIPS restarted between two renewals, and only then', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    let resyncs = 0
    let renewed = 0
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_UL_CONTACT_INSERT'], onEvent: () => undefined, onResync: () => void resyncs++, onRenewed: () => void renewed++, logger: quiet })
    cleanups.push(() => events.stop())
    await events.start()
    expect(resyncs).toBe(1)
    await events['renew']()
    expect([resyncs, renewed]).toEqual([1, 1])
    // Restarted between two renewals: no failure was seen, the subscription is gone, the start time changed.
    sips.restart('Wed Oct 14 18:05:00 2026')
    await events['renew']()
    expect([resyncs, renewed]).toEqual([2, 1])
    expect(sips.subscriptions.map(s => s.event)).toEqual(['E_UL_CONTACT_INSERT'])
    expect(events.connected).toBe(true)
  })

  it('unsubscribes when it stops (expire 0), best effort', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_UL_CONTACT_INSERT', 'E_ACC_CDR'], onEvent: () => undefined, logger: quiet })
    await events.start()
    expect(sips.subscriptions).toHaveLength(2)
    await events.stop()
    expect(sips.subscriptions).toEqual([])
    expect(sips.requests.filter(r => r.method === 'event_subscribe' && r.params[2] === 0).map(r => r.params[0])).toEqual(['E_UL_CONTACT_INSERT', 'E_ACC_CDR'])
    // OpenSIPS gone: stopping does not wait for it more than a moment.
    const other = await fakeOpensips()
    cleanups.push(other.close)
    const e2 = new OpensipsEvents({ miUrl: other.url, events: ['E_ACC_CDR'], onEvent: () => undefined, logger: quiet })
    await e2.start()
    other.state.down = true
    const t0 = Date.now()
    await e2.stop()
    expect(Date.now() - t0).toBeLessThan(1_500)
  })

  it('tells OpenSIPS the advertised address, and refuses one it could not send to', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const events = new OpensipsEvents({ miUrl: sips.url, listen: '127.0.0.1:0', advertise: 'gateway.example.test:9999', events: ['E_ACC_CDR'], onEvent: () => undefined, logger: quiet })
    cleanups.push(() => events.stop())
    await events.start()
    expect(sips.subscriptions[0]!.socket).toBe('udp:gateway.example.test:9999')
    const bare = { miUrl: sips.url, events: ['E'], onEvent: () => undefined }
    expect(() => new OpensipsEvents({ ...bare, listen: '0.0.0.0' })).toThrow(/wildcard/)
    expect(new OpensipsEvents({ ...bare, listen: '0.0.0.0:7000', advertise: '192.0.2.10' }).address).toBeUndefined()
    expect(() => new OpensipsEvents({ ...bare, listen: '0.0.0.0', advertise: '0.0.0.0' })).toThrow(/advertise/)
    expect(() => new OpensipsEvents({ ...bare, listen: '[::1]:7000' })).toThrow(/IPv4/)
    expect(() => new OpensipsEvents({ ...bare, miUrl: 'udp:[::1]:8880' })).toThrow(/IPv4/)
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
    expect(parseDlgList({ Dialogs: [{ ID: '1:2', state: 4, timestart: 1792002800, callid: 'c1', from_uri: 'sip:101@127.0.0.1', to_uri: 'sip:102@127.0.0.1' }, { state: 4 }, { state: 2, timestart: 0, callid: 'c2', from_uri: 'sip:101@127.0.0.1', to_uri: 'sip:103@127.0.0.1' }] })).toEqual([
      { callid: 'c1', state: 4, caller: '101', callee: '102', startedAt: '2026-10-14T18:33:20.000Z' },
      { callid: 'c2', state: 2, caller: '101', callee: '103' }
    ])
    expect(parseDlgList(null)).toEqual([])
  })
})
