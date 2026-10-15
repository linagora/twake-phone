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
    expect(events.reason).toMatch(/MI does not answer/)
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
    expect(events.reason).toBeUndefined()
  })

  it('lives through a failed renewal (the subscription still lives in OpenSIPS), and tells only once it expired without one', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    let expired = 0
    const got: string[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_ACC_CDR'], expireSec: 1, timeoutMs: 50, onEvent: m => got.push(m), onExpired: () => void expired++, logger: quiet })
    cleanups.push(() => events.stop())
    await events.start()
    // One MI reply lost: degraded, but OpenSIPS keeps sending until the expiry of the last subscription.
    sips.state.down = true
    await events['renew']()
    expect(events.connected).toBe(false)
    expect(events.live).toBe(true)
    expect(expired).toBe(0)
    sips.push('E_ACC_CDR', { callid: 'c1' })
    await until('the CDR sent meanwhile', () => got.length === 1)
    await until('the expiry', () => expired === 1)
    expect(events.live).toBe(false)
    sips.state.down = false
    await until('the resubscription', () => events.connected, 5_000)
    expect(events.live).toBe(true)
    expect(expired).toBe(1)
  })

  it('logs an error once the state of OpenSIPS could not be read three times in a row, and says why it is degraded', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const errors: string[] = []
    let fail = true
    const onResync = () => {
      if (fail) throw new Error('OpenSIPS MI ul_dump: no reply within 50 ms')
    }
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_ACC_CDR'], onEvent: () => undefined, onResync, logger: { ...quiet, error: m => errors.push(m) } })
    cleanups.push(() => events.stop())
    await events.start()
    expect(events.connected).toBe(false)
    expect(events.reason).toMatch(/state of OpenSIPS cannot be read/)
    await events['renew']()
    expect(errors).toEqual([])
    await events['renew']()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/3 times in a row.*one MI datagram \(about 64 KB\)/)
    fail = false
    await events['renew']()
    expect(events.connected).toBe(true)
    expect(events.reason).toBeUndefined()
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

  it('accepts the events from the addresses it is given besides the MI host, and is degraded while only others arrive', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const got: string[] = []
    const errors: string[] = []
    const statuses: boolean[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, from: ['127.0.0.3'], events: ['E_ACC_CDR'], onEvent: m => got.push(m), onStatus: s => statuses.push(s), logger: { ...quiet, error: m => errors.push(m) } })
    cleanups.push(() => events.stop())
    await events.start()
    const socketAt = async (host: string) => {
      const s = dgram.createSocket('udp4')
      await new Promise<void>(r => s.bind(0, host, r))
      cleanups.push(() => new Promise<void>(r => s.close(() => r())))
      return s
    }
    // event_datagram sends from the address its kernel picks for the route, not always the MI one.
    const [relay, other] = [await socketAt('127.0.0.3'), await socketAt('127.0.0.2')]
    const [, host, port] = /^udp:(.+):(\d+)$/.exec(events.address!)!
    const send = (s: dgram.Socket, method: string) => s.send(JSON.stringify({ jsonrpc: '2.0', method, params: {} }), Number(port), host)
    send(relay!, 'E_FROM_RELAY')
    await until('the event from an accepted address', () => got.includes('E_FROM_RELAY'))
    await events['renew']()
    expect(events.connected).toBe(true)
    // A renewal period with nothing at all is quiet, not deaf.
    await events['renew']()
    expect(events.connected).toBe(true)
    // Then only datagrams from an address nobody listed: degraded, with the reason, and an error in the log.
    send(other!, 'E_ACC_CDR')
    send(other!, 'E_ACC_CDR')
    await until('the ignored datagrams', () => events['foreign'] === 2)
    await events['renew']()
    expect(events.connected).toBe(false)
    expect(events.reason).toMatch(/not accepted \(OPENSIPS_EVENTS_FROM\)/)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/only datagrams from 127\.0\.0\.2 arrived.*OPENSIPS_EVENTS_FROM/)
    expect(got).toEqual(['E_FROM_RELAY'])
    // An accepted one comes again: heard.
    sips.push('E_ACC_CDR', {})
    await until('the event from the MI host', () => got.length === 2)
    await events['renew']()
    expect(events.connected).toBe(true)
    expect(statuses).toEqual([true, false, true])
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
    // "Up time" is measured on the wall clock: going back (NTP) is not a restart, only "Up since" says so.
    sips.state.upTime = '1 [sec]'
    await events['renew']()
    expect([resyncs, renewed]).toEqual([1, 2])
    sips.restart('Wed Oct 14 18:05:00 2026')
    await events['renew']()
    expect([resyncs, renewed]).toEqual([2, 2])
    expect(sips.subscriptions.map(s => s.event)).toEqual(['E_UL_CONTACT_INSERT'])
    expect(events.connected).toBe(true)
  })

  it('unsubscribes when it stops (expire 0), best effort, but not from a fixed address the next instance may hold', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const events = new OpensipsEvents({ miUrl: sips.url, events: ['E_UL_CONTACT_INSERT', 'E_ACC_CDR'], onEvent: () => undefined, logger: quiet })
    const delays: number[] = []
    const schedule = events['schedule'].bind(events)
    events['schedule'] = (ms: number) => void (delays.push(ms), schedule(ms))
    await events.start()
    // An address of its own (any free port): renewed at half the expiry from the start.
    expect(delays).toEqual([60_000])
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
    // A fixed address (a port, or an advertised one): a redeployed instance subscribes with the same one, maybe
    // before this one stops. No unsubscription, and a first renewal soon after the start, in case an older
    // instance unsubscribed it meanwhile.
    const third = await fakeOpensips()
    cleanups.push(third.close)
    const squatter = dgram.createSocket('udp4')
    await new Promise<void>(r => squatter.bind(0, '127.0.0.1', r))
    const port = squatter.address().port
    await new Promise<void>(r => squatter.close(() => r()))
    for (const where of [{ advertise: '127.0.0.1:9' }, { listen: `127.0.0.1:${port}` }, {}]) {
      const fixed = new OpensipsEvents({ miUrl: third.url, ...where, events: ['E_ACC_CDR'], onEvent: () => undefined, logger: quiet })
      const fixedDelays: number[] = []
      const reschedule = fixed['schedule'].bind(fixed)
      fixed['schedule'] = (ms: number) => void (fixedDelays.push(ms), reschedule(ms))
      await fixed.start()
      await fixed['renew']()
      expect(fixedDelays).toEqual('advertise' in where || 'listen' in where ? [5_000, 60_000] : [60_000, 60_000])
      await fixed.stop()
    }
    // Only the instance on a free port of its own unsubscribed.
    expect(third.requests.filter(r => r.method === 'event_subscribe' && r.params[2] === 0)).toHaveLength(1)
    expect(third.subscriptions.map(s => s.socket)).toEqual(['udp:127.0.0.1:9', 'udp:127.0.0.1:9', `udp:127.0.0.1:${port}`, `udp:127.0.0.1:${port}`])
  })

  it('listens on a wildcard without an advertised address when OpenSIPS is on this host: tells it the loopback, with a warning', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const got: string[] = []
    const warnings: string[] = []
    const events = new OpensipsEvents({ miUrl: sips.url, listen: '0.0.0.0', events: ['E_ACC_CDR'], onEvent: m => got.push(m), logger: { info: () => undefined, warn: m => warnings.push(m) } })
    cleanups.push(() => events.stop())
    await events.start()
    expect(events.connected).toBe(true)
    expect(sips.subscriptions[0]!.socket).toMatch(/^udp:127\.0\.0\.1:\d+$/)
    expect(warnings.some(w => /listening on 0\.0\.0\.0 without an advertised address.*told 127\.0\.0\.1/.test(w))).toBe(true)
    sips.push('E_ACC_CDR', {})
    await until('the event', () => got.length === 1)
  })

  it('tells OpenSIPS the advertised address; a configuration that cannot work is logged and leaves it degraded, never thrown', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const events = new OpensipsEvents({ miUrl: sips.url, listen: '127.0.0.1:0', advertise: 'gateway.example.test:9999', events: ['E_ACC_CDR'], onEvent: () => undefined, logger: quiet })
    cleanups.push(() => events.stop())
    await events.start()
    expect(sips.subscriptions[0]!.socket).toBe('udp:gateway.example.test:9999')
    const warnings: string[] = []
    const bare = { miUrl: sips.url, events: ['E'], onEvent: () => undefined, logger: { info: () => undefined, warn: (m: string) => warnings.push(m) } }
    expect(new OpensipsEvents({ ...bare, listen: '0.0.0.0:7000', advertise: '192.0.2.10' }).address).toBeUndefined()
    const bad = [
      { miUrl: 'udp:192.0.2.1:8880', listen: '0.0.0.0' },
      { listen: '0.0.0.0', advertise: '0.0.0.0' },
      { listen: '[::1]:7000' },
      { miUrl: 'udp:[::1]:8880' },
      { listen: 'nope:x' },
      { miUrl: 'tcp:127.0.0.1:8880' }
    ]
    for (const config of bad) {
      const e = new OpensipsEvents({ ...bare, ...config })
      await e.start()
      expect(e.address).toBeUndefined()
      expect(e.connected).toBe(false)
      expect(e.reason).toMatch(/invalid configuration/)
      await e.stop()
    }
    expect(warnings.map(w => /^OpenSIPS events disabled, calls still work: (.*)$/.exec(w)?.[1])).toEqual([
      expect.stringMatching(/wildcard: set the address OpenSIPS sends the events to \(advertise\)/),
      expect.stringMatching(/advertise address must be one OpenSIPS can send to/),
      expect.stringMatching(/listen address must be IPv4/),
      expect.stringMatching(/MI URL must be IPv4/),
      expect.stringMatching(/host\[:port\]/),
      expect.stringMatching(/MI URL must be udp:host:port/)
    ])
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
