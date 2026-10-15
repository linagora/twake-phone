import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PUSH_TARGETS_SCHEMA, PushTargets } from './push-targets.js'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, SubscriberProvisioner } from './subscriber.js'

/** A pool that records what it is asked and answers `rows` to the SELECTs. */
const recorder = (rows: unknown[] = []) => {
  const queries: { text: string; values?: unknown[] }[] = []
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim(), values })
      return /^(SELECT|WITH)/.test(text.trim()) ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }
    }
  }
  return { queries, pool }
}

describe('PUSH_TARGETS_SCHEMA', () => {
  it('is created at each start of the Gateway and by the file of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(PUSH_TARGETS_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS push_targets')
  })
})

describe('PushTargets', () => {
  it('lists the extensions of its tenant only, with their holder', async () => {
    const db = recorder([{ extension: '102', holder: 'jean' }])
    expect(await new PushTargets({ pool: db.pool, tenantId: 'A' }).list()).toEqual([{ extension: '102', userId: 'jean' }])
    expect(db.queries[0]).toMatchObject({ text: 'SELECT extension, holder FROM push_targets WHERE tenant_id = $1 ORDER BY extension', values: ['A'] })
  })

  it('writes exactly the extensions given, never one that is no SIP user name nor one without a holder', async () => {
    const db = recorder()
    let ready = 0
    await new PushTargets({ pool: db.pool, tenantId: 'A', ready: async () => void ready++ }).set([
      { extension: '102', userId: 'jean' },
      { extension: "1' OR '1'='1", userId: 'eve' },
      { extension: '103', userId: '' }
    ])
    expect(ready).toBe(2)
    // Not alive yet (OpenSIPS not heard): written with no time left (now()).
    expect(db.queries.map(q => q.values)).toEqual([
      ['A', ['102'], ['jean']],
      ['A', ['102'], ['jean'], null]
    ])
    expect(db.queries[1].text).toContain('coalesce($4::timestamptz, now())')
    expect(db.queries[0].text).toMatch(/^DELETE FROM push_targets p WHERE p.tenant_id = \$1 AND NOT EXISTS/)
    // Another tenant's row on the same extension stays theirs; a row already right is not written again.
    expect(db.queries[1].text).toContain('WHERE push_targets.tenant_id = EXCLUDED.tenant_id AND push_targets.holder IS DISTINCT FROM EXCLUDED.holder')
    // Nobody: the tenant's rows go, nothing is inserted.
    const none = recorder()
    await new PushTargets({ pool: none.pool }).set([])
    expect(none.queries).toHaveLength(1)
    expect(none.queries[0].values).toEqual(['default', [], []])
  })
})

describe('PushTargets, one person and the lease', () => {
  it("writes or removes one person's row only, alive as long as the others, and gives up only the life it gave", async () => {
    const until = '2026-10-15 12:00:00.123456+00'
    const db = recorder([{ until }])
    const t = new PushTargets({ pool: db.pool, tenantId: 'A' })
    // Released before it was ever kept alive: nothing to give up.
    await t.release()
    expect(db.queries).toEqual([])
    await t.keepAlive(120)
    await t.setOne({ extension: '102', userId: 'jean' }, true)
    await t.setOne({ extension: '102', userId: 'jean' }, false)
    await t.setOne({ extension: "1' OR '1'='1", userId: 'eve' }, true)
    expect(db.queries.map(q => q.values)).toEqual([
      ['A', 120],
      ['A', '102', 'jean', until],
      ['A', '102', 'jean']
    ])
    // Never shorter than another Gateway of the tenant made them; the life as the database wrote it.
    expect(db.queries[0].text).toBe(
      'WITH t AS (SELECT now() + make_interval(secs => $2) AS until), u AS (UPDATE push_targets p SET alive_until = t.until FROM t WHERE p.tenant_id = $1 AND p.alive_until < t.until) SELECT until::text AS until FROM t'
    )
    expect(db.queries[1].text).toContain('VALUES ($2, $1, $3, coalesce($4::timestamptz, now()))')
    expect(db.queries[2].text).toBe('DELETE FROM push_targets WHERE tenant_id = $1 AND extension = $2 AND holder = $3')
    // Released (the Gateway stops): the rows that still have the life it gave them, not those another one renewed.
    await t.release()
    await t.setOne({ extension: '103', userId: 'bob' }, true)
    expect(db.queries.slice(3).map(q => [q.text, q.values])).toEqual([
      ['UPDATE push_targets SET alive_until = now() WHERE tenant_id = $1 AND alive_until = $2::timestamptz AND alive_until > now()', ['A', until]],
      [expect.stringMatching(/^INSERT INTO push_targets/), ['A', '103', 'bob', null]]
    ])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the SQL itself, as OpenSIPS will read what it writes.
if (process.env.TEST_DATABASE_URL) {
  describe('PushTargets on PostgreSQL', () => {
    // A schema of its own: subscriber.spec.ts drops and creates the same tables at the same time (in parallel).
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_push_targets' })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_push_targets CASCADE')
      await pool.end()
    })
    const ready = async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS spec_push_targets')
      await new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).ensureSchema()
    }
    beforeAll(ready)

    it('keeps each tenant to its own rows, and drops the rows of a holder who no longer holds the extension', async () => {
      const a = new PushTargets({ pool, ready, tenantId: 'spec-A' })
      const b = new PushTargets({ pool, ready, tenantId: 'spec-B' })
      await a.set([
        { extension: '9102', userId: 'jean' },
        { extension: '9103', userId: 'bob' }
      ])
      // B cannot take A's extension, nor remove it.
      await b.set([{ extension: '9102', userId: 'mallory' }])
      expect(await a.list()).toEqual([
        { extension: '9102', userId: 'jean' },
        { extension: '9103', userId: 'bob' }
      ])
      expect(await b.list()).toEqual([])
      await b.set([])
      // What OpenSIPS reads: one row per extension.
      expect((await pool.query("SELECT 1 FROM push_targets WHERE extension = '9102'")).rowCount).toBe(1)
      // Bob unsubscribed his last browser.
      await a.set([{ extension: '9102', userId: 'jean' }])
      expect(await a.list()).toEqual([{ extension: '9102', userId: 'jean' }])
      // Alive only while kept so, as OpenSIPS reads it (alive_until > now()); one person's row alone.
      const alive = async () => (await pool.query("SELECT extension FROM push_targets WHERE extension LIKE '91%' AND alive_until > now() ORDER BY extension")).rows.map(r => r.extension)
      expect(await alive()).toEqual([])
      await a.keepAlive(60)
      expect(await alive()).toEqual(['9102'])
      await a.setOne({ extension: '9104', userId: 'paul' }, true)
      await b.setOne({ extension: '9102', userId: 'mallory' }, true)
      expect(await alive()).toEqual(['9102', '9104'])
      expect(await a.list()).toEqual([
        { extension: '9102', userId: 'jean' },
        { extension: '9104', userId: 'paul' }
      ])
      await a.setOne({ extension: '9104', userId: 'paul' }, false)
      // A second Gateway of the tenant (a new one starting before the old one stops): the rows live as long as the
      // longer life, and the Gateway that stops gives up only the rows whose life is still the one it gave.
      const a2 = new PushTargets({ pool, ready, tenantId: 'spec-A' })
      await a2.keepAlive(120)
      await a.keepAlive(60)
      const lives = async () => (await pool.query("SELECT extension, alive_until > now() + interval '90 seconds' AS long FROM push_targets WHERE extension LIKE '91%' ORDER BY extension")).rows.map(r => `${r.extension} ${r.long}`)
      expect(await lives()).toEqual(['9102 true'])
      await a.release()
      expect(await alive()).toEqual(['9102'])
      await a2.release()
      expect(await alive()).toEqual([])
      expect(await a.list()).toEqual([{ extension: '9102', userId: 'jean' }])
      // 9102 now belongs to someone else in the directory: Jean's row goes.
      await a.reconcile([{ extension: '9102', userId: 'paul' }])
      expect(await a.list()).toEqual([])
    })
  })

  // A push_targets of the first version of step 5 (no alive_until): the Gateway adds the column at its start, as the
  // Compose file does, and then writes and keeps rows alive as on a fresh database.
  describe('PushTargets on a push_targets of the first version', () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_push_targets_v1' })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_push_targets_v1 CASCADE')
      await pool.end()
    })

    it('gains alive_until at the start of the Gateway, its rows kept', async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_push_targets_v1 CASCADE')
      await pool.query('CREATE SCHEMA spec_push_targets_v1')
      await pool.query(`CREATE TABLE push_targets (
        extension VARCHAR(64) PRIMARY KEY NOT NULL,
        tenant_id TEXT DEFAULT '' NOT NULL,
        holder TEXT DEFAULT '' NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      )`)
      await pool.query("INSERT INTO push_targets (extension, tenant_id, holder) VALUES ('9202', 'spec-A', 'jean')")
      await new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).ensureSchema()
      const t = new PushTargets({ pool, tenantId: 'spec-A' })
      await t.keepAlive(60)
      await t.setOne({ extension: '9203', userId: 'bob' }, true)
      // What OpenSIPS reads (opensips.cfg.tpl, route[wake_next] and route[group_next]).
      const { rows } = await pool.query('SELECT extension FROM push_targets WHERE alive_until > now() ORDER BY extension')
      expect(rows.map(r => r.extension)).toEqual(['9202', '9203'])
    })
  })
}
