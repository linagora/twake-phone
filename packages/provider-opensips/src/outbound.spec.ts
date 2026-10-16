import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { FRAUD_DEFAULTS, type OutboundProfile, type Trunk } from '@twake/telephony-types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EMERGENCY_RESTORED_SEC, FRAUD_OVERSEAS_PREFIXES, FRAUD_PROFILE, OUTBOUND_SCHEMA, OutboundTables, TRIGGER_LOCK_TIMEOUT, projectOutbound } from './outbound.js'
import { SUBSCRIBER_SQL } from './subscriber.js'
import { TRUNK_SCHEMA, TRUNK_SQL, TrunkTables, projectTrunks } from './trunks.js'

// Fictional numbers only (ARCEP's ranges for fiction); the operator's names are reserved for documentation (RFC 2606).
const PROFILES: OutboundProfile[] = [
  { id: 'national', name: 'France', allowed: ['mobile', 'fixed'], caps: { concurrent: 2, dailyMinutes: 60 } },
  { id: 'internal', allowed: [] }
]

describe('projectOutbound', () => {
  it('writes the profiles, the organisation and who has which, and the default caps and thresholds of what is not said', () => {
    const p = projectOutbound({ defaultProfile: 'internal', caps: { monthlyCalls: 1000 } }, PROFILES, [{ userId: 'bob', profileId: 'national' }, { userId: 'alice', profileId: 'internal' }])
    // In the order of TRUNK_OUTBOUND_CLASSES, whatever the order given; each cap not said: its default (review 6b, n°6:
    // 2 calls at a time and 300 minutes a day a person, 20 and 3000 for the organisation); 0: none.
    expect(p.profiles).toEqual([
      ['internal', ',,', 2, 0, 300, 0, 0],
      ['national', ',fixed,mobile,', 2, 0, 60, 0, 0]
    ])
    expect(p.settings).toEqual(['internal', 20, 0, 3000, 1000, 0, 2, 0, 300, 0, 0])
    expect(p.users).toEqual([
      ['alice', 'internal'],
      ['bob', 'national']
    ])
    // Numbers in France (prefix 33, the number without its +), every other one (no prefix), and the French overseas
    // ones with the international thresholds (review 6b, n°14), each threshold warning then critical: calls per minute,
    // attempts of the day, calls at the same time, in a row, the duration of one.
    const d = FRAUD_DEFAULTS
    const international = [3, 6, 20, 60, 2, 4, 5, 15, 1800, 3600]
    expect(p.fraud).toEqual([
      [1, FRAUD_PROFILE, '33', 6, 20, 150, 500, 3, 0, 10, 40, 7200, 14400],
      [2, FRAUD_PROFILE, '', ...international],
      ...FRAUD_OVERSEAS_PREFIXES.map((prefix, i) => [3 + i, FRAUD_PROFILE, prefix, ...international])
    ])
    expect(p.fraud).toHaveLength(18)
    expect(FRAUD_OVERSEAS_PREFIXES).toContain('33262')
    expect(FRAUD_OVERSEAS_PREFIXES).toContain('33639')
    expect(d.national.callsPerMinute).toEqual({ warning: 6, critical: 20 })
  })

  it('lifts a cap an administrator sets to null, keeps the default of one not said, the caps of those without a profile too', () => {
    const p = projectOutbound({ caps: { concurrent: null, dailyMinutes: null }, userCaps: { concurrent: 4, dailyMinutes: null } }, [{ id: 'free', allowed: ['fixed'], caps: { concurrent: null, dailyMinutes: null } }], [])
    expect(p.settings).toEqual(['', 0, 0, 0, 0, 0, 4, 0, 0, 0, 0])
    expect(p.profiles).toEqual([['free', ',fixed,', 0, 0, 0, 0, 0]])
  })

  it('takes the thresholds an administrator sets in place of the default ones, one by one, overseas as abroad', () => {
    const p = projectOutbound({ fraud: { national: { callsPerMinute: { warning: 2, critical: 3 } }, international: { concurrentCalls: {} } } }, [], [])
    expect(p.fraud[0]!.slice(3, 5)).toEqual([2, 3])
    expect(p.fraud[0]!.slice(5)).toEqual([150, 500, 3, 0, 10, 40, 7200, 14400])
    // An empty threshold: none at all (0), not the default one.
    expect(p.fraud[1]!.slice(7, 9)).toEqual([0, 0])
    expect(p.fraud[17]!.slice(7, 9)).toEqual([0, 0])
  })

  it('refuses what could not go into the tables', () => {
    const bad: [Parameters<typeof projectOutbound>, RegExp][] = [
      [[{}, [{ id: 'National', allowed: [] }], []], /Profile id/],
      [[{}, [{ id: 'a', allowed: [] }, { id: 'a', allowed: [] }], []], /twice/],
      [[{}, [{ id: 'a', allowed: ['premium' as never] }], []], /allowed/],
      [[{}, [{ id: 'a', allowed: [], caps: { concurrent: 0 } }], []], /concurrent/],
      [[{}, [{ id: 'a', allowed: [], caps: { dailyMinutes: 1.5 } }], []], /dailyMinutes/],
      [[{ userCaps: { dailyCalls: -1 } }, [], []], /Those without a profile: dailyCalls/],
      [[{ defaultProfile: 'none' }, [], []], /Default profile/],
      [[{}, [], [{ userId: 'alice', profileId: 'none' }]], /no profile/],
      [[{}, [{ id: 'a', allowed: [] }], [{ userId: 'alice', profileId: 'a' }, { userId: 'alice', profileId: 'a' }]], /twice/],
      [[{}, [], [{ userId: 'a b', profileId: 'a' }]], /User id/],
      [[{ fraud: { national: { callsPerMinute: { warning: -1 } } } }, [], []], /callsPerMinute/]
    ]
    for (const [args, message] of bad) expect(() => projectOutbound(...args), JSON.stringify(args)).toThrow(message)
  })

  it('creates its tables with the trunks, the column of the CDRs and the triggers that count what was used, only where they lack, and no index on the CDRs', () => {
    expect(TRUNK_SCHEMA).toContain(OUTBOUND_SCHEMA)
    // Review 6b, n°16: a lock on acc for 5 s at most, nothing else to build (no CDR is read during a call).
    expect(TRUNK_SQL).toContain("SET LOCAL lock_timeout = '5s';")
    expect(TRUNK_SQL).toContain("ALTER TABLE acc ADD COLUMN external VARCHAR(64) DEFAULT '' NOT NULL;")
    expect(TRUNK_SQL).toContain("CREATE TRIGGER twake_outbound_acc AFTER INSERT ON acc FOR EACH ROW WHEN (NEW.external = 'out') EXECUTE FUNCTION twake_outbound_cdr();")
    expect(TRUNK_SQL).not.toMatch(/CREATE INDEX[^;]*ON acc/)
    expect(SUBSCRIBER_SQL).toContain('ALTER TABLE acc ADD COLUMN IF NOT EXISTS external')
    // OpenSIPS checks the versions of the tables of fraud_detection, of the drouting it needs, and of dialog (n°5).
    expect(OUTBOUND_SCHEMA).toContain("('fraud_detection', 1), ('dr_gateways', 6), ('dr_rules', 4), ('dr_carriers', 3), ('dr_groups', 2), ('dialog', 12)")
  })
})

describe('the fallback of a trunk and of a direct number (FR-C8, review 6b, n°1)', () => {
  const TRUNK: Trunk = { id: 'operator', auth: 'ip', domain: 'operator.example', codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }
  it('is projected with them: an extension or a ring group, never a number outside, nor the number\'s own target', () => {
    const p = projectTrunks([{ ...TRUNK, fallbackTarget: '200' }], [{ id: 'd', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101', fallbackTarget: '102' }], 'udp:127.0.0.1:5070')
    expect(p.trunks[0]!.at(-1)).toBe('200')
    expect(p.dids[0]!.at(-1)).toBe('102')
    expect(projectTrunks([TRUNK], [], 'udp:127.0.0.1:5070').trunks[0]!.at(-1)).toBe('')
    for (const n of ['+33199000198', '0199000100', '112', '1', 'a b'])
      expect(() => projectTrunks([{ ...TRUNK, fallbackTarget: n }], [], 'udp:127.0.0.1:5070'), n).toThrow(/fallback is an extension or a ring group/)
    expect(() => projectTrunks([TRUNK], [{ id: 'd', trunkId: 'operator', first: '+33199000101', last: '+33199000101', target: '101', fallbackTarget: '101' }], 'udp:127.0.0.1:5070')).toThrow(/where the number rings already/)
  })
})

const md5 = (s: string) => createHash('md5').update(s).digest('hex')
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
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_outbound -c TimeZone=UTC' })
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
      await pool.query('DELETE FROM acc; DELETE FROM missed_calls; DELETE FROM outbound_usage; DELETE FROM outbound_reservations; DELETE FROM outbound_usage_missed; DELETE FROM dialog')
    })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_outbound CASCADE')
      await pool.end()
    })
    type Verdict = { verdict: string; reason: string; reason_scope: string; max_sec: number }
    /** twake_outbound() as route[outbound_query] asks it: the calls in progress counted with this one. */
    const ask = async (ext: string, { cls = 'fixed', number = '33199000201', user = 1, tenant = 1, key = `k-${Math.random()}`, max = 14400, min = 60 } = {}) =>
      (await pool.query('SELECT * FROM twake_outbound($1, $2, $3, $4, $5, md5($6), $7, $8)', [ext, cls, number, user, tenant, key, max, min])).rows[0] as Verdict
    /** A CDR as OpenSIPS writes it at the end of a call (its trigger counts it). */
    const cdr = (caller: string, external: string, duration: number, callid = `c-${Math.random()}`) =>
      pool.query("INSERT INTO acc (method, callid, time, duration, caller, external) VALUES ('INVITE', $1, localtimestamp, $2, $3, $4)", [callid, duration, caller, external])
    const usage = async (scope: string, subject: string, period = 'd') =>
      (await pool.query("SELECT calls, seconds::int AS seconds FROM outbound_usage WHERE scope = $1 AND subject = $2 AND period = $3 AND start = (CASE WHEN $3 = 'd' THEN (now() AT TIME ZONE 'Europe/Paris')::date ELSE date_trunc('month', now() AT TIME ZONE 'Europe/Paris')::date END)", [scope, subject, period])).rows[0] as { calls: number; seconds: number } | undefined

    it('writes the rules once, and says when the thresholds changed (OpenSIPS reloads them then only)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      // The default thresholds are there from the start (TRUNK_SQL): nothing for OpenSIPS to reload.
      expect((await pool.query('SELECT ruleid, prefix, cpm_warning, cpm_critical, call_duration_critical FROM fraud_detection WHERE ruleid <= 3 ORDER BY ruleid')).rows).toEqual([
        { ruleid: 1, prefix: '33', cpm_warning: 6, cpm_critical: 20, call_duration_critical: 14400 },
        { ruleid: 2, prefix: '', cpm_warning: 3, cpm_critical: 6, call_duration_critical: 3600 },
        { ruleid: 3, prefix: '33262', cpm_warning: 3, cpm_critical: 6, call_duration_critical: 3600 }
      ])
      expect(await t.set({}, PROFILES, [{ userId: 'alice', profileId: 'national' }])).toEqual({ fraud: false })
      expect(await t.set({}, [...PROFILES].reverse(), [{ userId: 'alice', profileId: 'national' }])).toEqual({ fraud: false })
      expect((await pool.query('SELECT count(*)::int AS n FROM fraud_detection')).rows[0].n).toBe(18)
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
      expect(await ask('101', { cls: 'mobile' })).toMatchObject({ verdict: 'ok' })
      expect(await ask('101', { cls: 'international' })).toEqual({ verdict: 'rights', reason: 'international', reason_scope: 'user', max_sec: 0 })
      expect(await ask('102', { cls: 'fixed' })).toMatchObject({ verdict: 'rights', reason: 'fixed' })
      expect(await ask('103', { cls: 'international' })).toMatchObject({ verdict: 'ok' })
      await t.set({ defaultProfile: 'internal' }, PROFILES, [{ userId: 'alice', profileId: 'national' }])
      expect(await ask('103')).toMatchObject({ verdict: 'rights' })
      expect(await ask('102')).toMatchObject({ verdict: 'rights' })
      // An extension without an account, or not one of ours: the default profile all the same, never more.
      expect(await ask('999')).toMatchObject({ verdict: 'rights' })
    })

    it('holds the default caps before the Gateway wrote anything, and refuses past the calls at the same time, this one counted (review 6b, n°6, n°10)', async () => {
      await pool.query('DELETE FROM outbound_settings; DELETE FROM outbound_profiles; DELETE FROM outbound_users')
      // One call asked about again and again (its own reservation never counts against it).
      const key = 'one-call'
      expect(await ask('101', { user: 2, tenant: 2, key })).toMatchObject({ verdict: 'ok' })
      expect(await ask('101', { user: 3, tenant: 3, key })).toEqual({ verdict: 'limit', reason: 'concurrent', reason_scope: 'user', max_sec: 0 })
      expect(await ask('101', { user: 1, tenant: 21, key })).toEqual({ verdict: 'limit', reason: 'concurrent', reason_scope: 'tenant', max_sec: 0 })
      // 300 minutes a day a person, 3000 for the organisation: a call alone may have all that is left, but no more than
      // the critical duration of its number (4 h in France, 1 h abroad), and reserves no more (second review 6b, n°5).
      expect((await ask('101', { user: 1, tenant: 1, key })).max_sec).toBe(14400)
      expect((await pool.query('SELECT seconds FROM outbound_reservations WHERE call_key = md5($1)', [key])).rows).toEqual([{ seconds: 14400 }])
      expect((await ask('101', { user: 1, tenant: 1, key: 'abroad', number: '442079460123', cls: 'international' })).max_sec).toBe(Math.floor((18000 - 14400) / 2))
      await pool.query("DELETE FROM outbound_reservations WHERE call_key = md5('one-call')")
      expect((await ask('101', { user: 2, tenant: 2, key: 'abroad', number: '442079460123', cls: 'international' })).max_sec).toBe(3600)
      expect((await pool.query("SELECT seconds FROM outbound_reservations WHERE call_key = md5('abroad')")).rows).toEqual([{ seconds: 3600 }])
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: null, dailyMinutes: null }, userCaps: { concurrent: null, dailyMinutes: null } }, [], [])
      expect(await ask('101', { user: 50, tenant: 500 })).toEqual({ verdict: 'ok', reason: '', reason_scope: '', max_sec: 14400 })
    })

    it('counts the answered calls to the public network of the day and the month as their CDR is written, never an emergency call, and reads no CDR (review 6b, n°15)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: null, dailyCalls: 10, monthlyMinutes: 100 } }, [{ id: 'p', allowed: ['fixed'], caps: { concurrent: null, dailyCalls: 3, monthlyCalls: 5, dailyMinutes: 2 } }], [{ userId: 'alice', profileId: 'p' }])
      await cdr('101', 'out', 30)
      await cdr('101', 'out', 45)
      await cdr('101', 'emergency', 600)
      await cdr('101', '', 600)
      await cdr('102', 'out', 120)
      expect(await usage('user', '101')).toEqual({ calls: 2, seconds: 75 })
      expect(await usage('user', '101', 'm')).toEqual({ calls: 2, seconds: 75 })
      expect(await usage('tenant', '')).toEqual({ calls: 3, seconds: 195 })
      // Hers: 3 - 2 calls today, this one counted: the last; 120 s - 75 s left of her minutes today.
      expect(await ask('101', { min: 5 })).toEqual({ verdict: 'ok', reason: 'dailyMinutes', reason_scope: 'user', max_sec: 45 })
      await cdr('101', 'out', 10)
      expect(await ask('101', { min: 5 })).toEqual({ verdict: 'limit', reason: 'dailyCalls', reason_scope: 'user', max_sec: 0 })
      // The CDRs are never read: what they hold is in outbound_usage (the CDRs locked, the answer all the same).
      const locker = await pool.connect()
      try {
        await locker.query('BEGIN')
        await locker.query('LOCK TABLE acc IN ACCESS EXCLUSIVE MODE')
        expect(await ask('102', { min: 5 })).toMatchObject({ verdict: 'ok' })
      } finally {
        await locker.query('ROLLBACK')
        locker.release()
      }
      // The organisation's minutes: everyone's (6000 s a month, 205 used, 5700 more), the calls above ended.
      await pool.query('DELETE FROM outbound_reservations')
      await cdr('103', 'out', 5700)
      expect(await ask('103', { min: 5 })).toMatchObject({ verdict: 'ok', reason: 'monthlyMinutes', reason_scope: 'tenant', max_sec: 6000 - 5905 })
    })

    it('shares the minutes left between the calls in progress as PostgreSQL holds them, whatever OpenSIPS counted, and reserves each share until its CDR or missed call (second review 6b, n°3, n°5)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: null, dailyMinutes: null } }, [{ id: 'p', allowed: ['fixed'], caps: { concurrent: 3, dailyMinutes: 10 } }], [{ userId: 'alice', profileId: 'p' }])
      // 600 s. Alone (whatever count OpenSIPS passes, 3 here), a call gets all that is left, as long as it may last
      // (300 s here); the next one half of what the first leaves, the third a third of what the two leave.
      const a = await ask('101', { user: 3, key: 'a', max: 300, min: 5 })
      const b = await ask('101', { user: 1, key: 'b', min: 5 })
      const c = await ask('101', { user: 2, key: 'c', min: 5 })
      expect([a.max_sec, b.max_sec, c.max_sec]).toEqual([300, 150, 50])
      expect((await pool.query('SELECT sum(seconds)::int AS s FROM outbound_reservations')).rows[0].s).toBeLessThanOrEqual(600)
      // Asked again for the same call (a retry): its own reservation does not count against it.
      expect((await ask('101', { user: 3, key: 'c', min: 5 })).max_sec).toBe(50)
      // The first ends after 50 s: its CDR releases its reservation and counts its 50 s.
      await cdr('101', 'out', 50, 'a')
      expect((await pool.query('SELECT call_key FROM outbound_reservations ORDER BY call_key')).rows.map(r => r.call_key)).toEqual([...['b', 'c'].map(k => md5(k))].sort())
      // A call that rang out (its missed call) releases its own.
      await pool.query("INSERT INTO missed_calls (method, callid, time, caller, external) VALUES ('INVITE', 'b', localtimestamp, '101', 'out')")
      expect((await pool.query('SELECT count(*)::int AS n FROM outbound_reservations')).rows[0].n).toBe(1)
      // Left: 600 - 50 used - 50 reserved by c = 500, for c and this one.
      expect((await ask('101', { user: 2, key: 'd', min: 5 })).max_sec).toBe(250)
      // Less than the shortest call: refused.
      expect(await ask('101', { user: 2, key: 'e', min: 400 })).toEqual({ verdict: 'limit', reason: 'dailyMinutes', reason_scope: 'user', max_sec: 0 })
      // A reservation past its time (OpenSIPS gone) holds nothing.
      await pool.query("UPDATE outbound_reservations SET until = now() - interval '1 second'")
      expect((await ask('101', { user: 1, key: 'f', min: 5 })).max_sec).toBe(550)
    })

    it('gives two calls asked at the same instant the same outcome every time, whichever PostgreSQL serves first, never more than is left (second review 6b, n°3)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: null, dailyMinutes: null } }, [{ id: 'p', allowed: ['fixed'], caps: { concurrent: 2, dailyMinutes: 10 } }], [{ userId: 'alice', profileId: 'p' }])
      const two = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_outbound -c TimeZone=UTC' })
      try {
        const rounds = new Set<string>()
        for (let i = 0; i < 10; i++) {
          await pool.query('DELETE FROM outbound_reservations')
          // As OpenSIPS counts them under its lock: one sees 1 call in progress, the other 2.
          const asked = await Promise.all([1, 2].map(n => two.query('SELECT * FROM twake_outbound($1, $2, $3, $4, $5, md5($6), $7, $8)', ['101', 'fixed', '33199000201', n, n, `r${i}-${n}`, 14400, 60]).then(r => r.rows[0] as Verdict)))
          rounds.add(asked.map(v => `${v.verdict}:${v.max_sec}`).sort().join(' '))
          expect(asked.reduce((sum, v) => sum + v.max_sec, 0)).toBeLessThanOrEqual(600)
        }
        // The first served holds the 600 s (prepaid-like): the other finds nothing left, every round alike.
        expect([...rounds]).toEqual(['limit:0 ok:600'])
      } finally {
        await two.end()
      }
    })

    it('bounds a call by the critical duration of the thresholds of its number, overseas as abroad (review 6b, n°14)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: null, dailyMinutes: null }, userCaps: { concurrent: null, dailyMinutes: null } }, [], [])
      expect((await ask('103', { number: '33199000201' })).max_sec).toBe(14400)
      expect((await ask('103', { number: '442079460123', cls: 'international' })).max_sec).toBe(3600)
      expect((await ask('103', { number: '33262262000000', cls: 'overseas' })).max_sec).toBe(3600)
      expect((await ask('103', { number: '33199000201', max: 600 })).max_sec).toBe(600)
    })

    it('counts a call on the day it was answered in Europe/Paris, whatever the time zone of the session (review 6b, n°13)', async () => {
      // The seconds since midnight in Paris: a call answered a minute after it, ended now, belongs to today there,
      // though that minute is still yesterday in UTC.
      const { rows } = await pool.query("SELECT extract(epoch FROM (now() AT TIME ZONE 'Europe/Paris') - date_trunc('day', now() AT TIME ZONE 'Europe/Paris'))::int AS s, current_setting('TimeZone') AS tz")
      expect(rows[0].tz).toBe('UTC')
      const since = rows[0].s as number
      if (since < 120) return
      await cdr('102', 'out', since - 60)
      expect(await usage('user', '102')).toEqual({ calls: 1, seconds: since - 60 })
      // Answered a minute before midnight in Paris: yesterday's call, its seconds since midnight today's (n°11).
      await cdr('102', 'out', since + 60)
      expect(await usage('user', '102')).toEqual({ calls: 1, seconds: 2 * since - 60 })
    })

    it('counts the seconds of a call across midnight in each day and month they were spent in, the call itself on the day it was answered (second review 6b, n°11)', async () => {
      const add = async (end: string, secs: number) =>
        (await pool.query("SELECT scope, subject, period, start::text AS start, calls, seconds::int AS seconds FROM twake_outbound_add('101', $1::timestamptz, $2) WHERE scope = 'user' ORDER BY period, start", [end, secs])).rows
      // Ended at 00:10 on 1 November in Paris (23:10 UTC the day before), answered 20 min before: 10 min each side.
      expect(await add('2026-10-31T23:10:00Z', 1200)).toEqual([
        { scope: 'user', subject: '101', period: 'd', start: '2026-10-31', calls: 1, seconds: 600 },
        { scope: 'user', subject: '101', period: 'd', start: '2026-11-01', calls: 0, seconds: 600 },
        { scope: 'user', subject: '101', period: 'm', start: '2026-10-01', calls: 1, seconds: 600 },
        { scope: 'user', subject: '101', period: 'm', start: '2026-11-01', calls: 0, seconds: 600 }
      ])
      // Within a day: all of it there; the organisation's rows alike.
      expect(await add('2026-10-15T10:00:00.400Z', 61)).toEqual([
        { scope: 'user', subject: '101', period: 'd', start: '2026-10-15', calls: 1, seconds: 61 },
        { scope: 'user', subject: '101', period: 'm', start: '2026-10-01', calls: 1, seconds: 61 }
      ])
      expect((await pool.query("SELECT count(*)::int AS n, sum(seconds)::int AS s FROM twake_outbound_add('101', '2026-10-31T23:10:00.700Z', 1201) WHERE scope = 'tenant' AND period = 'd'")).rows[0]).toEqual({ n: 2, s: 1201 })
    })

    it('never holds a CDR for a lock on what counts it: written at once, counted as missed, read by the caps, counted by the next CDR (second review 6b, n°2)', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: null, dailyMinutes: null } }, [{ id: 'p', allowed: ['fixed'], caps: { concurrent: null, dailyMinutes: 10 } }], [{ userId: 'alice', profileId: 'p' }])
      expect(TRIGGER_LOCK_TIMEOUT).toBe('200ms')
      expect(await ask('101', { key: 'held', min: 5 })).toMatchObject({ max_sec: 600 })
      const locker = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=spec_outbound' })
      await locker.connect()
      try {
        await locker.query('BEGIN')
        await locker.query('LOCK TABLE outbound_usage IN EXCLUSIVE MODE')
        await locker.query('LOCK TABLE outbound_reservations IN EXCLUSIVE MODE')
        const started = Date.now()
        await cdr('101', 'out', 100, 'held')
        // Written within the trigger's lock timeout (a few of them at most), not when the lock goes.
        expect(Date.now() - started).toBeLessThan(1500)
        expect((await pool.query("SELECT count(*)::int AS n FROM acc WHERE callid = 'held'")).rows[0].n).toBe(1)
        expect((await pool.query('SELECT subject, seconds::int AS seconds, answered FROM outbound_usage_missed')).rows).toEqual([{ subject: '101', seconds: 100, answered: true }])
      } finally {
        await locker.query('ROLLBACK')
        await locker.end()
      }
      // The caps read it already: 600 - 100 left, the reservation of the call over.
      expect((await ask('101', { key: 'next', min: 5 })).max_sec).toBe(500)
      await pool.query('DELETE FROM outbound_reservations')
      // The next CDR counts it, and itself.
      await cdr('101', 'out', 20)
      expect((await pool.query('SELECT count(*)::int AS n FROM outbound_usage_missed')).rows[0].n).toBe(0)
      expect(await usage('user', '101')).toEqual({ calls: 2, seconds: 120 })
    })

    it('at a restart, releases the reservations of the calls the crash lost and bounds the emergency calls restored (second review 6b, n°4, n°10)', async () => {
      const dialog = (callid: string, profiles: string, timeout: number) =>
        pool.query("INSERT INTO dialog (dlg_id, callid, from_uri, from_tag, to_uri, to_tag, caller_cseq, callee_cseq, caller_ping_cseq, callee_ping_cseq, caller_sock, callee_sock, state, start_time, timeout, profiles) VALUES ((random() * 1e12)::bigint, $1, 'sip:101@x', 'a', 'sip:112@x', 'b', '1', '1', 0, 0, 'udp:127.0.0.1:5060', 'udp:127.0.0.1:5070', 4, extract(epoch FROM now())::int, $2, $3)", [callid, timeout, profiles])
      const now = Math.floor(Date.now() / 1000)
      await dialog('answered', 'trunk_caller#101#,trunk_out##', now + 3000)
      await dialog('sos', 'trunk_emergency##', now + 604800)
      await pool.query("INSERT INTO outbound_reservations (call_key, subject, seconds, until) VALUES (md5('answered'), '101', 300, now() + interval '1 hour'), (md5('ringing'), '101', 300, now() + interval '1 hour')")
      expect(EMERGENCY_RESTORED_SEC).toBe(7200)
      expect((await pool.query('SELECT twake_outbound_restart($1) AS r', [EMERGENCY_RESTORED_SEC])).rows[0].r).toMatch(/^1 reservation\(s\) of calls lost released, 1 emergency call\(s\) bounded/)
      expect((await pool.query('SELECT call_key FROM outbound_reservations')).rows).toEqual([{ call_key: md5('answered') }])
      const left = (await pool.query("SELECT callid, timeout - extract(epoch FROM now())::int AS left FROM dialog ORDER BY callid")).rows as { callid: string; left: number }[]
      expect(left[0]).toMatchObject({ callid: 'answered' })
      expect(left[0]!.left).toBeGreaterThan(2900)
      expect(left[1]).toMatchObject({ callid: 'sos' })
      expect(left[1]!.left).toBeLessThanOrEqual(EMERGENCY_RESTORED_SEC)
      expect(left[1]!.left).toBeGreaterThan(EMERGENCY_RESTORED_SEC - 60)
    })

    it('answers the query of route[outbound_query] with the verdict and the longest the call may last', async () => {
      const t = new OutboundTables({ pool, ready, tenantId: 'spec-A' })
      await t.set({ caps: { concurrent: 5, dailyMinutes: null } }, PROFILES, [{ userId: 'alice', profileId: 'national' }])
      const query = scriptQuery('outbound_query', { o_ext: '101', o_class: 'mobile', o_number: '33639980001', u_active: '1', t_active: '1', o_key: md5('call') }).replace('${TRUNK_MAX_CALL_SEC}', '14400').replace('${TRUNK_MIN_CALL_SEC}', '60')
      // Mayotte (0639): an hour at most, though the 60 minutes of her day are left.
      expect((await pool.query(query)).rows[0]).toEqual({ verdict: 'ok', reason: '', reason_scope: '', max_sec: 3600 })
      expect((await pool.query(query.replace("'33639980001'", "'33199000201'"))).rows[0]).toEqual({ verdict: 'ok', reason: 'dailyMinutes', reason_scope: 'user', max_sec: 3600 })
      // And the query of route[trunk_out] reads the trunk only (n°2): nothing of step 6b there.
      expect(scriptQuery('trunk_query', { ext: '101', called: '+33639980001' })).not.toMatch(/twake_outbound|outbound_/)
    })
  })
}
