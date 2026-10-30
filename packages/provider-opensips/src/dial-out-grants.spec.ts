import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLICK_TO_CALL_ROOM, DIAL_OUT_GRANTS_SCHEMA, DialOutGrants, GRANT_HEADER, JOIN_HEADER } from './dial-out-grants.js'
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
    // Review 8b: the room of a conference, and the call that took the grant.
    for (const sql of [SUBSCRIBER_SQL, TRUNK_SQL, DIAL_OUT_GRANTS_SCHEMA])
      expect(sql).toContain('ALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS room VARCHAR(64);\nALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS used_by VARCHAR(64);\nALTER TABLE dial_out_grants ADD COLUMN IF NOT EXISTS used_call VARCHAR(200);')
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
    expect(db.queries.at(-1)).toEqual({ text: 'DELETE FROM dial_out_grants WHERE tenant_id = $1 AND token = $2 AND used_by IS NULL', values: ['A', token] })
  })

  it("writes a conference's grant (step 8b): the call it takes the place of, or the token of the window it joins, its person's own", async () => {
    const db = recorder()
    const grants = new DialOutGrants({ pool: db.pool, tenantId: 'A', token: () => 'f'.repeat(32) })
    await grants.grant('101', '102', 30, { replaces: 'a84b4c76e66710@pc33.example.test;to-tag=1928301774;from-tag=a6c85cf' })
    await grants.grant('101', '101', 30, { join: '0123456789abcdef'.repeat(2), room: 'twake-call-0123456789abcdef' })
    await grants.grant('101', '103', 30, { room: 'twake-call-0123456789abcdef' })
    const inserts = db.queries.filter(q => q.text.startsWith('INSERT'))
    expect(inserts.map(q => q.text)).toEqual(Array(3).fill('INSERT INTO dial_out_grants (token, tenant_id, extension, number, expires_at, replaces, join_token, room) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, $7, $8)'))
    expect(inserts.map(q => q.values!.slice(5))).toEqual([
      ['a84b4c76e66710@pc33.example.test;to-tag=1928301774;from-tag=a6c85cf', null, null],
      [null, '0123456789abcdef'.repeat(2), 'twake-call-0123456789abcdef'],
      [null, null, 'twake-call-0123456789abcdef']
    ])
    db.queries.splice(0)
    // Nothing a header could be written with, no join for someone else's extension nor both at once.
    for (const [number, conference] of [
      ['102', { replaces: 'c1;to-tag=a;from-tag=b\r\nX-Evil: 1' }],
      ['102', { replaces: 'c1, c2;to-tag=a;from-tag=b' }],
      ['102', { replaces: 'c1;to-tag=a' }],
      ['102', { join: '0123456789abcdef'.repeat(2) }],
      ['101', { join: 'G'.repeat(32) }],
      ['101', { join: '0123456789abcdef'.repeat(2), replaces: 'c1;to-tag=a;from-tag=b' }],
      ['103', { room: "twake-call-0123456789abcdef'\r\nX: 1" }],
      ['103', { room: 'twake-0123456789abcdef' }]
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

describe('the grants of a click-to-call (ADR 0033)', () => {
  it('writes one for a line and a number, in the room of the click-to-calls, with a token nobody is told; never for anything else', async () => {
    const db = recorder()
    const grants = new DialOutGrants({ pool: db.pool, tenantId: 'acme' })
    await grants.grantClickToCall('103', '+33612345678')
    expect(db.queries.map(q => q.text)).toEqual([
      'DELETE FROM dial_out_grants WHERE tenant_id = $1 AND expires_at < now()',
      'INSERT INTO dial_out_grants (token, tenant_id, extension, number, expires_at, room) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6)'
    ])
    expect(db.queries[1]!.values).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), 'acme', '103', '+33612345678', 60, CLICK_TO_CALL_ROOM])
    db.queries.splice(0)
    for (const [line, number] of [["103' OR '1'='1", '102'], ['103', "102' --"], ['103', 'sip:102'], ['103', '1']] as const)
      await expect(grants.grantClickToCall(line, number)).rejects.toMatchObject({ statusCode: 400 })
    expect(db.queries).toEqual([])
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
    const line = tpl.split('\n').find(l => l.includes('$var(meet_query) = "UPDATE dial_out_grants'))!
    /** route[meet_source]'s query for an INVITE carrying `grant`, From `from` (its tag `tag`), to `to`, of Call-ID `callId`. */
    const query = (grant: string, from: string, to: string, tag = 'SCL_tag', callId = 'call-1') =>
      line
        .slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
        .replace(`'" + $ft + "'`, `'${tag}'`)
        .replace(`'" + $ci + "'`, `'${callId}'`)
        .replace(`'" + $avp(meet_grant) + "'`, `'${grant}'`)
        .replace(`'" + $fU + "'`, `'${from}'`)
        .replace(`'" + $rU + "'`, `'${to}'`)
    const take = async (grant: string, from: string, to: string) => (await pool.query(query(grant, from, to))).rowCount
    /** The same query's row, as OpenSIPS reads it into its AVPs (meet_known, meet_replaces, meet_join, meet_room). */
    const taken = async (grant: string, from: string, to: string, tag?: string, callId?: string) => (await pool.query({ text: query(grant, from, to, tag, callId), rowMode: 'array' })).rows

    it("hands OpenSIPS what a conference's grant says, once (step 8b); a grant of step 8 says none of it", async () => {
      const grants = new DialOutGrants({ pool, ready, tenantId: 'spec' })
      const replacing = await grants.grant('9101', '9102', 30, { replaces: 'c1;to-tag=b;from-tag=a', room: 'twake-call-00000000000000a1' })
      const joining = await grants.grant('9101', '9101', 30, { join: 'e'.repeat(32) })
      const plain = await grants.grant('9101', '9102')
      expect(await taken(replacing, '9101', '9102')).toEqual([[1, 'c1;to-tag=b;from-tag=a', '', 'twake-call-00000000000000a1']])
      expect(await taken(replacing, '9101', '9102')).toEqual([])
      expect(await taken(joining, '9101', '9101')).toEqual([[1, '', 'e'.repeat(32), '']])
      expect(await taken(plain, '9101', '9102')).toEqual([[1, '', '', '']])
    })

    it('keeps which call took a grant (review 8b, n°3): its From tag and Call-ID, for the Gateway to compare with its own; a while, then gone with the others past their time', async () => {
      const grants = new DialOutGrants({ pool, ready, tenantId: 'spec' })
      const token = await grants.grant('9101', '9102', 1)
      expect(await grants.taken(token)).toBeUndefined()
      expect(await taken(token, '9101', '9102', 'SCL_k1Z9x', 'a1b2c3@192.0.2.30')).toEqual([[1, '', '', '']])
      expect(await grants.taken(token)).toEqual({ tag: 'SCL_k1Z9x', callId: 'a1b2c3@192.0.2.30' })
      // Withdrawn once taken (the room's call failed after, second review 8b, n°1): it stays, to be read.
      await grants.revoke(token)
      expect(await grants.taken(token)).toEqual({ tag: 'SCL_k1Z9x', callId: 'a1b2c3@192.0.2.30' })
      // Used: another call with the same grant takes nothing, and the first one's stays written.
      expect(await taken(token, '9101', '9102', 'SCL_other', 'other@192.0.2.31')).toEqual([])
      expect(await grants.taken(token)).toEqual({ tag: 'SCL_k1Z9x', callId: 'a1b2c3@192.0.2.30' })
      // Kept 10 minutes from its use (a grant of 1 s, still there to compare), then deleted at a next grant.
      await new Promise(r => setTimeout(r, 1_100))
      await grants.grant('9101', '103')
      expect(await grants.taken(token)).toEqual({ tag: 'SCL_k1Z9x', callId: 'a1b2c3@192.0.2.30' })
      await pool.query("UPDATE dial_out_grants SET expires_at = now() - interval '1 second' WHERE token = $1", [token])
      await grants.grant('9101', '103')
      expect(await grants.taken(token)).toBeUndefined()
    })

    const ctcLine = tpl.split('\n').find(l => l.includes('$var(ctc_query) = "UPDATE dial_out_grants'))!
    /** The REFER's query of a click-to-call (ADR 0033): the call Wazo placed to `line`, showing `number`. */
    const takeClickToCall = async (line: string, number: string, callId = 'wazo-call-1') =>
      (await pool.query(ctcLine.slice(ctcLine.indexOf('"') + 1, ctcLine.lastIndexOf('"')).replace(`'" + $dlg_val(wline_callee) + "'`, `'${line}'`).replace(`'" + $dlg_val(wline_caller) + "'`, `'${number}'`).replaceAll(`'" + $ci + "'`, `'${callId}'`))).rowCount

    it('lets OpenSIPS take a click-to-call grant once, for its line and its number, before its expiry; never a grant of a room', async () => {
      const grants = new DialOutGrants({ pool, ready, tenantId: 'spec' })
      await grants.grantClickToCall('9101', '+33612345678')
      expect(await takeClickToCall('9102', '+33612345678')).toBe(0)
      expect(await takeClickToCall('9101', '+33612345679')).toBe(0)
      expect(await takeClickToCall('9101', '+33612345678')).toBe(1)
      // A copy of that REFER, in the same call: found again. Another call: nothing.
      expect(await takeClickToCall('9101', '+33612345678')).toBe(1)
      expect(await takeClickToCall('9101', '+33612345678', 'wazo-call-2')).toBe(0)
      // A room's grant for the same person and number is no click-to-call's (and its token no REFER carries).
      const room = await grants.grant('9101', '102')
      expect(await takeClickToCall('9101', '102')).toBe(0)
      expect(await take(room, '9101', '102')).toBe(1)
      // Past its time.
      await grants.grantClickToCall('9101', '103', 1)
      await pool.query("UPDATE dial_out_grants SET expires_at = now() - interval '1 second' WHERE room = 'click-to-call' AND number = '103'")
      expect(await takeClickToCall('9101', '103')).toBe(0)
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
