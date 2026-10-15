import { readFileSync } from 'node:fs'
import pg from 'pg'
import { FRAUD_DEFAULTS, type OutboundProfile, type Trunk } from '@twake/telephony-types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FRAUD_PROFILE, NO_CAP_LEFT, OUTBOUND_SCHEMA, OutboundTables, projectOutbound } from './outbound.js'
import { SUBSCRIBER_SQL } from './subscriber.js'
import { TRUNK_SCHEMA, TRUNK_SQL, TrunkTables, projectTrunks } from './trunks.js'

// Fictional numbers only (ARCEP's ranges for fiction); the operator's names are reserved for documentation (RFC 2606).
const PROFILES: OutboundProfile[] = [
  { id: 'national', name: 'France', allowed: ['mobile', 'fixed'], caps: { concurrent: 2, dailyMinutes: 60 } },
  { id: 'internal', allowed: [] }
]

describe('projectOutbound', () => {
  it('writes the profiles, the organisation and who has which, and the default thresholds of what is not said', () => {
    const p = projectOutbound({ defaultProfile: 'internal', caps: { monthlyCalls: 1000 } }, PROFILES, [{ userId: 'bob', profileId: 'national' }, { userId: 'alice', profileId: 'internal' }])
    // In the order of TRUNK_OUTBOUND_CLASSES, whatever the order given; 0: no cap.
    expect(p.profiles).toEqual([
      ['internal', ',,', 0, 0, 0, 0, 0],
      ['national', ',fixed,mobile,', 2, 0, 60, 0, 0]
    ])
    expect(p.settings).toEqual(['internal', 0, 0, 0, 1000, 0])
    expect(p.users).toEqual([
      ['alice', 'internal'],
      ['bob', 'national']
    ])
    // Numbers in France (prefix 33, the number without its +) and every other one (no prefix), each threshold warning
    // then critical: calls per minute, of the day, at the same time, in a row, the duration of one.
    const d = FRAUD_DEFAULTS
    expect(p.fraud).toEqual([
      [1, FRAUD_PROFILE, '33', 6, 20, 150, 500, 3, 0, 10, 40, 14400, 0],
      [2, FRAUD_PROFILE, '', 3, 6, 20, 60, 2, 4, 5, 15, 3600, 0]
    ])
    expect(d.national.callsPerMinute).toEqual({ warning: 6, critical: 20 })
  })

  it('takes the thresholds an administrator sets in place of the default ones, one by one', () => {
    const p = projectOutbound({ fraud: { national: { callsPerMinute: { warning: 2, critical: 3 } }, international: { concurrentCalls: {} } } }, [], [])
    expect(p.fraud[0]!.slice(3, 5)).toEqual([2, 3])
    expect(p.fraud[0]!.slice(5)).toEqual([150, 500, 3, 0, 10, 40, 14400, 0])
    // An empty threshold: none at all (0), not the default one.
    expect(p.fraud[1]!.slice(7, 9)).toEqual([0, 0])
  })

  it('refuses what could not go into the tables', () => {
    const bad: [Parameters<typeof projectOutbound>, RegExp][] = [
      [[{}, [{ id: 'National', allowed: [] }], []], /Profile id/],
      [[{}, [{ id: 'a', allowed: [] }, { id: 'a', allowed: [] }], []], /twice/],
      [[{}, [{ id: 'a', allowed: ['premium' as never] }], []], /allowed/],
      [[{}, [{ id: 'a', allowed: [], caps: { concurrent: 0 } }], []], /concurrent/],
      [[{}, [{ id: 'a', allowed: [], caps: { dailyMinutes: 1.5 } }], []], /dailyMinutes/],
      [[{ defaultProfile: 'none' }, [], []], /Default profile/],
      [[{}, [], [{ userId: 'alice', profileId: 'none' }]], /no profile/],
      [[{}, [{ id: 'a', allowed: [] }], [{ userId: 'alice', profileId: 'a' }, { userId: 'alice', profileId: 'a' }]], /twice/],
      [[{}, [], [{ userId: 'a b', profileId: 'a' }]], /User id/],
      [[{ fraud: { national: { callsPerMinute: { warning: -1 } } } }, [], []], /callsPerMinute/]
    ]
    for (const [args, message] of bad) expect(() => projectOutbound(...args), JSON.stringify(args)).toThrow(message)
  })

  it('creates its tables with the trunks, and the column and index of the CDRs the caps read, only where they lack', () => {
    expect(TRUNK_SCHEMA).toContain(OUTBOUND_SCHEMA)
    expect(TRUNK_SQL).toContain("ALTER TABLE acc ADD COLUMN external VARCHAR(64) DEFAULT '' NOT NULL;")
    expect(TRUNK_SQL).toContain('CREATE INDEX acc_external_idx ON acc (external, time);')
    expect(SUBSCRIBER_SQL).toContain('ALTER TABLE acc ADD COLUMN IF NOT EXISTS external')
    // OpenSIPS checks the versions of the tables of fraud_detection and of the drouting it needs.
    expect(OUTBOUND_SCHEMA).toContain("('fraud_detection', 1), ('dr_gateways', 6), ('dr_rules', 4), ('dr_carriers', 3), ('dr_groups', 2)")
  })
})

describe('the fallback number of a trunk and of a direct number (FR-C8)', () => {
  const TRUNK: Trunk = { id: 'operator', auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }
  it('is projected with them, the trunk calling it: never a number it may not call, a short or premium one', () => {
    const p = projectTrunks([{ ...TRUNK, fallbackNumber: '+33199000198' }], [{ id: 'd', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101', fallbackNumber: '+33199000199' }], 'udp:127.0.0.1:5070')
    expect(p.trunks[0]!.at(-1)).toBe('+33199000198')
    expect(p.dids[0]!.at(-1)).toBe('+33199000199')
    for (const n of ['+33899000000', '+442079460123', '+33639980001', '112', '0199000100', '+3319900'])
      expect(() => projectTrunks([{ ...TRUNK, fallbackNumber: n }], [], 'udp:127.0.0.1:5070'), n).toThrow(/fallback number/)
    expect(projectTrunks([{ ...TRUNK, allowed: ['international'], countries: ['44'], fallbackNumber: '+442079460123' }], [], 'udp:127.0.0.1:5070').trunks[0]!.at(-1)).toBe('+442079460123')
    expect(() => projectTrunks([TRUNK], [{ id: 'd', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101', fallbackNumber: '+33899000000' }], 'udp:127.0.0.1:5070')).toThrow(/fallback number/)
  })
})

const SCRIPT = readFileSync(new URL('../../../docker/opensips/opensips.cfg.tpl', import.meta.url), 'utf8')
/** The query of opensips.cfg.tpl kept in `$var(name)`, with the script's variables given. */
const scriptQuery = (name: string, vars: Record<string, string>) => {
  const line = new RegExp(`\\$var\\(${name}\\) = (".*");$`, 'm').exec(SCRIPT)?.[1]
  if (!line) throw new Error(`no $var(${name}) in opensips.cfg.tpl`)
  return line.slice(1, -1).replace(/" \+ \$var\((\w+)\) \+ "/g, (_, v: string) => vars[v]!)
}

// Against a real PostgreSQL (TEST_DATABASE_URL): the SQL itself, and twake_outbound() on what it writes.
if (process.env.TEST_DATABASE_URL) {
  describe('OutboundTables on PostgreSQL', () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_outbound' })
    const ready = async () => undefined
    beforeAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_outbound CASCADE; CREATE SCHEMA spec_outbound')
      await pool.query(SUBSCRIBER_SQL)
      await pool.query(TRUNK_SQL)
      await pool.query(TRUNK_SQL)
      await new TrunkTables({ pool, ready, tenantId: 'spec-A' }).set([{ id: 'operator', auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }], [])
      await pool.query("INSERT INTO subscriber (username, domain, holder) VALUES ('101', '', 'alice'), ('102', '', 'bob'), ('103', '', 'carol')")
    })
    beforeEach(async () => {
      await pool.query('DELETE FROM acc')
    })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_outbound CASCADE')
      await pool.end()
    })
    const rules = async (ext: string) => (await pool.query('SELECT * FROM twake_outbound($1, $2)', [ext, 'spec-A'])).rows[0] as Record<string, unknown>
    const cdr = (caller: string, external: string, duration: number, ago = "'0 seconds'") =>
      pool.query(`INSERT INTO acc (method, callid, time, duration, caller, external) VALUES ('INVITE', md5(random()::text), localtimestamp - interval ${ago}, $1, $2, $3)`, [duration, caller, external])

    it('writes the rules once, and says when the thresholds changed (OpenSIPS reloads them then only)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      // The default thresholds are there from the start (TRUNK_SQL): nothing for OpenSIPS to reload.
      expect((await pool.query('SELECT ruleid, prefix, cpm_warning, cpm_critical FROM fraud_detection ORDER BY ruleid')).rows).toEqual([
        { ruleid: 1, prefix: '33', cpm_warning: 6, cpm_critical: 20 },
        { ruleid: 2, prefix: '', cpm_warning: 3, cpm_critical: 6 }
      ])
      expect(await t.set({}, PROFILES, [{ userId: 'alice', profileId: 'national' }])).toEqual({ fraud: false })
      expect(await t.set({}, [...PROFILES].reverse(), [{ userId: 'alice', profileId: 'national' }])).toEqual({ fraud: false })
      expect((await pool.query('SELECT count(*)::int AS n FROM fraud_detection')).rows[0].n).toBe(2)
      expect(await t.set({ fraud: { national: { callsPerMinute: { warning: 2, critical: 3 } } } }, PROFILES, [])).toEqual({ fraud: true })
      expect((await pool.query("SELECT cpm_warning, cpm_critical FROM fraud_detection WHERE prefix = '33'")).rows).toEqual([{ cpm_warning: 2, cpm_critical: 3 }])
      // OpenSIPS restarting keeps them (the defaults are only written where there are none).
      await pool.query(TRUNK_SQL)
      expect((await pool.query("SELECT cpm_warning FROM fraud_detection WHERE prefix = '33'")).rows).toEqual([{ cpm_warning: 2 }])
      expect(await t.set({}, PROFILES, [])).toEqual({ fraud: true })
      // Another tenant of the same database: refused, as its trunks would be.
      await expect(new OutboundTables({ pool, ready, tenantId: 'spec-B' }).set({}, [], [])).rejects.toMatchObject({ statusCode: 409, code: 'OUTBOUND_OTHER_TENANT' })
    })

    it('gives a call the rights of its caller: their profile, the default one, or none (the trunk alone)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({}, PROFILES, [{ userId: 'alice', profileId: 'national' }, { userId: 'bob', profileId: 'internal' }])
      expect(await rules('101')).toMatchObject({ allowed: ',fixed,mobile,', user_concurrent: 2, tenant_concurrent: 0 })
      expect(await rules('102')).toMatchObject({ allowed: ',,', user_concurrent: 0 })
      expect(await rules('103')).toMatchObject({ allowed: null, user_calls_left: NO_CAP_LEFT, seconds_left: NO_CAP_LEFT })
      await t.set({ defaultProfile: 'internal' }, PROFILES, [{ userId: 'alice', profileId: 'national' }])
      expect(await rules('103')).toMatchObject({ allowed: ',,' })
      expect(await rules('102')).toMatchObject({ allowed: ',,' })
      // An extension without an account, or not one of ours: the default profile all the same, never more.
      expect(await rules('999')).toMatchObject({ allowed: ',,' })
    })

    it('counts the answered calls to the public network of the day and the month, the person\'s and everyone\'s, never an emergency call', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { dailyCalls: 10, monthlyMinutes: 100 } }, [{ id: 'p', allowed: ['fixed'], caps: { dailyCalls: 3, monthlyCalls: 5, dailyMinutes: 2 } }], [{ userId: 'alice', profileId: 'p' }])
      await cdr('101', 'out', 30)
      await cdr('101', 'out', 45)
      await cdr('101', 'emergency', 600)
      await cdr('101', '', 600)
      await cdr('102', 'out', 120)
      const a = await rules('101')
      // Hers: 3 - 2 calls today; 120 s - 75 s today, the least of the minute caps.
      expect(a).toMatchObject({ user_calls_left: 1, user_calls_param: 'dailyCalls', tenant_calls_left: 7, tenant_calls_param: 'dailyCalls', seconds_left: 45, seconds_param: 'dailyMinutes', seconds_scope: 'user' })
      // The day before (within the month, unless today is its first day): the month's caps only.
      await cdr('101', 'out', 10, "'1 day'")
      await cdr('101', 'out', 10, "'1 day'")
      await cdr('101', 'out', 10, "'1 day'")
      const firstOfMonth = new Date().getDate() === 1
      expect((await rules('101')).user_calls_left).toBe(firstOfMonth ? 1 : 0)
      if (!firstOfMonth) expect((await rules('101')).user_calls_param).toBe('monthlyCalls')
      // The organisation's minutes: everyone's.
      await cdr('103', 'out', 5960)
      expect(await rules('103')).toMatchObject({ allowed: null, user_calls_left: NO_CAP_LEFT, tenant_calls_left: expect.any(Number), seconds_param: 'monthlyMinutes', seconds_scope: 'tenant' })
      expect(((await rules('103')).seconds_left as number) <= 6000 - 5960 - 195).toBe(true)
    })

    it('answers the query of route[trunk_out] with the trunk and the rules of the caller', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: 5 } }, PROFILES, [{ userId: 'alice', profileId: 'national' }])
      const row = (await pool.query(scriptQuery('trunk_query', { ext: '101', called: '+33639980001' }))).rows[0] as Record<string, unknown>
      expect(row).toMatchObject({ setid: 1, presented: '+33199000100', allowed: ',fixed,mobile,freephone,standard-rate,', rights: ',fixed,mobile,', user_concurrent: 2, tenant_concurrent: 5, seconds_left: 3600, seconds_param: 'dailyMinutes' })
    })
  })
}
