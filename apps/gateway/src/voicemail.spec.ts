import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { VOICEMAIL_BOXES_SCHEMA, VoicemailBoxes } from '@twake/provider-opensips'
import type { ProviderFactory, RoutedEvent, TelephonyProvider, VoicemailBox, VoicemailBoxesWrite, VoicemailOwner, VoicemailProvider, VoicemailSync } from '@twake/telephony-provider-sdk'
import type { TelephonyEvent, Voicemail } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import type { ContactDirectory } from './contacts.js'
import { StoreDirectory } from './directory.js'
import { DirectorySync } from './directory-sync.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { holderSecretOf, retentionDaysOf, voicemailMismatch, wazoFromEnv } from './voicemail.js'
import { voicemailRole } from './voicemail-lease.js'

const until = async (what: string, fn: () => boolean | Promise<boolean>, timeout = 3_000) => {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** The number of a person's mailbox, theirs whatever extension they hold (as provider-wazo: fourth review 11a, n°1). */
const NUMBERS: Record<string, string> = { alice: '1001', jean: '1002', marie: '1003', bob: '1004' }
const boxOf = (userId: string) => `${NUMBERS[userId] ?? [...userId].map(c => c.charCodeAt(0) % 10).join('')}@ctx`

/**
 * A voicemail server in memory: one mailbox per extension, for the holder of the last sync. As provider-wazo: its
 * status is what its last request left (a Gateway that makes none says nothing new: fourth review 11a, n°3), `probe`
 * asks it now, and it writes nothing unless it is given `mayWrite` and that says yes (fourth review n°10): what it
 * wrote is in `written`.
 */
const fakeVoicemail = () => {
  const holders = new Map<string, string>()
  const messages = new Map<string, Voicemail[]>()
  const syncs: string[] = []
  let fail = 0
  /** A synchronisation that waits for this to be resolved (a voicemail server that takes its time). */
  let gate: Promise<void> | undefined
  const purges: Date[] = []
  const erased: string[] = []
  let push: ((e: RoutedEvent) => void) | undefined
  const pending: RoutedEvent[] = []
  let down = false
  /** What its last request left: unknown before the first. */
  let answered: boolean | undefined
  const reached = () => {
    answered = !down
    if (down) throw new Error('voicemail server not reached')
  }
  /** What it wrote: `sync <holders>` or `purge`. */
  const written: string[] = []
  /** How many mailboxes the next synchronisations say Wazo refused; how many synchronisations were asked. */
  let refused = 0
  let tries = 0
  /** What the next synchronisations hold back (second review 11a, n°9), and the `release` each one was given. */
  let heldBack: VoicemailSync['heldBack']
  const releases: string[] = []
  /** Called during a synchronisation, after the reads (another Gateway changing a holder meanwhile). */
  let during: (() => Promise<void>) | undefined
  /** Called once the voicemail server is written, before the synchronisation answers. */
  let after: (() => Promise<void>) | undefined
  /** What a synchronisation given a release finds held back instead (the mass changed since the administrator saw it). */
  let atRelease: VoicemailSync['heldBack']
  /** Synchronisations waiting for `hold`'s gate. */
  let waiting = 0
  const owned: VoicemailOwner[] = []
  /** The id of the mailbox at each extension (`box-<extension>-<holder>`), as the events name it. */
  const boxIds = new Map<string, string>()
  const mine = (o: VoicemailOwner) => holders.get(o.extension) === o.userId
  const vm: VoicemailProvider = {
    id: 'fake-wazo',
    getStatus: () => (answered ? 'CONNECTED' : 'DISCONNECTED'),
    getStatusReason: () => (answered ? undefined : 'voicemail server not reached'),
    probe: async () => reached(),
    async syncMailboxes(list, options = {}) {
      tries++
      if (gate) {
        waiting++
        await gate
        waiting--
      }
      if (fail-- > 0) throw new Error('voicemail server not reached')
      reached()
      syncs.push(list.map(h => `${h.extension}=${h.userId}`).sort().join(','))
      releases.push(options.release ? JSON.stringify(options.release) : '')
      // Before any change: the mailboxes already at their holder's extension.
      await options.beforeChanges?.(list.filter(h => holders.get(h.extension) === h.userId).map(h => ({ extension: h.extension, mailbox: boxOf(h.userId) })))
      await during?.()
      // As the provider: nothing written unless it may write, asked before each write.
      if (!options.mayWrite) throw new Error('syncMailboxes without mayWrite: the provider would write without asking')
      if (!options.mayWrite()) throw new Error('stopped: the mailboxes are no longer this Gateway\'s to write')
      written.push(`sync ${list.map(h => `${h.extension}=${h.userId}`).sort().join(',')}`)
      if (options.release && atRelease) {
        heldBack = atRelease
        atRelease = undefined
      }
      // Let go: what was held back is done, when the release names exactly that.
      const released = !!heldBack && !!options.release && JSON.stringify(options.release) === JSON.stringify(heldBack)
      if (released) heldBack = undefined
      const held = heldBack
      for (const [ext, user] of [...holders]) {
        if (list.some(h => h.extension === ext && h.userId === user)) continue
        holders.delete(ext)
        messages.delete(ext)
      }
      for (const h of list) {
        if (holders.has(h.extension)) continue
        holders.set(h.extension, h.userId)
        messages.set(h.extension, [])
      }
      for (const h of list) if (!boxIds.has(h.extension)) boxIds.set(h.extension, `box-${h.extension}-${h.userId}`)
      for (const ext of [...boxIds.keys()]) if (!holders.has(ext)) boxIds.delete(ext)
      for (const h of list) boxIds.set(h.extension, `box-${h.extension}-${h.userId}`)
      await after?.()
      return { boxes: list.map(h => ({ extension: h.extension, mailbox: boxOf(h.userId) })), failed: refused, ...(held ? { heldBack: held } : {}), ...(released ? { released: true } : {}) }
    },
    // With the mailbox of an event: that very mailbox must be the one at the extension, the person's (as provider-wazo).
    owns: async o => {
      owned.push(o)
      return mine(o) && (o.mailbox === undefined || boxIds.get(o.extension) === o.mailbox)
    },
    async listMessages(o) {
      answered = !down
      if (down) throw new Error('fetch failed')
      return mine(o) ? [...(messages.get(o.extension) ?? [])] : []
    },
    getRecording: async (o, id) => {
      if (!mine(o) || !messages.get(o.extension)?.some(m => m.id === id)) return undefined
      const bytes = new TextEncoder().encode(`RIFF${id}`)
      // A stream, in two pieces; one past its bound breaks off.
      const body = (async function* () {
        yield bytes.slice(0, 4)
        if (id.endsWith('-big')) throw new Error('recording larger than its bound')
        yield bytes.slice(4)
      })()
      return { contentType: 'audio/wav', size: bytes.length, body }
    },
    async eraseMessages(o) {
      if (down) throw new Error('fetch failed')
      erased.push(o.userId)
      let n = 0
      for (const [ext, user] of holders) {
        if (user !== o.userId) continue
        n += messages.get(ext)?.length ?? 0
        messages.set(ext, [])
      }
      return n
    },
    async purgeMessages(before, options = {}) {
      purges.push(before)
      if (!options.mayWrite) throw new Error('purgeMessages without mayWrite: the provider would delete without asking')
      if (!options.mayWrite()) throw new Error('stopped')
      written.push('purge')
      return 0
    },
    async markRead(o, id) {
      const m = mine(o) ? messages.get(o.extension)?.find(x => x.id === id) : undefined
      if (m) m.unread = false
      return !!m
    },
    async deleteMessage(o, id) {
      const list = mine(o) ? messages.get(o.extension) : undefined
      if (!list?.some(m => m.id === id)) return false
      messages.set(o.extension, list.filter(m => m.id !== id))
      return true
    },
    subscribe() {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const e = pending.shift()
            if (e) return Promise.resolve({ value: e, done: false })
            return new Promise<IteratorResult<RoutedEvent>>(resolve => (push = value => resolve({ value, done: false })))
          }
        })
      }
    },
    close: async () => {}
  }
  const emit = (e: RoutedEvent) => {
    if (push) {
      const p = push
      push = undefined
      p(e)
    } else pending.push(e)
  }
  return {
    vm,
    holders,
    boxIds,
    messages,
    syncs,
    releases,
    owned,
    holdBack: (h: VoicemailSync['heldBack']) => void (heldBack = h),
    duringSync: (fn: (() => Promise<void>) | undefined) => void (during = fn),
    afterSync: (fn: (() => Promise<void>) | undefined) => void (after = fn),
    foundAtRelease: (h: VoicemailSync['heldBack']) => void (atRelease = h),
    waiting: () => waiting,
    emit,
    purges,
    erased,
    written,
    failNext: (n: number) => void (fail = n),
    refuse: (n: number) => void (refused = n),
    tries: () => tries,
    down: (d: boolean) => void (down = d),
    hold: () => {
      let open!: () => void
      gate = new Promise<void>(resolve => (open = resolve))
      return () => {
        gate = undefined
        open()
      }
    }
  }
}

/**
 * A SIP server keeping the mailboxes it is given, as provider-opensips with its `voicemail_boxes` table: that table
 * itself when given `db` (VoicemailBoxes on a real PostgreSQL), in memory otherwise.
 */
const sipServer = (withMailboxes = true, access?: boolean | 'error', db?: VoicemailBoxes) => {
  const given: VoicemailBox[][] = []
  const withdrawn: string[][] = []
  /** What the SIP server was told, in order. */
  const order: string[] = []
  const asked = { access: 0 }
  /**
   * Called at each set before it is written and after (a test acting between the Gateway's last check and its write,
   * or between two writes); withdrawals that fail first, or wait; what the next set says it left out as withdrawn
   * since the mark given, or whether it refuses it under an older lease (VOICEMAIL_FENCED), in memory.
   */
  const hooks: { beforeSet?: (boxes: VoicemailBox[]) => Promise<void>; onSet?: (boxes: VoicemailBox[]) => Promise<void>; onWithdraw?: () => Promise<void>; failWithdraw: number; withdrawnOnce?: string[]; fenceNext?: boolean } = { failWithdraw: 0 }
  /** The codes of the writes the database refused. */
  const errors: string[] = []
  /** What each write was given to check (VoicemailBoxesWrite), and the number of the last withdrawal. */
  const writes: VoicemailBoxesWrite[] = []
  let mark = 0
  const provider = {
    ...(access !== undefined
      ? {
          getVoicemailAccess: async () => {
            asked.access++
            if (access === 'error') throw new Error('MI not reached')
            return access
          }
        }
      : {}),
    getStatus: () => 'CONNECTED',
    getCapabilities: async () => ({ presence: { realtime: true }, conference: { dialIn: false, dialOut: false } }),
    getPresence: async () => ({ status: 'available', source: 'telephony' }),
    setPresence: async () => {},
    ...(withMailboxes
      ? {
          setVoicemailBoxes: async (boxes: VoicemailBox[], write: VoicemailBoxesWrite = {}) => {
            writes.push(write)
            await hooks.beforeSet?.(boxes)
            let left: string[] | undefined
            if (db) {
              try {
                left = (await db.set(boxes, write)).withdrawn
              } catch (err) {
                errors.push(String((err as { code?: unknown }).code ?? err))
                throw err
              }
            } else if (hooks.fenceNext) {
              hooks.fenceNext = false
              throw Object.assign(new Error('written under a later lease'), { code: 'VOICEMAIL_FENCED' })
            } else {
              left = hooks.withdrawnOnce
              hooks.withdrawnOnce = undefined
            }
            given.push(boxes)
            order.push(`set ${boxes.map(b => b.extension).join(',')}`)
            await hooks.onSet?.(boxes)
            return left?.length ? { withdrawn: left } : {}
          },
          withdrawVoicemailBoxes: async (extensions: string[]) => {
            if (hooks.failWithdraw-- > 0) throw new Error('database down a moment')
            await hooks.onWithdraw?.()
            if (db) await db.withdraw(extensions)
            withdrawn.push(extensions)
            order.push(`withdraw ${extensions.join(',')}`)
            mark++
          },
          voicemailMark: async () => (db ? db.mark() : mark)
        }
      : {}),
    subscribe: async function* () {},
    close: async () => {}
  }
  const factory: ProviderFactory<unknown> = { type: 'sip', create: () => provider as unknown as TelephonyProvider }
  return { factory, given, withdrawn, asked, order, hooks, writes, errors }
}

const setup = async (opts: { withMailboxes?: boolean; access?: boolean | 'error'; voicemail?: boolean | 'other-tenant'; directorySync?: DirectorySync; store?: MemoryStore; slow?: boolean; retentionDays?: number; purgeMs?: number; syncMs?: number; hub?: boolean; accessCacheMs?: number; changeMs?: number; alertMs?: number; mapped?: boolean; db?: VoicemailBoxes } = {}) => {
  process.env.AUTH_MODE = 'dev'
  const store = opts.store ?? new MemoryStore()
  if (opts.mapped !== false) {
    await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101', displayName: 'Alice Martin' })
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '102' })
  }
  const sip = sipServer(opts.withMailboxes ?? true, opts.access, opts.db)
  const wazo = fakeVoicemail()
  const release = opts.slow ? wazo.hold() : undefined
  const bus = new EventBus()
  const registry = new ProviderRegistry([{ tenantId: 'A', type: 'sip', config: {} }], [sip.factory])
  const app = await buildApp(registry, {
    store,
    bus,
    directory: new StoreDirectory(store),
    tickets: new TicketStore(),
    // 'other-tenant': a voicemail server for another tenant only, none for A.
    ...(opts.voicemail === false ? {} : { voicemail: (t: string) => (t === (opts.voicemail === 'other-tenant' ? 'B' : 'A') ? wazo.vm : undefined) }),
    ...(opts.directorySync ? { directorySync: opts.directorySync } : {}),
    admin: { adminRole: 'twakephone-admin', adminUsers: new Set(['A:root']) },
    ...(opts.retentionDays !== undefined ? { voicemailRetentionDays: opts.retentionDays } : {}),
    ...(opts.purgeMs !== undefined ? { voicemailPurgeMs: opts.purgeMs } : {}),
    ...(opts.syncMs !== undefined ? { voicemailSyncMs: opts.syncMs } : {}),
    ...(opts.accessCacheMs !== undefined ? { voicemailAccessCacheMs: opts.accessCacheMs } : {}),
    ...(opts.changeMs !== undefined ? { voicemailChangeMs: opts.changeMs } : {}),
    ...(opts.alertMs !== undefined ? { voicemailAlertMs: opts.alertMs } : {}),
    // The hub of the webhooks (its lease no longer says who writes the mailboxes: their own does, third review 11a).
    ...(opts.hub ? { secretsKey: randomBytes(32), webhooks: { pollMs: 20, stateLeaseMs: 300, streamSettleMs: 0 }, trunkWatchMs: 0 } : {}),
    // The lease of the mailboxes, short: renewed every 100 ms, the next holder writing 100 ms after the last one could.
    voicemailLeaseMs: 300,
    voicemailRetryMs: [20]
  })
  if (opts.hub) await app.ready()
  registry.startAll()
  const as = (user: string, tenant = 'A') => ({ 'x-dev-user': user, 'x-dev-tenant': tenant })
  const heard = (user: string) => {
    const got: TelephonyEvent[] = []
    bus.subscribe('A', user, e => void got.push(e))
    return got
  }
  return { app, as, store, sip, wazo, heard, release }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Another Gateway takes the lease of the mailboxes of A (a greater weight: at once). */
const steal = (store: MemoryStore) => store.takeWebhookLease(voicemailRole('A'), 'gw_other', 60_000, 99)
/** A change of holder marked by another Gateway (VOICEMAIL_CHANGED): the one that writes the mailboxes synchronises. */
const changed = (store: MemoryStore) => store.putOperatorState('A', 'voicemail:changed', { at: `${Date.now()}-${Math.random()}` })

const message = (id: string, over: Partial<Voicemail> = {}): Voicemail => ({ id, from: '101', fromName: 'Alice Martin', receivedAt: '2026-10-18T02:12:04.000Z', durationSec: 7, unread: true, ...over })

describe('the mailboxes (step 11a)', () => {
  it('gives each holder of an extension a mailbox at the start, then hands them to the SIP server', async () => {
    const { app, wazo, sip } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    expect(wazo.syncs).toEqual(['101=alice,102=jean'])
    // Before the changes, none at its holder yet; then both.
    expect(sip.given[0]).toEqual([])
    expect(sip.given[1]).toEqual([
      { extension: '101', mailbox: '1001@ctx' },
      { extension: '102', mailbox: '1002@ctx' }
    ])
    await app.close()
  })

  it('tries again until the voicemail server answers, and empties nothing while it fails (second review 11a, n°1)', async () => {
    const store = new MemoryStore()
    const sip = sipServer()
    const wazo = fakeVoicemail()
    wazo.failNext(3)
    process.env.AUTH_MODE = 'dev'
    await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '102' })
    const registry = new ProviderRegistry([{ tenantId: 'A', type: 'sip', config: {} }], [sip.factory])
    const app = await buildApp(registry, { store, bus: new EventBus(), directory: new StoreDirectory(store), tickets: new TicketStore(), voicemail: () => wazo.vm, voicemailRetryMs: [20] })
    registry.startAll()
    await until('the fourth try', () => sip.given.length === 2, 4_000)
    expect(wazo.syncs).toEqual(['102=jean'])
    // What the SIP server had stays while it fails: never emptied for the tenant. Then the mailboxes before the changes
    // (none at its holder yet), and after.
    expect(sip.given).toEqual([[], [{ extension: '102', mailbox: '1002@ctx' }]])
    expect(sip.withdrawn).toEqual([])
    await app.close()
  })

  it('hands the SIP server the mailboxes at their holder only before the voicemail server changes anything, and withdraws an extension given to someone else at once (second review 11a, n°3)', async () => {
    const store = new MemoryStore()
    const people = [
      { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] },
      { id: 'alice', displayName: 'Alice', numbers: [{ type: 'extension' as const, number: '101' }] }
    ]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
    const { app, wazo, sip } = await setup({ store, directorySync })
    await until('the mailboxes', () => sip.given.length >= 2)
    await directorySync.run()
    await until('a sync of the directory', () => wazo.syncs.length >= 2)
    await until('idle', () => sip.given.length >= 4)
    sip.order.length = 0
    // Jean leaves 102 for 105, Marie takes 102: 102 and 105 lose any mailbox at once, before the voicemail server is
    // asked anything; its synchronisation hands first only Alice's (still at 101), then all three.
    people[0] = { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '105' }] }
    people.push({ id: 'marie', displayName: 'Marie', numbers: [{ type: 'extension' as const, number: '102' }] })
    await directorySync.run()
    await until('the sync', () => sip.order.length === 3)
    expect(sip.order).toEqual(['withdraw 102,105', 'set 101', 'set 101,105,102'])
    await app.close()
  })

  it('withdraws a mailbox whose holder changed while it synchronised, synchronises once more, and again on a schedule (second review 11a, n°8)', async () => {
    const { app, wazo, sip, store } = await setup({ syncMs: 60 })
    await until('the mailboxes', () => sip.given.length >= 2)
    // Another Gateway gives 102 to Marie while this one synchronises (its list had Jean at 102).
    wazo.duringSync(async () => {
      wazo.duringSync(undefined)
      await store.deleteMapping('A', 'jean')
      await store.upsertMapping({ tenantId: 'A', userId: 'marie', extension: '102' })
    })
    await until('the withdrawal', () => sip.withdrawn.length === 1)
    expect(sip.withdrawn).toEqual([['102']])
    await until('the round after', () => wazo.syncs.includes('101=alice,102=marie'))
    // Nothing changes: synchronised all the same, every voicemailSyncMs.
    const n = wazo.syncs.length
    await until('the schedule', () => wazo.syncs.length >= n + 2)
    await app.close()
  })

  it("synchronises out of the tenant's turn: a person's presence never waits behind a slow voicemail server (review 11a, n°1)", async () => {
    const { app, as, wazo, sip, release } = await setup({ slow: true })
    await new Promise(r => setTimeout(r, 30))
    expect(wazo.syncs).toEqual([])
    const start = Date.now()
    const res = await app.inject({ method: 'PUT', url: '/api/v1/me/presence', headers: as('jean'), payload: { status: 'dnd' } })
    expect(res.statusCode).toBe(200)
    // Far below the turn's bound (10 s): it did not wait for the synchronisation, still held.
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(sip.given).toEqual([])
    release!()
    await until('the mailboxes', () => sip.given.length === 2)
    await app.close()
  })

  it('says the platform has mailboxes only with a voicemail server and a SIP server that sends calls to it, for someone with an extension', async () => {
    const on = await setup()
    expect((await on.app.inject({ url: '/api/v1/capabilities', headers: on.as('jean') })).json().voicemail).toBe(true)
    expect((await on.app.inject({ url: '/api/v1/capabilities', headers: on.as('stranger') })).json().voicemail).toBeUndefined()
    await on.app.close()
    // A SIP server that says it sends no call to the mailboxes (started without Wazo: review 11a, n°13) too.
    for (const off of [await setup({ voicemail: false }), await setup({ withMailboxes: false }), await setup({ access: false })]) {
      expect((await off.app.inject({ url: '/api/v1/capabilities', headers: off.as('jean') })).json().voicemail).toBeUndefined()
      await off.app.close()
    }
    for (const off of [await setup({ voicemail: false }), await setup({ withMailboxes: false })]) {
      const res = await off.app.inject({ url: '/api/v1/voicemails', headers: off.as('jean') })
      expect(res.statusCode).toBe(501)
      await off.app.close()
    }
    const said = await setup({ access: true })
    expect((await said.app.inject({ url: '/api/v1/capabilities', headers: said.as('jean') })).json().voicemail).toBe(true)
    await said.app.close()
  })

  it('leaves the mailboxes of the SIP server alone when the Gateway has no voicemail server (third review 11a, n°3)', async () => {
    for (const voicemail of [false, 'other-tenant'] as const) {
      const { app, sip, store } = await setup({ voicemail })
      await sleep(300)
      expect([sip.given, sip.withdrawn]).toEqual([[], []])
      // It takes no lease of the mailboxes: another Gateway takes it at once, at the lowest weight.
      expect(await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 300, 1)).toBeTruthy()
      await app.close()
    }
  })

  it("streams a recording, and breaks the answer off when it passes the provider's bound (review 11a, n°3)", async () => {
    const { app, as, wazo, sip } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    wazo.messages.get('102')!.push(message('1-big'))
    // Its head was sent; the body stops short of the length announced, the answer broken off (never a whole that is not).
    await expect(app.inject({ url: '/api/v1/voicemails/1-big/audio', headers: as('jean') })).rejects.toThrow(/destroyed before completion/)
    // Whole within it, its length said.
    wazo.messages.get('102')!.push(message('1-1'))
    const ok = await app.inject({ url: '/api/v1/voicemails/1-1/audio', headers: as('jean') })
    expect([ok.statusCode, ok.headers['content-length'], ok.body]).toEqual([200, '7', 'RIFF1-1'])
    await app.close()
  })

  it("erases the person's messages with their history (review 11a, n°10), and says the voicemail server is down", async () => {
    const { app, as, wazo, sip } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    wazo.messages.get('102')!.push(message('m1'), message('m2'))
    wazo.messages.get('101')!.push(message('m3'))
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })
    expect([res.statusCode, res.json()]).toEqual([200, { deleted: 0, voicemails: 2 }])
    expect(wazo.messages.get('102')).toEqual([])
    expect(wazo.messages.get('101')).toHaveLength(1)
    wazo.down(true)
    const down = await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })
    expect([down.statusCode, down.json().code]).toEqual([502, 'VOICEMAIL_UNAVAILABLE'])
    await app.close()
    const off = await setup({ voicemail: false })
    expect((await off.app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: off.as('jean') })).json()).toEqual({ deleted: 0 })
    await off.app.close()
  })

  it('deletes the messages past the retention period at the start, then on a schedule', async () => {
    const { app, wazo } = await setup({ retentionDays: 30, purgeMs: 40 })
    await until('two rounds', () => wazo.purges.length >= 2)
    const age = Date.now() - wazo.purges[0]!.getTime()
    expect(age).toBeGreaterThanOrEqual(30 * 86_400_000)
    expect(age).toBeLessThan(30 * 86_400_000 + 5_000)
    await app.close()
    const never = await setup({ retentionDays: 0, purgeMs: 10 })
    await new Promise(r => setTimeout(r, 50))
    expect(never.wazo.purges).toEqual([])
    await never.app.close()
  })

  it("lists, plays, marks as read and deletes the person's own messages only", async () => {
    const { app, as, wazo, sip } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    wazo.messages.get('102')!.push(message('1792289524-00000004'))
    const list = await app.inject({ url: '/api/v1/voicemails', headers: as('jean') })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({ items: [message('1792289524-00000004')] })
    // Alice's mailbox is empty; someone without an extension has none.
    expect((await app.inject({ url: '/api/v1/voicemails', headers: as('alice') })).json()).toEqual({ items: [] })
    expect((await app.inject({ url: '/api/v1/voicemails', headers: as('stranger') })).json()).toEqual({ items: [] })
    expect((await app.inject({ url: '/api/v1/voicemails' })).statusCode).toBe(401)
    const audio = await app.inject({ url: '/api/v1/voicemails/1792289524-00000004/audio', headers: as('jean') })
    expect([audio.statusCode, audio.headers['content-type'], audio.headers['cache-control'], audio.body]).toEqual([200, 'audio/wav', 'private, no-store', 'RIFF1792289524-00000004'])
    // Not Alice's: exactly as a message that does not exist; nor an id that is none.
    for (const [user, id] of [['alice', '1792289524-00000004'], ['jean', 'nope'], ['jean', '..%2F..%2Fetc'], ['stranger', '1792289524-00000004']] as const) {
      expect((await app.inject({ url: `/api/v1/voicemails/${id}/audio`, headers: as(user) })).statusCode, `${user} ${id}`).toBe(404)
      expect((await app.inject({ method: 'POST', url: `/api/v1/voicemails/${id}/read`, headers: as(user) })).statusCode).toBe(404)
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/voicemails/${id}`, headers: as(user) })).statusCode).toBe(404)
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/voicemails/1792289524-00000004/read', headers: as('jean') })).statusCode).toBe(204)
    expect(wazo.messages.get('102')![0]!.unread).toBe(false)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/voicemails/1792289524-00000004', headers: as('jean') })).statusCode).toBe(204)
    expect(wazo.messages.get('102')).toEqual([])
    await app.close()
  })

  it('answers 502 with a code the app translates when the voicemail server is down, and the Gateway stays ready, degraded', async () => {
    const { app, as, wazo, sip } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    wazo.down(true)
    const res = await app.inject({ url: '/api/v1/voicemails', headers: as('jean') })
    expect([res.statusCode, res.json().code]).toEqual([502, 'VOICEMAIL_UNAVAILABLE'])
    expect(JSON.stringify(res.json())).not.toMatch(/fetch failed/)
    const ready = await app.inject('/ready')
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toMatchObject({ ready: true, degraded: 1, reasons: ['voicemail server not reached'] })
    await app.close()
  })

  it("tells a mailbox's news to its holder only, never to someone the extension was just given to", async () => {
    const { app, wazo, sip, heard } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    const jean = heard('jean')
    const alice = heard('alice')
    wazo.emit({ extension: '102', event: { type: 'voicemail.created', timestamp: '2026-10-18T02:12:07.000Z', payload: { voicemail: message('m1') } } })
    await until('the event', () => jean.length === 1)
    expect(jean[0]).toMatchObject({ type: 'voicemail.created', payload: { voicemail: { id: 'm1' } } })
    // The mailbox of 102 is someone else's (the Gateway gave 102 to Jean before the voicemail server heard of it): its
    // news go to nobody.
    wazo.holders.set('102', 'someone-else')
    wazo.emit({ extension: '102', event: { type: 'voicemail.deleted', timestamp: '2026-10-18T02:13:00.000Z', payload: { id: 'm1' } } })
    wazo.emit({ extension: '101', event: { type: 'voicemail.deleted', timestamp: '2026-10-18T02:13:01.000Z', payload: { id: 'm9' } } })
    await until('the second event', () => alice.length === 1)
    expect(jean).toHaveLength(1)
    await app.close()
  })

  it('synchronises the mailboxes again once the directory changed who holds which extension', async () => {
    const store = new MemoryStore()
    const people = [{ id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] }]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
    const { app, wazo, sip } = await setup({ store, directorySync })
    await until('the mailboxes', () => sip.given.length >= 1)
    // The directory's own mapping of Jean first, then 102 passes to Marie.
    await directorySync.run()
    people[0] = { id: 'marie', displayName: 'Marie', numbers: [{ type: 'extension' as const, number: '102' }] }
    await directorySync.run()
    await until('the second sync', () => wazo.syncs.some(s => s.includes('102=marie')))
    expect(wazo.holders.get('102')).toBe('marie')
    await app.close()
  })
})

describe('the mailboxes, with several Gateways (second review 11a)', () => {
  it('synchronises them and purges the messages on the Gateway that holds the lease of the mailboxes only, from when it takes it (n°1; third review, n°2)', async () => {
    const store = new MemoryStore()
    // Another Gateway writes them when this one starts.
    expect(await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 60_000, 99)).toBeTruthy()
    const { app, wazo, sip } = await setup({ store, syncMs: 30, purgeMs: 30 })
    await new Promise(r => setTimeout(r, 250))
    expect(wazo.syncs).toEqual([])
    expect(wazo.purges).toEqual([])
    expect(sip.given).toEqual([])
    // It lets the lease go: this one takes it, synchronises and purges.
    await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 0)
    await until('the mailboxes', () => sip.given.length >= 2, 5_000)
    expect(wazo.syncs[0]).toBe('101=alice,102=jean')
    await until('a purge', () => wazo.purges.length >= 1)
    await app.close()
  })

  it('never lets a Gateway without a voicemail server write the mailboxes, nor stop the one that has one (third review 11a, n°3)', async () => {
    const store = new MemoryStore()
    const people = [
      { id: 'alice', displayName: 'Alice Martin', numbers: [{ type: 'extension' as const, number: '101' }] },
      { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] }
    ]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
    const without = await setup({ store, voicemail: false, directorySync })
    const withWazo = await setup({ store, mapped: false, changeMs: 30 })
    await until('the mailboxes, by the Gateway with Wazo', () => withWazo.sip.given.length >= 2, 5_000)
    await directorySync.run()
    await sleep(300)
    expect([without.sip.given, without.sip.withdrawn]).toEqual([[], []])
    // The one with Wazo goes on writing them: a change of holder, on the Gateway without Wazo, is withdrawn there at
    // once (an extension given to someone else never sends calls to the previous holder) and written by the other.
    people[1] = { id: 'marie', displayName: 'Marie', numbers: [{ type: 'extension' as const, number: '102' }] }
    await directorySync.run()
    await until('the withdrawal', () => without.sip.withdrawn.some(w => w.includes('102')))
    await until('written by the one with Wazo', () => withWazo.wazo.syncs.some(s => s.includes('102=marie')) && withWazo.sip.given.at(-1)!.some(b => b.extension === '102'))
    expect(without.sip.given).toEqual([])
    await withWazo.app.close()
    await without.app.close()
  })

  it('gives the mailboxes to a Gateway that reaches its voicemail server over one that does not (third review 11a, n°11)', async () => {
    const store = new MemoryStore()
    const first = await setup({ store })
    await until('the mailboxes, by the first', () => first.sip.given.length >= 2, 5_000)
    // Its Wazo goes away: it can no longer synchronise; a second one, whose Wazo answers, takes them over.
    first.wazo.down(true)
    const second = await setup({ store, mapped: false, syncMs: 50 })
    await until('the mailboxes, by the second', () => second.wazo.syncs.length >= 1 && second.sip.given.length >= 2, 5_000)
    const n = first.wazo.syncs.length
    first.wazo.down(false)
    await new Promise(r => setTimeout(r, 300))
    // The first, whose Wazo is back, does not take them back (the same weight: the holder keeps the lease).
    expect(first.wazo.syncs.length).toBe(n)
    await first.app.close()
    await second.app.close()
  })

  it('stops before the voicemail server writes once it lost the lease mid-round, and leaves the release asked (third review 11a, n°2)', async () => {
    const store = new MemoryStore()
    const { app, as, wazo, sip } = await setup({ store, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    const held = async () => (await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()
    wazo.holdBack({ park: 3, of: 4 })
    await changed(store)
    let seen: { heldBack?: unknown; release?: unknown } = {}
    await until('held back', () => (void held().then(h => (seen = h)), !!seen.heldBack))
    // The round the release asks loses the lease once it read the holders, before the voicemail server changes anything.
    wazo.duringSync(async () => {
      wazo.duringSync(undefined)
      await steal(store)
      await sleep(250)
    })
    const syncs = wazo.syncs.length
    const sets = sip.given.length
    const written = wazo.written.length
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 3, of: 4 } })).statusCode).toBe(202)
    await until('the round', () => wazo.syncs.length > syncs)
    await sleep(500)
    // One round, stopped there: the mailboxes at their holder handed before, nothing after; no other round.
    expect(wazo.syncs.length).toBe(syncs + 1)
    expect(wazo.releases.at(-1)).toBe(JSON.stringify({ park: 3, of: 4 }))
    expect(sip.given.length).toBe(sets + 1)
    // The voicemail server wrote nothing of that round (fourth review 11a, n°10).
    expect(wazo.written.length).toBe(written)
    // The release is left for the Gateway that writes them now, and what was held stays held.
    expect(await held()).toMatchObject({ heldBack: { park: 3, of: 4 }, release: { park: 3, of: 4, by: 'root', state: 'asked' } })
    await app.close()
  })

  it('hands the SIP server nothing more once it lost the lease after the voicemail server wrote (third review 11a, n°2)', async () => {
    const store = new MemoryStore()
    const { app, wazo, sip } = await setup({ store, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    wazo.afterSync(async () => {
      wazo.afterSync(undefined)
      await steal(store)
      await sleep(250)
    })
    const syncs = wazo.syncs.length
    const sets = sip.given.length
    await changed(store)
    await until('the round', () => wazo.syncs.length > syncs)
    await sleep(500)
    expect(wazo.syncs.length).toBe(syncs + 1)
    expect(sip.given.length).toBe(sets + 1)
    await app.close()
  })

  it('starts no other round once it lost the lease after its last write, though one more was asked, and keeps nothing of it (third review 11a, n°2)', async () => {
    const store = new MemoryStore()
    const { app, as, wazo, sip } = await setup({ store, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    // The round: Jean leaves 102 to Marie meanwhile (one more round asked), the lease lost right after the last write.
    wazo.duringSync(async () => {
      wazo.duringSync(undefined)
      await store.deleteMapping('A', 'jean')
      await store.upsertMapping({ tenantId: 'A', userId: 'marie', extension: '102' })
    })
    wazo.holdBack({ park: 1, of: 2 })
    const sets = sip.given.length
    sip.hooks.onSet = async () => {
      if (sip.given.length !== sets + 2) return
      await steal(store)
      await sleep(250)
    }
    const syncs = wazo.syncs.length
    await changed(store)
    await until('the round', () => sip.given.length >= sets + 2)
    await sleep(500)
    expect(wazo.syncs.length).toBe(syncs + 1)
    expect(sip.given.length).toBe(sets + 2)
    // Withdrawn all the same (any Gateway withdraws), and what the round held back not kept: no longer its to say.
    expect(sip.withdrawn.at(-1)).toEqual(['102'])
    expect((await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()).toEqual({})
    await app.close()
  })

  it('hears of a change of holder another Gateway made, at once, and tries a withdrawal that failed again (third review 11a, n°5)', async () => {
    const store = new MemoryStore()
    const people = [
      { id: 'alice', displayName: 'Alice Martin', numbers: [{ type: 'extension' as const, number: '101' }] },
      { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] }
    ]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const leader = await setup({ store, changeMs: 30 })
    await until('the mailboxes', () => leader.sip.given.length >= 2, 5_000)
    // Another Gateway, which does not write the mailboxes, hears the directory give 102 to Marie.
    const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
    const other = await setup({ store, mapped: false, directorySync })
    await directorySync.run()
    other.sip.hooks.failWithdraw = 1
    people[1] = { id: 'marie', displayName: 'Marie', numbers: [{ type: 'extension' as const, number: '102' }] }
    await directorySync.run()
    // It withdraws 102 there (once more after a failure), and the one that writes them gives Marie hers.
    await until('the withdrawal', () => other.sip.withdrawn.some(w => w.includes('102')), 5_000)
    await until('the leader synchronises', () => leader.wazo.syncs.some(s => s.includes('102=marie')), 5_000)
    expect(other.wazo.syncs).toEqual([])
    await other.app.close()
    await leader.app.close()
  })

  it('never undoes a withdrawal with a round that read the holders before it (third review 11a, n°1)', async () => {
    const store = new MemoryStore()
    const people = [
      { id: 'alice', displayName: 'Alice Martin', numbers: [{ type: 'extension' as const, number: '101' }] },
      { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] }
    ]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
    const { app, wazo, sip } = await setup({ store, directorySync, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await directorySync.run()
    await until('idle', () => wazo.syncs.length >= 2 && wazo.waiting() === 0)
    await sleep(100)
    // A round waits for a slow Wazo, its holders read (Jean at 102, his mailbox there). Meanwhile 102 passes to Marie.
    const release = wazo.hold()
    await changed(store)
    await until('the round waiting', () => wazo.waiting() === 1)
    sip.order.length = 0
    people[1] = { id: 'marie', displayName: 'Marie', numbers: [{ type: 'extension' as const, number: '102' }] }
    await directorySync.run()
    await until('the withdrawal', () => sip.order.includes('withdraw 102'))
    release()
    await until('the round with Marie', () => sip.order.includes('set 101,102'), 5_000)
    // Between the withdrawal and the round that read Marie at 102, nothing hands 102 to the SIP server: not the
    // older round's list before its changes, nor its list after them.
    const from = sip.order.indexOf('withdraw 102')
    const last = sip.order.indexOf('set 101,102')
    expect(sip.order.slice(from, last).filter(o => o.startsWith('set') && o.includes('102'))).toEqual([])
    // The older round handed its list before its changes, without 102, then the one after them, without 102 too.
    expect(sip.order.slice(from, last).filter(o => o.startsWith('set')).length).toBeGreaterThanOrEqual(2)
    expect(wazo.syncs.at(-1)).toBe('101=alice,102=marie')
    expect(wazo.holders.get('102')).toBe('marie')
    await app.close()
  })

  it('tells the administrators when the synchronisation keeps failing (third review 11a, n°11)', async () => {
    const store = new MemoryStore()
    const { app, wazo } = await setup({ store, alertMs: 60 })
    wazo.failNext(1_000)
    let alerted = false
    await until('the alert', () => (void store.listAlerts('A').then(a => (alerted = a.some(x => x.alert.kind === 'voicemail' && x.alert.param === 'sync-failing'))), alerted), 5_000)
    const alerts = await store.listAlerts('A')
    expect(alerts.filter(a => a.alert.kind === 'voicemail')).toHaveLength(1)
    await app.close()
  })

  it('tells the voicemail server which mailbox an event was of, for it to say whether it is the holder\'s (n°2; third review, n°12)', async () => {
    const { app, wazo, sip, heard } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    const jean = heard('jean')
    // A mailbox that is no longer the one at 102 (moved by another Gateway, or someone else's): told to nobody.
    wazo.emit({ extension: '102', mailbox: 'box-102-someone', event: { type: 'voicemail.created', timestamp: '2026-10-18T02:12:06.000Z', payload: { voicemail: message('m0') } } })
    wazo.emit({ extension: '102', mailbox: wazo.boxIds.get('102')!, event: { type: 'voicemail.created', timestamp: '2026-10-18T02:12:07.000Z', payload: { voicemail: message('m1') } } })
    await until('the event', () => jean.length === 1)
    expect(jean.map(e => (e.payload as { voicemail: { id: string } }).voicemail.id)).toEqual(['m1'])
    expect(wazo.owned).toEqual([
      { extension: '102', userId: 'jean', mailbox: 'box-102-someone' },
      { extension: '102', userId: 'jean', mailbox: 'box-102-jean' }
    ])
    await app.close()
  })

  it('keeps what a synchronisation held back for the administrators, and lets go the very mass one of them saw (n°9; third review, n°6 and n°15)', async () => {
    const { app, as, wazo, sip } = await setup({ syncMs: 40 })
    await until('the mailboxes', () => sip.given.length >= 2)
    expect((await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()).toEqual({})
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 3, of: 4 } })).json()).toMatchObject({ code: 'VOICEMAIL_NOTHING_HELD' })
    // Administrators only, to read it and to let it go.
    expect((await app.inject({ url: '/api/v1/admin/voicemail', headers: as('jean') })).statusCode).toBe(403)
    // The next synchronisation holds three of four back: kept, with when it started.
    wazo.holdBack({ park: 3, of: 4 })
    const held = async () => (await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()
    let seen: { heldBack?: { park?: number; of?: number; since?: string }; release?: unknown; releases?: { applied: boolean; by: string; park?: number; of: number }[] } = {}
    await until('held back', () => (void held().then(h => (seen = h)), !!seen.heldBack))
    expect(seen.heldBack).toMatchObject({ park: 3, of: 4, since: expect.any(String) })
    expect(wazo.releases.every(r => !r)).toBe(true)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('jean'), payload: { park: 3, of: 4 } })).statusCode).toBe(403)
    // The counts seen are said, and must be what is held now.
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root') })).json()).toMatchObject({ code: 'VOICEMAIL_RELEASE_COUNTS' })
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 'all', of: 4 } })).statusCode).toBe(400)
    const changed = await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 2, of: 4 } })
    expect([changed.statusCode, changed.json().code, changed.json().heldBack]).toEqual([409, 'VOICEMAIL_HELD_CHANGED', expect.objectContaining({ park: 3, of: 4 })])
    expect(wazo.releases.every(r => !r)).toBe(true)
    // Meant: the next synchronisation is given those counts; it found them, they go, and nothing is held any more.
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 3, of: 4 } })
    expect([res.statusCode, res.json()]).toEqual([202, { release: 'asked', applied: 'at the next synchronisation of the mailboxes' }])
    await until('the release', () => wazo.releases.includes(JSON.stringify({ park: 3, of: 4 })))
    await until('nothing held', () => (void held().then(h => (seen = h)), !seen.heldBack && !seen.release))
    expect(wazo.releases.filter(r => r)).toHaveLength(1)
    expect(seen.releases).toEqual([expect.objectContaining({ park: 3, of: 4, by: 'root', applied: true })])
    // Another mass appears; a release asked for it finds yet another at the next round: not applied, held again, said.
    wazo.holdBack({ park: 4, of: 5 })
    await until('held back again', () => (void held().then(h => (seen = h)), !!seen.heldBack))
    wazo.foundAtRelease({ park: 5, of: 5 })
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 4, of: 5 } })).statusCode).toBe(202)
    await until('the release used', () => (void held().then(h => (seen = h)), (seen.releases?.length ?? 0) === 2))
    expect(seen.releases![0]).toMatchObject({ park: 4, of: 5, applied: false })
    await until('held back with what it found', () => (void held().then(h => (seen = h)), (seen.heldBack)?.park === 5))
    await app.close()
  })

  it('answers the administrators from the store on every Gateway, one without a voicemail server too (third review 11a, n°15)', async () => {
    const store = new MemoryStore()
    const leader = await setup({ store, changeMs: 30, syncMs: 0 })
    await until('the mailboxes', () => leader.sip.given.length >= 2)
    leader.wazo.holdBack({ park: 3, of: 4 })
    await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '103' })
    await store.putOperatorState('A', 'voicemail:changed', { at: new Date().toISOString() })
    const without = await setup({ store, voicemail: false, mapped: false })
    let seen: { heldBack?: unknown } = {}
    await until('held back, read on the other', () => (void without.app.inject({ url: '/api/v1/admin/voicemail', headers: without.as('root') }).then(r => (seen = r.json())), !!seen.heldBack), 5_000)
    // Let go there: the Gateway that writes the mailboxes hears of it at its next look.
    expect((await without.app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: without.as('root'), payload: { park: 3, of: 4 } })).statusCode).toBe(202)
    await until('the release, on the leader', () => leader.wazo.releases.includes(JSON.stringify({ park: 3, of: 4 })), 5_000)
    await without.app.close()
    await leader.app.close()
  })

  it('reads whether the SIP server sends calls to the mailboxes once in a while, and says nothing when it did not answer (n°21)', async () => {
    const said = await setup({ access: true })
    for (let i = 0; i < 3; i++) expect((await said.app.inject({ url: '/api/v1/capabilities', headers: said.as('jean') })).json().voicemail).toBe(true)
    expect(said.sip.asked.access).toBe(1)
    await said.app.close()
    const failing = await setup({ access: 'error' })
    for (let i = 0; i < 2; i++) expect((await failing.app.inject({ url: '/api/v1/capabilities', headers: failing.as('jean') })).json().voicemail).toBeUndefined()
    // Not kept: asked again each time until it answers.
    expect(failing.sip.asked.access).toBe(2)
    await failing.app.close()
    const fresh = await setup({ access: true, accessCacheMs: 0 })
    await fresh.app.inject({ url: '/api/v1/capabilities', headers: fresh.as('jean') })
    await fresh.app.inject({ url: '/api/v1/capabilities', headers: fresh.as('jean') })
    expect(fresh.sip.asked.access).toBe(2)
    await fresh.app.close()
  })
})

describe('the mailboxes, at the junction with the providers (fourth review 11a)', () => {
  it('lets the voicemail server write only once it is given mayWrite, and writes nothing more once the lease is lost (n°10)', async () => {
    const store = new MemoryStore()
    const { app, wazo, sip } = await setup({ store, changeMs: 30, purgeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await until('a purge written', () => wazo.written.includes('purge'))
    expect(wazo.written).toContain('sync 101=alice,102=jean')
    // The lease lost: neither a synchronisation nor a purge writes any more.
    await steal(store)
    await sleep(150)
    const written = wazo.written.length
    await changed(store)
    await sleep(300)
    expect(wazo.written.length).toBe(written)
    await app.close()
  })

  it('hands the SIP server the fencing token of its lease and the mark read before the holders, and goes round again when it says it left an extension out (n°2)', async () => {
    const { app, wazo, sip, store } = await setup({ changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    expect(sip.writes.length).toBeGreaterThanOrEqual(2)
    expect(sip.writes.every(w => typeof w.fence === 'number' && w.fence > 0 && w.since === 0)).toBe(true)
    await sleep(100)
    // The SIP server says 102 was withdrawn since the mark the round read: one more round.
    sip.hooks.withdrawnOnce = ['102']
    const syncs = wazo.syncs.length
    await changed(store)
    await until('one more round', () => wazo.syncs.length >= syncs + 2)
    // The same token while the lease is kept.
    expect(new Set(sip.writes.map(w => w.fence)).size).toBe(1)
    await app.close()
  })

  it('stops at once, without trying again, when the SIP server refuses a write under an older lease (n°2)', async () => {
    const { app, wazo, sip, store } = await setup({ changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    sip.hooks.fenceNext = true
    const syncs = wazo.syncs.length
    await changed(store)
    await until('the round', () => wazo.syncs.length > syncs)
    await sleep(300)
    expect(wazo.syncs.length).toBe(syncs + 1)
    expect(sip.hooks.fenceNext).toBe(false)
    await app.close()
  })

  it('tells the administrators once while the synchronisation keeps failing, and once while the voicemail server keeps refusing mailboxes (n°12)', async () => {
    const store = new MemoryStore()
    const told: string[] = []
    const addAlert = store.addAlert.bind(store)
    store.addAlert = async record => {
      told.push(`${record.alert.param}=${record.alert.value}`)
      return addAlert(record)
    }
    const { app, wazo } = await setup({ store, alertMs: 60, syncMs: 30 })
    wazo.failNext(1_000)
    await until('the alert', () => told.length >= 1, 5_000)
    // Failing every 20 ms meanwhile: told once.
    await sleep(300)
    expect(told).toEqual([expect.stringMatching(/^sync-failing=/)])
    // It holds again, with two mailboxes refused at each round: told once, with how many.
    wazo.refuse(2)
    wazo.failNext(0)
    await until('the refusals told', () => told.length >= 2, 5_000)
    await sleep(300)
    expect(told.slice(1)).toEqual(['boxes-refused=2'])
    await app.close()
  })

  it('forgets what it saw failing when it loses the lease: once it takes it again, it counts from then (n°12)', async () => {
    const store = new MemoryStore()
    const told: string[] = []
    const addAlert = store.addAlert.bind(store)
    store.addAlert = async record => {
      told.push(String(record.alert.param))
      return addAlert(record)
    }
    const { app, wazo } = await setup({ store, alertMs: 500 })
    wazo.failNext(100_000)
    await until('failing', () => wazo.tries() >= 3, 5_000)
    await sleep(300)
    // Lost after failing for a while, given back 500 ms later: failing again, for less than 500 ms of this lease.
    await steal(store)
    await sleep(500)
    expect(told).toEqual([])
    const tries = wazo.tries()
    await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 0)
    await until('a round again', () => wazo.tries() > tries, 5_000)
    await sleep(250)
    expect(told).toEqual([])
    await until('the alert, at last', () => told.length === 1, 5_000)
    await app.close()
  })

  it('marks a change of the directory for the Gateway that writes the mailboxes before it withdraws, a name too (n°13)', async () => {
    const store = new MemoryStore()
    const people = [
      { id: 'alice', displayName: 'Alice Martin', numbers: [{ type: 'extension' as const, number: '101' }] },
      { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] }
    ]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const leader = await setup({ store, changeMs: 30 })
    await until('the mailboxes', () => leader.sip.given.length >= 2, 5_000)
    const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
    const other = await setup({ store, mapped: false, directorySync })
    await directorySync.run()
    await until('the round', () => leader.wazo.syncs.length >= 2, 2_000)
    await sleep(100)
    // A name only: no extension to withdraw, marked all the same, and the leader goes round.
    let syncs = leader.wazo.syncs.length
    people[0] = { ...people[0]!, displayName: 'Alice Martin-Durand' }
    await directorySync.run()
    await until('the round for the name', () => leader.wazo.syncs.length > syncs, 2_000)
    // 102 to Marie, the withdrawal hanging: the mark is there before it, and the leader goes round meanwhile.
    let letGo: (() => void) | undefined
    other.sip.hooks.onWithdraw = () => new Promise<void>(resolve => (letGo = resolve))
    syncs = leader.wazo.syncs.length
    people[1] = { id: 'marie', displayName: 'Marie', numbers: [{ type: 'extension' as const, number: '102' }] }
    await directorySync.run()
    await until('the round for Marie', () => leader.wazo.syncs.some(s => s.includes('102=marie')), 2_000)
    expect(other.sip.withdrawn).toEqual([])
    expect(letGo).toBeDefined()
    letGo!()
    await until('the withdrawal', () => other.sip.withdrawn.some(w => w.includes('102')))
    await other.app.close()
    await leader.app.close()
  })

  it('records a release replaced before any round read it, keeps 20 of them, and says which one a round that stopped half-way was given (n°14)', async () => {
    type Seen = { releases?: { at?: string; replaced?: boolean; interrupted?: boolean; applied: boolean }[] }
    // 20 already, newest first: the 21st pushes the oldest out.
    const store = new MemoryStore()
    const day = (d: number) => `2026-01-${String(d).padStart(2, '0')}`
    await store.putOperatorState('A', 'voicemail:releases', Array.from({ length: 20 }, (_, i) => ({ park: 1, of: 2, by: 'root', at: `${day(20 - i)}T00:00:00.000Z`, applied: true, done: `${day(20 - i)}T00:01:00.000Z` })))
    // Held back, as the Gateway that writes the mailboxes said; two releases asked here, the first read by no round.
    await store.putOperatorState('A', 'voicemail:held', { park: 4, of: 5, since: new Date().toISOString() })
    const without = await setup({ store, voicemail: false })
    const release = (s: typeof without) => s.app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: s.as('root'), payload: { park: 4, of: 5 } })
    const read = async (s: typeof without): Promise<Seen> => (await s.app.inject({ url: '/api/v1/admin/voicemail', headers: s.as('root') })).json()
    expect((await release(without)).statusCode).toBe(202)
    expect((await read(without)).releases).toHaveLength(20)
    expect((await release(without)).statusCode).toBe(202)
    let seen = await read(without)
    expect(seen.releases).toHaveLength(20)
    expect(seen.releases![0]).toMatchObject({ park: 4, of: 5, applied: false, replaced: true })
    expect(seen.releases![1]!.at).toBe(`${day(20)}T00:00:00.000Z`)
    expect(seen.releases![19]!.at).toBe(`${day(2)}T00:00:00.000Z`)
    await without.app.close()

    // A round given a release stops half-way (the voicemail server fails); the next one, given it again, finds another
    // mass: not applied, and said to come after a round that may have applied part of it.
    const other = new MemoryStore()
    const { app, as, wazo, sip } = await setup({ store: other, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    wazo.holdBack({ park: 4, of: 5 })
    await changed(other)
    await until('held back', async () => !!(await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json<{ heldBack?: unknown }>().heldBack)
    await sleep(100)
    wazo.foundAtRelease({ park: 5, of: 5 })
    wazo.failNext(1)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 4, of: 5 } })).statusCode).toBe(202)
    await until('the release recorded', async () => ((seen = (await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()), (seen.releases?.length ?? 0) === 1), 5_000)
    expect(seen.releases![0]).toMatchObject({ park: 4, of: 5, applied: false, interrupted: true })
    await app.close()
  })
})

// Against a real PostgreSQL (TEST_DATABASE_URL): the SIP server's own table of the mailboxes, written by two Gateways.
if (process.env.TEST_DATABASE_URL) {
  describe("the mailboxes in the SIP server's database, with two Gateways (fourth review 11a, n°2)", () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, options: '-c search_path=spec_gateway_voicemail' })
    beforeAll(async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS spec_gateway_voicemail')
      await pool.query(VOICEMAIL_BOXES_SCHEMA)
    })
    beforeEach(async () => {
      await pool.query('TRUNCATE voicemail_boxes, voicemail_writers, voicemail_withdrawals')
    })
    afterAll(async () => {
      await pool.query('DROP SCHEMA IF EXISTS spec_gateway_voicemail CASCADE')
      await pool.end()
    })
    const rows = async () => (await pool.query<{ extension: string; mailbox: string }>("SELECT extension, mailbox FROM voicemail_boxes WHERE tenant_id = 'A' ORDER BY extension")).rows.map(r => `${r.extension}>${r.mailbox}`)
    const db = () => new VoicemailBoxes({ pool, tenantId: 'A' })

    it("never lets a round of one Gateway undo another Gateway's withdrawal made between its last read of the holders and its write", async () => {
      const store = new MemoryStore()
      const people = [
        { id: 'alice', displayName: 'Alice Martin', numbers: [{ type: 'extension' as const, number: '101' }] },
        { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] }
      ]
      const directory = { listAll: async () => people } as unknown as ContactDirectory
      const a = await setup({ store, changeMs: 30, db: db() })
      await until('the mailboxes, by A', async () => (await rows()).join() === '101>1001@ctx,102>1002@ctx', 5_000)
      const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
      const b = await setup({ store, mapped: false, db: db(), directorySync })
      await directorySync.run()
      await until("A's round for that run", () => a.wazo.syncs.length >= 2, 5_000)
      await sleep(200)
      // A's round read Jean at 102, then the store again just before its write: there, B gives 102 to Marie and
      // withdraws it. A's write leaves 102 out, in the database's transaction, and says so.
      const seen: string[][] = []
      let armed = true
      a.sip.hooks.beforeSet = async boxes => {
        if (!armed || !boxes.some(x => x.extension === '102')) return
        armed = false
        people[1] = { id: 'marie', displayName: 'Marie', numbers: [{ type: 'extension' as const, number: '102' }] }
        await directorySync.run()
        await until('B withdrew 102', () => b.sip.withdrawn.some(w => w.includes('102')))
        expect(await rows()).toEqual(['101>1001@ctx'])
      }
      a.sip.hooks.onSet = async () => void seen.push(await rows())
      await changed(store)
      await until('Marie at 102', async () => (await rows()).includes('102>1003@ctx'), 5_000)
      expect(armed).toBe(false)
      // From B's withdrawal on, the database never sent 102 to Jean's mailbox again.
      expect(seen[0]).toEqual(['101>1001@ctx'])
      expect(seen.filter(r => r.includes('102>1002@ctx'))).toEqual([])
      await b.app.close()
      await a.app.close()
    })

    it('refuses the write of a Gateway that lost the lease while it wrote, once another one took the lease and wrote', async () => {
      const store = new MemoryStore()
      const a = await setup({ store, changeMs: 30, db: db() })
      await until('the mailboxes, by A', async () => (await rows()).length === 2, 5_000)
      const b = await setup({ store, mapped: false, db: db() })
      await sleep(200)
      // A's write waits: meanwhile its voicemail server stops answering, Bob gets 103, and B takes the lease and writes.
      let armed = true
      a.sip.hooks.beforeSet = async () => {
        if (!armed) return
        armed = false
        a.wazo.down(true)
        await store.upsertMapping({ tenantId: 'A', userId: 'bob', extension: '103' })
        await until('written by B', async () => (await rows()).includes('103>1004@ctx'), 5_000)
      }
      await changed(store)
      await until("A's write refused", () => a.sip.errors.includes('VOICEMAIL_FENCED'), 8_000)
      expect(await rows()).toEqual(['101>1001@ctx', '102>1002@ctx', '103>1004@ctx'])
      // A stops there: no other round of its own.
      const syncs = a.wazo.syncs.length
      await sleep(300)
      expect(a.wazo.syncs.length).toBe(syncs)
      await b.app.close()
      await a.app.close()
    })
  })
}

describe('voicemailMismatch (third review 11a, n°3 and n°10)', () => {
  it("says at the start what differs from OpenSIPS's view of the mailboxes, its own bound of a call to one", () => {
    expect(voicemailMismatch({ maxMessageSec: 180 }, { on: true, maxCallSec: 300 })).toEqual([])
    expect(voicemailMismatch({ maxMessageSec: 300 }, { on: true, maxCallSec: 300 })).toEqual([])
    expect(voicemailMismatch({ maxMessageSec: 180 }, { on: true, maxCallSec: 120 })).toEqual([expect.stringMatching(/^VOICEMAIL_MAX_SEC \(180 s\) is longer than OpenSIPS lets a call to a mailbox last \(its VOICEMAIL_MAX_CALL_SEC, 120 s\)/)])
    expect(voicemailMismatch({ maxMessageSec: 180 }, { on: true })).toEqual([])
    expect(voicemailMismatch({ maxMessageSec: 180 }, { on: false, maxCallSec: 300 })).toEqual([expect.stringMatching(/OpenSIPS sends no call to the mailboxes/)])
    expect(voicemailMismatch(undefined, { on: true, maxCallSec: 300 })).toEqual([expect.stringMatching(/this Gateway has no voicemail server/)])
    expect(voicemailMismatch(undefined, { on: false })).toEqual([])
    expect(voicemailMismatch({ maxMessageSec: 600 }, undefined)).toEqual([])
  })
})

describe('wazoFromEnv', () => {
  const urls = { WAZO_AUTH_URL: 'http://127.0.0.1:9497/0.1', WAZO_CONFD_URL: 'http://127.0.0.1:9486/1.1', WAZO_CALLD_URL: 'http://127.0.0.1:9500/1.0', WAZO_WEBSOCKETD_URL: 'ws://127.0.0.1:9502/' }
  const creds = { WAZO_USER: 'twakephone', WAZO_PASSWORD: 'not-a-real-password' }

  const key = Buffer.alloc(32, 1)

  it('is off without its settings, and takes Wazo behind its own entry point or each API where it listens', () => {
    expect(wazoFromEnv({}, key)).toBeUndefined()
    expect(wazoFromEnv({}, undefined)).toBeUndefined()
    expect(wazoFromEnv({ ...urls, ...creds }, key)).toBeDefined()
    expect(wazoFromEnv({ WAZO_URL: 'https://wazo.example.test/', ...creds }, key)).toBeDefined()
    expect(wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_MESSAGES: '20', VOICEMAIL_MAX_SEC: '120', VOICEMAIL_GRACE_DAYS: '0' }, key)).toBeDefined()
  })

  it('keys the holders with a key of its own derived from SECRETS_KEY, required with Wazo (review 11a, n°9)', () => {
    expect(() => wazoFromEnv({ ...urls, ...creds }, undefined)).toThrow(/SECRETS_KEY/)
    expect(holderSecretOf(key)).toHaveLength(32)
    expect(holderSecretOf(key).equals(key)).toBe(false)
    expect(holderSecretOf(key).equals(holderSecretOf(Buffer.alloc(32, 2)))).toBe(false)
  })

  it('reads the bounds and the retention period of the messages, and refuses those that are none', () => {
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_MESSAGES: '0' }, key)).toThrow(/VOICEMAIL_MAX_MESSAGES/)
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '3 min' }, key)).toThrow(/VOICEMAIL_MAX_SEC/)
    // A message longer than a call to a mailbox lasts (second review 11a, n°11): refused at the start.
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '600' }, key)).toThrow(/VOICEMAIL_MAX_SEC \(600 s\) is longer than a call to a mailbox lasts \(VOICEMAIL_MAX_CALL_SEC, 300 s\)/)
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '200', VOICEMAIL_MAX_CALL_SEC: '120' }, key)).toThrow(/VOICEMAIL_MAX_CALL_SEC, 120 s/)
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_CALL_SEC: '10' }, key)).toThrow(/30 to 3600/)
    expect(wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '600', VOICEMAIL_MAX_CALL_SEC: '900' }, key)).toBeDefined()
    expect(retentionDaysOf({})).toBe(30)
    expect(retentionDaysOf({ VOICEMAIL_RETENTION_DAYS: '0' })).toBe(0)
    expect(retentionDaysOf({ VOICEMAIL_RETENTION_DAYS: '90' })).toBe(90)
    expect(() => retentionDaysOf({ VOICEMAIL_RETENTION_DAYS: '-1' })).toThrow(/VOICEMAIL_RETENTION_DAYS/)
  })

  it('refuses half a configuration, a URL that is none or carries credentials', () => {
    expect(() => wazoFromEnv({ WAZO_AUTH_URL: urls.WAZO_AUTH_URL, ...creds }, key)).toThrow(/WAZO_URL/)
    expect(() => wazoFromEnv({ ...urls }, key)).toThrow(/WAZO_USER and WAZO_PASSWORD/)
    expect(() => wazoFromEnv({ ...urls, WAZO_CALLD_URL: 'not a url', ...creds }, key)).toThrow(/calldUrl is not a URL/)
    expect(() => wazoFromEnv({ ...urls, WAZO_WEBSOCKETD_URL: 'http://127.0.0.1:9502/', ...creds }, key)).toThrow(/ws: or wss:/)
    expect(() => wazoFromEnv({ ...urls, WAZO_CONFD_URL: 'http://user:pass@127.0.0.1:9486/1.1', ...creds }, key)).toThrow(/credentials/)
  })
})
