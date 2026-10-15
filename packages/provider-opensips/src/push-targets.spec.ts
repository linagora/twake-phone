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
      return text.trim().startsWith('SELECT') ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }
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
    expect(db.queries.map(q => q.values)).toEqual([
      ['A', ['102'], ['jean']],
      ['A', ['102'], ['jean']]
    ])
    expect(db.queries[0].text).toMatch(/^DELETE FROM push_targets p WHERE p.tenant_id = \$1 AND NOT EXISTS/)
    // Another tenant's row on the same extension stays theirs.
    expect(db.queries[1].text).toContain('ON CONFLICT (extension) DO UPDATE SET holder = EXCLUDED.holder, updated_at = now() WHERE push_targets.tenant_id = EXCLUDED.tenant_id')
    // Nobody: the tenant's rows go, nothing is inserted.
    const none = recorder()
    await new PushTargets({ pool: none.pool }).set([])
    expect(none.queries).toHaveLength(1)
    expect(none.queries[0].values).toEqual(['default', [], []])
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
      // 9102 now belongs to someone else in the directory: Jean's row goes.
      await a.reconcile([{ extension: '9102', userId: 'paul' }])
      expect(await a.list()).toEqual([])
    })
  })
}
