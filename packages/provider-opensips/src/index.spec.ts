import dgram from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoutedEvent } from '@twake/telephony-provider-sdk'
import type { ForwardingRules } from '@twake/telephony-types'
import { AsyncQueue, OpensipsProvider, SUBSCRIBED_EVENTS, type CallRules, type DialOutGrants, type DndRule, type OutboundTables, type PushTargets, type TrunkTables } from './index.js'
import { fakeOpensips } from '../test/fake-opensips.js'

const user = { id: 'alice', tenantId: 't', displayName: 'Alice', extension: '101' }
const browser = { id: 'b', type: 'browser' as const, label: 'Browser' }
const quiet = { info: () => undefined, warn: () => undefined }

const until = async (what: string, fn: () => boolean, timeout = 3_000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('OpensipsProvider', () => {
  const make = () => new OpensipsProvider({ websocketUrl: 'wss://sip.example.test:443', domain: 'sip.example.test', sipSecretFor: async ext => `secret-${ext}` })
  const cleanups: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c()
  })

  it('hands the browser where to register and as whom, with the per-user secret', async () => {
    const session = await make().getSession(user, browser)
    expect(session).toEqual({ type: 'sip-webrtc', websocketUrl: 'wss://sip.example.test:443', domain: 'sip.example.test', username: '101', credential: 'secret-101', iceServers: [] })
  })

  it('gives no session to a user without extension, nor to a non-browser endpoint', async () => {
    await expect(make().getSession({ ...user, extension: undefined }, browser)).rejects.toMatchObject({ statusCode: 404 })
    expect(await make().getSession(user, { ...browser, type: 'desk-phone' })).toEqual({ type: 'external' })
  })

  it('says the browser does the calling and the Gateway cannot originate', async () => {
    const caps = await make().getCapabilities()
    expect(caps.media.browserAudio).toBe(true)
    expect(caps.calling.outbound).toBe(false)
    expect(caps.presence.realtime).toBe(false)
    expect(caps.history).toBe(false)
    await expect(make().originate({ user, target: '102' })).rejects.toMatchObject({ statusCode: 501 })
  })

  it('refuses a configuration without a WebSocket URL or domain', () => {
    expect(() => new OpensipsProvider({ websocketUrl: 'http://x', domain: 'd', sipSecretFor: async () => '' })).toThrow(/ws:\/\//)
    expect(() => new OpensipsProvider({ websocketUrl: 'ws://x', domain: '', sipSecretFor: async () => '' })).toThrow(/domain/)
  })

  it('without events, a user with an extension is offline (nobody told the Gateway otherwise); one without keeps what they set', async () => {
    const p = make()
    expect((await p.getPresence(user)).status).toBe('offline')
    const noExtension = { ...user, extension: undefined }
    expect((await p.getPresence(noExtension)).status).toBe('available')
    await p.setPresence(noExtension, { status: 'dnd', source: 'user' })
    expect((await p.getPresence(noExtension)).status).toBe('dnd')
    expect((await p.getPresence({ ...noExtension, tenantId: 'other' })).status).toBe('available')
  })

  it('with events: subscribes to OpenSIPS, reads who is registered, and streams presence and calls to the Gateway', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.dump.Domains[0]!.AORs.push({ AOR: '102', Contacts: [{ Contact: 'sip:b@y.invalid', Expires: 3000 }] })
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, logger: quiet })
    cleanups.push(() => p.close())
    const got: RoutedEvent[] = []
    void (async () => {
      for await (const e of p.subscribe()) got.push(e)
    })()
    expect(() => p.subscribe()).toThrow(/one consumer/)
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    expect(sips.subscriptions.map(s => s.event)).toEqual(SUBSCRIBED_EVENTS)
    expect((await p.getCapabilities()).presence.realtime).toBe(true)
    expect((await p.getCapabilities()).history).toBe(true)
    await until('the seeded presence', () => got.length === 1)
    expect(got[0]).toMatchObject({ extension: '102', event: { type: 'presence.changed', payload: { presence: { status: 'available', source: 'telephony' } } } })
    expect((await p.getPresence({ ...user, extension: '102' })).status).toBe('available')
    expect((await p.getPresence(user)).status).toBe('offline')
    sips.push('E_UL_CONTACT_INSERT', { domain: 'location', aor: '101', uri: 'sip:a@x.invalid' })
    sips.push('E_TWAKEPHONE_CALLING', { callid: 'c1', caller: '101', callee: '102' })
    sips.push('E_TWAKEPHONE_RINGING', { callid: 'c1', caller: '101', callee: '102' })
    await until('the call', () => got.length >= 7)
    expect(got.slice(1).map(e => `${e.extension}:${e.event.type}`)).toEqual(['101:presence.changed', '101:call.created', '101:presence.changed', '101:call.ringing', '102:call.ringing', '102:presence.changed'])
    expect([...p.presences().entries()].map(([ext, pr]) => `${ext}:${pr.status}`)).toEqual(['102:busy', '101:busy'])
    // What the user sets shows once the call is over.
    await p.setPresence(user, { status: 'away', source: 'user' })
    expect((await p.getPresence(user)).status).toBe('busy')
    sips.push('E_ACC_CDR', { callid: 'c1', caller: '101', callee: '102', duration: 3, ms_duration: 2500, time: 1792002800, setuptime: 3, created: 1792002797 })
    await until('the end', () => got.some(e => e.event.type === 'call.ended'))
    expect((await p.getPresence(user))).toMatchObject({ status: 'away', source: 'user' })
    await p.close()
    expect(p.getStatus()).toBe('DEGRADED')
    // Unsubscribed on the way out.
    expect(sips.subscriptions).toEqual([])
  })

  it('is DEGRADED once an attempt to reach OpenSIPS failed, and not realtime', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.down = true
    const warnings: string[] = []
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 50 }, logger: { info: () => undefined, warn: m => warnings.push(m) } })
    cleanups.push(() => p.close())
    await until('a failed attempt', () => warnings.some(w => /no reply within 50 ms; retrying/.test(w)))
    expect(sips.state.received).toBeGreaterThan(0)
    expect(p.getStatus()).toBe('DEGRADED')
    expect(p.getStatusReason()).toMatch(/MI does not answer/)
    expect((await p.getCapabilities()).presence.realtime).toBe(false)
  })

  it('keeps what OpenSIPS told through a failed renewal, forgets the registrations once the subscription lapsed, and ends the lost calls when it is back', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, expireSec: 1, timeoutMs: 50 }, logger: quiet })
    cleanups.push(() => p.close())
    const got: string[] = []
    void (async () => {
      for await (const e of p.subscribe()) got.push(`${e.extension}:${e.event.type}:${e.event.type === 'presence.changed' ? e.event.payload.presence.status : (e.event.payload as { call: { state: string } }).call.state}`)
    })()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    for (const aor of ['101', '102', '103']) sips.push('E_UL_CONTACT_INSERT', { aor, uri: `sip:${aor}@x.invalid`, expires: Math.floor(Date.now() / 1000) + 300 })
    for (const [callid, callee] of [['c1', '102'], ['c2', '103']]) {
      sips.push('E_TWAKEPHONE_CALLING', { callid, caller: '101', callee })
      sips.push('E_TWAKEPHONE_ANSWERED', { callid, caller: '101', callee })
    }
    await until('both calls', () => got.filter(g => g.endsWith(':call.connected:connected')).length === 4)
    got.splice(0)
    // One lost MI reply: degraded, but the subscription still lives and nothing is forgotten.
    sips.state.down = true
    await p['events']!['renew']()
    expect(p.getStatus()).toBe('DEGRADED')
    expect((await p.getCapabilities()).presence.realtime).toBe(true)
    expect(got).toEqual([])
    // A call ends meanwhile: its CDR still makes its history.
    sips.push('E_ACC_CDR', { callid: 'c1', caller: '101', callee: '102', time: Math.floor(Date.now() / 1000) - 3, duration: 3, ms_duration: 3000, created: Math.floor(Date.now() / 1000) - 4 })
    await until('the end of c1', () => got.includes('101:call.ended:ended'))
    expect(got).toEqual(['101:call.ended:ended', '102:call.ended:ended', '102:presence.changed:available'])
    got.splice(0)
    // No renewal for the whole life of the subscription: the registrations no longer hold; c2 is kept, not dropped.
    await until('the expiry', () => got.length > 0, 3_000)
    expect(got.sort()).toEqual(['102:presence.changed:offline'])
    expect((await p.getCapabilities()).presence.realtime).toBe(false)
    expect(p['tracker'].activeCalls().map(c => c.id)).toEqual(['c2'])
    got.splice(0)
    // Back, with 101 and 103 registered and c2 gone while nobody listened: it ends, with its history.
    sips.state.dump.Domains[0]!.AORs.push(...['101', '103'].map(aor => ({ AOR: aor, Contacts: [{ Contact: `sip:${aor}@x.invalid`, Expires: 300 }] })))
    sips.state.down = false
    await until('the resync', () => p.getStatus() === 'CONNECTED', 5_000)
    expect(got.sort()).toEqual(['101:call.ended:ended', '101:presence.changed:available', '103:call.ended:ended', '103:presence.changed:available'])
    expect(p['tracker'].activeCalls()).toEqual([])
  })

  it('reads OpenSIPS again when it restarted between two renewals, and lets unrefreshed registrations lapse', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, logger: quiet })
    cleanups.push(() => p.close())
    const got: string[] = []
    void (async () => {
      for await (const e of p.subscribe()) if (e.event.type === 'presence.changed') got.push(`${e.extension}:${e.event.payload.presence.status}`)
    })()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    // 102 registered for a moment that is already over (its deletion was lost); 103 for long.
    const now = Math.floor(Date.now() / 1000)
    sips.push('E_UL_CONTACT_INSERT', { aor: '102', uri: 'sip:b@x.invalid', expires: now - 60 })
    sips.push('E_UL_CONTACT_INSERT', { aor: '103', uri: 'sip:c@x.invalid', expires: now + 3600 })
    await until('both available', () => got.length === 2)
    await p['events']!['renew']()
    expect(got.slice(2)).toEqual(['102:offline'])
    // OpenSIPS restarted (registrations in memory: none left) without any renewal failing.
    const reads = sips.requests.filter(r => r.method === 'ul_dump').length
    sips.restart('Wed Oct 14 18:20:00 2026')
    await p['events']!['renew']()
    expect(sips.requests.filter(r => r.method === 'ul_dump').length).toBe(reads + 1)
    expect(got.slice(3)).toEqual(['103:offline'])
  })

  it('tries again to listen when the address is not free yet', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const squatter = dgram.createSocket('udp4')
    await new Promise<void>(r => squatter.bind(0, '127.0.0.1', r))
    const port = squatter.address().port
    const warnings: string[] = []
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, listen: `127.0.0.1:${port}` }, logger: { info: () => undefined, warn: m => warnings.push(m) } })
    cleanups.push(() => p.close())
    await until('the failure', () => warnings.some(w => /not started: .*EADDRINUSE.*retrying in 1 s/.test(w)))
    await new Promise<void>(r => squatter.close(() => r()))
    expect(p.getStatusReason()).toMatch(/cannot listen/)
    await until('the subscription', () => p.getStatus() === 'CONNECTED', 5_000)
    expect(p.getStatusReason()).toBeUndefined()
    expect(sips.subscriptions[0]!.socket).toBe(`udp:127.0.0.1:${port}`)
  })
})

describe('OpensipsProvider call rules', () => {
  /** A `call_rules` table in memory, recording what the provider asks of it. */
  const fakeRules = () => {
    const calls: string[] = []
    const forwards = new Map<string, ForwardingRules>()
    const dnd = new Map<string, DndRule>()
    const rules = {
      getForwarding: async (ext: string) => forwards.get(ext) ?? {},
      setForwarding: async (ext: string, r: ForwardingRules, holder: string) => void (calls.push(`forward ${ext} by ${holder}`), forwards.set(ext, r)),
      setDnd: async (ext: string, d: DndRule | null, holder: string) => void (calls.push(`dnd ${ext} ${JSON.stringify(d)}${holder === user.id ? '' : ` by ${holder}`}`), d ? dnd.set(ext, d) : dnd.delete(ext)),
      clearDndExcept: async (keep: string[]) => void (calls.push(`clear except ${keep.join(',')}`), [...dnd.keys()].filter(e => !keep.includes(e)).forEach(e => dnd.delete(e))),
      reconcile: async (holders: { extension: string; userId: string }[]) => void calls.push(`reconcile ${holders.map(h => `${h.extension}=${h.userId}`).join(',')}`)
    }
    return { calls, dnd, rules: rules as unknown as CallRules }
  }
  const make = (callRules?: CallRules) => new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', callRules })
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c()
  })

  it('forwards only with the call rules table, and only for a user with an extension', async () => {
    expect((await make().getCapabilities()).forwarding).toBe(false)
    await expect(make().setForwarding(user, { always: '103' })).rejects.toMatchObject({ statusCode: 501 })
    expect(await make().getForwarding(user)).toEqual({})
    const db = fakeRules()
    const p = make(db.rules)
    expect((await p.getCapabilities()).forwarding).toBe(true)
    await p.setForwarding(user, { busy: '103', noAnswer: { target: '104', delaySec: 10 } })
    expect(await p.getForwarding(user)).toEqual({ busy: '103', noAnswer: { target: '104', delaySec: 10 } })
    expect(db.calls).toEqual(['forward 101 by alice'])
    await expect(p.getForwarding({ ...user, extension: undefined })).rejects.toMatchObject({ statusCode: 404 })
    await expect(p.setForwarding({ ...user, extension: undefined }, {})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('writes a "do not disturb" in the table OpenSIPS reads, with its end and message, and lifts it when it is left', async () => {
    const db = fakeRules()
    const p = make(db.rules)
    cleanups.push(() => p.close())
    await p.setPresence(user, { status: 'dnd', source: 'user', until: '2099-01-01T00:00:00.000Z', message: 'En réunion' })
    await p.setPresence(user, { status: 'dnd', source: 'user' })
    await p.setPresence(user, { status: 'away', source: 'user', message: 'Au déjeuner' })
    // Away to available: nothing for OpenSIPS.
    await p.setPresence(user, { status: 'available', source: 'user' })
    await p.setPresence({ ...user, extension: undefined }, { status: 'dnd', source: 'user' })
    expect(db.calls).toEqual(['dnd 101 {"until":"2099-01-01T00:00:00.000Z","message":"En réunion"}', 'dnd 101 {}', 'dnd 101 null'])
    // A "do not disturb" past its end may still be in the table: leaving it lifts it there too.
    await p.setPresence(user, { status: 'dnd', source: 'user', until: new Date(Date.now() - 1_000).toISOString() })
    await p.setPresence(user, { status: 'away', source: 'user' })
    expect(db.calls.slice(3)).toEqual([expect.stringMatching(/^dnd 101 \{"until"/), 'dnd 101 null'])
  })

  it("changes any other presence without OpenSIPS's database, even when it is down", async () => {
    const down = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    const p = make({ setDnd: down, clearDndExcept: down, reconcile: down } as unknown as CallRules)
    cleanups.push(() => p.close())
    await p.setPresence(user, { status: 'away', source: 'user', message: 'Au déjeuner' })
    await p.setPresence(user, { status: 'available', source: 'user' })
    expect((await p.getPresence(user)).status).toBe('offline')
    expect(p['tracker'].userPresences().get('101')).toMatchObject({ status: 'available' })
    // Entering a "do not disturb" needs it: refused, the choice not kept.
    await expect(p.setPresence(user, { status: 'dnd', source: 'user' })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(p['tracker'].userPresences().get('101')).toMatchObject({ status: 'available' })
  })

  it('hands who holds each extension to the table, for the rules to follow the person', async () => {
    const db = fakeRules()
    const p = make(db.rules)
    await p.syncExtensions([{ extension: '101', userId: 'alice' }, { extension: '102', userId: 'bob' }])
    expect(db.calls).toEqual(['reconcile 101=alice,102=bob'])
    await make().syncExtensions([])
  })

  it('removes the accounts no longer held, and their windows from OpenSIPS at once (MI ul_rm)', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.dump.Domains[0]!.AORs.push({ AOR: '102', Contacts: [{ Contact: 'sip:b@y.invalid', Expires: 3000 }] }, { AOR: '103', Contacts: [{ Contact: 'sip:c@y.invalid', Expires: 3000 }] })
    const given: { extension: string; userId: string }[][] = []
    const accounts = { reconcile: async (holders: { extension: string; userId: string }[]) => (given.push(holders), ['102']) }
    const warnings: string[] = []
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, accounts, logger: { info: () => undefined, warn: m => void warnings.push(m) } })
    cleanups.push(() => p.close())
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    await p.syncExtensions([{ extension: '101', userId: 'alice', displayName: 'Alice' }, { extension: '103', userId: 'carol' }])
    expect(given).toEqual([[{ extension: '101', userId: 'alice' }, { extension: '103', userId: 'carol' }]])
    expect(sips.requests.filter(r => r.method === 'ul_rm').map(r => r.params)).toEqual([['location', '102']])
    expect(sips.state.dump.Domains[0]!.AORs.map(a => (a as { AOR: string }).AOR)).toEqual(['103'])
    // OpenSIPS not answering: the account is gone all the same, said so; the windows go when their registration ends.
    sips.state.down = true
    await p.syncExtensions([{ extension: '101', userId: 'alice' }])
    expect(warnings).toEqual([expect.stringMatching(/^OpenSIPS: the windows of 102 not removed \(.*\); they go when their registration ends$/)])
    // Without the MI, nothing more than the accounts.
    const bare = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', accounts })
    await bare.syncExtensions([])
    expect(given).toHaveLength(3)
  })

  it('writes the trunks where OpenSIPS reads them, and has it reload only what changed, its numbering plan once', async () => {
    const trunk = { id: 'operator', auth: 'register' as const, domain: 'operator.example', proxies: ['192.0.2.20'], username: '0033199000100', password: 'not-a-real-one', codecs: ['PCMA' as const], numberFormat: 'e164' as const, defaultNumber: '+33199000100' }
    const dids = [{ id: 'd1', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' }]
    const writes: unknown[] = []
    let changed = { dispatcher: true, registrant: true }
    const trunks = { set: async (t: unknown, d: unknown) => (writes.push([t, d]), changed) } as unknown as TrunkTables
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const warnings: string[] = []
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, trunks, logger: { info: () => undefined, warn: m => void warnings.push(m) } })
    cleanups.push(() => p.close())
    expect((await p.getCapabilities()).trunks).toBe(true)
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    const reloads = () => sips.requests.map(r => r.method).filter(m => m.endsWith('_reload'))
    await p.setTrunks([trunk], dids)
    expect(writes).toEqual([[[trunk], dids]])
    expect(reloads()).toEqual(['ds_reload', 'reg_reload', 'dp_reload'])
    // The direct numbers only: nothing to reload (OpenSIPS reads them call by call).
    changed = { dispatcher: false, registrant: false }
    await p.setTrunks([trunk], [])
    expect(reloads()).toHaveLength(3)
    // Another server: the dispatcher only, never a registration again for nothing.
    changed = { dispatcher: true, registrant: false }
    await p.setTrunks([{ ...trunk, proxies: ['192.0.2.21'] }], [])
    expect(reloads()).toEqual(['ds_reload', 'reg_reload', 'dp_reload', 'ds_reload'])
    // OpenSIPS not answering: written, not applied: the change fails (502), and is reloaded at the next one, even one
    // that changes nothing OpenSIPS reloads.
    sips.state.down = true
    await expect(p.setTrunks([trunk], [])).rejects.toMatchObject({ statusCode: 502, code: 'TRUNK_RELOAD_FAILED' })
    expect(warnings).toEqual([expect.stringMatching(/^OpenSIPS: trunks written, ds_reload \(.*\) failed: not applied until it reloads them or restarts$/)])
    sips.state.down = false
    changed = { dispatcher: false, registrant: false }
    await p.setTrunks([trunk], [])
    expect(reloads()).toEqual(['ds_reload', 'reg_reload', 'dp_reload', 'ds_reload', 'ds_reload'])
    await p.setTrunks([trunk], [])
    expect(reloads()).toHaveLength(5)
    changed = { dispatcher: true, registrant: false }
    // Without the MI: written, read at OpenSIPS's next start.
    const bare = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', trunks, logger: { info: () => undefined, warn: m => void warnings.push(m) } })
    await bare.setTrunks([trunk], [])
    expect(warnings.at(-1)).toMatch(/^OpenSIPS: trunks written, ds_reload, dp_reload not asked \(no MI\)/)
    // Without the tables: no trunk on this platform.
    expect((await make().getCapabilities()).trunks).toBe(false)
    await expect(make().setTrunks([trunk], [])).rejects.toMatchObject({ statusCode: 501 })
  })

  it("grants a room's call through the grants table, or says it cannot (step 8, review n°1)", async () => {
    const given: unknown[] = []
    const dialOutGrants = { grant: async (...a: unknown[]) => (given.push(['grant', ...a]), 'ab'.repeat(16)), revoke: async (t: string) => void given.push(['revoke', t]) } as unknown as DialOutGrants
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', dialOutGrants })
    const grant = await p.grantRoomCall({ extension: '101', number: '+33612345678' })
    expect(grant.token).toBe('ab'.repeat(16))
    await grant.revoke()
    expect(given).toEqual([['grant', '101', '+33612345678', undefined, {}], ['revoke', 'ab'.repeat(16)]])
    // A conference's (step 8b): what the grant says of it goes to the table.
    await p.grantRoomCall({ extension: '101', number: '102', replaces: 'c1;to-tag=b;from-tag=a' })
    await p.grantRoomCall({ extension: '101', number: '101', join: 'cd'.repeat(16) })
    expect(given.slice(2)).toEqual([
      ['grant', '101', '102', undefined, { replaces: 'c1;to-tag=b;from-tag=a' }],
      ['grant', '101', '101', undefined, { join: 'cd'.repeat(16) }]
    ])
    // Without the table: no room calls anybody.
    await expect(make().grantRoomCall({ extension: '101', number: '102' })).rejects.toMatchObject({ statusCode: 501 })
  })

  it('reads a call between two extensions from its dialog in OpenSIPS (MI dlg_list_ctx, step 8b): answered, its parties and tags; a call with the operator or a room is external; anything else is no such call', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, logger: quiet })
    cleanups.push(() => p.close())
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    const dialog = (callid: string, over: Record<string, unknown> = {}, values: Record<string, unknown>[] = [{ callee: '103' }, { dialled: '102' }, { callee_tag: 'tag-b' }]) => ({
      callid,
      state: 4,
      from_uri: 'sip:101@sip.example.test',
      to_uri: 'sip:102@sip.example.test',
      caller_tag: 'tag-a',
      CALLEES: [{ callee_tag: 'tag-b' }, { callee_tag: 'tag-c' }],
      context: { values },
      ...over
    })
    sips.state.dialogContexts.set('c1', dialog('c1'))
    // Forwarded from 102 to 103: the extension it reached, and the tag of the phone that answered.
    expect(await p.callBetweenExtensions('c1')).toEqual({ callId: 'c1', caller: '101', callerTag: 'tag-a', callee: '103', calleeTag: 'tag-b' })
    expect(sips.requests.find(r => r.method === 'dlg_list_ctx')?.params).toEqual({ callid: 'c1' })
    sips.state.dialogContexts.set('trunk', dialog('trunk', {}, [{ callee: '103' }, { callee_tag: 'b' }, { trunk: 'caller' }]))
    sips.state.dialogContexts.set('room', dialog('room', {}, [{ callee: '103' }, { callee_tag: 'b' }, { meet: 'caller' }]))
    expect([await p.callBetweenExtensions('trunk'), await p.callBetweenExtensions('room')]).toEqual(['external', 'external'])
    // Ringing; answered before OpenSIPS kept the tag of the answer; to oneself; a name no extension has; unknown.
    sips.state.dialogContexts.set('early', dialog('early', { state: 2 }))
    sips.state.dialogContexts.set('untagged', dialog('untagged', {}, [{ callee: '103' }]))
    sips.state.dialogContexts.set('self', dialog('self', { from_uri: 'sip:103@sip.example.test' }))
    sips.state.dialogContexts.set('odd', dialog('odd', { from_uri: '<sip:alice;x@sip.example.test>' }))
    for (const id of ['early', 'untagged', 'self', 'odd', 'nope']) expect(await p.callBetweenExtensions(id), id).toBeUndefined()
    // Without the MI: no such call.
    expect(await make().callBetweenExtensions('c1')).toBeUndefined()
    // An MI that answers another error, or none at all, cannot say: not "no such call" (review 8b, n°10).
    sips.state.dialogContexts.set('broken', 'fail')
    await expect(p.callBetweenExtensions('broken')).rejects.toMatchObject({ statusCode: 503, code: 'SIP_SERVER_UNAVAILABLE' })
    sips.state.down = true
    await expect(p.callBetweenExtensions('c1')).rejects.toMatchObject({ statusCode: 503, code: 'SIP_SERVER_UNAVAILABLE' })
    sips.state.down = false
  })

  it('ends a call OpenSIPS has by its Call-ID (MI dlg_end_dlg, review 8b, n°3), saying whether it was answered or still ringing (third review 8b, n°1); one it no longer has is no error, and said (second review 8b, n°1)', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, logger: quiet })
    cleanups.push(() => p.close())
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    sips.state.dialogContexts.set('diverted@192.0.2.30', { callid: 'diverted@192.0.2.30', state: 4, caller_tag: 'x', from_uri: 'sip:101@sip.example.test', context: { values: [] } })
    expect(await p.endRoomCall('diverted@192.0.2.30')).toBe('answered')
    expect(sips.requests.find(r => r.method === 'dlg_list_ctx')?.params).toEqual({ callid: 'diverted@192.0.2.30' })
    expect(sips.requests.find(r => r.method === 'dlg_end_dlg')?.params).toEqual({ dialog_id: 'diverted@192.0.2.30' })
    expect(sips.state.dialogContexts.has('diverted@192.0.2.30')).toBe(false)
    expect(await p.endRoomCall('diverted@192.0.2.30')).toBeUndefined()
    // Still ringing (early, 2): cancelled, and said so.
    sips.state.dialogContexts.set('early@192.0.2.30', { callid: 'early@192.0.2.30', state: 2, caller_tag: 'x', from_uri: 'sip:101@sip.example.test', context: { values: [] } })
    expect(await p.endRoomCall('early@192.0.2.30')).toBe('ringing')
    expect(sips.state.dialogContexts.has('early@192.0.2.30')).toBe(false)
    // An MI that answers another error than "no such dialog" is no answer.
    sips.state.dialogContexts.set('broken@192.0.2.30', 'fail')
    await expect(p.endRoomCall('broken@192.0.2.30')).rejects.toBeTruthy()
    await expect(make().endRoomCall('x')).rejects.toMatchObject({ statusCode: 501 })
  })

  it("reads the access number of Meet's rooms OpenSIPS was started with, or says it cannot (step 8, review n°12)", async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, logger: { info: () => undefined, warn: () => undefined } })
    cleanups.push(() => p.close())
    await p.getCapabilities()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    sips.state.shv = [{ name: 'meet_on', type: 1, value: 1 }, { name: 'meet_number', type: 2, value: '8000' }, { name: 'other', type: 1, value: 3 }]
    expect(await p.getMeetAccess()).toEqual({ number: '8000' })
    sips.state.shv = [{ name: 'meet_on', type: 1, value: 0 }, { name: 'meet_number', type: 2, value: '8000' }]
    expect(await p.getMeetAccess()).toEqual({})
    // An OpenSIPS of before step 8: it cannot say.
    sips.state.shv = [{ name: 'other', type: 1, value: 3 }]
    expect(await p.getMeetAccess()).toBeUndefined()
    sips.state.shv = undefined
    await expect(p.getMeetAccess()).rejects.toThrow()
    // Without the MI: it cannot say.
    expect(await make().getMeetAccess()).toBeUndefined()
  })

  it('reads whether OpenSIPS sends calls to the mailboxes, or says it cannot (step 11a, review n°13)', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, logger: { info: () => undefined, warn: () => undefined } })
    cleanups.push(() => p.close())
    await p.getCapabilities()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    sips.state.shv = [{ name: 'wazo_on', type: 1, value: 1 }, { name: 'meet_on', type: 1, value: 0 }]
    expect(await p.getVoicemailAccess()).toBe(true)
    sips.state.shv = [{ name: 'wazo_on', type: 1, value: 0 }]
    expect(await p.getVoicemailAccess()).toBe(false)
    // The shape of other versions of OpenSIPS, read as well.
    sips.state.shvAs = 'VARs'
    expect(await p.getVoicemailAccess()).toBe(false)
    sips.state.shv = [{ name: 'wazo_on', type: 1, value: 1 }]
    expect(await p.getVoicemailAccess()).toBe(true)
    sips.state.shvAs = 'lists'
    // An OpenSIPS of before step 11a: it cannot say.
    sips.state.shv = [{ name: 'meet_on', type: 1, value: 1 }]
    expect(await p.getVoicemailAccess()).toBeUndefined()
    expect(await make().getVoicemailAccess()).toBeUndefined()
    // With the longest call to a mailbox (third review 11a, n°10), as the Gateway compares it at its start.
    sips.state.shv = [{ name: 'wazo_on', type: 1, value: 1 }, { name: 'vm_max_sec', type: 1, value: 120 }]
    expect(await p.getVoicemailSettings()).toEqual({ on: true, maxCallSec: 120 })
    sips.state.shv = [{ name: 'wazo_on', type: 1, value: 0 }]
    expect(await p.getVoicemailSettings()).toEqual({ on: false })
    sips.state.shv = [{ name: 'wazo_on', type: 1, value: 1 }, { name: 'vm_max_sec', type: 1, value: 'x' }]
    expect(await p.getVoicemailSettings()).toEqual({ on: true })
    sips.state.shv = [{ name: 'meet_on', type: 1, value: 1 }]
    expect(await p.getVoicemailSettings()).toBeUndefined()
    expect(await make().getVoicemailSettings()).toBeUndefined()
  })

  it('asks OpenSIPS how the trunks are doing (step 7): its servers and registrations, nothing else of its answers', async () => {
    let sets = [
      { id: 'operator', setid: 1, aor: 'sip:0033199000100@operator.example' },
      { id: 'backup', setid: 2, aor: '' }
    ]
    const trunks = { set: async () => ({ dispatcher: false, registrant: false }), sets: async () => sets } as unknown as TrunkTables
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    sips.state.dispatcher.PARTITIONS[0]!.SETS.push(
      { id: 1, Destinations: [{ URI: 'sip:192.0.2.20:5060', state: 'Active', first_hit_counter: 3, socket: 'udp:127.0.0.1:5070' }, { URI: 'sip:192.0.2.21', state: 'Probing', first_hit_counter: 0 }] },
      { id: 1001, Destinations: [{ URI: 'sip:192.0.2.30', state: 'Active' }] },
      { id: 2, Destinations: [{ URI: 'sip:backup.operator.example', state: 'Inactive' }] }
    )
    sips.state.registrations.Records.push({ AOR: 'sip:0033199000100@operator.example', expires: 600, state: 'REGISTERED_STATE', enabled: 'yes', binding: 'sip:0033199000100@192.0.2.10:5070' })
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, trunks, logger: quiet })
    cleanups.push(() => p.close())
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    const status = await p.getTrunkStatus()
    expect(status).toEqual([
      { id: 'operator', registration: { state: 'registered' }, servers: [{ address: '192.0.2.20:5060', state: 'up' }, { address: '192.0.2.21', state: 'probing' }] },
      { id: 'backup', servers: [{ address: 'backup.operator.example', state: 'disabled' }] }
    ])
    // Nothing of the address of record, the binding or the sockets goes out.
    expect(JSON.stringify(status)).not.toMatch(/0033199000100|5070|192\.0\.2\.30/)
    // Without a trunk that registers, reg_list is not asked; without trunks, nothing is.
    sets = [{ id: 'backup', setid: 2, aor: '' }]
    const asked = sips.requests.length
    await p.getTrunkStatus()
    expect(sips.requests.slice(asked).map(r => r.method)).toEqual(['ds_list'])
    sets = []
    expect(await p.getTrunkStatus()).toEqual([])
    expect(sips.requests.length).toBe(asked + 1)
    // OpenSIPS not answering: it fails, not a status made up.
    sets = [{ id: 'backup', setid: 2, aor: '' }]
    sips.state.down = true
    await expect(p.getTrunkStatus()).rejects.toThrow()
    // Without the MI: unknown; without the tables: no trunk on this platform.
    expect(await new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', trunks }).getTrunkStatus()).toBeUndefined()
    await expect(make().getTrunkStatus()).rejects.toMatchObject({ statusCode: 501 })
  })

  it('writes the outbound rules where OpenSIPS reads them, and has it reload its thresholds only when they changed (step 6b)', async () => {
    const writes: unknown[] = []
    let changed = { fraud: true }
    const outbound = { set: async (...args: unknown[]) => (writes.push(args), changed) } as unknown as OutboundTables
    const trunks = { set: async () => ({ dispatcher: false, registrant: false }) } as unknown as TrunkTables
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const warnings: string[] = []
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url, timeoutMs: 300 }, trunks, outbound, logger: { info: () => undefined, warn: m => void warnings.push(m) } })
    cleanups.push(() => p.close())
    expect((await p.getCapabilities()).outboundPolicy).toBe(true)
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    const reloads = () => sips.requests.map(r => r.method).filter(m => m === 'fraud_reload')
    const profiles = [{ id: 'national', allowed: ['fixed' as const, 'mobile' as const] }]
    await p.setOutboundPolicy({ defaultProfile: 'national' }, profiles, [{ userId: 'alice', profileId: 'national' }])
    expect(writes).toEqual([[{ defaultProfile: 'national' }, profiles, [{ userId: 'alice', profileId: 'national' }]]])
    expect(reloads()).toHaveLength(1)
    // Profiles, caps, who has which: read call by call, nothing to reload.
    changed = { fraud: false }
    await p.setOutboundPolicy({}, profiles, [])
    expect(reloads()).toHaveLength(1)
    // OpenSIPS not answering: written, not applied (502), asked again at the next change whatever it changes.
    sips.state.down = true
    changed = { fraud: true }
    await expect(p.setOutboundPolicy({}, [], [])).rejects.toMatchObject({ statusCode: 502, code: 'OUTBOUND_RELOAD_FAILED' })
    expect(warnings.at(-1)).toMatch(/^OpenSIPS: thresholds written, fraud_reload failed/)
    sips.state.down = false
    changed = { fraud: false }
    await p.setOutboundPolicy({}, [], [])
    expect(reloads().length).toBeGreaterThanOrEqual(2)
    const after = reloads().length
    await p.setOutboundPolicy({}, [], [])
    expect(reloads()).toHaveLength(after)
    // Without the tables, or without trunks: no outbound rules on this platform.
    expect((await make().getCapabilities()).outboundPolicy).toBe(false)
    await expect(make().setOutboundPolicy({}, [], [])).rejects.toMatchObject({ statusCode: 501 })
  })

  it('subscribes to the thresholds and caps of the calls to the public network, and hands their alerts on, never as a call', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, logger: quiet })
    cleanups.push(() => p.close())
    const got: RoutedEvent[] = []
    void (async () => {
      for await (const e of p.subscribe()) got.push(e)
    })()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    for (const e of ['E_FRD_WARNING', 'E_FRD_CRITICAL', 'E_TWAKEPHONE_LIMIT', 'E_TWAKEPHONE_RIGHTS', 'E_TWAKEPHONE_EMERGENCY', 'E_TWAKEPHONE_PIN']) expect(sips.subscriptions.map(s => s.event)).toContain(e)
    sips.push('E_FRD_CRITICAL', { param: 'total-calls', value: 500, threshold: 500, user: '101', called_number: '442079460123', rule_id: 2, profile_id: 1 })
    sips.push('E_TWAKEPHONE_LIMIT', { caller: '102', number: '+33639980001', param: 'dailyMinutes', scope: 'tenant', callid: 'x1' })
    // Review 6b, n°11: a number outside the caller's rights, and emergency calls in a row (the third raises it).
    sips.push('E_TWAKEPHONE_RIGHTS', { caller: '103', number: '+442079460123', param: 'international', callid: 'x2' })
    for (const id of ['e1', 'e2', 'e3']) sips.push('E_TWAKEPHONE_EMERGENCY', { caller: '104', number: '112', callid: id })
    await until('the alerts', () => got.filter(e => e.event.type === 'alert.raised').length === 4)
    expect(got.map(e => [e.extension, e.event.type === 'alert.raised' ? e.event.payload.alert : e.event.type])).toEqual([
      ['101', { kind: 'fraud-critical', param: 'dailyAttempts', scope: 'user', value: 500, threshold: 500, extension: '101', number: '+442079460123' }],
      ['102', { kind: 'limit', param: 'dailyMinutes', scope: 'tenant', extension: '102', number: '+33639980001' }],
      ['103', { kind: 'rights', param: 'international', scope: 'user', extension: '103', number: '+442079460123' }],
      ['104', { kind: 'emergency', param: 'burst', scope: 'user', value: 3, threshold: 3, extension: '104', number: '112' }]
    ])
  })

  it('says it is degraded while OpenSIPS\'s tables cannot count what the caps need, and why (review 6b)', () => {
    let problem: string | undefined = 'acc.external is missing'
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', schemaProblem: () => problem, logger: quiet })
    expect(p.getStatus()).toBe('DEGRADED')
    expect(p.getStatusReason()).toBe('acc.external is missing')
    problem = undefined
    expect(p.getStatus()).toBe('CONNECTED')
  })

  it('writes who can be woken where OpenSIPS reads it, only while it hears the events that say whom to wake', async () => {
    const written: string[] = []
    const pushTargets = {
      set: async (t: { extension: string; userId: string }[]) => void written.push(`set ${t.map(h => `${h.extension}=${h.userId}`).join(',')}`),
      reconcile: async (t: { extension: string; userId: string }[]) => void written.push(`reconcile ${t.map(h => `${h.extension}=${h.userId}`).join(',')}`),
      setOne: async (t: { extension: string; userId: string }, on: boolean) => void written.push(`one ${t.extension}=${t.userId} ${on}`),
      keepAlive: async (sec: number) => void written.push(`alive ${sec}`),
      release: async () => void written.push('release')
    } as unknown as PushTargets
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, pushTargets, logger: quiet })
    expect((await p.getCapabilities()).push).toBe(true)
    await p.setWakeable([{ extension: '102', userId: 'jean' }])
    await p.syncExtensions([{ extension: '102', userId: 'jean' }])
    // One person's browser, alone: their row only.
    await p.setWakeableOne({ extension: '103', userId: 'bob' }, true)
    await p.setWakeableOne({ extension: '103', userId: 'bob' }, false)
    expect(written.filter(w => !w.startsWith('alive'))).toEqual(['set 102=jean', 'reconcile 102=jean', 'one 103=bob true', 'one 103=bob false'])
    // The rows live as long as the subscription to the events (each renewal), and no longer once it stops.
    await vi.waitFor(() => expect(written).toContain('alive 120'))
    await p.close()
    expect(written.at(-1)).toBe('release')
    // Without the events, nobody would hear whom to wake: nobody can be (OpenSIPS would hold calls for nothing).
    const deaf = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', pushTargets })
    expect((await deaf.getCapabilities()).push).toBe(false)
    await deaf.setWakeable([{ extension: '102', userId: 'jean' }])
    expect(written.at(-1)).toBe('set ')
    await deaf.setWakeableOne({ extension: '103', userId: 'bob' }, true)
    expect(written.at(-1)).toBe('one 103=bob false')
    // Without the table, nothing to write.
    expect((await make().getCapabilities()).push).toBe(false)
    await make().setWakeable([{ extension: '102', userId: 'jean' }])
  })

  it('subscribes to the wake event and hands it to the person to wake', async () => {
    const sips = await fakeOpensips()
    cleanups.push(sips.close)
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', events: { miUrl: sips.url }, logger: quiet })
    cleanups.push(() => p.close())
    const got: RoutedEvent[] = []
    void (async () => {
      for await (const e of p.subscribe()) got.push(e)
    })()
    await until('the subscription', () => p.getStatus() === 'CONNECTED')
    expect(sips.subscriptions.map(s => s.event)).toContain('E_TWAKEPHONE_WAKE')
    sips.push('E_TWAKEPHONE_CALLING', { callid: 'w1', caller: '101', callee: '102', dialled: '102' })
    sips.push('E_TWAKEPHONE_WAKE', { callid: 'w1', caller: '101', callee: '102', dialled: '102', wait: 30 })
    await until('the wake', () => got.some(e => e.event.type === 'call.wake'))
    expect(got.find(e => e.event.type === 'call.wake')).toMatchObject({ extension: '102', event: { payload: { waitSec: 30, call: { id: 'w1', remoteNumber: '101', direction: 'inbound' } } } })
  })

  it('keeps the choice out of the tracker when the table refuses it', async () => {
    const rules = { setDnd: async () => Promise.reject(Object.assign(new Error('the message must be one line'), { statusCode: 400 })) } as unknown as CallRules
    const p = make(rules)
    await expect(p.setPresence(user, { status: 'dnd', source: 'user', message: 'x' })).rejects.toMatchObject({ statusCode: 400 })
    expect(p['tracker'].userPresences().size).toBe(0)
  })

  it('restores the choices the Gateway kept, and forgets every other one, here and in the table', async () => {
    const db = fakeRules()
    const p = make(db.rules)
    cleanups.push(() => p.close())
    // 103 chose "do not disturb" before the extension went to someone else; 104's was left in the table.
    await p.setPresence({ ...user, extension: '103' }, { status: 'dnd', source: 'user' })
    db.dnd.set('104', {})
    db.calls.splice(0)
    const bob = { ...user, id: 'bob', extension: '102' }
    const carol = { ...user, id: 'carol', extension: undefined }
    await p.restorePresences([
      { user, presence: { status: 'dnd', source: 'user', message: 'En congé' } },
      { user: bob, presence: { status: 'away', source: 'user' } },
      { user: carol, presence: { status: 'dnd', source: 'user' } }
    ])
    // Bob's absence is the Gateway's alone: nothing in the table for it.
    expect(db.calls).toEqual(['clear except 101', 'dnd 101 {"message":"En congé"}'])
    expect([...db.dnd.keys()]).toEqual(['101'])
    expect([...p['tracker'].userPresences().keys()].sort()).toEqual(['101', '102'])
    expect((await p.getPresence(carol)).status).toBe('dnd')
  })

  it('tells the end of a chosen presence when it comes, without anyone asking', async () => {
    const p = make()
    cleanups.push(() => p.close())
    const tracker = p['tracker']
    await p.setPresence(user, { status: 'dnd', source: 'user', until: new Date(Date.now() + 150).toISOString() })
    await p.setPresence({ ...user, extension: '102' }, { status: 'away', source: 'user', until: new Date(Date.now() + 300).toISOString() })
    expect(tracker['userPresence'].size).toBe(2)
    await until('the first end', () => tracker['userPresence'].size === 1)
    await until('the second end', () => tracker['userPresence'].size === 0)
    expect(p['expiryTimer']).toBeDefined()
    expect(tracker.nextUserPresenceEnd()).toBeUndefined()
    // One without extension: its end holds too.
    const noExtension = { ...user, extension: undefined }
    await p.setPresence(noExtension, { status: 'away', source: 'user', until: new Date(Date.now() - 1).toISOString() })
    expect((await p.getPresence(noExtension)).status).toBe('available')
  })
})

describe('AsyncQueue', () => {
  it('keeps at most its bound waiting, drops the rest and says so once per overflow', async () => {
    const drops: number[] = []
    const q = new AsyncQueue<number>(3, n => drops.push(n))
    for (let i = 0; i < 6; i++) q.push(i)
    expect(q.dropped).toBe(3)
    expect(drops).toEqual([1])
    const it = q[Symbol.asyncIterator]()
    expect([(await it.next()).value, (await it.next()).value, (await it.next()).value]).toEqual([0, 1, 2])
    // Drained: the next overflow is told again.
    for (let i = 0; i < 5; i++) q.push(i)
    expect(drops).toEqual([1, 4])
    q.close()
  })

  it('drops what can be dropped first: the oldest presence makes room for a call event, a new presence is dropped', async () => {
    const q = new AsyncQueue<string>(3, undefined, s => s.startsWith('presence'))
    for (const s of ['presence1', 'call1', 'presence2', 'call2', 'presence3', 'call3', 'call4']) q.push(s)
    // presence1 then presence2 made room for call2 and call3; presence3 was dropped; call4 had no room left.
    expect(q.dropped).toBe(4)
    const it = q[Symbol.asyncIterator]()
    expect([(await it.next()).value, (await it.next()).value, (await it.next()).value]).toEqual(['call1', 'call2', 'call3'])
    q.close()
  })

  it('a provider queue drops the presences before the call events when the Gateway does not keep up', () => {
    const p = new OpensipsProvider({ websocketUrl: 'wss://sip.example.test', domain: 'sip.example.test', sipSecretFor: async () => 's', logger: quiet })
    const q = p['queue']
    expect(q['droppable']({ extension: '101', event: { type: 'presence.changed', timestamp: '', payload: { userId: '', presence: { status: 'busy', source: 'telephony' } } } })).toBe(true)
    expect(q['droppable']({ extension: '101', event: { type: 'call.ended', timestamp: '', payload: { call: { id: 'c', direction: 'inbound', state: 'ended', remoteNumber: '102', startedAt: '' } } } })).toBe(false)
  })
})
