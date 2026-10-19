import { describe, expect, it } from 'vitest'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL } from './subscriber.js'
import { WAZO_LINES_SCHEMA, WazoLines } from './wazo-lines.js'

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

describe('WAZO_LINES_SCHEMA', () => {
  it('is created at each start of the Gateway and by the file of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(WAZO_LINES_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS wazo_lines')
  })
})

describe('WazoLines', () => {
  it('lists the extensions of its tenant only', async () => {
    const db = recorder([{ extension: '102' }, { extension: '103' }])
    expect(await new WazoLines({ pool: db.pool, tenantId: 'A' }).list()).toEqual(['102', '103'])
    expect(db.queries[0]).toMatchObject({ text: 'SELECT extension FROM wazo_lines WHERE tenant_id = $1 ORDER BY extension', values: ['A'] })
  })

  it('writes exactly these extensions in one statement, leaves out what OpenSIPS would not read, and never touches another tenant', async () => {
    const db = recorder()
    const out = await new WazoLines({ pool: db.pool, tenantId: 'A' }).set(['102', '102', '103', 'abc', "1'2", ''])
    expect(out.skipped).toEqual(['abc', "1'2", ''])
    expect(db.queries).toHaveLength(1)
    expect(db.queries[0]!.values).toEqual(['A', ['102', '103']])
    expect(db.queries[0]!.text).toContain('DELETE FROM wazo_lines WHERE tenant_id = $1 AND NOT (extension = ANY($2::text[]))')
    expect(db.queries[0]!.text).toContain('ON CONFLICT (extension) DO NOTHING')
  })

  it('waits for the schema check of the provider before each query', async () => {
    const db = recorder()
    const order: string[] = []
    const lines = new WazoLines({ pool: { query: async (t, v) => (order.push('query'), db.pool.query(t, v)) }, ready: async () => void order.push('ready') })
    await lines.list()
    expect(order).toEqual(['ready', 'query'])
  })
})
