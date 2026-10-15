import { describe, expect, it } from 'vitest'
import { SubscriberProvisioner } from '@twake/provider-opensips'
import { parseKey } from './crypto.js'
import { storedOpensipsFactory } from './providers.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'

const key = parseKey('0'.repeat(64))
const browser = { id: 'b', type: 'browser' as const, label: 'Browser' }

describe('storedOpensipsFactory', () => {
  const setup = () => {
    const store = new MemoryStore()
    const queries: string[] = []
    const values: unknown[][] = []
    const provisioner = new SubscriberProvisioner({
      pool: {
        query: async (text, params) => {
          queries.push(text)
          values.push((params as unknown[] | undefined) ?? [])
          // The version check of ensureSchema() reads the row OpenSIPS's schema holds.
          return /SELECT table_name, table_version/.test(text) ? { rows: [{ table_name: 'subscriber', table_version: 8 }, { table_name: 'acc', table_version: 7 }, { table_name: 'missed_calls', table_version: 5 }] } : { rows: [], rowCount: 1 }
        }
      },
      realm: 'sip.test'
    })
    const factory = storedOpensipsFactory({ store, key, env: { OPENSIPS_DB_URL: 'postgres://x' }, provisionerFor: () => provisioner })
    const provider = factory.create({ websocketUrl: 'wss://sip.test/ws', domain: 'sip.test', subscriberDbUrlRef: 'env:OPENSIPS_DB_URL' }, { tenantId: 't', site: 'default' })
    return { store, queries, values, provider }
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

  it('forwards through the call_rules of the same database, once the schema is there, with the tenant and who holds each extension', async () => {
    const { store, queries, values, provider } = setup()
    await store.upsertMapping({ tenantId: 't', userId: 'alice', extension: '101' })
    await store.upsertMapping({ tenantId: 't', userId: 'bob', extension: '102' })
    expect((await provider.getCapabilities()).forwarding).toBe(true)
    await provider.setForwarding!({ id: 'alice', tenantId: 't', displayName: 'Alice', extension: '101' }, { always: '102', busy: '103' })
    const create = queries.findIndex(q => /CREATE TABLE IF NOT EXISTS call_rules/.test(q))
    const insert = queries.findIndex(q => /INSERT INTO call_rules/.test(q))
    expect(create).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThan(create)
    // 103 is nobody's: its holder is empty, the next reconcile drops that forward.
    expect(values[insert]).toEqual(['101', 't', 'alice', '102', 'bob', '103', '', null, null, 20])
  })

  it('keeps the ring groups and the directory names in the same database, for its tenant', async () => {
    const { queries, values, provider } = setup()
    expect((await provider.getCapabilities()).groups).toBe(true)
    await provider.setGroup!({ number: '200', name: 'Accueil', members: ['101', '102'] })
    const create = queries.findIndex(q => /CREATE TABLE IF NOT EXISTS call_groups/.test(q))
    const insert = queries.findIndex(q => /INSERT INTO call_groups/.test(q))
    expect(create).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThan(create)
    expect(values[insert]).toEqual(['200', 't', 'Accueil', ['101', '102']])
    await provider.syncExtensions!([{ extension: '101', userId: 'alice', displayName: 'Alice Martin' }])
    const names = queries.findIndex(q => /INSERT INTO display_names/.test(q))
    expect(values[names]).toEqual(['t', ['101'], ['Alice Martin']])
  })

  it('refuses an extension nobody is mapped to', async () => {
    const { provider } = setup()
    await expect(provider.getSession!({ id: 'x', tenantId: 't', displayName: 'X', extension: '999' }, browser)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses a second tenant on the OpenSIPS database of another (call_rules is keyed by extension alone)', async () => {
    const versions = { rows: [{ table_name: 'subscriber', table_version: 8 }, { table_name: 'acc', table_version: 7 }, { table_name: 'missed_calls', table_version: 5 }] }
    const provisioner = new SubscriberProvisioner({ pool: { query: async (text: string) => (/SELECT table_name, table_version/.test(text) ? versions : { rows: [] }) }, realm: 'sip.test' })
    const env = { A_DB: 'postgres://gw:one@db.example.test/opensips', B_DB: 'postgres://other:two@DB.example.test:5432/opensips', C_DB: 'postgres://gw:one@db.example.test/opensips_c' }
    const factory = storedOpensipsFactory({ store: new MemoryStore(), key, env, provisionerFor: () => provisioner })
    const config = (ref: string) => ({ websocketUrl: 'wss://sip.test/ws', domain: 'sip.test', subscriberDbUrlRef: ref })
    const a = factory.create(config('env:A_DB'), { tenantId: 'a', site: 'default' })
    // The same database under other credentials and spelling is still the same one.
    expect(() => factory.create(config('env:B_DB'), { tenantId: 'b', site: 'default' })).toThrow(/already serves tenant a/)
    // Its own database, or the same tenant again (a provider recreated), is fine.
    factory.create(config('env:C_DB'), { tenantId: 'c', site: 'default' })
    factory.create(config('env:A_DB'), { tenantId: 'a', site: 'default' })
    // Once a's provider is closed, its database is free.
    await a.close()
    expect(() => factory.create(config('env:B_DB'), { tenantId: 'b', site: 'default' })).not.toThrow()
  })

  it('refuses to start without the secrets key', () => {
    const factory = storedOpensipsFactory({ store: new MemoryStore(), env: { OPENSIPS_DB_URL: 'postgres://x' } })
    expect(() => factory.create({ websocketUrl: 'wss://sip.test/ws', domain: 'sip.test', subscriberDbUrlRef: 'env:OPENSIPS_DB_URL' })).toThrow(/SECRETS_KEY/)
  })
})

describe('ProviderRegistry', () => {
  it('skips, and reports, a tenant whose provider type this Gateway no longer builds (an asterisk row from before step 4c)', () => {
    const created: string[] = []
    const factory = { type: 'opensips', create: (_: unknown, ctx?: { tenantId: string }) => (created.push(ctx!.tenantId), { close: async () => {} }) as never }
    const registry = new ProviderRegistry(
      [
        { tenantId: 'old', type: 'asterisk', config: {} },
        { tenantId: 'new', type: 'opensips', config: {} }
      ],
      [factory]
    )
    const warnings: string[] = []
    registry.startAll(w => void warnings.push(w))
    expect(created).toEqual(['new'])
    expect(warnings).toEqual(['Tenant old: no provider of type "asterisk" in this Gateway; remove or replace its provider_configs row'])
    expect([registry.serves('old'), registry.serves('new'), registry.serves('none')]).toEqual([false, true, false])
    expect(() => registry.forTenant('old')).toThrow(expect.objectContaining({ statusCode: 404 }))
  })
})
