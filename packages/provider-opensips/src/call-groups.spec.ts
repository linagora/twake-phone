import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CALL_GROUPS_SCHEMA, CallGroups, DISPLAY_NAMES_SCHEMA, GROUP_MEMBERS_MAX, sipDisplayName } from './call-groups.js'
import { SUBSCRIBER_SCHEMA, SUBSCRIBER_SQL, SubscriberProvisioner } from './subscriber.js'

/** A pool that records what it is asked and answers `rows` to the SELECTs, `rowCount` to the rest. */
const recorder = (rows: unknown[] = [], rowCount = 1) => {
  const queries: { text: string; values?: unknown[] }[] = []
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text: text.replace(/\s+/g, ' ').trim(), values })
      return text.trim().startsWith('SELECT') ? { rows, rowCount: rows.length } : { rows: [], rowCount }
    }
  }
  return { queries, pool }
}

describe('CALL_GROUPS_SCHEMA and DISPLAY_NAMES_SCHEMA', () => {
  it('are created at each start of the Gateway and by the file of the Compose stack', () => {
    expect(SUBSCRIBER_SCHEMA).toContain(CALL_GROUPS_SCHEMA.trim())
    expect(SUBSCRIBER_SCHEMA).toContain(DISPLAY_NAMES_SCHEMA.trim())
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS call_groups')
    expect(SUBSCRIBER_SQL).toContain('CREATE TABLE IF NOT EXISTS display_names')
  })
})

describe('sipDisplayName', () => {
  it('keeps a name as it may go into a quoted display name: one line, no quote or backslash, at most 64 characters', () => {
    expect(sipDisplayName('  Jean   Dupont ')).toBe('Jean Dupont')
    expect(sipDisplayName('Élodie Œuvray-Laßmann')).toBe('Élodie Œuvray-Laßmann')
    expect(sipDisplayName('Bob "the boss" \\ Durand')).toBe('Bob the boss Durand')
    expect(sipDisplayName('Alice\r\nX-Evil: 1')).toBe('Alice X-Evil: 1')
    expect(sipDisplayName('a b\u0085c\u007fd')).toBe('a b c d')
    expect(sipDisplayName(undefined)).toBe('')
    expect(sipDisplayName(' " \\ ')).toBe('')
    // 64 characters, not 64 UTF-16 units: an emoji is not cut in half.
    const long = `${'é'.repeat(63)}😀😀`
    expect([...sipDisplayName(long)]).toHaveLength(64)
    expect(sipDisplayName(long).endsWith('😀')).toBe(true)
  })
})

describe('CallGroups', () => {
  it('lists the groups of its tenant only, in the order of their numbers', async () => {
    const db = recorder([{ number: '200', name: 'Accueil', members: ['101', '102'] }])
    expect(await new CallGroups({ pool: db.pool, tenantId: 'A' }).list()).toEqual([{ number: '200', name: 'Accueil', members: ['101', '102'] }])
    expect(db.queries[0]).toMatchObject({ text: 'SELECT number, name, members FROM call_groups WHERE tenant_id = $1 ORDER BY number', values: ['A'] })
  })

  it('creates a group only on a number that is no account of OpenSIPS and no group yet', async () => {
    const db = recorder()
    const groups = new CallGroups({ pool: db.pool, tenantId: 'A' })
    await groups.set({ number: '200', name: ' Accueil  "central" ', members: ['101', '102', '101'] }, 'create')
    expect(db.queries[0]!.text).toMatch(/^INSERT INTO call_groups .* WHERE NOT EXISTS \(SELECT 1 FROM subscriber s WHERE s.username = \$1::text\) ON CONFLICT \(number\) DO NOTHING$/)
    // The name as SIP will carry it, the members once each, in order.
    expect(db.queries[0]!.values).toEqual(['200', 'A', 'Accueil central', ['101', '102']])
    // Nothing written, a group of the tenant has the number: said so.
    await expect(new CallGroups({ pool: recorder([{ tenant_id: 'A' }], 0).pool, tenantId: 'A' }).set({ number: '200', name: 'x', members: ['101'] }, 'create')).rejects.toMatchObject({ statusCode: 409, code: 'GROUP_EXISTS' })
    // Nothing written, an account or another tenant's group has it: the same words for both, nothing about the other tenant.
    for (const rows of [[], [{ tenant_id: 'B' }]]) {
      const err = await new CallGroups({ pool: recorder(rows, 0).pool, tenantId: 'A' }).set({ number: '200', name: 'x', members: ['101'] }, 'create').catch((e: Error) => e)
      expect(err).toMatchObject({ statusCode: 409, code: 'GROUP_NUMBER_TAKEN', message: 'this number is taken' })
    }
  })

  it('replaces a group of its tenant only, and says when it has none', async () => {
    const db = recorder()
    await new CallGroups({ pool: db.pool, tenantId: 'A' }).set({ number: '200', name: 'Accueil', members: ['102'] }, 'replace')
    expect(db.queries[0]).toMatchObject({ text: 'UPDATE call_groups SET name = $3, members = $4, updated_at = now() WHERE number = $1 AND tenant_id = $2', values: ['200', 'A', 'Accueil', ['102']] })
    await expect(new CallGroups({ pool: recorder([], 0).pool, tenantId: 'A' }).set({ number: '200', name: 'x', members: ['101'] }, 'replace')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses what OpenSIPS could not use, before any query', async () => {
    const db = recorder()
    const groups = new CallGroups({ pool: db.pool })
    for (const number of ["200' OR 1=1", '', 'sip:200@x', 'x'.repeat(65)]) await expect(groups.set({ number, name: 'G', members: ['101'] })).rejects.toMatchObject({ statusCode: 400 })
    await expect(groups.set({ number: '200', name: ' "\\ ', members: ['101'] })).rejects.toMatchObject({ statusCode: 400, message: /name/ })
    await expect(groups.set({ number: '200', name: 'G', members: [] })).rejects.toMatchObject({ statusCode: 400 })
    await expect(groups.set({ number: '200', name: 'G', members: Array.from({ length: GROUP_MEMBERS_MAX + 1 }, (_, i) => String(300 + i)) })).rejects.toMatchObject({ statusCode: 400 })
    await expect(groups.set({ number: '200', name: 'G', members: ["101'"] })).rejects.toMatchObject({ statusCode: 400 })
    expect(await groups.delete("200' OR 1=1")).toBe(false)
    expect(db.queries).toEqual([])
  })

  it('deletes a group of its tenant, and says when there was none', async () => {
    const db = recorder()
    expect(await new CallGroups({ pool: db.pool, tenantId: 'A' }).delete('200')).toBe(true)
    expect(db.queries[0]).toMatchObject({ text: 'DELETE FROM call_groups WHERE number = $1 AND tenant_id = $2', values: ['200', 'A'] })
    expect(await new CallGroups({ pool: recorder([], 0).pool, tenantId: 'A' }).delete('200')).toBe(false)
  })

  it('waits for the schema before each query', async () => {
    const order: string[] = []
    const pool = { query: async () => (order.push('query'), { rows: [], rowCount: 0 }) }
    await new CallGroups({ pool, ready: async () => void order.push('ready') }).list()
    expect(order).toEqual(['ready', 'query'])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the SQL itself, as OpenSIPS will read what it writes.
if (process.env.TEST_DATABASE_URL) {
  describe('CallGroups on PostgreSQL', () => {
    // A schema of its own: subscriber.spec.ts drops and creates the same tables at the same time (in parallel).
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, options: '-c search_path=spec_call_groups' })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_call_groups CASCADE')
      await pool.end()
    })
    const ready = async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS spec_call_groups')
      await new SubscriberProvisioner({ pool, realm: 'sip.example.test' }).ensureSchema()
    }
    beforeAll(ready)

    it('keeps each tenant to its own groups, and keeps the members in their order', async () => {
      const a = new CallGroups({ pool, ready, tenantId: 'spec-A' })
      const b = new CallGroups({ pool, ready, tenantId: 'spec-B' })
      await pool.query("DELETE FROM call_groups WHERE number IN ('9200', '9201')")
      await a.set({ number: '9200', name: 'Accueil', members: ['9103', '9101', '9102'] }, 'create')
      await expect(a.set({ number: '9200', name: 'Autre', members: ['9101'] }, 'create')).rejects.toMatchObject({ statusCode: 409, code: 'GROUP_EXISTS' })
      await a.set({ number: '9200', name: 'Accueil', members: ['9102', '9101'] }, 'replace')
      await expect(b.set({ number: '9200', name: 'Pris', members: ['9101'] }, 'create')).rejects.toMatchObject({ statusCode: 409, code: 'GROUP_NUMBER_TAKEN', message: 'this number is taken' })
      await expect(b.set({ number: '9200', name: 'Pris', members: ['9101'] }, 'replace')).rejects.toMatchObject({ statusCode: 404 })
      await b.set({ number: '9201', name: 'Support', members: ['9104'] }, 'create')
      expect(await a.list()).toEqual([{ number: '9200', name: 'Accueil', members: ['9102', '9101'] }])
      expect(await b.list()).toEqual([{ number: '9201', name: 'Support', members: ['9104'] }])
      expect(await b.delete('9200')).toBe(false)
      expect(await a.delete('9200')).toBe(true)
      expect(await b.delete('9201')).toBe(true)
      expect(await a.list()).toEqual([])
    })

    it('never creates a group on the number of an account OpenSIPS has (an extension wins there)', async () => {
      const a = new CallGroups({ pool, ready, tenantId: 'spec-A' })
      const accounts = new SubscriberProvisioner({ pool, realm: 'sip.example.test' })
      await ready()
      await accounts.setSipSecret('9299', 'secret', 'zed')
      try {
        await expect(a.set({ number: '9299', name: 'Accueil', members: ['9101'] }, 'create')).rejects.toMatchObject({ statusCode: 409, code: 'GROUP_NUMBER_TAKEN' })
        expect(await a.list()).toEqual([])
        // Once the account is gone (its holder left), the number is free.
        expect(await accounts.reconcileAccounts([{ extension: '9101', userId: 'ann' }])).toEqual(['9299'])
        expect((await pool.query("SELECT 1 FROM subscriber WHERE username = '9299'")).rowCount).toBe(0)
        await a.set({ number: '9299', name: 'Accueil', members: ['9101'] }, 'create')
        expect(await a.list()).toEqual([{ number: '9299', name: 'Accueil', members: ['9101'] }])
      } finally {
        await a.delete('9299')
        await accounts.removeSipSecret('9299')
      }
    })

    it('writes the directory names of the extensions held, and keeps the members nobody holds now in the groups', async () => {
      const a = new CallGroups({ pool, ready, tenantId: 'spec-A' })
      await pool.query("DELETE FROM display_names WHERE extension LIKE '91%'")
      await pool.query("DELETE FROM call_groups WHERE number = '9200'")
      await a.set({ number: '9200', name: 'Accueil', members: ['9103', '9101', '9102'] }, 'create')
      await pool.query("INSERT INTO display_names (extension, tenant_id, display_name) VALUES ('9109', '', 'Nobody''s')")
      await a.reconcile([
        { extension: '9101', displayName: 'Alice "Al" Martin' },
        { extension: '9103', displayName: 'Bob Durand' },
        { extension: '9104' }
      ])
      const names = await pool.query("SELECT extension, tenant_id, display_name FROM display_names WHERE extension LIKE '91%' ORDER BY extension")
      // No name for 9104 (none in the directory), no row of no tenant.
      expect(names.rows).toEqual([
        { extension: '9101', tenant_id: 'spec-A', display_name: 'Alice Al Martin' },
        { extension: '9103', tenant_id: 'spec-A', display_name: 'Bob Durand' }
      ])
      // 9102 is nobody's now: still a member (a position), in its place.
      expect(await a.list()).toEqual([{ number: '9200', name: 'Accueil', members: ['9103', '9101', '9102'] }])
      // Bob leaves, then everyone: the names go, the members stay until an administrator changes the group.
      await a.reconcile([{ extension: '9101', displayName: 'Alice Martin' }])
      expect((await pool.query("SELECT extension, display_name FROM display_names WHERE extension LIKE '91%'")).rows).toEqual([{ extension: '9101', display_name: 'Alice Martin' }])
      await a.reconcile([])
      expect(await a.list()).toEqual([{ number: '9200', name: 'Accueil', members: ['9103', '9101', '9102'] }])
      await a.delete('9200')
    })

    it("never takes over another tenant's name of an extension", async () => {
      const a = new CallGroups({ pool, ready, tenantId: 'spec-A' })
      const b = new CallGroups({ pool, ready, tenantId: 'spec-B' })
      await ready()
      await pool.query("DELETE FROM display_names WHERE extension LIKE '91%'")
      await a.reconcile([{ extension: '9101', displayName: 'Alice Martin' }])
      // Two tenants on one database (the Gateway refuses it, ADR 0013): B's reconcile leaves A's row alone, both ways.
      await b.reconcile([{ extension: '9101', displayName: 'Mallory' }])
      await a.reconcile([{ extension: '9101', displayName: 'Alice Martin' }])
      await b.reconcile([{ extension: '9101', displayName: 'Mallory' }])
      expect((await pool.query("SELECT tenant_id, display_name FROM display_names WHERE extension = '9101'")).rows).toEqual([{ tenant_id: 'spec-A', display_name: 'Alice Martin' }])
    })
  })
}
