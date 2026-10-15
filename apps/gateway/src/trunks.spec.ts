import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { DidRange, Trunk } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { decrypt } from './crypto.js'
import { StoreDirectory } from './directory.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { parseDid, parseTrunk, providerTrunks, publicTrunk, trunkFromEnv, trunkRecord } from './trunks.js'

// Fictional numbers only (ARCEP: 01 99 00 xx xx, 06 39 98 xx xx), documentation addresses (RFC 5737) and names.
const trunk = { auth: 'register', domain: 'operator.example', proxies: ['192.0.2.20', 'sip2.operator.example:5070'], username: '0033199000100', password: 'not-a-real-one', codecs: ['PCMA', 'PCMU'], defaultNumber: '+33199000100' }

describe('parseTrunk', () => {
  it('keeps what an operator needs, in order, and the password apart', () => {
    expect(parseTrunk({ ...trunk, name: ' Opérateur ', realm: 'operator.example', registerExpires: 900, assertIdentity: true, numberFormat: 'national' })).toEqual({
      config: { name: 'Opérateur', auth: 'register', domain: 'operator.example', proxies: ['192.0.2.20', 'sip2.operator.example:5070'], username: '0033199000100', realm: 'operator.example', registerExpires: 900, codecs: ['PCMA', 'PCMU'], numberFormat: 'national', assertIdentity: true, defaultNumber: '+33199000100' },
      password: 'not-a-real-one'
    })
    // Recognised by its address: no login needed; the format is E.164 by default.
    expect(parseTrunk({ auth: 'ip', domain: 'operator.example', sources: ['192.0.2.30', '2001:db8::1'], codecs: ['G722', 'PCMA'], defaultNumber: '+33199000100' })).toEqual({
      config: { auth: 'ip', domain: 'operator.example', sources: ['192.0.2.30', '2001:db8::1'], codecs: ['G722', 'PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' },
      password: undefined
    })
  })

  it('refuses anything that could not go into a SIP message or the database of the SIP server, naming the field', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ auth: 'digest' }, /^auth/],
      [{ domain: '' }, /^domain/],
      [{ domain: 'operator.example:5060' }, /^domain/],
      [{ domain: 'operator.example;lr' }, /^domain/],
      [{ proxies: ['192.0.2.20:99999'] }, /^proxies/],
      [{ proxies: ['a', 'b', 'c', 'd', 'e'] }, /^proxies/],
      [{ proxies: ['192.0.2.20', '192.0.2.20'] }, /^proxies/],
      [{ username: "0033' OR 1=1" }, /^username/],
      [{ realm: 'a"b' }, /^realm/],
      [{ registerExpires: 30 }, /^registerExpires/],
      [{ codecs: [] }, /^codecs/],
      [{ codecs: ['PCMA', 'GSM'] }, /^codecs/],
      [{ codecs: ['PCMA', 'PCMA'] }, /^codecs/],
      [{ numberFormat: 'local' }, /^numberFormat/],
      [{ defaultNumber: '0199000100' }, /^defaultNumber/],
      [{ password: 'two\nlines' }, /^password/],
      [{ password: 'x'.repeat(65) }, /^password/],
      [{ password: undefined }, /registers needs a username and a password/],
      [{ username: undefined }, /registers needs a username and a password/],
      [{ sources: ['192.0.2.30'] }, /^sources/],
      [{ name: 'two\nlines' }, /^name/]
    ]
    for (const [change, error] of bad) {
      const body = { ...trunk, ...change }
      expect(() => parseTrunk(body), JSON.stringify(change)).toThrow(error)
      try {
        parseTrunk(body)
      } catch (err) {
        expect(err).toMatchObject({ statusCode: 400, code: 'TRUNK_INVALID' })
      }
    }
    expect(() => parseTrunk(null)).toThrow(/JSON object/)
  })

  it('keeps the current password unless a new one is given, and removes it on null', () => {
    const key = randomBytes(32)
    const first = trunkRecord('A', 'operator', parseTrunk(trunk), undefined, key)
    expect(decrypt(first.passwordEnc!, key)).toBe('not-a-real-one')
    const { password: _password, ...withoutPassword } = trunk
    const same = trunkRecord('A', 'operator', parseTrunk(withoutPassword, first), first, key)
    expect(same.passwordEnc).toBe(first.passwordEnc)
    expect(() => parseTrunk({ ...withoutPassword, password: null }, first)).toThrow(/registers needs a username and a password/)
    const ip = trunkRecord('A', 'operator', parseTrunk({ ...withoutPassword, auth: 'ip', password: null }, first), first, key)
    expect(ip.passwordEnc).toBeUndefined()
    // Never shown; handed in clear to the provider only.
    expect(publicTrunk(first)).toEqual({ id: 'operator', ...parseTrunk(trunk).config, hasPassword: true })
    expect(JSON.stringify(publicTrunk(first))).not.toContain('not-a-real-one')
    expect(providerTrunks([first, ip], key)).toEqual([{ id: 'operator', ...parseTrunk(trunk).config, password: 'not-a-real-one' }, { id: 'operator', ...ip.config }])
    // Without SECRETS_KEY: a trunk without a password only.
    expect(() => trunkRecord('A', 'operator', parseTrunk(trunk), undefined, undefined)).toThrow(/SECRETS_KEY/)
    expect(() => providerTrunks([first], undefined)).toThrow(/SECRETS_KEY/)
  })
})

describe('parseDid', () => {
  const trunks = [{ id: 'operator' }]
  it('takes one number or a range, and an extension, a group, or the last digits of the number called', () => {
    expect(parseDid('reception', { trunkId: 'operator', first: '+33199000101', target: '101' }, trunks, [])).toEqual({ id: 'reception', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' })
    expect(parseDid('sales', { trunkId: 'operator', first: '+33199000110', last: '+33199000119', suffixDigits: 3 }, trunks, [])).toEqual({ id: 'sales', trunkId: 'operator', first: '+33199000110', last: '+33199000119', suffixDigits: 3 })
  })

  it('refuses a number of no trunk, no E.164, a backward or oversized range, both or neither target', () => {
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['Sales', { trunkId: 'operator', first: '+33199000101', target: '101' }, /^id/],
      ['x', { trunkId: 'other', first: '+33199000101', target: '101' }, /^trunkId/],
      ['x', { trunkId: 'operator', first: '0199000101', target: '101' }, /^first/],
      ['x', { trunkId: 'operator', first: '+33199000109', last: '+33199000101', target: '101' }, /^last/],
      ['x', { trunkId: 'operator', first: '+33199000101', last: '+331990001011', target: '101' }, /^last/],
      ['x', { trunkId: 'operator', first: '+33199000000', last: '+33199099999', suffixDigits: 5 }, /10000 numbers/],
      ['x', { trunkId: 'operator', first: '+33199000101', target: "101' --" }, /^target/],
      ['x', { trunkId: 'operator', first: '+33199000101' }, /one of them/],
      ['x', { trunkId: 'operator', first: '+33199000101', target: '101', suffixDigits: 3 }, /one of them/],
      ['x', { trunkId: 'operator', first: '+33199000101', suffixDigits: 7 }, /^suffixDigits/]
    ]
    for (const [id, body, error] of bad) expect(() => parseDid(id, body, trunks, []), JSON.stringify(body)).toThrow(error)
  })

  it('gives no number to two ranges (409), a range being free to change itself', () => {
    const others: DidRange[] = [{ id: 'sales', trunkId: 'operator', first: '+33199000110', last: '+33199000119', suffixDigits: 3 }]
    expect(() => parseDid('x', { trunkId: 'operator', first: '+33199000119', target: '101' }, trunks, others)).toThrow(expect.objectContaining({ statusCode: 409, code: 'DID_OVERLAP' }))
    expect(() => parseDid('x', { trunkId: 'operator', first: '+33199000100', last: '+33199000110', target: '101' }, trunks, others)).toThrow(/sales/)
    expect(parseDid('x', { trunkId: 'operator', first: '+33199000120', target: '101' }, trunks, others).first).toBe('+33199000120')
    expect(parseDid('sales', { trunkId: 'operator', first: '+33199000110', last: '+33199000115', suffixDigits: 3 }, trunks, others).last).toBe('+33199000115')
  })
})

describe('trunkFromEnv', () => {
  it('reads a first trunk and its direct numbers from TRUNK_*, and nothing without TRUNK_DOMAIN', () => {
    expect(trunkFromEnv({})).toBeUndefined()
    const seed = trunkFromEnv({
      TRUNK_DOMAIN: 'operator.example',
      TRUNK_PROXIES: '192.0.2.20, 192.0.2.21:5070',
      TRUNK_USERNAME: '0033199000100',
      TRUNK_PASSWORD: 'not-a-real-one',
      TRUNK_DEFAULT_NUMBER: '+33199000100',
      TRUNK_DIDS: '+33199000101=101, +33199000110..+33199000119=last:3'
    })
    expect(seed).toEqual({
      id: 'operator',
      parsed: { config: { auth: 'register', domain: 'operator.example', proxies: ['192.0.2.20', '192.0.2.21:5070'], username: '0033199000100', codecs: ['PCMA', 'PCMU'], numberFormat: 'e164', defaultNumber: '+33199000100' }, password: 'not-a-real-one' },
      dids: [
        { id: 'operator-1', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' },
        { id: 'operator-2', trunkId: 'operator', first: '+33199000110', last: '+33199000119', suffixDigits: 3 }
      ]
    })
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_DEFAULT_NUMBER: '+33199000100' })).toThrow(/^TRUNK_\*: a trunk that registers needs/)
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_DIDS: '+33199000101' })).toThrow(/^TRUNK_DIDS: "\+33199000101" is not/)
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_DIDS: '+33199000101=101,+33199000101=102' })).toThrow(/^TRUNK_DIDS \+33199000101=102: .*operator-1/)
  })
})

describe('trunk routes', () => {
  const setup = async (opts: { withTrunks?: boolean; key?: Buffer | null; store?: MemoryStore; refuse?: boolean } = {}) => {
    process.env.AUTH_MODE = 'dev'
    const store = opts.store ?? new MemoryStore()
    const handed: { trunks: (Trunk & { password?: string })[]; dids: DidRange[] }[] = []
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ trunks: opts.withTrunks !== false }),
      subscribe: async function* () {},
      close: async () => {},
      ...(opts.withTrunks !== false
        ? {
            setTrunks: async (trunks: (Trunk & { password?: string })[], dids: DidRange[]) => {
              if (opts.refuse) throw Object.assign(new Error('refused by the SIP server'), { statusCode: 400 })
              handed.push({ trunks, dids })
            }
          }
        : {})
    }
    const factory: ProviderFactory<unknown> = { type: 'recording', create: () => provider as unknown as TelephonyProvider }
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'recording', config: {} }, { tenantId: 'B', type: 'recording', config: {} }], [factory])
    const key = opts.key === null ? undefined : (opts.key ?? randomBytes(32))
    const app = await buildApp(registry, {
      store,
      bus: new EventBus(),
      directory: new StoreDirectory(store),
      tickets: new TicketStore(),
      admin: { adminRole: 'twakephone-admin', adminUsers: new Set() },
      ...(key ? { secretsKey: key } : {})
    })
    registry.startAll()
    const as = (user: string, roles?: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant, ...(roles ? { 'x-dev-roles': roles } : {}) })
    return { app, as, admin: as('root', 'twakephone-admin'), handed, store, key }
  }

  it('lets an administrator set a trunk and its direct numbers, hands them whole to the provider, never shows the password', async () => {
    const { app, admin, handed, store, key } = await setup()
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: trunk })
    expect(put.statusCode).toBe(201)
    expect(put.json()).toMatchObject({ id: 'operator', domain: 'operator.example', hasPassword: true })
    expect(put.body).not.toContain('not-a-real-one')
    expect(handed.at(-1)!.trunks).toEqual([expect.objectContaining({ id: 'operator', password: 'not-a-real-one' })])
    expect(decrypt((await store.listTrunks('A'))[0]!.passwordEnc!, key!)).toBe('not-a-real-one')
    // Changed without a password: the one kept stays.
    const { password: _password, ...withoutPassword } = trunk
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: { ...withoutPassword, registerExpires: 900 } })).statusCode).toBe(200)
    expect(handed.at(-1)!.trunks[0]).toMatchObject({ registerExpires: 900, password: 'not-a-real-one' })

    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/reception', headers: admin, payload: { trunkId: 'operator', first: '+33199000101', target: '101' } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/sales', headers: admin, payload: { trunkId: 'operator', first: '+33199000110', last: '+33199000119', suffixDigits: 3 } })).statusCode).toBe(201)
    const clash = await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/other', headers: admin, payload: { trunkId: 'operator', first: '+33199000115', target: '102' } })
    expect(clash.statusCode).toBe(409)
    expect(clash.json()).toMatchObject({ code: 'DID_OVERLAP' })
    expect(handed.at(-1)!.dids.map(d => d.id)).toEqual(['reception', 'sales'])
    const list = await app.inject({ url: '/api/v1/admin/trunks', headers: admin })
    expect(list.json().items).toEqual([expect.objectContaining({ id: 'operator', hasPassword: true })])
    expect(list.body).not.toContain('not-a-real-one')
    expect(list.body).not.toContain('passwordEnc')
    expect((await app.inject({ url: '/api/v1/admin/dids', headers: admin })).json().items.map((d: DidRange) => d.id)).toEqual(['reception', 'sales'])

    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/dids/reception', headers: admin })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/dids/reception', headers: admin })).statusCode).toBe(404)
    // A trunk goes with its numbers.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/operator', headers: admin })).statusCode).toBe(204)
    expect(handed.at(-1)).toEqual({ trunks: [], dids: [] })
    expect(await store.listDids('A')).toEqual([])
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/operator', headers: admin })).statusCode).toBe(404)
  })

  it('keeps out whoever is not an administrator, and each tenant to its own trunks', async () => {
    const { app, as, admin, store } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: as('bob'), payload: trunk })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/admin/trunks', headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/v1/admin/dids' })).statusCode).toBe(401)
    await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: trunk })
    const otherAdmin = as('root', 'twakephone-admin', 'B')
    expect((await app.inject({ url: '/api/v1/admin/trunks', headers: otherAdmin })).json().items).toEqual([])
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/x', headers: otherAdmin, payload: { trunkId: 'operator', first: '+33199000101', target: '101' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/operator', headers: otherAdmin })).statusCode).toBe(404)
    expect(await store.listTrunks('A')).toHaveLength(1)
  })

  it('keeps nothing the provider refused, nor an invalid trunk, and says 501 where trunks are not available', async () => {
    const refused = await setup({ refuse: true })
    expect((await refused.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: refused.admin, payload: trunk })).statusCode).toBe(400)
    expect(await refused.store.listTrunks('A')).toEqual([])
    const { app, admin, store } = await setup()
    const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: { ...trunk, codecs: ['GSM'] } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'TRUNK_INVALID' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/Bad_Id', headers: admin, payload: trunk })).statusCode).toBe(400)
    expect(await store.listTrunks('A')).toEqual([])
    const none = await setup({ withTrunks: false })
    expect((await none.app.inject({ url: '/api/v1/admin/trunks', headers: none.admin })).statusCode).toBe(501)
    expect((await none.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: none.admin, payload: trunk })).statusCode).toBe(501)
    // No SECRETS_KEY: no password to keep.
    const keyless = await setup({ key: null })
    expect((await keyless.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: keyless.admin, payload: trunk })).statusCode).toBe(501)
    const { password: _password, ...withoutPassword } = trunk
    expect((await keyless.app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: keyless.admin, payload: { ...withoutPassword, auth: 'ip' } })).statusCode).toBe(201)
  })

  it('hands the provider the trunks the store kept as soon as it starts', async () => {
    const key = randomBytes(32)
    const store = new MemoryStore()
    await store.upsertTrunk(trunkRecord('A', 'operator', parseTrunk(trunk), undefined, key))
    await store.upsertDid({ tenantId: 'A', id: 'reception', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' })
    const { handed } = await setup({ store, key })
    const until = Date.now() + 2000
    while (handed.length < 2 && Date.now() < until) await new Promise(r => setTimeout(r, 10))
    // Tenant A's, and B's (none).
    expect(handed).toContainEqual({ trunks: [expect.objectContaining({ id: 'operator', password: 'not-a-real-one' })], dids: [{ id: 'reception', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' }] })
    expect(handed).toContainEqual({ trunks: [], dids: [] })
  })
})
