import { describe, expect, it } from 'vitest'
import type { Contact } from '@twake/telephony-types'
import { MemoryContactDirectory } from './contacts.js'
import { DirectorySync, MAX_INTERVAL_MS, extensionOf, parseInterval } from './directory-sync.js'
import { MemoryStore } from './store/memory.js'

const person = (id: string, name: string, extension?: string, department = 'Support'): Contact => ({
  id,
  displayName: name,
  numbers: [...(extension ? [{ type: 'extension' as const, number: extension }] : []), { type: 'work' as const, number: '+33123456700' }],
  department
})

const setup = (people: Contact[], store = new MemoryStore()) => {
  const directory = new MemoryContactDirectory(people)
  return { store, directory, sync: new DirectorySync({ store, directory, tenantId: 'acme', now: () => new Date('2026-10-14T10:00:00.000Z') }) }
}

describe('DirectorySync', () => {
  it('creates a mapping per person with an extension, with name and department, and counts the rest', async () => {
    const { store, sync } = setup([person('alice', 'Alice Martin', '101', 'Direction'), person('bob', 'Bob Durand', '102'), person('carol', 'Carol Nobody')])
    const report = await sync.run()
    expect(report).toMatchObject({ seen: 3, withExtension: 2, created: 2, updated: 0, unchanged: 0, removed: 0, conflicts: [], startedAt: '2026-10-14T10:00:00.000Z' })
    expect(await store.getMappingByUser('acme', 'alice')).toEqual({ tenantId: 'acme', userId: 'alice', extension: '101', displayName: 'Alice Martin', department: 'Direction', source: 'ldap', syncedAt: '2026-10-14T10:00:00.000Z' })
    expect(await store.getMappingByExtension('acme', '102')).toMatchObject({ userId: 'bob' })
    expect(await store.getMappingByUser('acme', 'carol')).toBeNull()
    expect(sync.status()).toMatchObject({ running: false, last: { created: 2 } })
  })

  it('is idempotent, follows a change, and removes who left the directory or lost their extension', async () => {
    const people = [person('alice', 'Alice Martin', '101'), person('bob', 'Bob Durand', '102'), person('dave', 'Dave', '104')]
    const { store, directory, sync } = setup(people)
    await sync.run()
    expect(await sync.run()).toMatchObject({ created: 0, updated: 0, unchanged: 3, removed: 0 })
    // Alice moves to another department, Bob loses his extension, Dave leaves.
    people.splice(0, 3, person('alice', 'Alice Martin', '101', 'Direction'), person('bob', 'Bob Durand'))
    directory.listAll = async () => people
    expect(await sync.run()).toMatchObject({ seen: 2, withExtension: 1, created: 0, updated: 1, unchanged: 0, removed: 2 })
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ department: 'Direction' })
    expect(await store.getMappingByUser('acme', 'bob')).toBeNull()
    expect(await store.getMappingByUser('acme', 'dave')).toBeNull()
  })

  it('lets two people swap extensions', async () => {
    const people = [person('alice', 'Alice', '101'), person('bob', 'Bob', '102')]
    const { store, directory, sync } = setup(people)
    await sync.run()
    directory.listAll = async () => [person('alice', 'Alice', '102'), person('bob', 'Bob', '101')]
    expect(await sync.run()).toMatchObject({ created: 0, updated: 2, conflicts: [] })
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '102' })
    expect(await store.getMappingByUser('acme', 'bob')).toMatchObject({ extension: '101' })
  })

  it('keeps a manual mapping of someone the directory does not know, and never takes its extension', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'admin', extension: '100' })
    await store.upsertMapping({ tenantId: 'acme', userId: 'old', extension: '109' })
    const { sync } = setup([person('alice', 'Alice', '101'), person('eve', 'Eve', '100')], store)
    const report = await sync.run()
    expect(report).toMatchObject({ created: 1, removed: 0, conflicts: [{ userId: 'eve', extension: '100', heldBy: 'admin' }] })
    expect(await store.getMappingByUser('acme', 'admin')).toMatchObject({ extension: '100', source: 'manual' })
    expect(await store.getMappingByUser('acme', 'old')).toMatchObject({ extension: '109' })
    expect(await store.getMappingByUser('acme', 'eve')).toBeNull()
  })

  it('takes over the manual mapping of someone the directory knows: the directory is the truth', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'alice', extension: '199', displayName: 'A.' })
    const { sync } = setup([person('alice', 'Alice Martin', '101')], store)
    expect(await sync.run()).toMatchObject({ updated: 1, conflicts: [] })
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '101', displayName: 'Alice Martin', source: 'ldap' })
  })

  it('reports an extension the directory gives to two people, and keeps the first', async () => {
    const { store, sync } = setup([person('bob', 'Bob', '103'), person('marc', 'Marc', '103')])
    const report = await sync.run()
    expect(report.conflicts).toEqual([{ userId: 'marc', extension: '103', heldBy: 'bob' }])
    expect(await store.getMappingByExtension('acme', '103')).toMatchObject({ userId: 'bob' })
  })

  it('leaves a duplicated extension with the person who already holds it, whatever the listing order', async () => {
    const people = [person('alice', 'Alice', '101')]
    const { store, directory, sync } = setup(people)
    await sync.run()
    directory.listAll = async () => [person('bob', 'Bob', '101'), person('alice', 'Alice', '101')]
    const report = await sync.run()
    expect(report).toMatchObject({ unchanged: 1, created: 0, removed: 0, conflicts: [{ userId: 'bob', extension: '101', heldBy: 'alice' }] })
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '101' })
    expect(await store.getMappingByUser('acme', 'bob')).toBeNull()
  })

  it('never costs a mapping to a conflict: a person whose new extension is taken keeps the old one', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'admin', extension: '100' })
    const people = [person('alice', 'Alice', '101')]
    const { directory, sync } = setup(people, store)
    await sync.run()
    directory.listAll = async () => [person('alice', 'Alice', '100')]
    const report = await sync.run()
    expect(report).toMatchObject({ created: 0, updated: 0, removed: 0, conflicts: [{ userId: 'alice', extension: '100', heldBy: 'admin' }] })
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '101', source: 'ldap' })
    expect(await store.getMappingByUser('acme', 'admin')).toMatchObject({ extension: '100' })
  })

  it('lets a person take the extension a known person moves away from, in any order', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'alice', extension: '101' })
    const { sync } = setup([person('bob', 'Bob', '101'), person('alice', 'Alice', '102')], store)
    expect(await sync.run()).toMatchObject({ created: 1, updated: 1, conflicts: [] })
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '102', source: 'ldap' })
    expect(await store.getMappingByUser('acme', 'bob')).toMatchObject({ extension: '101' })
  })

  it("never gives a person a ring group's number: a conflict, and they keep the extension they had", async () => {
    const store = new MemoryStore()
    const people = [person('alice', 'Alice', '101'), person('bob', 'Bob', '102')]
    const directory = new MemoryContactDirectory(people)
    const groups = new Set<string>(['200'])
    const asked: string[] = []
    const sync = new DirectorySync({ store, directory, tenantId: 'acme', reserved: async tenantId => (asked.push(tenantId), groups) })
    await sync.run()
    expect(asked).toEqual(['acme'])
    // Alice is given 200 in the directory: the group keeps its number, Alice her 101; Carol, new, gets nothing.
    directory.listAll = async () => [person('alice', 'Alice', '200'), person('bob', 'Bob', '102'), person('carol', 'Carol', '200')]
    const report = await sync.run()
    expect(report).toMatchObject({ created: 0, updated: 0, removed: 0, conflicts: [{ userId: 'alice', extension: '200', heldBy: '', group: true }, { userId: 'carol', extension: '200', heldBy: '', group: true }] })
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '101' })
    expect(await store.getMappingByUser('acme', 'carol')).toBeNull()
    // The groups cannot be read: nothing changes, and the report says so without detail.
    const failing = new DirectorySync({ store, directory, tenantId: 'acme', reserved: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432') } })
    const failed = await failing.run()
    expect(failed.error).toMatch(/call groups could not be read/)
    expect(JSON.stringify(failed)).not.toMatch(/10\.0\.0\.5/)
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '101' })
  })

  it('refuses to remove anything when the directory lists nobody', async () => {
    const people = [person('alice', 'Alice', '101')]
    const { store, directory, sync } = setup(people)
    await sync.run()
    directory.listAll = async () => []
    const report = await sync.run()
    expect(report.error).toMatch(/listed nobody/)
    expect(report.removed).toBe(0)
    expect(await store.getMappingByUser('acme', 'alice')).not.toBeNull()
    // Nothing synced yet and nobody listed: nothing to say.
    expect((await setup([]).sync.run()).error).toBeUndefined()
  })

  it('never touches another tenant', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'other', userId: 'alice', extension: '101', source: 'ldap' })
    const { sync } = setup([], store)
    expect(await sync.run()).toMatchObject({ seen: 0, removed: 0 })
    expect(await store.getMappingByUser('other', 'alice')).not.toBeNull()
  })

  it('reports a directory that cannot be listed without saying where it lives, and keeps the mappings', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'alice', extension: '101', source: 'ldap' })
    const { directory, sync } = setup([], store)
    directory.listAll = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:636')
    }
    const report = await sync.run()
    expect(report.error).toMatch(/could not be listed/)
    expect(JSON.stringify(report)).not.toMatch(/10\.0\.0\.5/)
    expect(await store.getMappingByUser('acme', 'alice')).not.toBeNull()
    const noList = new DirectorySync({ store, directory: { search: directory.search.bind(directory), getMany: directory.getMany.bind(directory) }, tenantId: 'acme' })
    expect((await noList.run()).error).toMatch(/could not be listed/)
  })

  it('runs one synchronisation at a time: a second caller joins the one in progress', async () => {
    const { directory, sync } = setup([person('alice', 'Alice', '101')])
    let release!: () => void
    directory.listAll = () => new Promise(resolve => (release = () => resolve([person('alice', 'Alice', '101')])))
    const first = sync.run()
    expect(sync.status().running).toBe(true)
    const second = sync.run()
    release()
    expect(await first).toBe(await second)
    expect(sync.status().running).toBe(false)
  })

  it('runs an exclusive task between two synchronisations, never during one', async () => {
    const { directory, sync } = setup([person('alice', 'Alice', '101')])
    const order: string[] = []
    let release!: () => void
    directory.listAll = () => new Promise(resolve => (release = () => (order.push('run ends'), resolve([person('alice', 'Alice', '101')]))))
    const run = sync.run()
    // Waits for the run in progress, and the next run waits for it.
    const task = sync.exclusive(async () => {
      order.push('task')
      await new Promise(r => setTimeout(r, 20))
      order.push('task ends')
      return 42
    })
    release()
    await run
    directory.listAll = async () => (order.push('second run'), [person('alice', 'Alice', '101')])
    const second = sync.run()
    expect(await task).toBe(42)
    await second
    expect(order).toEqual(['run ends', 'task', 'task ends', 'second run'])
    // A task that fails holds nothing back.
    await expect(sync.exclusive(async () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    await expect(sync.run()).resolves.toMatchObject({ unchanged: 1 })
  })

  it('waits a bounded time for a synchronisation that does not end: 503 SYNC_RUNNING, and the task never runs', async () => {
    const { directory, sync } = setup([person('alice', 'Alice', '101')])
    let release!: () => void
    directory.listAll = () => new Promise(resolve => (release = () => resolve([person('alice', 'Alice', '101')])))
    const run = sync.run()
    let ran = false
    const started = Date.now()
    await expect(sync.exclusive(async () => (ran = true), 50)).rejects.toMatchObject({ statusCode: 503, code: 'SYNC_RUNNING' })
    expect(Date.now() - started).toBeLessThan(1_000)
    release()
    await run
    // Its turn came after it gave up: skipped, and it holds nothing back.
    await new Promise(r => setTimeout(r, 10))
    expect(ran).toBe(false)
    await expect(sync.exclusive(async () => 7, 50)).resolves.toBe(7)
    directory.listAll = async () => [person('alice', 'Alice', '101')]
    await expect(sync.run()).resolves.toMatchObject({ unchanged: 1 })
  })

  it('schedules runs and stops cleanly', async () => {
    const { sync } = setup([person('alice', 'Alice', '101')])
    sync.start(60_000, 5)
    expect(sync.status().intervalMs).toBe(60_000)
    await new Promise(r => setTimeout(r, 40))
    expect(sync.status().last?.created).toBe(1)
    sync.stop()
    expect(sync.status().intervalMs).toBeUndefined()
  })
})

describe('extensionOf and parseInterval', () => {
  it('takes the first extension, without spaces, and none when there is none', () => {
    expect(extensionOf(person('a', 'A', '1 01'))).toBe('101')
    expect(extensionOf(person('a', 'A'))).toBeUndefined()
    expect(extensionOf({ id: 'a', displayName: 'A', numbers: [{ type: 'extension', number: ' ' }] })).toBeUndefined()
  })
  it('reads human intervals', () => {
    expect(parseInterval(undefined, 7)).toBe(7)
    expect(parseInterval('15m', 7)).toBe(900_000)
    expect(parseInterval('1h', 7)).toBe(3_600_000)
    expect(parseInterval('90', 7)).toBe(90_000)
    expect(parseInterval('0', 7)).toBe(0)
    expect(parseInterval('24d', 7)).toBe(24 * 86_400_000)
    expect(() => parseInterval('soon', 7)).toThrow(/invalid interval/)
    // Above what a timer takes, Node would fire at once: a hot loop against the directory.
    expect(() => parseInterval('30d', 7)).toThrow(/at most 24 days/)
    expect(() => parseInterval('99999999999', 7)).toThrow(/at most 24 days/)
    expect(() => new DirectorySync({ store: new MemoryStore(), directory: new MemoryContactDirectory([]), tenantId: 't' }).start(MAX_INTERVAL_MS + 1)).toThrow(/out of range/)
  })
})
