import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import pg from 'pg'
import type { DidRange, Trunk } from '@twake/telephony-types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, type Queryable } from './subscriber.js'
import { DEFAULT_TRUNK_SOCKET, SOURCES_SET, TRUNK_SCHEMA, TRUNK_SQL, TrunkTables, codecFlags, projectTrunks, trunkSecret, trunkStatusFrom } from './trunks.js'

// Fictional numbers only (ARCEP's ranges for fiction); the operator's names are reserved for documentation (RFC 2606).
const OPERATOR: Trunk & { password: string } = {
  id: 'operator',
  auth: 'register',
  domain: 'sip.operator.example',
  proxies: ['sbc1.operator.example:5060', 'sbc2.operator.example'],
  sources: ['192.0.2.10'],
  username: '0033199000100',
  password: 'not-a-real-password',
  realm: 'operator.example',
  codecs: ['PCMA', 'PCMU'],
  numberFormat: 'international-00',
  defaultNumber: '+33199000100'
}
const DIDS: DidRange[] = [
  { id: 'd2', trunkId: 'operator', first: '+33199000110', last: '+33199000119', suffixDigits: 3 },
  { id: 'd1', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101' }
]

describe('TRUNK_SQL', () => {
  it('is what entrypoint.sh runs before OpenSIPS starts (docker/opensips/trunk.sql), and part of the schema of the Gateway', () => {
    expect(readFileSync(new URL('../../../docker/opensips/trunk.sql', import.meta.url), 'utf8')).toBe(TRUNK_SQL)
    expect(SUBSCRIBER_SCHEMA).toContain(TRUNK_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS dids')
    expect(TRUNK_SQL).toContain("('dispatcher', 9), ('dialplan', 5), ('registrant', 3)")
  })
})

describe('projectTrunks', () => {
  it("writes the operator's servers in order, probed, its other addresses only recognised, and the registration", () => {
    const p = projectTrunks([OPERATOR], DIDS, 'udp:192.0.2.1:5070')
    const ha1 = `0x${createHash('md5').update('0033199000100:operator.example:not-a-real-password').digest('hex')}`
    expect(p.trunks).toEqual([['operator', 1, 0, 'sip.operator.example', 'international-00', 0, '0033199000100', ha1, 'operator.example', 'codec-strip-all codec-except-PCMA codec-except-PCMU codec-except-telephone-event', '+33199000100', 'sip:0033199000100@sip.operator.example', ',fixed,mobile,freephone,standard-rate,', '', '']])
    // The dispatcher tries the highest priority first (algorithm 8): the first server gets the calls, the second one
    // takes over. The other addresses: in a set of their own that no call is sent to (ds_select_dst is only ever given
    // a trunk's own set), never probed: with every server down, a call fails at once rather than going to one of them.
    expect(p.dispatcher).toEqual([
      [1, 'sip:sbc1.operator.example:5060', 'udp:192.0.2.1:5070', 0, 1, '1', 2, '', 'operator'],
      [1, 'sip:sbc2.operator.example', 'udp:192.0.2.1:5070', 0, 1, '1', 1, '', 'operator'],
      [1 + SOURCES_SET, 'sip:192.0.2.10', 'udp:192.0.2.1:5070', 0, 0, '1', 0, '', 'operator']
    ])
    const sets = (trunks: Trunk[]) => projectTrunks(trunks, [], DEFAULT_TRUNK_SOCKET).dispatcher.map(r => [r[0], r[1]])
    expect(sets([OPERATOR, { ...OPERATOR, id: 'backup', proxies: ['192.0.2.20'], sources: ['192.0.2.21', '192.0.2.22'] }])).toEqual([
      [1, 'sip:sbc1.operator.example:5060'],
      [1, 'sip:sbc2.operator.example'],
      [1001, 'sip:192.0.2.10'],
      [2, 'sip:192.0.2.20'],
      [1002, 'sip:192.0.2.21'],
      [1002, 'sip:192.0.2.22']
    ])
    expect(() => projectTrunks(Array.from({ length: SOURCES_SET }, (_, i) => ({ ...OPERATOR, id: `t${i}` })), [], DEFAULT_TRUNK_SOCKET)).toThrow(/At most 999 trunks/)
    // Registered from the trunk socket, with no other address declared (ARCHITECTURE §13), through the first server.
    expect(p.registrant).toEqual([['sip:sip.operator.example', 'sip:sbc1.operator.example:5060', 'sip:0033199000100@sip.operator.example', '0033199000100', ha1, 'sip:0033199000100@192.0.2.1:5070', 600, 'udp:192.0.2.1:5070']])
    expect(p.dids).toEqual([
      ['d2', 'operator', '+33199000110', '+33199000119', '', 3, ''],
      ['d1', 'operator', '+33199000101', '+33199000101', '101', 0, '']
    ])
  })

  it('keeps the password itself when the realm is unknown, and registers nothing for a trunk that trusts addresses', () => {
    const p = projectTrunks([{ ...OPERATOR, auth: 'ip', realm: undefined, proxies: undefined, sources: undefined }], [], DEFAULT_TRUNK_SOCKET)
    expect(p.trunks[0]![7]).toBe('not-a-real-password')
    expect(p.registrant).toEqual([])
    expect(p.dispatcher).toEqual([[1, 'sip:sip.operator.example', DEFAULT_TRUNK_SOCKET, 0, 1, '1', 1, '', 'operator']])
    expect(trunkSecret('u', 'r', 'p')).toMatch(/^0x[0-9a-f]{32}$/)
  })

  it('lets a trunk call what its administrator allows of the classes a trunk may call, the default ones otherwise', () => {
    const row = (t: Partial<Trunk>) => projectTrunks([{ ...OPERATOR, ...t }], [], DEFAULT_TRUNK_SOCKET).trunks[0]![12]
    expect(row({})).toBe(',fixed,mobile,freephone,standard-rate,')
    expect(row({ allowed: ['fixed', 'mobile', 'overseas'] })).toBe(',fixed,mobile,overseas,')
    expect(row({ allowed: ['international'], countries: ['44'] })).toBe(',international,')
    for (const allowed of [['premium'], ['emergency'], ['fixed', 'Mobile']]) expect(() => row({ allowed: allowed as Trunk['allowed'] }), allowed.join()).toThrow(/allowed/)
  })

  it('calls abroad only the countries a trunk lists, never a whole world, France, its overseas or a code of no country', () => {
    const row = (t: Partial<Trunk>) => projectTrunks([{ ...OPERATOR, ...t }], [], DEFAULT_TRUNK_SOCKET).trunks[0]![13]
    expect(row({})).toBe('')
    expect(row({ allowed: ['fixed', 'international'], countries: ['44', '32', '1'] })).toBe(',44,32,1,')
    // The North American plan per area: `1` for the United States and Canada, Jamaica by its own (1876).
    expect(row({ allowed: ['international'], countries: ['1', '1876'] })).toBe(',1,1876,')
    // `international` without countries would be every country: refused, as countries without it.
    expect(() => row({ allowed: ['international'] })).toThrow(/countries/)
    expect(() => row({ allowed: ['international'], countries: [] })).toThrow(/countries/)
    expect(() => row({ countries: ['44'] })).toThrow(/countries/)
    for (const c of ['33', '262', '590', '689', '870', '881', '882', '883', '979', '800', '808', '991', '0', '044', '+44', '1034', '12345', '18', '', '4 4', "4'"])
      expect(() => row({ allowed: ['international'], countries: [c] }), c).toThrow(/countries/)
  })

  it('binds the registration to the address OpenSIPS announces on the trunk socket, when it announces one', () => {
    const binding = (advertise?: string) => projectTrunks([OPERATOR], [], 'udp:192.0.2.1:5070', advertise).registrant[0]![5]
    expect(binding()).toBe('sip:0033199000100@192.0.2.1:5070')
    expect(binding('203.0.113.7')).toBe('sip:0033199000100@203.0.113.7:5070')
    expect(binding('203.0.113.7:5080')).toBe('sip:0033199000100@203.0.113.7:5080')
    expect(binding('pbx.example.test')).toBe('sip:0033199000100@pbx.example.test:5070')
    for (const bad of ['[2001:db8::1]:5070', 'a b', '203.0.113.7:x']) expect(() => binding(bad), bad).toThrow(/advertised/)
    expect(() => new TrunkTables({ pool: { query: async () => ({}) }, advertise: '2001:db8::1' })).toThrow(/advertised/)
  })

  it('takes IPv4 only, as the trunk socket of entrypoint.sh: an operator could not reach an IPv6 address there', () => {
    expect(() => projectTrunks([OPERATOR], [], 'udp:[2001:db8::1]:5070')).toThrow(/udp:IPv4:PORT/)
    expect(() => projectTrunks([{ ...OPERATOR, sources: ['2001:db8::10'] }], [], DEFAULT_TRUNK_SOCKET)).toThrow(/source/)
    expect(() => projectTrunks([{ ...OPERATOR, proxies: ['[2001:db8::20]:5060'] }], [], DEFAULT_TRUNK_SOCKET)).toThrow(/server/)
  })

  it('refuses what could not go into the tables, or into a query of the script', () => {
    const bad: [Partial<Trunk & { password?: string }>, RegExp][] = [
      [{ id: 'Operator' }, /id/],
      [{ domain: "x' OR '1" }, /domain/],
      [{ domain: 'sip.example:5060' }, /domain/],
      [{ defaultNumber: '0199000100' }, /default number/],
      [{ username: 'a b' }, /user name/],
      [{ proxies: ['sip:x'] }, /server/],
      [{ sources: ['operator.example'] }, /source/],
      [{ password: undefined }, /registering/],
      [{ realm: undefined, password: 'x'.repeat(65) }, /64/]
    ]
    for (const [change, message] of bad) expect(() => projectTrunks([{ ...OPERATOR, ...change }], [], DEFAULT_TRUNK_SOCKET), JSON.stringify(change)).toThrow(message)
    const did = (d: Partial<DidRange>) => () => projectTrunks([OPERATOR], [{ ...DIDS[1]!, ...d }], DEFAULT_TRUNK_SOCKET)
    expect(did({ trunkId: 'other' })).toThrow(/no trunk/)
    expect(did({ first: '0199000101' })).toThrow(/E.164/)
    expect(did({ last: '+3319900010' })).toThrow(/E.164/)
    expect(did({ last: '+33199000100' })).toThrow(/E.164/)
    expect(did({ target: "1' --" })).toThrow(/target/)
    expect(did({ target: '101', suffixDigits: 3 })).toThrow(/target/)
    expect(did({ target: undefined, suffixDigits: 7 })).toThrow(/target/)
    expect(() => new TrunkTables({ pool: { query: async () => ({}) }, socket: 'udp:0.0.0.0' })).toThrow(/udp:IPv4:PORT/)
  })

  it('keeps the trunk side of rtpengine to the codecs chosen and DTMF events', () => {
    expect(codecFlags(['G722'])).toBe('codec-strip-all codec-except-G722 codec-except-telephone-event')
  })
})

const SCRIPT = readFileSync(new URL('../../../docker/opensips/opensips.cfg.tpl', import.meta.url), 'utf8')
/** A query of opensips.cfg.tpl (`$var(name) = "..." + $var(x) + "...";`) with the script's variables given. */
const scriptQuery = (name: string, vars: Record<string, string>) => {
  const line = new RegExp(`\\$var\\(${name}\\) = (".*");$`, 'm').exec(SCRIPT)?.[1]
  if (!line) throw new Error(`no $var(${name}) in opensips.cfg.tpl`)
  return line.slice(1, -1).replace(/" \+ \$var\((\w+)\) \+ "/g, (_, v: string) => {
    if (!(v in vars)) throw new Error(`$var(${v}) not given`)
    return vars[v]!
  })
}

describe('trunkStatusFrom', () => {
  const sets = [{ id: 'operator', setid: 1, aor: 'sip:login@operator.example' }]
  const ds = (state: string) => ({ PARTITIONS: [{ name: 'default', SETS: [{ id: 1, Destinations: [{ URI: 'sip:sbc1.operator.example:5060', state }] }] }] })
  const reg = (state: string, enabled = 'yes') => ({ Records: [{ AOR: 'sip:login@operator.example', state, enabled }] })

  it("says each of uac_registrant's states in the words of the contract", () => {
    const states: [string, string][] = [
      ['REGISTERED_STATE', 'registered'],
      ['REGISTERING_STATE', 'registering'],
      ['AUTHENTICATING_STATE', 'registering'],
      ['NOT_REGISTERED_STATE', 'unregistered'],
      ['UNREGISTERING_STATE', 'unregistered'],
      ['AUTHENTICATING_UNREGISTER_STATE', 'unregistered'],
      ['WRONG_CREDENTIALS_STATE', 'refused'],
      ['REGISTER_TIMEOUT_STATE', 'timeout'],
      ['REGISTRAR_ERROR_STATE', 'error'],
      ['INTERNAL_ERROR_STATE', 'error']
    ]
    for (const [state, said] of states) expect(trunkStatusFrom(sets, ds('Active'), reg(state))[0]!.registration, state).toEqual({ state: said })
    expect(trunkStatusFrom(sets, ds('Active'), reg('REGISTERED_STATE', 'no'))[0]!.registration).toEqual({ state: 'disabled' })
    // A state of a later OpenSIPS, or no record (not loaded yet): no registration said rather than a wrong one.
    expect(trunkStatusFrom(sets, ds('Active'), reg('SOMETHING_NEW'))[0]!.registration).toBeUndefined()
    expect(trunkStatusFrom(sets, ds('Active'), { Records: [] })[0]!.registration).toBeUndefined()
  })

  it("says each of dispatcher's states, and leaves out what it cannot read", () => {
    expect(trunkStatusFrom(sets, ds('Active'), undefined)[0]!.servers).toEqual([{ address: 'sbc1.operator.example:5060', state: 'up' }])
    expect(trunkStatusFrom(sets, ds('Probing'), undefined)[0]!.servers).toEqual([{ address: 'sbc1.operator.example:5060', state: 'probing' }])
    expect(trunkStatusFrom(sets, ds('Inactive'), undefined)[0]!.servers).toEqual([{ address: 'sbc1.operator.example:5060', state: 'disabled' }])
    expect(trunkStatusFrom(sets, ds('Weird'), undefined)[0]!.servers).toEqual([])
    expect(trunkStatusFrom(sets, null, null)).toEqual([{ id: 'operator', servers: [] }])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the SQL itself, and the queries of opensips.cfg.tpl on what it writes.
if (process.env.TEST_DATABASE_URL) {
  describe('TrunkTables on PostgreSQL', () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_trunks' })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_trunks CASCADE')
      await pool.end()
    })
    const ready = async () => undefined
    beforeAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_trunks CASCADE; CREATE SCHEMA spec_trunks')
      // The tables the outbound rules read too (`subscriber`, `acc`: step 6b), as the Compose stack creates them.
      await pool.query(SUBSCRIBER_SQL)
      await pool.query(TRUNK_SQL)
      // Twice: what entrypoint.sh does at each start.
      await pool.query(TRUNK_SQL)
    })

    it('writes the projection once, and nothing when it holds already (no reload, no registration sent again)', async () => {
      const tables = new TrunkTables({ pool, ready, tenantId: 'spec-A', socket: 'udp:192.0.2.1:5070' })
      expect(await tables.set([OPERATOR], DIDS)).toEqual({ dispatcher: true, registrant: true })
      expect(await tables.set([OPERATOR], [...DIDS].reverse())).toEqual({ dispatcher: false, registrant: false })
      // A new number: only our tables change.
      expect(await tables.set([OPERATOR], [...DIDS, { id: 'd3', trunkId: 'operator', first: '+33199000120', last: '+33199000120', target: '200' }])).toEqual({ dispatcher: false, registrant: false })
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM dids')
      expect(rows[0].n).toBe(3)
      // Another expiry: the registration only.
      expect(await tables.set([{ ...OPERATOR, registerExpires: 300 }], DIDS)).toEqual({ dispatcher: false, registrant: true })
      const reg = await pool.query('SELECT aor, binding_uri, expiry, forced_socket, state FROM registrant')
      expect(reg.rows).toEqual([{ aor: 'sip:0033199000100@sip.operator.example', binding_uri: 'sip:0033199000100@192.0.2.1:5070', expiry: 300, forced_socket: 'udp:192.0.2.1:5070', state: 0 }])
      // Step 7: the set and address of record of each trunk, which the status read from OpenSIPS is matched against.
      expect(await tables.sets()).toEqual([{ id: 'operator', setid: 1, aor: 'sip:0033199000100@sip.operator.example' }])
      expect(await new TrunkTables({ pool, ready, tenantId: 'spec-B' }).sets()).toEqual([])
      // No trunk any more: everything of the tenant goes.
      expect(await tables.set([], [])).toEqual({ dispatcher: true, registrant: true })
      for (const t of ['trunks', 'dids', 'dispatcher', 'registrant']) expect((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0)
      const dp = await pool.query('SELECT count(*)::int AS n FROM dialplan')
      expect(dp.rows[0].n).toBeGreaterThan(10)
    })

    it('writes trunks with sources and countries once, and nothing when they hold already', async () => {
      const tables = new TrunkTables({ pool, ready, tenantId: 'spec-A', socket: 'udp:192.0.2.1:5070' })
      const trunks = [
        { ...OPERATOR, allowed: ['fixed' as const, 'international' as const], countries: ['44', '32'] },
        { ...OPERATOR, id: 'backup', auth: 'ip' as const, proxies: ['192.0.2.20', '192.0.2.23'], sources: ['192.0.2.22', '192.0.2.21'] }
      ]
      expect(await tables.set(trunks, DIDS)).toEqual({ dispatcher: true, registrant: true })
      expect(await tables.set(trunks, DIDS)).toEqual({ dispatcher: false, registrant: false })
      expect((await pool.query('SELECT setid, destination, state, probe_mode FROM dispatcher ORDER BY setid, priority DESC, id')).rows).toEqual([
        { setid: 1, destination: 'sip:sbc1.operator.example:5060', state: 0, probe_mode: 1 },
        { setid: 1, destination: 'sip:sbc2.operator.example', state: 0, probe_mode: 1 },
        { setid: 2, destination: 'sip:192.0.2.20', state: 0, probe_mode: 1 },
        { setid: 2, destination: 'sip:192.0.2.23', state: 0, probe_mode: 1 },
        { setid: 1001, destination: 'sip:192.0.2.10', state: 0, probe_mode: 0 },
        { setid: 1002, destination: 'sip:192.0.2.22', state: 0, probe_mode: 0 },
        { setid: 1002, destination: 'sip:192.0.2.21', state: 0, probe_mode: 0 }
      ])
      expect((await pool.query('SELECT id, countries FROM trunks ORDER BY position')).rows).toEqual([
        { id: 'operator', countries: ',44,32,' },
        { id: 'backup', countries: '' }
      ])
      // Removing a trunk takes its sources too.
      expect(await tables.set([trunks[0]!], DIDS)).toEqual({ dispatcher: true, registrant: false })
      expect((await pool.query('SELECT setid FROM dispatcher ORDER BY setid')).rows.map(r => r.setid)).toEqual([1, 1, 1001])
      await tables.set([], [])
      expect((await pool.query('SELECT count(*)::int AS n FROM dispatcher')).rows[0].n).toBe(0)
    })

    it('never lets two tenants write their first trunks at once: one of them is told another has them (409), never a 500', async () => {
      // Each waits a moment once it has read whose trunks the database holds, as a slow writer would.
      const slow = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, options: '-c search_path=spec_trunks' })
      const delayed: Queryable = {
        query: (text, values) => slow.query(text, values),
        connect: async () => {
          const c = await slow.connect()
          return {
            query: async (text: string, values?: unknown[]) => {
              const r = await c.query(text, values)
              if (text.includes('SELECT tenant_id FROM trunks WHERE tenant_id <> $1')) await new Promise(resolve => setTimeout(resolve, 300))
              return r
            },
            release: () => c.release()
          }
        }
      }
      try {
        const a = new TrunkTables({ pool: delayed, ready, tenantId: 'spec-A' })
        const b = new TrunkTables({ pool: delayed, ready, tenantId: 'spec-B' })
        const results = await Promise.allSettled([a.set([OPERATOR], []), b.set([{ ...OPERATOR, id: 'other' }], [])])
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
        const refused = results.find(r => r.status === 'rejected')
        expect(refused?.status === 'rejected' && refused.reason).toMatchObject({ statusCode: 409, code: 'TRUNK_OTHER_TENANT' })
        expect((await pool.query('SELECT DISTINCT tenant_id FROM trunks')).rows).toHaveLength(1)
      } finally {
        for (const t of ['spec-A', 'spec-B']) await new TrunkTables({ pool, ready, tenantId: t }).set([], [])
        await slow.end()
      }
    })

    it('answers the queries of opensips.cfg.tpl: the direct number called, the trunk and number of a caller', async () => {
      const tables = new TrunkTables({ pool, ready, tenantId: 'spec-A' })
      await tables.set([OPERATOR, { ...OPERATOR, id: 'backup', auth: 'ip', defaultNumber: '+33199000200' }], DIDS)
      // route[trunk_in], as the script builds it: the Request-URI's number first, then the To's (the To's first when
      // the Request-URI names the login a trunk registers with).
      const DND = { dnd_sql: 'SELECT 1 FROM call_rules r WHERE r.extension = ', dnd_now: ' AND r.dnd AND (r.dnd_until IS NULL OR r.dnd_until > now())' }
      const didRow = async (n1: string, n2: string, ruUser = '') => (await pool.query({ text: scriptQuery('did_query', { n1, n2, ru_user: ruUser, ...DND }), rowMode: 'array' })).rows[0] as unknown[] | undefined
      const inbound = async (n1: string, n2: string, ruUser = '') => {
        const row = await didRow(n1, n2, ruUser)
        return row ? { target: row[0] } : undefined
      }
      expect(await inbound('+33199000101', '')).toMatchObject({ target: '101' })
      expect(await inbound('', '+33199000113')).toMatchObject({ target: '113' })
      expect(await inbound('+33199000100', '+33199000113')).toMatchObject({ target: '113' })
      expect(await inbound('+33199000101', '+33199000113')).toMatchObject({ target: '101' })
      expect(await inbound('+33199000101', '+33199000113', '0033199000100')).toMatchObject({ target: '113' })
      expect(await inbound('+33199000120', '')).toBeUndefined()
      expect(await inbound('+331990001011', '')).toBeUndefined()
      // route[trunk_out], as the script builds it: the trunk of the caller's direct number and that number, else the
      // first trunk and its own; what it may call; and, for a number called that is one of ours, what it rings.
      const outbound = async (ext: string, called = '+33639980001') => (await pool.query(scriptQuery('trunk_query', { ext, called }))).rows[0] as Record<string, unknown> | undefined
      expect(await outbound('101')).toMatchObject({ setid: 1, presented: '+33199000101', number_format: 'international-00', allowed: ',fixed,mobile,freephone,standard-rate,', internal: null })
      // Nothing of step 6b in it (review 6b, n°2): the rights and caps are a query of their own, never an emergency call's.
      expect(Object.keys((await outbound('101'))!)).not.toContain('rights')
      expect(await outbound('115')).toMatchObject({ setid: 1, presented: '+33199000115' })
      expect(await outbound('102')).toMatchObject({ setid: 1, presented: '+33199000100' })
      expect(await outbound('1150')).toMatchObject({ presented: '+33199000100' })
      expect(await outbound('102', '+33199000101')).toMatchObject({ internal: '101' })
      expect(await outbound('102', '+33199000113')).toMatchObject({ internal: '113' })
      expect(await outbound('102', '+33199000120')).toMatchObject({ internal: null })
      expect(await outbound('102', '+331990001131')).toMatchObject({ internal: null })
      expect(await outbound('102', '112')).toMatchObject({ internal: null, presented: '+33199000100' })
      expect(await outbound('102', '')).toMatchObject({ internal: null })
      // The countries of the trunk, for its international numbers.
      await tables.set([{ ...OPERATOR, allowed: ['international'], countries: ['44'] }], DIDS)
      expect(await outbound('101', '+442079460123')).toMatchObject({ allowed: ',international,', countries: ',44,' })
      await tables.set([], [])
    })

    it('reads with a direct number called its fallback inside: the number\'s own, else its trunk\'s, what it is, and whether the number is anyone\'s (review 6b, n°1, n°9)', async () => {
      const tables = new TrunkTables({ pool, ready, tenantId: 'spec-A' })
      await tables.set([{ ...OPERATOR, fallbackTarget: '300' }], [DIDS[0]!, { ...DIDS[1]!, fallbackTarget: '113' }])
      await pool.query("INSERT INTO subscriber (username, domain) VALUES ('101', ''), ('113', ''), ('114', '')")
      await pool.query("INSERT INTO call_groups (number, tenant_id, name, members) VALUES ('300', 'spec-A', 'Accueil', '{113,114,115}')")
      try {
        const DND = { dnd_sql: 'SELECT 1 FROM call_rules r WHERE r.extension = ', dnd_now: ' AND r.dnd AND (r.dnd_until IS NULL OR r.dnd_until > now())' }
        const did = async (n: string) => {
          const row = (await pool.query({ text: scriptQuery('did_query', { n1: n, n2: '', ru_user: '', ...DND }), rowMode: 'array' })).rows[0] as unknown[]
          return { target: row[0], fallback: row[2], kind: row[3], members: row[4], assigned: row[5] }
        }
        expect(await did('+33199000101')).toEqual({ target: '101', fallback: '113', kind: 'extension', members: '', assigned: 1 })
        // The trunk's: a group, its members in their order.
        expect(await did('+33199000113')).toEqual({ target: '113', fallback: '300', kind: 'group', members: '113|114|115', assigned: 1 })
        // A number of the range nobody holds: not found (404), no fallback rung.
        expect(await did('+33199000110')).toMatchObject({ target: '110', assigned: 0 })
        // "Do not disturb": an extension in it is no fallback; a member in it is not rung.
        await pool.query("INSERT INTO call_rules (extension, tenant_id, dnd) VALUES ('113', 'spec-A', true), ('114', 'spec-A', true)")
        expect(await did('+33199000101')).toMatchObject({ fallback: '113', kind: '' })
        expect(await did('+33199000113')).toMatchObject({ kind: 'group', members: '115' })
      } finally {
        await pool.query("DELETE FROM call_rules WHERE extension IN ('113', '114'); DELETE FROM call_groups WHERE number = '300'; DELETE FROM subscriber WHERE username IN ('101', '113', '114')")
        await tables.set([], [])
      }
    })

    it("keeps each tenant to its own rows, and refuses trunks to a second tenant of the same database", async () => {
      const a = new TrunkTables({ pool, ready, tenantId: 'spec-A' })
      const b = new TrunkTables({ pool, ready, tenantId: 'spec-B' })
      await a.set([OPERATOR], DIDS)
      await b.set([], [])
      expect((await pool.query("SELECT count(*)::int AS n FROM trunks WHERE tenant_id = 'spec-A'")).rows[0].n).toBe(1)
      expect((await pool.query('SELECT count(*)::int AS n FROM dispatcher')).rows[0].n).toBe(3)
      // OpenSIPS's script reads one tenant's trunks: a second one is told so, not a clash of keys (a 500).
      await expect(b.set([{ ...OPERATOR, id: 'other' }], [])).rejects.toMatchObject({ statusCode: 409, code: 'TRUNK_OTHER_TENANT' })
      expect((await pool.query("SELECT count(*)::int AS n FROM trunks WHERE tenant_id = 'spec-B'")).rows[0].n).toBe(0)
      await a.set([], [])
      expect(await b.set([{ ...OPERATOR, id: 'other' }], [])).toEqual({ dispatcher: true, registrant: true })
      await b.set([], [])
    })

    it('writes the binding of the registration with the address announced', async () => {
      const tables = new TrunkTables({ pool, ready, tenantId: 'spec-A', socket: 'udp:192.0.2.1:5070', advertise: '203.0.113.7' })
      await tables.set([OPERATOR], [])
      expect((await pool.query('SELECT binding_uri FROM registrant')).rows).toEqual([{ binding_uri: 'sip:0033199000100@203.0.113.7:5070' }])
      expect((await pool.query("SELECT allowed FROM trunks")).rows).toEqual([{ allowed: ',fixed,mobile,freephone,standard-rate,' }])
      await tables.set([], [])
    })
  })
}
