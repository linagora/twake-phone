import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DIAL_OUT_GRANTS_SCHEMA, DialOutGrants, GRANT_HEADER, JOIN_HEADER } from './dial-out-grants.js'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, SubscriberProvisioner } from './subscriber.js'
import { TRUNK_SQL } from './trunks.js'

/** A pool that records what it is asked. */
const recorder = () => {
  const queries: { text: string; values?: unknown[] }[] = []
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim(), values })
      return { rows: [], rowCount: 0 }
    }
  }
  return { queries, pool }
}

describe('DIAL_OUT_GRANTS_SCHEMA', () => {
  it('is created at each start of the Gateway and by the files of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(DIAL_OUT_GRANTS_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS dial_out_grants')
    expect(TRUNK_SQL).toContain('CREATE TABLE IF NOT EXISTS dial_out_grants')
    expect(GRANT_HEADER).toBe('X-Twake-Grant')
    expect(JOIN_HEADER).toBe('Twake-Join')
    // Step 8b: the columns of a conference's grants, added to a table of step 8.
    for (const sql of [SUBSCRIBER_SQL, TRUNK_SQL]) expect(sql).toContain('ALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS replaces VARCHAR(320);\nALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS join_token VARCHAR(64);')
  })
})

describe('DialOutGrants', () => {
  it("writes one grant of its tenant, with a token of 32 hexadecimal characters, after the tenant's expired ones go", async () => {
    const db = recorder()
    let ready = 0
    const grants = new DialOutGrants({ pool: db.pool, tenantId: 'A', ready: async () => void ready++ })
    const token = await grants.grant('101', '+33612345678')
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(await grants.grant('101', '+33612345678')).not.toBe(token)
    expect(ready).toBe(2)
    expect(db.queries[0]).toEqual({ text: 'DELETE FROM dial_out_grants WHERE tenant_id = $1 AND expires_at < now()', values: ['A'] })
    expect(db.queries[1]).toEqual({
      text: 'INSERT INTO dial_out_grants (token, tenant_id, extension, number, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))',
      values: [token, 'A', '101', '+33612345678', 30]
    })
    await grants.revoke(token)
    expect(db.queries.at(-1)).toEqual({ text: 'DELETE FROM dial_out_grants WHERE tenant_id = $1 AND token = $2', values: ['A', token] })
  })

  it("writes a conference's grant (step 8b): the call it takes the place of, or the token of the window it joins, its person's own", async () => {
    const db = recorder()
    const grants = new DialOutGrants({ pool: db.pool, tenantId: 'A', token: () => 'f'.repeat(32) })
    await grants.grant('101', '102', 30, { replaces: 'a84b4c76e66710@pc33.example.test;to-tag=1928301774;from-tag=a6c85cf' })
    await grants.grant('101', '101', 30, { join: '0123456789abcdef'.repeat(2) })
    const inserts = db.queries.filter(q => q.text.startsWith('INSERT'))
    expect(inserts.map(q => q.text)).toEqual(Array(2).fill('INSERT INTO dial_out_grants (token, tenant_id, extension, number, expires_at, replaces, join_token) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, $7)'))
    expect(inserts.map(q => q.values!.slice(5))).toEqual([
      ['a84b4c76e66710@pc33.example.test;to-tag=1928301774;from-tag=a6c85cf', null],
      [null, '0123456789abcdef'.repeat(2)]
    ])
    db.queries.splice(0)
    // Nothing a header could be written with, no join for someone else's extension nor both at once.
    for (const [number, conference] of [
      ['102', { replaces: 'c1;to-tag=a;from-tag=b\r\nX-Evil: 1' }],
      ['102', { replaces: 'c1, c2;to-tag=a;from-tag=b' }],
      ['102', { replaces: 'c1;to-tag=a' }],
      ['102', { join: '0123456789abcdef'.repeat(2) }],
      ['101', { join: 'G'.repeat(32) }],
      ['101', { join: '0123456789abcdef'.repeat(2), replaces: 'c1;to-tag=a;from-tag=b' }]
    ] as const)
      await expect(grants.grant('101', number, 30, conference), JSON.stringify(conference)).rejects.toThrow()
    expect(db.queries).toEqual([])
  })

  it('never writes a grant for something that is no SIP user, no number, or that would live too long', async () => {
    const db = recorder()
    const grants = new DialOutGrants({ pool: db.pool })
    await expect(grants.grant("1' OR '1'='1", '102')).rejects.toMatchObject({ statusCode: 400 })
    await expect(grants.grant('101', "102'; --")).rejects.toMatchObject({ statusCode: 400 })
    await expect(grants.grant('101', '1')).rejects.toMatchObject({ statusCode: 400 })
    await expect(grants.grant('101', '102', 0)).rejects.toThrow(/1 to 300/)
    await expect(grants.grant('101', '102', 301)).rejects.toThrow(/1 to 300/)
    expect(db.queries).toEqual([])
    await grants.grant('101', '102', 300)
    expect(db.queries[1]!.values).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), 'default', '101', '102', 300])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the grants as OpenSIPS takes them, with the very query of
// route[meet_source] read from docker/opensips/opensips.cfg.tpl.
if (process.env.TEST_DATABASE_URL) {
  describe('DialOutGrants on PostgreSQL, taken by OpenSIPS', () => {
    // A schema of its own: other specs drop and create the same tables at the same time (in parallel).
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_dial_out_grants' })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_dial_out_grants CASCADE')
      await pool.end()
    })
    const ready = async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS spec_dial_out_grants')
      await new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).ensureSchema()
    }
    beforeAll(async () => {
      await ready()
      const p = new SubscriberProvisioner({ pool, realm: 'sip.example.test' })
      await p.setSipSecret('9101', 'not-a-real-secret-1')
      await p.setSipSecret('9102', 'not-a-real-secret-2')
    })

    const tpl = readFileSync(fileURLToPath(new URL('../../../docker/opensips/opensips.cfg.tpl', import.meta.url)), 'utf8')
    const line = tpl.split('\n').find(l => l.includes('$var(meet_query) = "DELETE FROM dial_out_grants'))!
    /** route[meet_source]'s query for an INVITE carrying `grant`, From `from`, to `to` (what passed its regexes). */
    const take = async (grant: string, from: string, to: string) => {
      const sql = line
        .slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
        .replace(`'" + $avp(meet_grant) + "'`, `'${grant}'`)
        .replace(`'" + $fU + "'`, `'${from}'`)
        .replace(`'" + $rU + "'`, `'${to}'`)
      return (await pool.query(sql)).rowCount
    }
    /** The same query's row, as OpenSIPS reads it into its AVPs (meet_known, meet_replaces, meet_join). */
    const taken = async (grant: string, from: string, to: string) => {
      const sql = line
        .slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
        .replace(`'" + $avp(meet_grant) + "'`, `'${grant}'`)
        .replace(`'" + $fU + "'`, `'${from}'`)
        .replace(`'" + $rU + "'`, `'${to}'`)
      return (await pool.query({ text: sql, rowMode: 'array' })).rows
    }

    it("hands OpenSIPS what a conference's grant says, once (step 8b); a grant of step 8 says none of it", async () => {
      const grants = new DialOutGrants({ pool, ready, tenantId: 'spec' })
      const replacing = await grants.grant('9101', '9102', 30, { replaces: 'c1;to-tag=b;from-tag=a' })
      const joining = await grants.grant('9101', '9101', 30, { join: 'e'.repeat(32) })
      const plain = await grants.grant('9101', '9102')
      expect(await taken(replacing, '9101', '9102')).toEqual([[1, 'c1;to-tag=b;from-tag=a', '']])
      expect(await taken(replacing, '9101', '9102')).toEqual([])
      expect(await taken(joining, '9101', '9101')).toEqual([[1, '', 'e'.repeat(32)]])
      expect(await taken(plain, '9101', '9102')).toEqual([[1, '', '']])
    })

    it('takes a grant once, before its expiry, for its person and its number only', async () => {
      const grants = new DialOutGrants({ pool, ready, tenantId: 'spec' })
      const token = await grants.grant('9101', '+33612345678')
      // Another person, another number: not that grant.
      expect(await take(token, '9102', '+33612345678')).toBe(0)
      expect(await take(token, '9101', '+33612345679')).toBe(0)
      expect(await take(token, '9101', '+33612345678')).toBe(1)
      // Used.
      expect(await take(token, '9101', '+33612345678')).toBe(0)
      // Past its time.
      const old = await grants.grant('9101', '102', 1)
      await pool.query("UPDATE dial_out_grants SET expires_at = now() - interval '1 second' WHERE token = $1", [old])
      expect(await take(old, '9101', '102')).toBe(0)
      // For an extension that is no account any more.
      const gone = await grants.grant('9199', '102')
      expect(await take(gone, '9199', '102')).toBe(0)
      // Withdrawn.
      const revoked = await grants.grant('9101', '102')
      await grants.revoke(revoked)
      expect(await take(revoked, '9101', '102')).toBe(0)
      // The expired ones go at the next grant.
      await grants.grant('9101', '103')
      expect((await pool.query('SELECT token FROM dial_out_grants WHERE token = $1', [old])).rowCount).toBe(0)
    })
  })
}
