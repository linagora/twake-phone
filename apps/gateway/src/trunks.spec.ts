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
import { defaultTrunk, parseDid, parseTrunk, providerTrunks, publicTrunk, trunkFromEnv, trunkRecord } from './trunks.js'

// Fictional numbers only (ARCEP: 01 99 00 xx xx, 06 39 98 xx xx), documentation addresses (RFC 5737) and names.
const trunk = { auth: 'register', domain: 'operator.example', proxies: ['192.0.2.20', 'sip2.operator.example:5070'], username: '0033199000100', password: 'not-a-real-one', codecs: ['PCMA', 'PCMU'], defaultNumber: '+33199000100' }

describe('parseTrunk', () => {
  it('keeps what an operator needs, in order, and the password apart', () => {
    expect(parseTrunk({ ...trunk, name: ' Opérateur ', realm: 'operator.example', registerExpires: 900, assertIdentity: true, numberFormat: 'national' })).toEqual({
      config: { name: 'Opérateur', auth: 'register', domain: 'operator.example', proxies: ['192.0.2.20', 'sip2.operator.example:5070'], username: '0033199000100', realm: 'operator.example', registerExpires: 900, codecs: ['PCMA', 'PCMU'], numberFormat: 'national', assertIdentity: true, defaultNumber: '+33199000100' },
      password: 'not-a-real-one'
    })
    // Recognised by its address: no login needed; the format is E.164 by default.
    expect(parseTrunk({ auth: 'ip', domain: 'operator.example', sources: ['192.0.2.30', '192.0.2.31'], codecs: ['G722', 'PCMA'], defaultNumber: '+33199000100' })).toEqual({
      config: { auth: 'ip', domain: 'operator.example', sources: ['192.0.2.30', '192.0.2.31'], codecs: ['G722', 'PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' },
      password: undefined
    })
    // A trunk that registers may name the addresses its operator calls from too (its SBCs are not always its
    // servers); what it may call, and whether it is the default one.
    expect(parseTrunk({ ...trunk, sources: ['192.0.2.30'], allowed: ['fixed', 'mobile', 'overseas'], default: true }).config).toMatchObject({ sources: ['192.0.2.30'], allowed: ['fixed', 'mobile', 'overseas'], default: true })
    expect(parseTrunk({ ...trunk, default: false }).config).not.toHaveProperty('default')
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
      [{ sources: ['2001:db8::1'] }, /^sources/],
      [{ proxies: ['[2001:db8::20]:5060'] }, /^proxies/],
      [{ registrar: '[2001:db8::20]' }, /^registrar/],
      [{ allowed: [] }, /^allowed/],
      [{ allowed: ['premium'] }, /^allowed/],
      [{ allowed: ['emergency'] }, /^allowed/],
      [{ allowed: ['fixed', 'fixed'] }, /^allowed/],
      [{ default: 'yes' }, /^default/],
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

  it('calls abroad only the countries listed with international, never every country nor a code of no country', () => {
    expect(parseTrunk({ ...trunk, allowed: ['fixed', 'international'], countries: ['44', '32', '1'] }).config).toMatchObject({ allowed: ['fixed', 'international'], countries: ['44', '32', '1'] })
    // The North American plan per area: `1` (the United States and Canada) does not start Jamaica's 1876, listed apart.
    expect(parseTrunk({ ...trunk, allowed: ['international'], countries: ['1', '1876'] }).config).toMatchObject({ countries: ['1', '1876'] })
    const bad: [Record<string, unknown>, RegExp][] = [
      // `international` alone would be the whole world.
      [{ allowed: ['international'] }, /^countries: .* required with international/],
      [{ allowed: ['international'], countries: [] }, /^countries/],
      [{ allowed: ['fixed'], countries: ['44'] }, /^countries: only with international/],
      [{ countries: ['44'] }, /^countries: only with international/],
      // France and its overseas have classes of their own; satellites, international networks and premium rate,
      // international freephone and shared cost: never.
      ...['33', '262', '508', '590', '594', '596', '687', '689', '681', '870', '878', '881', '882', '883', '888', '979', '800', '808', '991'].map(c => [{ allowed: ['international'], countries: [c] }, /^countries/] as [Record<string, unknown>, RegExp]),
      [{ allowed: ['international'], countries: ['+44'] }, /^countries/],
      [{ allowed: ['international'], countries: ['044'] }, /^countries/],
      [{ allowed: ['international'], countries: ['4444'] }, /^countries/],
      // An area of the North American plan is four digits, 1 then its area code (2 to 9 first).
      [{ allowed: ['international'], countries: ['1034'] }, /^countries/],
      [{ allowed: ['international'], countries: ['18'] }, /^countries/],
      [{ allowed: ['international'], countries: ['18765'] }, /^countries/],
      [{ allowed: ['international'], countries: ['*'] }, /^countries/],
      [{ allowed: ['international'], countries: ['44', '44'] }, /^countries/],
      // A code that starts another would call it too.
      [{ allowed: ['international'], countries: ['4', '44'] }, /^countries: .*none the start of another/],
      [{ allowed: ['international'], countries: Array.from({ length: 65 }, (_, i) => String(200 + i)) }, /^countries/]
    ]
    for (const [change, error] of bad) {
      expect(() => parseTrunk({ ...trunk, ...change }), JSON.stringify(change)).toThrow(error)
      try {
        parseTrunk({ ...trunk, ...change })
      } catch (err) {
        expect(err).toMatchObject({ statusCode: 400, code: 'TRUNK_INVALID' })
      }
    }
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

  it('hands the default trunk first (the one marked, else the first one): its number is presented by whoever has none', () => {
    const ip = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], defaultNumber: '+33199000100' }
    const a = trunkRecord('A', 'a', parseTrunk(ip), undefined, undefined)
    const b = trunkRecord('A', 'b', parseTrunk({ ...ip, defaultNumber: '+33199000200' }), undefined, undefined)
    const c = trunkRecord('A', 'c', parseTrunk({ ...ip, default: true }), undefined, undefined)
    expect(defaultTrunk([a, b])?.id).toBe('a')
    expect(defaultTrunk([a, b, c])?.id).toBe('c')
    expect(providerTrunks([a, b, c], undefined).map(t => t.id)).toEqual(['c', 'a', 'b'])
    expect(providerTrunks([], undefined)).toEqual([])
  })
})

describe('parseDid', () => {
  const trunks = [{ id: 'operator' }]
  it('takes one number or a range, and an extension, a group, or the last digits of the number called', () => {
    expect(parseDid('reception', { trunkId: 'operator', first: '+33199000101', target: '101' }, trunks, [])).toEqual({ id: 'reception', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' })
    expect(parseDid('sales', { trunkId: 'operator', first: '+33199000130', last: '+33199000139', suffixDigits: 3 }, trunks, [])).toEqual({ id: 'sales', trunkId: 'operator', first: '+33199000130', last: '+33199000139', suffixDigits: 3 })
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
      // An extension or a group of the internal plan (2 to 6 digits, the first not 0), never a number of the public network.
      ...['0101', '0199000101', '+33199000101', '1234567', '7', 'alice'].map(target => ['x', { trunkId: 'operator', first: '+33199000101', target }, /^target/] as [string, Record<string, unknown>, RegExp]),
      ['x', { trunkId: 'operator', first: '+33199000101' }, /one of them/],
      ['x', { trunkId: 'operator', first: '+33199000101', target: '101', suffixDigits: 3 }, /one of them/],
      ['x', { trunkId: 'operator', first: '+33199000101', suffixDigits: 7 }, /^suffixDigits/]
    ]
    for (const [id, body, error] of bad) expect(() => parseDid(id, body, trunks, []), JSON.stringify(body)).toThrow(error)
  })

  it('never makes a direct number ring an emergency number or another short number of the French plan', () => {
    const reserved = (body: Record<string, unknown>) => {
      try {
        parseDid('x', { trunkId: 'operator', ...body }, trunks, [])
      } catch (err) {
        return err as Error & { statusCode?: number; code?: string }
      }
      return undefined
    }
    for (const target of ['15', '17', '18', '112', '114', '115', '119', '191', '196', '197', '116000', '116006', '118218'])
      expect(reserved({ first: '+33199000101', target }), target).toMatchObject({ statusCode: 400, code: 'DID_RESERVED' })
    // The last digits of the numbers called make the extension: a range whose suffixes cross one is refused, naming them.
    const range = reserved({ first: '+33199000100', last: '+33199000199', suffixDigits: 3 })
    expect(range).toMatchObject({ statusCode: 400, code: 'DID_RESERVED' })
    expect(range?.message).toContain('112, 114, 115, 119, 191, 196, 197')
    expect(reserved({ first: '+33199000010', last: '+33199000019', suffixDigits: 2 })?.message).toContain('15, 17, 18')
    expect(reserved({ first: '+33199116000', last: '+33199116009', suffixDigits: 6 })?.code).toBe('DID_RESERVED')
    // Their neighbours are extensions like any other.
    expect(reserved({ first: '+33199000100', last: '+33199000109', suffixDigits: 3 })).toBeUndefined()
    expect(reserved({ first: '+33199000120', last: '+33199000189', suffixDigits: 3 })).toBeUndefined()
    expect(reserved({ first: '+33199000101', target: '1120' })).toBeUndefined()
  })

  it('gives no number to two ranges (409), a range being free to change itself', () => {
    const others: DidRange[] = [{ id: 'sales', trunkId: 'operator', first: '+33199000130', last: '+33199000139', suffixDigits: 3 }]
    expect(() => parseDid('x', { trunkId: 'operator', first: '+33199000139', target: '101' }, trunks, others)).toThrow(expect.objectContaining({ statusCode: 409, code: 'DID_OVERLAP' }))
    expect(() => parseDid('x', { trunkId: 'operator', first: '+33199000100', last: '+33199000130', target: '101' }, trunks, others)).toThrow(/sales/)
    expect(parseDid('x', { trunkId: 'operator', first: '+33199000120', target: '101' }, trunks, others).first).toBe('+33199000120')
    expect(parseDid('sales', { trunkId: 'operator', first: '+33199000130', last: '+33199000135', suffixDigits: 3 }, trunks, others).last).toBe('+33199000135')
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
      TRUNK_SOURCES: '192.0.2.40',
      TRUNK_DIDS: '+33199000101=101, +33199000130..+33199000139=last:3'
    })
    expect(seed).toEqual({
      id: 'operator',
      parsed: { config: { auth: 'register', domain: 'operator.example', proxies: ['192.0.2.20', '192.0.2.21:5070'], sources: ['192.0.2.40'], username: '0033199000100', codecs: ['PCMA', 'PCMU'], numberFormat: 'e164', defaultNumber: '+33199000100' }, password: 'not-a-real-one' },
      dids: [
        { id: 'operator-1', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' },
        { id: 'operator-2', trunkId: 'operator', first: '+33199000130', last: '+33199000139', suffixDigits: 3 }
      ]
    })
    expect(trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_ALLOWED: 'fixed, mobile,overseas' })?.parsed.config.allowed).toEqual(['fixed', 'mobile', 'overseas'])
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_ALLOWED: 'premium' })).toThrow(/^TRUNK_\*: allowed/)
    expect(trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_ALLOWED: 'fixed,international', TRUNK_COUNTRIES: '44, 32' })?.parsed.config).toMatchObject({ allowed: ['fixed', 'international'], countries: ['44', '32'] })
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_ALLOWED: 'international' })).toThrow(/^TRUNK_\*: countries/)
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_DIDS: '+33199000100..+33199000199=last:3' })).toThrow(/^TRUNK_DIDS .*112, 114/)
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_DEFAULT_NUMBER: '+33199000100' })).toThrow(/^TRUNK_\*: a trunk that registers needs/)
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_DIDS: '+33199000101' })).toThrow(/^TRUNK_DIDS: "\+33199000101" is not/)
    expect(() => trunkFromEnv({ TRUNK_DOMAIN: 'operator.example', TRUNK_AUTH: 'ip', TRUNK_DEFAULT_NUMBER: '+33199000100', TRUNK_DIDS: '+33199000101=101,+33199000101=102' })).toThrow(/^TRUNK_DIDS \+33199000101=102: .*operator-1/)
  })
})

describe('trunk routes', () => {
  const setup = async (opts: { withTrunks?: boolean; key?: Buffer | null; store?: MemoryStore; refuse?: boolean } = {}) => {
    process.env.AUTH_MODE = 'dev'
    const store = opts.store ?? new MemoryStore()
    // Who holds the extensions the direct numbers ring (tenant A), and its ring group 200.
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '102' })
    const handed: { trunks: (Trunk & { password?: string })[]; dids: DidRange[] }[] = []
    // fail: what the provider throws at the next set it is handed (written, then not reloaded: a 502).
    const control: { fail?: Error } = {}
    const provider = {
      getStatus: () => 'CONNECTED',
      getCapabilities: async () => ({ trunks: opts.withTrunks !== false }),
      subscribe: async function* () {},
      close: async () => {},
      listGroups: async () => [{ number: '200', name: 'Accueil', members: ['101'] }],
      ...(opts.withTrunks !== false
        ? {
            setTrunks: async (trunks: (Trunk & { password?: string })[], dids: DidRange[]) => {
              if (opts.refuse) throw Object.assign(new Error('refused by the SIP server'), { statusCode: 400 })
              handed.push({ trunks, dids })
              const fail = control.fail
              control.fail = undefined
              if (fail) throw fail
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
    return { app, as, admin: as('root', 'twakephone-admin'), handed, store, key, control }
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
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/sales', headers: admin, payload: { trunkId: 'operator', first: '+33199000130', last: '+33199000139', suffixDigits: 3 } })).statusCode).toBe(201)
    const clash = await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/other', headers: admin, payload: { trunkId: 'operator', first: '+33199000135', target: '102' } })
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

  it('rings only an extension someone holds or a ring group of the tenant', async () => {
    const { app, admin, store } = await setup()
    await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: trunk })
    const nobody = await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/x', headers: admin, payload: { trunkId: 'operator', first: '+33199000150', target: '150' } })
    expect(nobody.statusCode).toBe(400)
    expect(nobody.json()).toMatchObject({ code: 'DID_TARGET' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/group', headers: admin, payload: { trunkId: 'operator', first: '+33199000120', target: '200' } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/jean', headers: admin, payload: { trunkId: 'operator', first: '+33199000102', target: '102' } })).statusCode).toBe(201)
    expect((await store.listDids('A')).map(d => d.id).sort()).toEqual(['group', 'jean'])
  })

  it('lets an administrator choose the default trunk, and never removes it while another trunk is left', async () => {
    const { app, admin, handed, store } = await setup()
    const ip = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], defaultNumber: '+33199000100' }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: ip })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/backup', headers: admin, payload: { ...ip, defaultNumber: '+33199000200' } })).statusCode).toBe(201)
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['main', 'backup'])
    // The first one is the default: removing it would change the number everyone presents.
    const refused = await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main', headers: admin })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'TRUNK_DEFAULT' })
    // Another one made the default: handed first, the mark taken from the one that had it.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/backup', headers: admin, payload: { ...ip, defaultNumber: '+33199000200', default: true } })).statusCode).toBe(200)
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['backup', 'main'])
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...ip, default: true } })).statusCode).toBe(200)
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['main', 'backup'])
    expect((await store.listTrunks('A')).map(t => `${t.id}:${t.config.default ?? false}`)).toEqual(['main:true', 'backup:false'])
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main', headers: admin })).statusCode).toBe(409)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/backup', headers: admin })).statusCode).toBe(204)
    // The last one goes.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/trunks/main', headers: admin })).statusCode).toBe(204)
  })

  it('keeps the default trunk marked when a change does not say, and never unmarks it without another one marked', async () => {
    const { app, admin, handed, store } = await setup()
    const ip = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], defaultNumber: '+33199000100' }
    await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: ip })
    await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/backup', headers: admin, payload: { ...ip, defaultNumber: '+33199000200', default: true } })
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['backup', 'main'])
    // Another field of the default trunk changed, `default` not given: still the default.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/backup', headers: admin, payload: { ...ip, defaultNumber: '+33199000201' } })).statusCode).toBe(200)
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['backup', 'main'])
    expect((await store.listTrunks('A')).find(t => t.id === 'backup')?.config.default).toBe(true)
    // `default: false` on the default trunk: which one would be? Another one is marked instead.
    const unmark = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/backup', headers: admin, payload: { ...ip, defaultNumber: '+33199000201', default: false } })
    expect(unmark.statusCode).toBe(409)
    expect(unmark.json()).toMatchObject({ code: 'TRUNK_DEFAULT' })
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['backup', 'main'])
    // On another trunk, `default: false` changes nothing.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...ip, default: false } })).statusCode).toBe(200)
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['backup', 'main'])
  })

  it('moves the default mark in one write: a store that fails keeps the mark where it was', async () => {
    const { app, admin, handed, store } = await setup()
    const ip = { auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], defaultNumber: '+33199000100' }
    await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/main', headers: admin, payload: { ...ip, default: true } })
    await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/backup', headers: admin, payload: { ...ip, defaultNumber: '+33199000200' } })
    // The store writes several trunks at once, all or none (PostgreSQL: one transaction).
    const upsertTrunks = store.upsertTrunks.bind(store)
    let writes = 0
    store.upsertTrunks = async records => {
      writes++
      expect(records.map(r => `${r.id}:${r.config.default ?? false}`).sort()).toEqual(['backup:true', 'main:false'])
      throw new Error('database down')
    }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/backup', headers: admin, payload: { ...ip, defaultNumber: '+33199000200', default: true } })).statusCode).toBe(500)
    expect(writes).toBe(1)
    store.upsertTrunks = upsertTrunks
    expect((await store.listTrunks('A')).map(t => `${t.id}:${t.config.default ?? false}`)).toEqual(['main:true', 'backup:false'])
    expect(handed.at(-1)!.trunks.map(t => t.id)).toEqual(['main', 'backup'])
  })

  it('fails a change OpenSIPS did not apply (502), keeps the store and the provider on the previous set, the same when the store fails', async () => {
    const { app, admin, handed, store, control } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: trunk })).statusCode).toBe(201)
    control.fail = Object.assign(new Error('OpenSIPS did not reload the trunks'), { statusCode: 502, code: 'TRUNK_RELOAD_FAILED' })
    const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: { ...trunk, registerExpires: 900 } })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ code: 'TRUNK_RELOAD_FAILED' })
    expect((await store.listTrunks('A'))[0]!.config.registerExpires).toBeUndefined()
    // Handed the new set, then the previous one again.
    expect(handed.slice(-2).map(h => h.trunks[0]!.registerExpires)).toEqual([900, undefined])
    // The store fails after the provider took the set: the provider is handed the previous one.
    const upsertDid = store.upsertDid.bind(store)
    store.upsertDid = async () => {
      throw new Error('database down')
    }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/reception', headers: admin, payload: { trunkId: 'operator', first: '+33199000101', target: '101' } })).statusCode).toBe(500)
    expect(handed.slice(-2).map(h => h.dids.length)).toEqual([1, 0])
    store.upsertDid = upsertDid
    expect(await store.listDids('A')).toEqual([])
  })

  it('takes as a fallback an extension someone holds or a ring group, on the trunk or a range, never one that does not exist nor the number\'s own target (review 6b, n°1)', async () => {
    const { app, admin, handed } = await setup()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: { ...trunk, fallbackTarget: '200' } })).statusCode).toBe(201)
    expect(handed.at(-1)!.trunks[0]).toMatchObject({ fallbackTarget: '200' })
    const nobody = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: { ...trunk, fallbackTarget: '199' } })
    expect(nobody.statusCode).toBe(400)
    expect(nobody.json()).toMatchObject({ code: 'FALLBACK_TARGET' })
    const outside = await app.inject({ method: 'PUT', url: '/api/v1/admin/trunks/operator', headers: admin, payload: { ...trunk, fallbackTarget: '+33199000199' } })
    expect(outside.statusCode).toBe(400)
    expect(outside.json()).toMatchObject({ code: 'TRUNK_INVALID' })
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'operator', first: '+33199000101', target: '101', fallbackTarget: '102' } })).statusCode).toBe(201)
    expect(handed.at(-1)!.dids).toEqual([{ id: 'desk', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101', fallbackTarget: '102' }])
    const loop = await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'operator', first: '+33199000101', target: '101', fallbackTarget: '101' } })
    expect(loop.statusCode).toBe(409)
    expect(loop.json()).toMatchObject({ code: 'FALLBACK_LOOP' })
    const missing = await app.inject({ method: 'PUT', url: '/api/v1/admin/dids/desk', headers: admin, payload: { trunkId: 'operator', first: '+33199000101', target: '101', fallbackTarget: '198' } })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ code: 'FALLBACK_TARGET' })
    expect(handed.at(-1)!.dids[0]).toMatchObject({ fallbackTarget: '102' })
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
