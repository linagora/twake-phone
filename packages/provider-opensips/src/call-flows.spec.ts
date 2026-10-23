import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CALL_FLOWS_SCHEMA, CallFlows } from './call-flows.js'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, SubscriberProvisioner } from './subscriber.js'

const recorder = (rows: unknown[] = []) => {
  const queries: { text: string; values?: unknown[] }[] = []
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim(), values })
      return { rows, rowCount: rows.length }
    }
  }
  return { queries, pool }
}

describe('CALL_FLOWS_SCHEMA', () => {
  it('is created at each start of the Gateway and by the file of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(CALL_FLOWS_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS call_flows')
  })
})

describe('CallFlows', () => {
  it('lists the flows of its tenant only', async () => {
    const db = recorder([{ number: '801', route: 'queue|g1|120' }])
    expect(await new CallFlows({ pool: db.pool, tenantId: 'A' }).list()).toEqual([{ number: '801', route: 'queue|g1|120' }])
    expect(db.queries[0]).toMatchObject({ text: 'SELECT number, route FROM call_flows WHERE tenant_id = $1 ORDER BY number', values: ['A'] })
  })

  it('writes exactly these flows in one statement, leaves out what OpenSIPS would not read, and never touches another tenant', async () => {
    const db = recorder()
    const out = await new CallFlows({ pool: db.pool, tenantId: 'A' }).set([
      { number: '801', route: 'queue|g1|120' },
      { number: '800', route: 'menu|1=e:102~2=q:g1:120|twake-menu' },
      { number: 'abc', route: 'queue|g|1' },
      { number: '802', route: 'queue|g 2|1' },
      { number: '803', route: "queue|g';DROP|1" }
    ])
    expect(out.skipped).toEqual(['abc', '802', '803'])
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0]!.values).toEqual(['A', ['801', '800'], ['queue|g1|120', 'menu|1=e:102~2=q:g1:120|twake-menu']])
    expect(db.queries[0]!.text).toContain('DELETE FROM call_flows WHERE tenant_id = $1 AND NOT (number = ANY($2::text[]))')
    expect(db.queries[0]!.text).toContain('WHERE call_flows.tenant_id = EXCLUDED.tenant_id')
  })

  it('waits for the schema check of the provider before each query', async () => {
    const db = recorder()
    const order: string[] = []
    const flows = new CallFlows({ pool: { query: async (t, v) => (order.push('query'), db.pool.query(t, v)) }, ready: async () => void order.push('ready') })
    await flows.list()
    expect(order).toEqual(['ready', 'query'])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the SQL itself, as OpenSIPS will read what it writes.
if (process.env.TEST_DATABASE_URL) {
  describe('CallFlows on PostgreSQL', () => {
    // A schema of its own: subscriber.spec.ts drops and creates the same tables at the same time (in parallel).
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_call_flows' })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_call_flows CASCADE')
      await pool.end()
    })
    const ready = async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS spec_call_flows')
      await new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).ensureSchema()
    }
    beforeAll(ready)

    it('keeps each tenant to its own flows, replaces a route, drops the others, and never takes the number of another tenant', async () => {
      const a = new CallFlows({ pool, ready, tenantId: 'spec-A' })
      const b = new CallFlows({ pool, ready, tenantId: 'spec-B' })
      await pool.query("DELETE FROM call_flows WHERE number IN ('9800', '9801', '9802')")
      expect(await a.set([{ number: '9800', route: 'menu|1=q:g1:90|twake-menu' }, { number: '9801', route: 'queue|g1|90' }, { number: 'x', route: 'queue|g1|90' }])).toEqual({ skipped: ['x'] })
      await b.set([{ number: '9801', route: 'seq|stolen|10' }, { number: '9802', route: 'seq|g2|10' }])
      expect(await a.list()).toEqual([{ number: '9800', route: 'menu|1=q:g1:90|twake-menu' }, { number: '9801', route: 'queue|g1|90' }])
      expect(await b.list()).toEqual([{ number: '9802', route: 'seq|g2|10' }])
      // A route changed is written; one not in the list goes; the other tenant's stay theirs.
      await a.set([{ number: '9801', route: 'queue|g1|60' }])
      expect(await a.list()).toEqual([{ number: '9801', route: 'queue|g1|60' }])
      expect(await b.list()).toEqual([{ number: '9802', route: 'seq|g2|10' }])
      await a.set([])
      await b.set([])
      expect(await a.list()).toEqual([])
    })
  })
}
