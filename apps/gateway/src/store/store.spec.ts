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
    await pool.query('TRUNCATE provider_configs, user_mappings, call_history, sip_credentials, conferences, favorites, user_presence, push_subscriptions, vapid_keys RESTART IDENTITY')
    return store
  })
}
