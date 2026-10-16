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
    await pool.query('TRUNCATE provider_configs, user_mappings, call_history, sip_credentials, conferences, favorites, user_presence, push_subscriptions, vapid_keys, trunk_configs, direct_numbers, outbound_policies, telephony_alerts, webhook_subscriptions, webhook_deliveries, webhook_domains, webhook_state, webhook_sends, webhook_leases RESTART IDENTITY')
    return store
  })

  describe('PgStore, the claim of the webhook queue under a backlog', () => {
    it('costs what is claimed, not what waits: 100 000 pending deliveries, half of them paused, a claim within a bound', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const pool = (store as unknown as { pool: pg.Pool }).pool
      // 100 tenants of 20 subscriptions, 50 deliveries due each (a CRM common to all of them was down an hour); the
      // subscriptions of the even tenants paused (its breaker).
      const tenants = 100
      try {
        await pool.query(
          `INSERT INTO webhook_subscriptions (id, tenant_id, url, events, enabled, secret_enc, paused_until, created_at, updated_at)
           SELECT format('wh_load_%s_%s', t, n), format('load_%s', t), 'https://crm.example.org/in', ARRAY['call.missed'], true, 'enc',
                  CASE WHEN t % 2 = 0 THEN now() + interval '1 hour' END, now(), now()
           FROM generate_series(1, $1) t, generate_series(1, 20) n`,
          [tenants]
        )
        await pool.query(
          `INSERT INTO webhook_deliveries (id, tenant_id, subscription_id, event_id, event_type, body, status, created_at, next_attempt_at)
           SELECT format('dlv_load_%s_%s_%s', t, n, e), format('load_%s', t), format('wh_load_%s_%s', t, n), format('evt_%s', e), 'call.missed', '{}', 'pending',
                  now() - interval '1 hour' + e * interval '1 second', now() - interval '1 hour' + e * interval '1 second'
           FROM generate_series(1, $1) t, generate_series(1, 20) n, generate_series(1, 50) e`,
          [tenants]
        )
        await pool.query('ANALYZE webhook_deliveries')
        await pool.query('ANALYZE webhook_subscriptions')
        const caps = { perSubscription: 2, perTenant: 4, maxAttempts: 9, leaseMs: 60_000 }
        const times: number[] = []
        const taken: string[] = []
        // A claim per delivery ended (room 1) as well as a whole room (16), the queue drained as it goes.
        for (const room of [16, 1, 1, 1, 16, 16, 1, 16]) {
          const started = performance.now()
          const claimed = await store.claimWebhookDeliveries(room, caps)
          times.push(performance.now() - started)
          expect(claimed).toHaveLength(room)
          taken.push(...claimed.map(d => d.tenantId))
          for (const d of claimed.slice(0, Math.ceil(room / 2))) await store.completeWebhookDelivery(d.id, d.claim, { delivered: true, status: 204 })
        }
        // Never a paused one; never more than its share for a tenant.
        expect(taken.every(t => Number(t.split('_')[1]) % 2 === 1)).toBe(true)
        // The old claim took 370 to 525 ms for one delivery under twice that backlog; this one a few ms. The bound
        // leaves room for a loaded CI.
        times.sort((a, b) => a - b)
        expect(times[Math.floor(times.length / 2)]!).toBeLessThan(150)
      } finally {
        await pool.query("DELETE FROM webhook_deliveries WHERE tenant_id LIKE 'load\\_%'")
        await pool.query("DELETE FROM webhook_subscriptions WHERE tenant_id LIKE 'load\\_%'")
        await store.close()
      }
    }, 120_000)
  })

  describe('PgStore, the webhook queue and its lease under concurrent writes (review 10a, third)', () => {
    const sub = (tenantId: string, id: string) => ({
      tenantId,
      id,
      url: 'https://crm.example.org/in',
      events: ['call.missed' as const],
      enabled: true,
      secretEnc: 'enc',
      failures: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    /** Until a statement of another session waits on a lock (pg_stat_activity, read afresh each time). */
    const waiting = async (other: pg.Client, like: string) => {
      for (let i = 0; ; i++) {
        await other.query('SELECT pg_stat_clear_snapshot()')
        const { rows } = await other.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> pg_backend_pid()", [like])
        if (rows[0].n > 0) return
        if (i > 300) throw new Error(`nothing waited on a lock: ${like}`)
        await new Promise(r => setTimeout(r, 10))
      }
    }

    it('disables a subscription while the outcome of one of its deliveries is being written, without a deadlock (n°4)', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const other = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL })
      await other.connect()
      const tenant = `deadlock-${Date.now()}`
      const id = `wh_${Date.now().toString(16).padStart(16, '0').slice(-16)}`
      try {
        await store.addWebhookSubscription(sub(tenant, id), 20)
        await store.enqueueWebhookEvent(tenant, 'evt_1', 'call.missed', '{}', undefined)
        await store.enqueueWebhookEvent(tenant, 'evt_2', 'call.missed', '{}', undefined)
        const claimed = (await store.claimWebhookDeliveries(10, { perSubscription: 10, perTenant: 10, maxAttempts: 9 })).filter(d => d.tenantId === tenant)
        expect(claimed).toHaveLength(2)
        // An outcome being written, as completeWebhookDelivery writes it: the delivery first, then its subscription.
        await other.query('BEGIN')
        await other.query("UPDATE webhook_deliveries SET status = 'delivered', claim = NULL WHERE id = $1", [claimed[0]!.id])
        // The breaker disables the subscription meanwhile: it waits on the delivery, holding nothing the outcome needs.
        const disabled = store.disableFailingWebhookSubscription(tenant, id, new Date().toISOString())
        await waiting(other, '%webhook_deliveries%')
        await other.query('UPDATE webhook_subscriptions SET failures = 0 WHERE id = $1', [id])
        await other.query('COMMIT')
        expect(await disabled).toBe(true)
        const log = await store.listWebhookDeliveries(tenant, id)
        expect(log.map(d => [d.eventId, d.status, d.lastError]).sort()).toEqual([
          ['evt_1', 'delivered', undefined],
          ['evt_2', 'failed', 'disabled']
        ])
      } finally {
        await other.query('ROLLBACK').catch(() => undefined)
        await other.end()
        await store.deleteWebhookSubscription(tenant, id)
        await store.close()
      }
    })

    it('renews the lease within its bound however many changes of state are written at the same time (n°5)', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const tenant = `lease-${Date.now()}`
      const holder = `gw_${Date.now()}`
      try {
        await store.takeWebhookLease('webhook-state', holder, 0)
        // The lease of an earlier test lapses first.
        for (let i = 0; !(await store.takeWebhookLease('webhook-state', holder, 15_000, 1)); i++) {
          if (i > 200) throw new Error('the lease never came')
          await new Promise(r => setTimeout(r, 100))
        }
        let writing = true
        let written = 0
        const writer = async (w: number) => {
          for (let n = 0; writing; n++) {
            await store.setWebhookState({ tenantId: tenant, subject: `presence:u${w}`, state: n % 2 ? 'busy' : 'available', holder }, () => null)
            written++
          }
        }
        const writers = Array.from({ length: 16 }, (_, w) => writer(w))
        const times: number[] = []
        for (let i = 0; i < 20; i++) {
          const started = performance.now()
          expect(await store.takeWebhookLease('webhook-state', holder, 15_000, 1)).toBeTruthy()
          times.push(performance.now() - started)
          await new Promise(r => setTimeout(r, 25))
        }
        writing = false
        await Promise.all(writers)
        expect(written).toBeGreaterThan(100)
        times.sort((a, b) => a - b)
        // Behind the writes (FOR SHARE), it took 579 ms in the median and 1.56 s at worst under 9 writers.
        expect(times[Math.floor(times.length / 2)]!).toBeLessThan(100)
        expect(times.at(-1)!).toBeLessThan(500)
      } finally {
        await store.takeWebhookLease('webhook-state', holder, 0)
        const pool = (store as unknown as { pool: pg.Pool }).pool
        await pool.query('DELETE FROM webhook_state WHERE tenant_id = $1', [tenant])
        await store.close()
      }
    }, 30_000)

    it('brings up to date a database that played migration 013 as it stood before the second review (n°12)', async () => {
      const base = new URL(process.env.TEST_DATABASE_URL!)
      const name = `${decodeURIComponent(base.pathname.slice(1)) || 'postgres'}_migrate_spec`
      const own = new URL(base.toString())
      own.pathname = `/${name}`
      const server = new pg.Client({ connectionString: base.toString() })
      await server.connect()
      await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await server.query(`CREATE DATABASE "${name}"`)
      const store = new PgStore(own.toString())
      try {
        await store.migrate()
        const pool = (store as unknown as { pool: pg.Pool }).pool
        // 013 as it was at the first review: what the second added taken out, 014 never played.
        await pool.query(`
          ALTER TABLE webhook_subscriptions DROP COLUMN backlog, DROP COLUMN backlog_at, DROP COLUMN claimed_at;
          ALTER TABLE webhook_deliveries DROP COLUMN erase_body;
          DROP INDEX webhook_deliveries_held_idx;
          DROP INDEX webhook_deliveries_pending_idx;
          CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (subscription_id) WHERE status = 'pending';
          DROP TABLE webhook_sends;
          CREATE TABLE webhook_sends (subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE, at timestamptz NOT NULL);
          ALTER TABLE webhook_leases DROP COLUMN heard, DROP COLUMN write_from, DROP COLUMN write_until;
          DELETE FROM schema_migrations WHERE name = '014_webhooks_fairness.sql';
        `)
        await store.migrate()
        expect(await store.takeWebhookLease('webhook-state', 'gw_1', 15_000, 1)).toBeTruthy()
        await store.addWebhookSubscription(sub('acme', 'wh_00000000000000a1'), 20)
        expect(await store.enqueueWebhookDelivery('acme', 'wh_00000000000000a1', 'evt_1', 'webhook.test', '{}', undefined, 1000, { perSubscription: 1, windowMs: 60_000 })).toMatchObject({ eventId: 'evt_1' })
        expect(await store.claimWebhookDeliveries(4, { perSubscription: 2, perTenant: 4, maxAttempts: 9 })).toHaveLength(1)
        const { rows } = await pool.query<{ n: number }>("SELECT indnatts AS n FROM pg_index WHERE indexrelid = 'webhook_deliveries_pending_idx'::regclass")
        expect(rows[0]!.n).toBe(3)
        // Played again on a database up to date: nothing to do.
        await pool.query("DELETE FROM schema_migrations WHERE name = '014_webhooks_fairness.sql'")
        await store.migrate()
      } finally {
        await store.close()
        await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined)
        await server.end()
      }
    }, 30_000)
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
