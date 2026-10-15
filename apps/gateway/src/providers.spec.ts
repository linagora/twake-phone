import { describe, expect, it } from 'vitest'
import { SubscriberProvisioner } from '@twake/provider-opensips'
import { parseKey } from './crypto.js'
import { storedOpensipsFactory } from './providers.js'
import { MemoryStore } from './store/memory.js'

const key = parseKey('0'.repeat(64))
const browser = { id: 'b', type: 'browser' as const, label: 'Browser' }

describe('storedOpensipsFactory', () => {
  const setup = () => {
    const store = new MemoryStore()
    const queries: string[] = []
    const provisioner = new SubscriberProvisioner({
      pool: {
        query: async text => {
          queries.push(text)
          // The version check of ensureSchema() reads the row OpenSIPS's schema holds.
          return /SELECT table_name, table_version/.test(text) ? { rows: [{ table_name: 'subscriber', table_version: 8 }, { table_name: 'acc', table_version: 7 }, { table_name: 'missed_calls', table_version: 5 }] } : { rows: [] }
        }
      },
      realm: 'sip.test'
    })
    const factory = storedOpensipsFactory({ store, key, env: { OPENSIPS_DB_URL: 'postgres://x' }, provisionerFor: () => provisioner })
    const provider = factory.create({ websocketUrl: 'wss://sip.test/ws', domain: 'sip.test', subscriberDbUrlRef: 'env:OPENSIPS_DB_URL' }, { tenantId: 't', site: 'default' })
    return { store, queries, provider }
  }

  it('creates the schema once, provisions the secret at every session and hands the same one out again', async () => {
    const { store, queries, provider } = setup()
    await store.upsertMapping({ tenantId: 't', userId: 'alice', extension: '101' })
    const user = { id: 'alice', tenantId: 't', displayName: 'Alice', extension: '101' }
    const first = await provider.getSession!(user, browser)
    const second = await provider.getSession!(user, browser)
    expect(first).toMatchObject({ type: 'sip-webrtc', websocketUrl: 'wss://sip.test/ws', domain: 'sip.test', username: '101' })
    expect((first as { credential: string }).credential).toBe((second as { credential: string }).credential)
    expect(queries.filter(q => /CREATE TABLE/.test(q))).toHaveLength(1)
    // Re-provisioned at every session (same hashes): a `subscriber` table wiped under the Gateway heals itself.
    expect(queries.filter(q => /INSERT INTO subscriber/.test(q))).toHaveLength(2)
    // The store keeps the secret encrypted, never in clear.
    const stored = await store.getSipSecret('t', 'alice')
    expect(stored?.secretEnc).not.toContain((first as { credential: string }).credential)
  })

  it('forwards through the call_rules of the same database, once the schema is there', async () => {
    const { queries, provider } = setup()
    expect((await provider.getCapabilities()).forwarding).toBe(true)
    await provider.setForwarding!({ id: 'alice', tenantId: 't', displayName: 'Alice', extension: '101' }, { always: '102' })
    const create = queries.findIndex(q => /CREATE TABLE IF NOT EXISTS call_rules/.test(q))
    const insert = queries.findIndex(q => /INSERT INTO call_rules/.test(q))
    expect(create).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThan(create)
  })

  it('refuses an extension nobody is mapped to', async () => {
    const { provider } = setup()
    await expect(provider.getSession!({ id: 'x', tenantId: 't', displayName: 'X', extension: '999' }, browser)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses to start without the secrets key', () => {
    const factory = storedOpensipsFactory({ store: new MemoryStore(), env: { OPENSIPS_DB_URL: 'postgres://x' } })
    expect(() => factory.create({ websocketUrl: 'wss://sip.test/ws', domain: 'sip.test', subscriberDbUrlRef: 'env:OPENSIPS_DB_URL' })).toThrow(/SECRETS_KEY/)
  })
})
