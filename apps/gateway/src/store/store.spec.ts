import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { storeContract } from './contract.js'
import { MemoryStore } from './memory.js'
import { PgStore } from './pg.js'

storeContract('memory', async () => new MemoryStore())

// PostgreSQL contract: runs when TEST_DATABASE_URL points to a disposable database.
if (process.env.TEST_DATABASE_URL) {
  storeContract('postgres', async () => {
    const store = new PgStore(process.env.TEST_DATABASE_URL!)
    await store.migrate()
    const pool = (store as unknown as { pool: { query(sql: string): Promise<unknown> } }).pool
    await pool.query('TRUNCATE provider_configs, user_mappings, call_history, sip_credentials, conferences, favorites, user_presence, push_subscriptions, vapid_keys, trunk_configs, direct_numbers, outbound_policies, telephony_alerts RESTART IDENTITY')
    return store
  })

  describe('PgStore, trunks written together', () => {
    it('writes all of them or none: the default mark is never on two trunks, nor on none', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const config = { auth: 'ip' as const, domain: 'operator.example', codecs: ['PCMA' as const], numberFormat: 'e164' as const, defaultNumber: '+33199000100' }
      try {
        await store.upsertTrunks([
          { tenantId: 'atomic', id: 'main', config: { ...config, default: true } },
          { tenantId: 'atomic', id: 'backup', config }
        ])
        // The second write fails (PostgreSQL keeps no NUL in a jsonb): the first one is undone with it.
        await expect(
          store.upsertTrunks([
            { tenantId: 'atomic', id: 'backup', config: { ...config, default: true } },
            { tenantId: 'atomic', id: 'main', config: { ...config, name: 'nul\u0000' } }
          ])
        ).rejects.toThrow()
        expect((await store.listTrunks('atomic')).map(t => `${t.id}:${t.config.default ?? false}`)).toEqual(['main:true', 'backup:false'])
      } finally {
        for (const id of ['backup', 'main']) await store.deleteTrunk('atomic', id)
        await store.close()
      }
    })
  })

  describe('PgStore, a push subscription saved by two people at once', () => {
    it('says the browser moved (from someone it cannot name) when another request inserted it while this one waited', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const other = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL })
      await other.connect()
      const endpoint = `https://push.example.test/race-${Date.now()}`
      const record = (userId: string) => ({ tenantId: 'race', userId, endpoint, p256dh: `k-${userId}`, auth: `a-${userId}`, createdAt: new Date().toISOString() })
      try {
        // Jean's request inserted the browser and has not committed yet: Paul's waits on it, its snapshot without it.
        await other.query('BEGIN')
        await other.query('INSERT INTO push_subscriptions (endpoint, tenant_id, user_id, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [endpoint, 'race', 'jean', 'k-jean', 'a-jean', new Date().toISOString()])
        const saved = store.savePushSubscription(record('paul'))
        for (let i = 0; ; i++) {
          // `other` is inside its transaction, and a backend reads pg_stat_activity once per transaction: without
          // clearing that snapshot, a first look taken before Paul's statement waits is all it would ever see.
          await other.query('SELECT pg_stat_clear_snapshot()')
          const { rows } = await other.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO push_subscriptions%' AND pid <> pg_backend_pid()")
          if (rows[0].n > 0) break
          if (i > 200) throw new Error('the second save never waited on the first')
          await new Promise(r => setTimeout(r, 10))
        }
        await other.query('COMMIT')
        expect(await saved).toEqual({ outcome: 'moved' })
        expect((await store.listPushSubscriptions('race', 'paul')).map(s => s.endpoint)).toEqual([endpoint])
      } finally {
        await other.query('ROLLBACK').catch(() => undefined)
        await other.end()
        await store.deletePushEndpoint(endpoint)
        await store.close()
      }
    })
  })
}
