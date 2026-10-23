import { readFileSync } from 'node:fs'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { storeContract } from './contract.js'
import { MemoryStore } from './memory.js'
import { PgStore } from './pg.js'

storeContract('memory', async () => new MemoryStore())

describe('MemoryStore, the mappings changed together', () => {
  it('shows a read made during applyMappings all of it, never the removals without the writes (review of PR 27, n°5)', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'alice', extension: '101', source: 'ldap' })
    await store.upsertMapping({ tenantId: 'acme', userId: 'bob', extension: '102', source: 'ldap' })
    // Alice moves to 103: her row goes, then is written again. The reads start while the call has not settled.
    const applying = store.applyMappings('acme', { remove: [{ userId: 'alice' }], write: [{ tenantId: 'acme', userId: 'alice', extension: '103', source: 'ldap' }] })
    const listed = store.listMappings('acme')
    const alice = store.getMappingByUser('acme', 'alice')
    expect(await applying).toEqual({ failed: [] })
    expect((await listed).map(m => `${m.userId}:${m.extension}`)).toEqual(['alice:103', 'bob:102'])
    expect(await alice).toMatchObject({ extension: '103' })
  })
})

// PostgreSQL contract: runs when TEST_DATABASE_URL points to a disposable database.
if (process.env.TEST_DATABASE_URL) {
  storeContract('postgres', async () => {
    const store = new PgStore(process.env.TEST_DATABASE_URL!)
    await store.migrate()
    const pool = (store as unknown as { pool: { query(sql: string): Promise<unknown> } }).pool
    await pool.query('TRUNCATE recordings, supervision_log, provider_configs, user_mappings, call_history, sip_credentials, conferences, favorites, user_presence, push_subscriptions, vapid_keys, trunk_configs, direct_numbers, sites, site_members, outbound_policies, telephony_alerts, webhook_subscriptions, webhook_deliveries, webhook_domains, webhook_state, webhook_sends, webhook_leases, operator_cdrs, operator_state, history_erasures, history_erased_calls, number_changes, voicemail_transcripts RESTART IDENTITY')
    return store
  })

  describe('PgStore, the claim of the webhook queue under a backlog', () => {
    // The time of the claim kept to the microsecond: read into a Date, it fell to the start of its millisecond, before
    // a delivery queued later in that millisecond, left out (second review 10b: one of two just queued, 20 in 300).
    it('claims a delivery queued in the same millisecond as the claim, earlier in it', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const tenant = `micro-${Date.now()}`
      const id = `wh_${Date.now().toString(16).padStart(16, '0').slice(-16)}`
      const now = new Date().toISOString()
      try {
        await store.addWebhookSubscription({ tenantId: tenant, id, url: 'https://crm.example.org/in', events: ['call.missed'], enabled: true, secretEnc: 'enc', failures: 0, createdAt: now, updatedAt: now }, 20)
        await store.enqueueWebhookEvent(tenant, 'evt_1', 'call.missed', '{}', '2020-01-01T10:00:00.000100Z')
        await store.enqueueWebhookEvent(tenant, 'evt_2', 'call.missed', '{}', '2020-01-01T10:00:00.000500Z')
        const claimed = await store.claimWebhookDeliveries(10, { perSubscription: 10, perTenant: 10, maxAttempts: 9 }, { now: '2020-01-01T10:00:00.000900Z', leaseUntil: '2020-01-01T10:01:00.000900Z' })
        expect(claimed.filter(d => d.tenantId === tenant).map(d => d.eventId).sort()).toEqual(['evt_1', 'evt_2'])
      } finally {
        await store.deleteWebhookSubscription(tenant, id)
        await store.close()
      }
    })

    // Whatever the DateStyle and TimeZone of the session (fourth review 10b, n°8): "IST" of a time sent back as text
    // was read as Israel's, 3 h 30 off.
    it('claims at the time asked under another DateStyle and an abbreviated time zone, and reads in ISO', async () => {
      const url = new URL(process.env.TEST_DATABASE_URL!)
      url.searchParams.set('options', '-c DateStyle=SQL,DMY -c TimeZone=Asia/Kolkata')
      const store = new PgStore(url.toString())
      await store.migrate()
      const tenant = `style-${Date.now()}`
      const id = `wh_${(Date.now() + 1).toString(16).padStart(16, '0').slice(-16)}`
      const now = new Date().toISOString()
      try {
        const pool = (store as unknown as { pool: pg.Pool }).pool
        expect((await pool.query<{ d: string; z: string }>("SELECT current_setting('DateStyle') AS d, current_setting('TimeZone') AS z")).rows[0]).toEqual({ d: 'ISO, MDY', z: 'Asia/Kolkata' })
        await store.addWebhookSubscription({ tenantId: tenant, id, url: 'https://crm.example.org/in', events: ['call.missed'], enabled: true, secretEnc: 'enc', failures: 0, createdAt: now, updatedAt: now }, 20)
        await store.enqueueWebhookEvent(tenant, 'evt_1', 'call.missed', '{}', '2020-01-01T10:00:00.000100Z')
        await store.enqueueWebhookEvent(tenant, 'evt_2', 'call.missed', '{}', '2020-01-01T12:00:00.000000Z')
        const claimed = await store.claimWebhookDeliveries(10, { perSubscription: 10, perTenant: 10, maxAttempts: 9 }, { now: '2020-01-01T10:00:00.000900Z', leaseUntil: '2020-01-01T10:01:00.000900Z' })
        expect(claimed.filter(d => d.tenantId === tenant).map(d => d.eventId)).toEqual(['evt_1'])
      } finally {
        await store.deleteWebhookSubscription(tenant, id)
        await store.close()
      }
    })

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

    /** How many transactions the store ran again after a deadlock or a serialization failure. */
    const retried = (store: PgStore) => (store as unknown as { retried: number }).retried

    // Disabled by the breaker, disabled by an administrator, deleted: each while the outcome of one of the
    // subscription's deliveries is being written, as completeWebhookDelivery writes it (the delivery first, then its
    // subscription). None waits on a deadlock: none was run again (the order of the locks, not the retry, avoids it).
    const whileAnOutcome: [string, (store: PgStore, tenant: string, id: string) => Promise<boolean>, string[][]][] = [
      ['disables a failing subscription (third review, n°4)', (store, tenant, id) => store.disableFailingWebhookSubscription(tenant, id, new Date().toISOString()), [['evt_1', 'delivered'], ['evt_2', 'failed']]],
      ['disables a subscription for an administrator (third review, n°4)', (store, tenant, id) => store.updateWebhookSubscription({ ...sub(tenant, id), enabled: false }), [['evt_1', 'delivered'], ['evt_2', 'failed']]],
      ['deletes a subscription (fourth review, n°5)', (store, tenant, id) => store.deleteWebhookSubscription(tenant, id), []]
    ]
    for (const [what, write, after] of whileAnOutcome)
      it(`${what} while the outcome of one of its deliveries is being written, without a deadlock`, async () => {
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
          const first = claimed.find(d => d.eventId === 'evt_1')!
          // An outcome being written: the delivery first...
          await other.query('BEGIN')
          await other.query("UPDATE webhook_deliveries SET status = 'delivered', claim = NULL WHERE id = $1", [first.id])
          // ...the write meanwhile waits on the delivery, holding nothing the outcome needs...
          const written = write(store, tenant, id)
          await waiting(other, '%webhook_%')
          // ...which goes on with its subscription, and ends.
          await other.query('UPDATE webhook_subscriptions SET failures = 0 WHERE id = $1', [id])
          await other.query('COMMIT')
          expect(await written).toBe(true)
          expect(retried(store)).toBe(0)
          const log = await store.listWebhookDeliveries(tenant, id)
          expect(log.map(d => [d.eventId, d.status]).sort()).toEqual(after)
        } finally {
          await other.query('ROLLBACK').catch(() => undefined)
          await other.end()
          await store.deleteWebhookSubscription(tenant, id)
          await store.close()
        }
      })

    it('runs a transaction again once when PostgreSQL chose it as the victim of a deadlock, never another error (third review, n°4)', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      const inTransaction = (store as unknown as { inTransaction: <T>(run: (client: pg.PoolClient) => Promise<T>) => Promise<T> }).inTransaction.bind(store)
      try {
        let runs = 0
        const victim = Object.assign(new Error('deadlock detected'), { code: '40P01' })
        expect(await inTransaction(async client => (++runs === 1 ? Promise.reject(victim) : (await client.query<{ n: number }>('SELECT 1 AS n')).rows[0]!.n))).toBe(1)
        expect([runs, retried(store)]).toEqual([2, 1])
        // Twice a victim: the second error goes up; any other error at once.
        runs = 0
        await expect(inTransaction(async () => (++runs, Promise.reject(victim)))).rejects.toBe(victim)
        expect(runs).toBe(2)
        runs = 0
        const other = Object.assign(new Error('unique_violation'), { code: '23505' })
        await expect(inTransaction(async () => (++runs, Promise.reject(other)))).rejects.toBe(other)
        expect(runs).toBe(1)
      } finally {
        await store.close()
      }
    })

    it('renews the lease within its bound however many changes of state are written at the same time (n°5)', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const tenant = `lease-${Date.now()}`
      const holder = `gw_${Date.now()}`
      try {
        // Five subscriptions take the presences: each change queues five deliveries in its transaction.
        for (let k = 0; k < 5; k++) await store.addWebhookSubscription({ ...sub(tenant, `wh_${(Date.now() + k).toString(16).padStart(16, '0').slice(-16)}`), events: ['presence.changed'] }, 20)
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
            await store.setWebhookState({ tenantId: tenant, subject: `presence:u${w}`, state: n % 2 ? 'busy' : 'available', holder }, () => ({ id: `evt_${w}_${n}_${Math.random()}`, type: 'presence.changed', body: '{}' }))
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
        await pool.query('DELETE FROM webhook_subscriptions WHERE tenant_id = $1', [tenant])
        await store.close()
      }
    }, 30_000)

    /** The webhook tables as the catalog has them: columns, indexes and constraints, whatever the order of the columns. */
    const schemaOf = async (pool: pg.Pool) => ({
      columns: (
        await pool.query(
          "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name LIKE 'webhook\\_%' ORDER BY table_name, column_name"
        )
      ).rows,
      indexes: (await pool.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename LIKE 'webhook\\_%' ORDER BY indexname")).rows,
      constraints: (
        await pool.query("SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid::regclass::text LIKE 'webhook\\_%' ORDER BY 1, 2")
      ).rows
    })
    // 013 as the earlier heads of the branch had it (a database made from them then), the comments left out.
    const EARLIER_013: Record<string, string> = {
      '69fb72e (the first head)': `
        CREATE TABLE webhook_subscriptions (id text PRIMARY KEY, tenant_id text NOT NULL, url text NOT NULL, events text[] NOT NULL, description text,
          enabled boolean NOT NULL DEFAULT true, secret_enc text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, created_by text);
        CREATE INDEX webhook_subscriptions_tenant_idx ON webhook_subscriptions (tenant_id, created_at, id);
        CREATE TABLE webhook_domains (tenant_id text NOT NULL, position integer NOT NULL, domain text NOT NULL, PRIMARY KEY (tenant_id, domain));
        CREATE TABLE webhook_deliveries (id text PRIMARY KEY, tenant_id text NOT NULL, subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
          event_id text NOT NULL, event_type text NOT NULL, body text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
          attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, next_attempt_at timestamptz, claim text, last_attempt_at timestamptz, last_status integer,
          last_error text, delivered_at timestamptz, UNIQUE (subscription_id, event_id));
        CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
        CREATE INDEX webhook_deliveries_log_idx ON webhook_deliveries (subscription_id, created_at DESC, id DESC);
        CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at);
        CREATE TABLE webhook_state (tenant_id text NOT NULL, subject text NOT NULL, state text NOT NULL, since timestamptz NOT NULL, PRIMARY KEY (tenant_id, subject));`,
      '316e923 (the first review)': `
        CREATE TABLE webhook_subscriptions (id text PRIMARY KEY, tenant_id text NOT NULL, url text NOT NULL, events text[] NOT NULL, description text,
          enabled boolean NOT NULL DEFAULT true, disabled_reason text, secret_enc text NOT NULL, secret_prev_enc text, secret_prev_until timestamptz,
          failures integer NOT NULL DEFAULT 0, failing_since timestamptz, paused_until timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, created_by text);
        CREATE INDEX webhook_subscriptions_tenant_idx ON webhook_subscriptions (tenant_id, created_at, id);
        CREATE TABLE webhook_domains (tenant_id text NOT NULL, position integer NOT NULL, domain text NOT NULL, PRIMARY KEY (tenant_id, domain));
        CREATE TABLE webhook_deliveries (id text PRIMARY KEY, tenant_id text NOT NULL, subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
          event_id text NOT NULL, event_type text NOT NULL, body text NOT NULL, subject_user text, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
          attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, next_attempt_at timestamptz, claim text, last_attempt_at timestamptz, last_status integer,
          last_error text, delivered_at timestamptz, UNIQUE (subscription_id, event_id));
        CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
        CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (subscription_id) WHERE status = 'pending';
        CREATE INDEX webhook_deliveries_log_idx ON webhook_deliveries (subscription_id, created_at DESC, id DESC);
        CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at);
        CREATE INDEX webhook_deliveries_subject_idx ON webhook_deliveries (tenant_id, subject_user) WHERE subject_user IS NOT NULL;
        CREATE TABLE webhook_sends (subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE, at timestamptz NOT NULL);
        CREATE INDEX webhook_sends_idx ON webhook_sends (subscription_id, at);
        CREATE TABLE webhook_state (tenant_id text NOT NULL, subject text NOT NULL, state text NOT NULL, since timestamptz NOT NULL, PRIMARY KEY (tenant_id, subject));
        CREATE TABLE webhook_leases (role text PRIMARY KEY, holder text NOT NULL, until timestamptz NOT NULL);`,
      // The second review's: 013 as it stands, 014 not yet written.
      '3427359 (the second review)': readFileSync(new URL('../../migrations/013_webhooks.sql', import.meta.url), 'utf8')
    }
    for (const [n, [head, sql]] of Object.entries(EARLIER_013).entries())
      it(`brings a database that played 013 as it stood at ${head} to the schema of one made afresh (third review, n°12; fourth, n°6)`, async () => {
        const base = new URL(process.env.TEST_DATABASE_URL!)
        const name = `${decodeURIComponent(base.pathname.slice(1)) || 'postgres'}_migrate_spec_${n}`
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
          const fresh = await schemaOf(pool)
          // The webhook tables as that 013 made them, 014 never played, nor 018 (the leases' generation).
          await pool.query(`
            DROP TABLE IF EXISTS webhook_leases, webhook_state, webhook_sends, webhook_deliveries, webhook_domains, webhook_subscriptions;
            ${sql};
            DELETE FROM schema_migrations WHERE name IN ('014_webhooks_fairness.sql', '018_history_voicemail.sql');
          `)
          await store.migrate()
          expect(await schemaOf(pool)).toEqual(fresh)
          expect(await store.takeWebhookLease('webhook-state', 'gw_1', 15_000, 1)).toBeTruthy()
          await store.addWebhookSubscription(sub('acme', 'wh_00000000000000a1'), 20)
          expect(await store.enqueueWebhookDelivery('acme', 'wh_00000000000000a1', 'evt_1', 'webhook.test', '{}', undefined, 1000, { perSubscription: 1, windowMs: 60_000 })).toMatchObject({ eventId: 'evt_1' })
          expect(await store.claimWebhookDeliveries(4, { perSubscription: 2, perTenant: 4, maxAttempts: 9 })).toHaveLength(1)
          // Played again on a database up to date: nothing changes.
          await pool.query("DELETE FROM schema_migrations WHERE name IN ('014_webhooks_fairness.sql', '018_history_voicemail.sql')")
          await store.migrate()
          expect(await schemaOf(pool)).toEqual(fresh)
        } finally {
          await store.close()
          // Without FORCE: a connection of the store still closing is let close (never cut while it ends).
          for (let i = 0; i < 100; i++) {
            if (await server.query(`DROP DATABASE IF EXISTS "${name}"`).then(() => true, () => false)) break
            await new Promise(r => setTimeout(r, 20))
          }
          await server.end()
        }
      }, 30_000)
  })

  describe('PgStore, the history of a person and the records of the operator (second review 10b)', () => {
    /** The tables of the operator and of the erasures as the catalog has them, and the function of E.164. */
    const operatorSchemaOf = async (pool: pg.Pool) => {
      const tables = ['call_history', 'history_erasures', 'history_erased_calls', 'number_changes', 'operator_cdrs', 'operator_state']
      return {
        columns: (
          await pool.query(
            'SELECT table_name, column_name, data_type, is_nullable, column_default, generation_expression FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY table_name, column_name',
            [tables]
          )
        ).rows,
        indexes: (await pool.query('SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ANY($1) ORDER BY indexname', [tables])).rows,
        constraints: (await pool.query('SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid::regclass::text = ANY($1) ORDER BY 1, 2', [tables])).rows,
        e164: (await pool.query("SELECT pg_get_functiondef('e164_of(text)'::regprocedure) AS def")).rows
      }
    }

    it('brings a database that played 016 as it stood at 6ef6cc6 or at fbebfe6 to the schema of one made afresh, its erasures working (third review, n°7)', async () => {
      const base = new URL(process.env.TEST_DATABASE_URL!)
      const name = `${decodeURIComponent(base.pathname.slice(1)) || 'postgres'}_migrate_017`
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
        const fresh = await operatorSchemaOf(pool)
        // 6ef6cc6: its 016 played (the one in the repository, never rewritten again), 017 not; an entry written under
        // the rules of E.164 of then, with no-break spaces.
        await pool.query(`
          DELETE FROM schema_migrations WHERE name = '017_operator_erasures.sql';
          ALTER TABLE history_erasures DROP COLUMN numbers;
          DROP TABLE history_erased_calls, number_changes;
          DROP INDEX history_erasures_purge;
          ALTER TABLE call_history DROP COLUMN operator_forwarded;
          ${readFileSync(new URL('../../migrations/016_operator_review.sql', import.meta.url), 'utf8')}
        `)
        await pool.query("INSERT INTO call_history (tenant_id, user_id, call_id, direction, remote_number, started_at, duration_sec, state, answered) VALUES ('A', 'jean', 'nb', 'outbound', '06 39 98 00 01', now(), 0, 'ended', true)")
        await store.migrate()
        expect(await operatorSchemaOf(pool)).toEqual(fresh)
        expect((await pool.query("SELECT remote_e164 FROM call_history WHERE call_id = 'nb'")).rows).toEqual([{ remote_e164: '+33639980001' }])
        // The right to erasure works (it answered 500: no column `numbers`), its calls kept with their print.
        expect(await store.deleteHistory('A', 'jean', ['+33199000101'], { since: new Date(Date.now() - 60_000).toISOString(), keyOf: n => `key:${n}` })).toBe(1)
        expect(await store.numbersErasedAt('A', ['+33199000101'])).toHaveProperty('size', 1)
        expect((await store.erasedCalls('A', new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 60_000).toISOString())).map(c => c.remoteKey)).toEqual(['key:+33639980001'])
        // fbebfe6: its 016 had the rest, but neither the prints nor the indexes of the purge.
        await pool.query(`
          DELETE FROM schema_migrations WHERE name = '017_operator_erasures.sql';
          ALTER TABLE history_erased_calls DROP COLUMN remote_key;
          DROP INDEX history_erased_calls_purge, number_changes_purge, history_erasures_purge;
        `)
        await store.migrate()
        expect(await operatorSchemaOf(pool)).toEqual(fresh)
        // Played again on a database up to date: nothing changes.
        await pool.query("DELETE FROM schema_migrations WHERE name = '017_operator_erasures.sql'")
        await store.migrate()
        expect(await operatorSchemaOf(pool)).toEqual(fresh)
      } finally {
        await store.close()
        for (let i = 0; i < 100; i++) {
          if (await server.query(`DROP DATABASE IF EXISTS "${name}"`).then(() => true, () => false)) break
          await new Promise(r => setTimeout(r, 20))
        }
        await server.end()
      }
    }, 30_000)

    it('erases a history under its lock: an orphan settled meanwhile waits for it, then sees it (n°10)', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const other = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL })
      await other.connect()
      try {
        // Another transaction holds the lock of jean's history (a settlement of the operator's records under way).
        await other.query('BEGIN')
        await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['call_history|locked|jean'])
        let done = false
        const erasing = store.deleteHistory('locked', 'jean').then(() => (done = true))
        await new Promise(r => setTimeout(r, 300))
        expect(done).toBe(false)
        await other.query('COMMIT')
        await erasing
        expect(await store.historyErasedAt('locked', 'jean')).toBeDefined()
      } finally {
        await other.query('ROLLBACK').catch(() => undefined)
        await other.end()
        await store.close()
      }
    })

    it('pages the entries near a record at the millisecond, whatever the precision they were written with (n°13)', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const pool = (store as unknown as { pool: pg.Pool }).pool
      try {
        await pool.query("DELETE FROM call_history WHERE tenant_id = 'micro'")
        // 25 entries at the same millisecond, apart by microseconds (written by SQL, not by the Gateway).
        await pool.query(
          `INSERT INTO call_history (tenant_id, user_id, call_id, direction, remote_number, started_at, duration_sec, state, answered)
           SELECT 'micro', 'u' || lpad(i::text, 2, '0'), 'c', 'inbound', '+33612345678', timestamptz '2026-10-05T10:00:00.000Z' + (i || ' microseconds')::interval, 0, 'missed', false
             FROM generate_series(1, 25) AS i`
        )
        const seen: string[] = []
        let after: { startedAt: string; callId: string; userId: string } | undefined
        for (let page = 0; page < 10; page++) {
          const got = await store.historyNear('micro', { direction: 'inbound', remotes: ['+33612345678'], from: '2026-10-05T09:00:00.000Z', to: '2026-10-05T11:00:00.000Z', limit: 10, ...(after ? { after } : {}) })
          seen.push(...got.map(e => e.userId))
          if (got.length < 10) break
          const last = got.at(-1)!
          after = { startedAt: last.startedAt, callId: last.callId, userId: last.userId }
        }
        expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `u${String(i + 1).padStart(2, '0')}`))
      } finally {
        await pool.query("DELETE FROM call_history WHERE tenant_id = 'micro'")
        await store.close()
      }
    })
  })

  describe('PgStore, the mappings changed together', () => {
    it('runs the whole change again after a deadlock in a write, never counts that write as refused (review of PR 27, n°5)', async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL!)
      await store.migrate()
      const pool = (store as unknown as { pool: pg.Pool }).pool
      const internals = store as unknown as { retried: number; upsertMappingIn: (...args: unknown[]) => Promise<void> }
      try {
        await store.upsertMapping({ tenantId: 'retry', userId: 'alice', extension: '101', source: 'ldap' })
        await store.upsertMapping({ tenantId: 'retry', userId: 'carol', extension: '103', source: 'ldap' })
        // The first write of the first attempt is the victim of a deadlock: rolled back whole by PostgreSQL, not one
        // write refused within the transaction.
        const upsert = internals.upsertMappingIn.bind(store)
        let deadlocks = 1
        internals.upsertMappingIn = async (...args: unknown[]) => {
          if (deadlocks-- > 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
          return upsert(...args)
        }
        const retried = internals.retried
        const { failed } = await store.applyMappings('retry', {
          remove: [{ userId: 'alice' }, { userId: 'carol', left: true }],
          write: [{ tenantId: 'retry', userId: 'alice', extension: '102', source: 'ldap' }]
        })
        expect(failed).toEqual([])
        expect(internals.retried).toBe(retried + 1)
        expect((await store.listMappings('retry')).map(m => `${m.userId}:${m.extension}`)).toEqual(['alice:102'])
        // The removals of the first attempt went with it: each extension changed hands once.
        const { rows } = await pool.query("SELECT first_number FROM number_changes WHERE tenant_id = 'retry' ORDER BY first_number")
        expect(rows.map(r => r.first_number)).toEqual(['101', '103'])
      } finally {
        await pool.query("DELETE FROM user_mappings WHERE tenant_id = 'retry'")
        await pool.query("DELETE FROM number_changes WHERE tenant_id = 'retry'")
        await store.close()
      }
    })
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
