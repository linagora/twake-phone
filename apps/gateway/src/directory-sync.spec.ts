import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Contact } from '@twake/telephony-types'
import { MemoryContactDirectory } from './contacts.js'
import { DirectorySync, HOLDER_RECORD, MAX_INTERVAL_MS, VOICEMAIL_HELD, extensionOf, holderIdOf, parseInterval, type HolderRecord } from './directory-sync.js'
import { accessNumberInUse, meetAccessMismatch, reservedInUse, seedUserMap } from './directory.js'
import { MemoryStore } from './store/memory.js'
import { PgStore } from './store/pg.js'

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

  it('records who it no longer lists, forgets it once they are listed again in any form, and takes an id for someone new only after an absence confirmed at each run long enough (eighth review 11a, n°1 and n°3)', async () => {
    const DAY = 86_400_000
    let at = Date.parse('2026-10-14T10:00:00.000Z')
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'admin', extension: '100' })
    let people = [person('alice', 'Alice', '101'), person('bob', 'Bob', '102')]
    const directory = new MemoryContactDirectory(people)
    directory.listAll = async () => people
    const sync = new DirectorySync({ store, directory, tenantId: 'acme', now: () => new Date(at), absenceMs: DAY })
    const record = async (userId: string) => (await store.getOperatorState('acme', `${HOLDER_RECORD}${userId}`)) as HolderRecord | undefined
    const idOf = async (userId: string) => holderIdOf(userId, await record(userId))
    await sync.run()
    expect(await store.listOperatorState('acme', HOLDER_RECORD)).toEqual([])
    const run = async (now: typeof people, after: number) => {
      at += after
      people = now
      await sync.run()
    }
    // Bob missed by one listing: recorded; listed again two days later, without a run between that confirmed it: the
    // same Bob, his record back to his epoch (0). The administrator's manual mapping, never listed, is no absence.
    await run([people[0]!], 0)
    expect(await record('bob')).toEqual({ absentSince: new Date(at).toISOString(), absentConfirmed: new Date(at).toISOString() })
    expect(await record('admin')).toBeUndefined()
    await run([person('alice', 'Alice', '101'), person('bob', 'Bob', '102')], 2 * DAY)
    expect([await record('bob'), await idOf('bob')]).toEqual([{}, 'bob'])
    // Missed at each run for less than the absence: the same Bob, listed again even without an extension.
    await run([people[0]!], DAY / 4)
    await run([people[0]!], DAY / 2)
    await run([people[0]!, person('bob', 'Bob')], DAY / 4)
    expect([await record('bob'), await idOf('bob')]).toEqual([{}, 'bob'])
    expect(await store.getMappingByUser('acme', 'bob')).toBeNull()
    // Missed at each run for a day (without a mapping since he had no extension): confirmed, not written again; listed
    // again, someone new under that id.
    await run([people[0]!], DAY / 4)
    await run([people[0]!], DAY / 2)
    await run([people[0]!], DAY / 2)
    const confirmed = await record('bob')
    await run([people[0]!], DAY)
    expect(await record('bob')).toEqual(confirmed)
    await run([people[0]!, person('bob', 'Bob', '102')], DAY / 4)
    expect([await record('bob'), await idOf('bob')]).toEqual([{ epoch: 1 }, 'bob\u00001'])
    expect(await store.getMappingByUser('acme', 'bob')).toMatchObject({ extension: '102' })
    // That one missed once, then back: still the second holder of the id.
    await run([people[0]!], DAY / 4)
    expect(await record('bob')).toMatchObject({ epoch: 1, absentSince: new Date(at).toISOString() })
    await run([people[0]!, person('bob', 'Bob', '102')], DAY / 4)
    expect(await record('bob')).toEqual({ epoch: 1 })
    // Not listed, but given a mapping by an administrator: present all the same, however long the directory omits him.
    await run([people[0]!], DAY / 4)
    await store.upsertMapping({ tenantId: 'acme', userId: 'bob', extension: '109' })
    for (let i = 0; i < 4; i++) await run([people[0]!], DAY / 2)
    expect([await record('bob'), await idOf('bob')]).toEqual([{ epoch: 1 }, 'bob\u00001'])
    // Carol loses her extension, still listed (known from then on), then leaves for good: back, someone new.
    await run([people[0]!, person('carol', 'Carol', '103')], DAY / 4)
    await run([people[0]!, person('carol', 'Carol')], DAY / 4)
    expect(await record('carol')).toEqual({})
    for (let i = 0; i < 3; i++) await run([people[0]!], DAY / 2)
    await run([people[0]!, person('carol', 'Carol', '103')], DAY / 4)
    expect(await idOf('carol')).toBe('carol\u00001')
  })

  it('stands the absences still while a set-aside is held back, and forgets a decided one once no mailbox of theirs is left, unless something is held back (ninth review 11a, n°1 and n°3)', async () => {
    const DAY = 86_400_000
    let at = Date.parse('2026-10-14T10:00:00.000Z')
    const store = new MemoryStore()
    let people = [person('alice', 'Alice', '101'), person('bob', 'Bob', '102'), person('carol', 'Carol', '103')]
    const directory = new MemoryContactDirectory(people)
    directory.listAll = async () => people
    const sync = new DirectorySync({ store, directory, tenantId: 'acme', now: () => new Date(at), absenceMs: DAY, recordKeepMs: 10 * DAY })
    const record = async (userId: string) => (await store.getOperatorState('acme', `${HOLDER_RECORD}${userId}`)) as HolderRecord | undefined
    const span = (r: HolderRecord | undefined) => Date.parse(r!.absentConfirmed!) - Date.parse(r!.absentSince!)
    const run = async (after: number) => {
      at += after
      await sync.run()
    }
    await sync.run()
    people = [people[0]!, people[2]!]
    await run(0)
    await run(DAY / 2)
    expect(span(await record('bob'))).toBe(DAY / 2)
    // Held back: however many runs and days, the absence keeps its length.
    await store.putOperatorState('acme', VOICEMAIL_HELD, { park: 3, of: 4 })
    for (let i = 0; i < 4; i++) await run(DAY)
    expect(span(await record('bob'))).toBe(DAY / 2)
    // A removal held back only: the absences run.
    await store.putOperatorState('acme', VOICEMAIL_HELD, { remove: 3, of: 4 })
    await run(DAY / 4)
    expect(span(await record('bob'))).toBe((3 * DAY) / 4)
    await store.deleteOperatorState('acme', VOICEMAIL_HELD)
    await run(DAY / 4)
    expect(span(await record('bob'))).toBe(DAY)
    // Decided; kept while something is held back, gone once no mailbox of his can be left.
    const since = Date.parse((await record('bob'))!.absentSince!)
    await store.putOperatorState('acme', VOICEMAIL_HELD, { remove: 3, of: 4 })
    at = since + 11 * DAY
    await sync.run()
    expect(await record('bob')).toBeDefined()
    await store.deleteOperatorState('acme', VOICEMAIL_HELD)
    await sync.run()
    expect(await record('bob')).toBeUndefined()
  })

  it('changes nothing while who left cannot be recorded, and does it all at the next run that can (eighth review 11a, n°5)', async () => {
    const people = [person('alice', 'Alice', '101'), person('bob', 'Bob', '102'), person('carol', 'Carol', '103')]
    const { store, directory, sync } = setup(people)
    await sync.run()
    const put = store.putOperatorState.bind(store)
    let failing = 1
    store.putOperatorState = async (tenantId, key, value) => {
      if (key.startsWith(HOLDER_RECORD) && failing-- > 0) throw new Error('database down a moment')
      return put(tenantId, key, value)
    }
    // Bob leaves, Carol changes extension: nothing done, said.
    directory.listAll = async () => [person('alice', 'Alice', '101'), person('carol', 'Carol', '104')]
    expect(await sync.run()).toMatchObject({ removed: 0, updated: 0, error: expect.stringMatching(/could not be recorded: nothing was changed/) })
    expect(await store.getMappingByUser('acme', 'bob')).toMatchObject({ extension: '102' })
    expect(await store.getMappingByUser('acme', 'carol')).toMatchObject({ extension: '103' })
    expect(await store.listOperatorState('acme', HOLDER_RECORD)).toEqual([])
    expect(await sync.run()).toMatchObject({ removed: 1, updated: 1 })
    expect(await store.getMappingByUser('acme', 'carol')).toMatchObject({ extension: '104' })
    expect(await store.getMappingByUser('acme', 'bob')).toBeNull()
    // Bob absent from now; Carol, whose mapping changed, known.
    expect((await store.listOperatorState('acme', HOLDER_RECORD)).map(r => [r.key, r.value])).toEqual([
      [`${HOLDER_RECORD}bob`, { absentSince: '2026-10-14T10:00:00.000Z', absentConfirmed: '2026-10-14T10:00:00.000Z' }],
      [`${HOLDER_RECORD}carol`, {}]
    ])
  })

  it('reports mappings that could not be written or read, changes nothing, and does it at the next run (review of PR 27, n°2)', async () => {
    const people = [person('alice', 'Alice', '101'), person('bob', 'Bob', '102')]
    const { store, directory, sync } = setup(people)
    await sync.run()
    const apply = store.applyMappings.bind(store)
    store.applyMappings = async () => {
      throw new Error('connection terminated')
    }
    directory.listAll = async () => [person('alice', 'Alice', '103')]
    expect(await sync.run()).toMatchObject({ removed: 0, updated: 0, error: expect.stringMatching(/mappings could not be written: nothing was changed/) })
    expect(sync.status()).toMatchObject({ running: false, last: { error: expect.stringMatching(/could not be written/) } })
    expect((await store.listMappings('acme')).map(m => `${m.userId}:${m.extension}`)).toEqual(['alice:101', 'bob:102'])
    const list = store.listMappings.bind(store)
    store.applyMappings = apply
    store.listMappings = async () => {
      throw new Error('connection terminated')
    }
    expect(await sync.run()).toMatchObject({ removed: 0, updated: 0, error: expect.stringMatching(/mappings could not be read: nothing was changed/) })
    store.listMappings = list
    expect(await sync.run()).toMatchObject({ removed: 1, updated: 1, conflicts: [] })
    expect((await store.listMappings('acme')).map(m => `${m.userId}:${m.extension}`)).toEqual(['alice:103'])
  })

  it('logs a scheduled run that rejects, and runs again at the next tick (review of PR 27, n°2)', async () => {
    const errors: string[] = []
    const store = new MemoryStore()
    const sync = new DirectorySync({
      store,
      directory: new MemoryContactDirectory([person('alice', 'Alice', '101')]),
      tenantId: 'acme',
      log: { info: () => undefined, error: (_o, msg) => errors.push(msg) }
    })
    const run = sync.run.bind(sync)
    let runs = 0
    sync.run = () => (runs++ === 0 ? Promise.reject(new Error('out of the blue')) : run())
    sync.start(15, 1)
    for (let i = 0; i < 200 && !sync.status().last; i++) await new Promise(r => setTimeout(r, 5))
    sync.stop()
    expect(errors).toContain('directory synchronisation failed')
    expect(sync.status().last).toMatchObject({ created: 1 })
  })

  it('counts a write the store refused as a conflict, never as made (review of PR 27, n°5)', async () => {
    const { store, directory, sync } = setup([person('alice', 'Alice', '101'), person('bob', 'Bob', '102')])
    await sync.run()
    const apply = store.applyMappings.bind(store)
    // Another Gateway wrote Bob's new extension meanwhile: his write is refused, Alice's and Carol's go.
    store.applyMappings = async (tenantId, change) => {
      const out = await apply(tenantId, { ...change, write: change.write.filter(m => m.userId !== 'bob') })
      return { failed: [...out.failed, { userId: 'bob', err: new Error('duplicate key') }] }
    }
    directory.listAll = async () => [person('alice', 'Alice', '201'), person('bob', 'Bob', '202'), person('carol', 'Carol', '203')]
    expect(await sync.run()).toMatchObject({ created: 1, updated: 1, removed: 0, conflicts: [{ userId: 'bob', extension: '202', heldBy: '?' }] })
    // His row of before went with the removals, as in the PostgreSQL store: the next run writes it.
    expect((await store.listMappings('acme')).map(m => `${m.userId}:${m.extension}`)).toEqual(['alice:201', 'carol:203'])
    store.applyMappings = apply
    expect(await sync.run()).toMatchObject({ created: 1, updated: 0, unchanged: 2, conflicts: [] })
    expect(await store.getMappingByUser('acme', 'bob')).toMatchObject({ extension: '202' })
  })

  it('keeps the erasure of a history of whom it gives another extension, or none, and forgets it of whom left (fourth review 10b, n°2)', async () => {
    const people = [person('alice', 'Alice Martin', '101'), person('bob', 'Bob Durand', '102'), person('dave', 'Dave', '104')]
    const { store, directory, sync } = setup(people)
    await sync.run()
    for (const [userId, number] of [['alice', '+33199000101'], ['bob', '+33199000102'], ['dave', '+33199000104']] as const) await store.deleteHistory('acme', userId, [number])
    // Alice moves to 105, Bob loses his extension, Dave leaves.
    people.splice(0, 3, person('alice', 'Alice Martin', '105'), person('bob', 'Bob Durand'))
    directory.listAll = async () => people
    await sync.run()
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '105' })
    expect([!!(await store.historyErasedAt('acme', 'alice')), !!(await store.historyErasedAt('acme', 'bob')), !!(await store.historyErasedAt('acme', 'dave'))]).toEqual([true, true, false])
    expect([...(await store.numbersErasedAt('acme', ['+33199000101', '+33199000102', '+33199000104'])).keys()].sort()).toEqual(['+33199000101', '+33199000102'])
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

  it('never gives a person an emergency number or another short number of the French plan: dialled, it goes to the operator', async () => {
    const { store, directory, sync } = setup([person('alice', 'Alice', '101'), person('bob', 'Bob', '102')])
    await sync.run()
    // Alice is given 112 in the directory, Carol (new) 15, Dan 116006, Eve 118218: none of them gets it.
    directory.listAll = async () => [person('alice', 'Alice', '112'), person('bob', 'Bob', '102'), person('carol', 'Carol', '15'), person('dan', 'Dan', '116006'), person('eve', 'Eve', '118218'), person('fay', 'Fay', '1120')]
    const report = await sync.run()
    expect(report.conflicts).toEqual([
      { userId: 'alice', extension: '112', heldBy: '', reserved: true },
      { userId: 'carol', extension: '15', heldBy: '', reserved: true },
      { userId: 'dan', extension: '116006', heldBy: '', reserved: true },
      { userId: 'eve', extension: '118218', heldBy: '', reserved: true }
    ])
    expect(report).toMatchObject({ created: 1, removed: 0 })
    // Alice keeps the extension she had; nobody holds a reserved number; 1120 is an extension like any other.
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '101' })
    for (const n of ['112', '15', '116006', '118218']) expect(await store.getMappingByExtension('acme', n), n).toBeNull()
    expect(await store.getMappingByUser('acme', 'fay')).toMatchObject({ extension: '1120' })
  })

  it('never gives a person an extension out of the internal plan (2 to 6 digits, the first not 0): dialled, it would go to the operator', async () => {
    const { store, directory, sync } = setup([person('alice', 'Alice', '101')])
    await sync.run()
    directory.listAll = async () => [person('alice', 'Alice', '0101'), person('bob', 'Bob', '0199000102'), person('carol', 'Carol', '1234567'), person('dan', 'Dan', '7'), person('eve', 'Eve', '104')]
    const report = await sync.run()
    expect(report.conflicts).toEqual([
      { userId: 'alice', extension: '0101', heldBy: '', invalid: true },
      { userId: 'bob', extension: '0199000102', heldBy: '', invalid: true },
      { userId: 'carol', extension: '1234567', heldBy: '', invalid: true },
      { userId: 'dan', extension: '7', heldBy: '', invalid: true }
    ])
    // Alice keeps the extension she had; the others get none; Eve's is of the plan.
    expect(await store.getMappingByUser('acme', 'alice')).toMatchObject({ extension: '101' })
    for (const userId of ['bob', 'carol', 'dan']) expect(await store.getMappingByUser('acme', userId), userId).toBeNull()
    expect(await store.getMappingByUser('acme', 'eve')).toMatchObject({ extension: '104' })
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

describe('the short numbers of the French plan (an emergency number...) as extensions', () => {
  it('seeds DEV_USER_MAP (USER_EXTENSIONS of the pilot kit) without them, and says which were left out', async () => {
    const store = new MemoryStore()
    const warned: string[] = []
    await store.upsertMapping({ tenantId: 'acme', userId: 'bob', extension: '150' })
    await seedUserMap(store, 'acme', 'alice:101,bob:102,carol:112,dan:18,eve:116006', m => warned.push(m))
    expect((await store.listMappings('acme')).map(m => `${m.userId}:${m.extension}`).sort()).toEqual(['alice:101', 'bob:150'])
    expect(warned).toHaveLength(3)
    expect(warned[0]).toMatch(/^carol:112 left out: 112 is an emergency number/)
  })

  it('seeds DEV_USER_MAP with extensions of the internal plan only (2 to 6 digits, the first not 0)', async () => {
    const store = new MemoryStore()
    const warned: string[] = []
    await seedUserMap(store, 'acme', 'alice:101,bob:0102,carol:1234567,dan:+33199000104,eve:105', m => warned.push(m))
    expect((await store.listMappings('acme')).map(m => `${m.userId}:${m.extension}`).sort()).toEqual(['alice:101', 'eve:105'])
    expect(warned).toHaveLength(3)
    expect(warned[0]).toMatch(/^bob:0102 left out: an extension is 2 to 6 digits, the first not 0/)
  })

  it('names the extensions and ring groups kept from before that are one, to be changed', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'alice', extension: '101' })
    await store.upsertMapping({ tenantId: 'acme', userId: 'carol', extension: '115' })
    expect(await reservedInUse(store, 'acme', ['200', '17'])).toEqual(['extension 115 (carol)', 'ring group 17'])
    expect(await reservedInUse(store, 'other', [])).toEqual([])
  })
})

describe("the access number of Meet's rooms (step 8, review n°12)", () => {
  it('seeds DEV_USER_MAP without it when the rooms are on, and says so', async () => {
    const store = new MemoryStore()
    const warned: string[] = []
    await seedUserMap(store, 'acme', 'alice:101,bob:8000', m => warned.push(m), '8000')
    expect((await store.listMappings('acme')).map(m => `${m.userId}:${m.extension}`)).toEqual(['alice:101'])
    expect(warned).toEqual([expect.stringMatching(/^bob:8000 left out: 8000 is the access number of the meeting rooms \(MEET_NUMBER\)/)])
    // The rooms off: 8000 is an extension like another.
    const off = new MemoryStore()
    await seedUserMap(off, 'acme', 'alice:101,bob:8000', m => warned.push(m))
    expect((await off.listMappings('acme')).map(m => m.extension).sort()).toEqual(['101', '8000'])
    expect(warned).toHaveLength(1)
  })

  it('names the extension or ring group kept from before that is the access number, to be changed', async () => {
    const store = new MemoryStore()
    await store.upsertMapping({ tenantId: 'acme', userId: 'alice', extension: '101' })
    await store.upsertMapping({ tenantId: 'acme', userId: 'bob', extension: '8000' })
    expect(await accessNumberInUse(store, 'acme', '8000', ['200'])).toEqual(['extension 8000 (bob)'])
    expect(await accessNumberInUse(store, 'acme', '200', ['200', '300'])).toEqual(['ring group 200'])
    expect(await accessNumberInUse(store, 'acme', undefined, ['8000'])).toEqual([])
  })

  it('says when the Gateway and OpenSIPS disagree on it, nothing when they agree or OpenSIPS cannot say', () => {
    expect(meetAccessMismatch('8000', { number: '8000' })).toEqual([])
    expect(meetAccessMismatch(undefined, {})).toEqual([])
    expect(meetAccessMismatch('8000', undefined)).toEqual([])
    expect(meetAccessMismatch('8000', { number: '7000' })).toEqual([expect.stringMatching(/8000 here and 7000 in OpenSIPS/)])
    expect(meetAccessMismatch('8000', {})).toEqual([expect.stringMatching(/on here .* and off in OpenSIPS/)])
    expect(meetAccessMismatch(undefined, { number: '8000' })).toEqual([expect.stringMatching(/off here .* and on in OpenSIPS/)])
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL), in a schema of its own: the synchronisation of the mailboxes reads
// the mappings while a directory synchronisation changes them.
if (process.env.TEST_DATABASE_URL) {
  describe('DirectorySync on PostgreSQL, read meanwhile', () => {
    const SCHEMA = 'spec_directory_sync'
    const APP = 'spec-directory-sync'
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 })
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${SCHEMA}`)
    url.searchParams.set('application_name', APP)
    const stores: PgStore[] = []
    const open = async () => {
      const s = new PgStore(url.toString())
      stores.push(s)
      await s.migrate()
      return s
    }
    beforeAll(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    })
    afterAll(async () => {
      for (const s of stores) await s.close()
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await admin.end()
    })

    it('never shows someone given another extension as gone to a read between its removals and its writes (the mailbox set aside, the voicemail server reloaded)', async () => {
      const store = await open()
      // The synchronisation of the mailboxes, on another Gateway: its own connections.
      const mailboxes = await open()
      let people = [person('bob', 'Bob Durand', '102'), person('alice', 'Alice Martin', '101')]
      const directory = new MemoryContactDirectory(people)
      directory.listAll = async () => people
      const sync = new DirectorySync({ store, directory, tenantId: 'acme', now: () => new Date('2026-10-14T10:00:00.000Z') })
      await sync.run()
      // Alice moves to 103, Bob is renamed: Alice's row goes, then Bob's is written, then Alice's.
      people = [person('bob', 'Bob Durand-Petit', '102'), person('alice', 'Alice Martin', '103')]
      // Bob's row held by someone else a moment (another writer): the synchronisation waits on it, after Alice's row went.
      const lock = await admin.connect()
      let mid: Date | undefined
      try {
        await lock.query('BEGIN')
        await lock.query(`SELECT 1 FROM ${SCHEMA}.user_mappings WHERE tenant_id = 'acme' AND user_id = 'bob' FOR UPDATE`)
        const running = sync.run()
        const start = Date.now()
        for (;;) {
          const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [APP])
          if (rows[0]!.n > 0) break
          if (Date.now() - start > 5_000) throw new Error('the synchronisation never waited on the row held')
          await new Promise(r => setTimeout(r, 10))
        }
        // Read now, as the mailboxes are: Alice still there, at her extension of before.
        const seen = await mailboxes.listMappings('acme')
        expect(seen.map(m => `${m.userId}:${m.extension}`)).toEqual(['alice:101', 'bob:102'])
        // A call of the operator to 101 starting now still rang Alice: her extension changes hands after it.
        mid = (await admin.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t
        await lock.query('COMMIT')
        expect(await running).toMatchObject({ updated: 2, removed: 0, conflicts: [] })
      } finally {
        await lock.query('ROLLBACK').catch(() => undefined)
        lock.release()
      }
      expect((await mailboxes.listMappings('acme')).map(m => `${m.userId}:${m.extension}:${m.displayName}`)).toEqual(['alice:103:Alice Martin', 'bob:102:Bob Durand-Petit'])
      // The change of hands dated at its COMMIT, not at its BEGIN.
      expect(Date.parse((await mailboxes.numberChangedAt('acme', '101', '101'))!)).toBeGreaterThan(mid.getTime())
    })
  })
}
