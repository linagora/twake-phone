import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_TABLE_VERSION, SubscriberProvisioner, digestHashes } from './subscriber.js'

describe('SUBSCRIBER_SCHEMA', () => {
  it('is the SQL the Compose stack loads into PostgreSQL at first start (docker/opensips/subscriber.sql)', () => {
    const file = readFileSync(new URL('../../../docker/opensips/subscriber.sql', import.meta.url), 'utf8')
    const statements = (sql: string) => sql.split('\n').filter(l => !l.startsWith('--')).join('\n').trim()
    expect(statements(file)).toBe(statements(SUBSCRIBER_SCHEMA))
  })
})

describe('digestHashes', () => {
  it('computes the HA1 values auth_db compares against (RFC 7616 A1 = user:realm:password)', () => {
    // md5("101:sip.example.test:s3cret"), checked with `printf '101:sip.example.test:s3cret' | md5sum`.
    const h = digestHashes('101', 'sip.example.test', 's3cret')
    expect(h.ha1).toBe('4c72c8368eb8ec309fc6be33755cdccd')
    expect(h.ha1Sha256).toHaveLength(64)
    expect(h.ha1Sha512t256).toHaveLength(64)
    expect(digestHashes('101', 'other.realm', 's3cret').ha1).not.toBe(h.ha1)
  })
})

describe('SubscriberProvisioner', () => {
  it('writes the hashes, never the secret, and upserts on the account', async () => {
    const queries: { text: string; values?: unknown[] }[] = []
    const p = new SubscriberProvisioner({ pool: { query: async (text, values) => void queries.push({ text, values }) }, realm: 'sip.example.test' })
    await p.setSipSecret('101', 's3cret')
    await p.setSipSecret('101', 'another')
    expect(queries).toHaveLength(2)
    expect(queries[0]!.text).toMatch(/INSERT INTO subscriber/)
    expect(queries[0]!.text).toMatch(/ON CONFLICT \(username, domain\)/)
    expect(queries[0]!.values).toEqual(['101', '', '4c72c8368eb8ec309fc6be33755cdccd', expect.any(String), expect.any(String)])
    expect(JSON.stringify(queries)).not.toContain('s3cret')
  })

  it('refuses an extension that is not a SIP user name', async () => {
    const p = new SubscriberProvisioner({ pool: { query: async () => undefined }, realm: 'r' })
    await expect(p.setSipSecret("101' OR 1=1", 'x')).rejects.toMatchObject({ statusCode: 400 })
    await expect(p.setSipSecret('', 'x')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('needs a realm and a database', () => {
    expect(() => new SubscriberProvisioner({ pool: { query: async () => undefined }, realm: '' })).toThrow(/realm/)
    expect(() => new SubscriberProvisioner({ realm: 'r' })).toThrow(/database/)
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the schema OpenSIPS expects, and the row it reads.
if (process.env.TEST_DATABASE_URL) {
  describe('SubscriberProvisioner on PostgreSQL', () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
    afterAll(() => pool.end())

    it('creates the subscriber and version tables and keeps one row per extension', async () => {
      await pool.query('DROP TABLE IF EXISTS subscriber; DROP TABLE IF EXISTS version;')
      const p = new SubscriberProvisioner({ pool, realm: 'sip.example.test' })
      await p.ensureSchema()
      await p.ensureSchema() // idempotent
      await p.setSipSecret('101', 'first')
      await p.setSipSecret('101', 'second')
      await p.setSipSecret('102', 'other')
      const { rows } = await pool.query('SELECT username, domain, password, ha1 FROM subscriber ORDER BY username')
      expect(rows).toEqual([
        { username: '101', domain: '', password: '', ha1: digestHashes('101', 'sip.example.test', 'second').ha1 },
        { username: '102', domain: '', password: '', ha1: digestHashes('102', 'sip.example.test', 'other').ha1 }
      ])
      const version = await pool.query("SELECT table_version FROM version WHERE table_name = 'subscriber'")
      expect(version.rows[0]).toEqual({ table_version: SUBSCRIBER_TABLE_VERSION })
      await p.removeSipSecret('101')
      expect((await pool.query('SELECT username FROM subscriber')).rows).toEqual([{ username: '102' }])
    })
  })
}
