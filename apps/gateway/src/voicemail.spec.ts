import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ProviderFactory, RoutedEvent, TelephonyProvider, VoicemailBox, VoicemailOwner, VoicemailProvider, VoicemailSync } from '@twake/telephony-provider-sdk'
import type { TelephonyEvent, Voicemail } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import type { ContactDirectory } from './contacts.js'
import { StoreDirectory } from './directory.js'
import { DirectorySync } from './directory-sync.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { holderSecretOf, retentionDaysOf, wazoFromEnv } from './voicemail.js'
import { WEBHOOK_STATE_ROLE } from './store/types.js'

const until = async (what: string, fn: () => boolean, timeout = 3_000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** A voicemail server in memory: one mailbox per extension, for the holder of the last sync (as provider-wazo). */
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
  /** What the next synchronisations hold back (second review 11a, n°9), and the `release` each one was given. */
  let heldBack: VoicemailSync['heldBack']
  const releases: boolean[] = []
  /** Called during a synchronisation, after the reads (another Gateway changing a holder meanwhile). */
  let during: (() => Promise<void>) | undefined
  const owned: VoicemailOwner[] = []
  const mine = (o: VoicemailOwner) => holders.get(o.extension) === o.userId
  const vm: VoicemailProvider = {
    id: 'fake-wazo',
    getStatus: () => (down ? 'DISCONNECTED' : 'CONNECTED'),
    getStatusReason: () => (down ? 'voicemail server not reached' : undefined),
    async syncMailboxes(list, options = {}) {
      if (gate) await gate
      if (fail-- > 0) throw new Error('voicemail server not reached')
      syncs.push(list.map(h => `${h.extension}=${h.userId}`).sort().join(','))
      releases.push(!!options.release)
      // Before any change: the mailboxes already at their holder's extension.
      await options.beforeChanges?.(list.filter(h => holders.get(h.extension) === h.userId).map(h => ({ extension: h.extension, mailbox: `${h.extension}@ctx` })))
      await during?.()
      // Let go: what was held back is done.
      if (options.release) heldBack = undefined
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
      return { boxes: list.map(h => ({ extension: h.extension, mailbox: `${h.extension}@ctx` })), failed: 0, ...(held ? { heldBack: held } : {}) }
    },
    owns: async o => {
      owned.push(o)
      return mine(o)
    },
    async listMessages(o) {
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
    async purgeMessages(before) {
      purges.push(before)
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
    messages,
    syncs,
    releases,
    owned,
    holdBack: (h: VoicemailSync['heldBack']) => void (heldBack = h),
    duringSync: (fn: (() => Promise<void>) | undefined) => void (during = fn),
    emit,
    purges,
    erased,
    failNext: (n: number) => void (fail = n),
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

/** A SIP server keeping the mailboxes it is given, as provider-opensips with its `voicemail_boxes` table. */
const sipServer = (withMailboxes = true, access?: boolean | 'error') => {
  const given: VoicemailBox[][] = []
  const withdrawn: string[][] = []
  /** What the SIP server was told, in order. */
  const order: string[] = []
  const asked = { access: 0 }
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
          setVoicemailBoxes: async (boxes: VoicemailBox[]) => {
            given.push(boxes)
            order.push(`set ${boxes.map(b => b.extension).join(',')}`)
          },
          withdrawVoicemailBoxes: async (extensions: string[]) => {
            withdrawn.push(extensions)
            order.push(`withdraw ${extensions.join(',')}`)
          }
        }
      : {}),
    subscribe: async function* () {},
    close: async () => {}
  }
  const factory: ProviderFactory<unknown> = { type: 'sip', create: () => provider as unknown as TelephonyProvider }
  return { factory, given, withdrawn, asked, order }
}

const setup = async (opts: { withMailboxes?: boolean; access?: boolean | 'error'; voicemail?: boolean; directorySync?: DirectorySync; store?: MemoryStore; slow?: boolean; retentionDays?: number; purgeMs?: number; syncMs?: number; hub?: boolean; accessCacheMs?: number } = {}) => {
  process.env.AUTH_MODE = 'dev'
  const store = opts.store ?? new MemoryStore()
  await store.upsertMapping({ tenantId: 'A', userId: 'alice', extension: '101', displayName: 'Alice Martin' })
  await store.upsertMapping({ tenantId: 'A', userId: 'jean', extension: '102' })
  const sip = sipServer(opts.withMailboxes ?? true, opts.access)
  const wazo = fakeVoicemail()
  const release = opts.slow ? wazo.hold() : undefined
  const bus = new EventBus()
  const registry = new ProviderRegistry([{ tenantId: 'A', type: 'sip', config: {} }], [sip.factory])
  const app = await buildApp(registry, {
    store,
    bus,
    directory: new StoreDirectory(store),
    tickets: new TicketStore(),
    ...(opts.voicemail === false ? {} : { voicemail: (t: string) => (t === 'A' ? wazo.vm : undefined) }),
    ...(opts.directorySync ? { directorySync: opts.directorySync } : {}),
    admin: { adminRole: 'twakephone-admin', adminUsers: new Set(['A:root']) },
    ...(opts.retentionDays !== undefined ? { voicemailRetentionDays: opts.retentionDays } : {}),
    ...(opts.purgeMs !== undefined ? { voicemailPurgeMs: opts.purgeMs } : {}),
    ...(opts.syncMs !== undefined ? { voicemailSyncMs: opts.syncMs } : {}),
    ...(opts.accessCacheMs !== undefined ? { voicemailAccessCacheMs: opts.accessCacheMs } : {}),
    // The hub of the webhooks: its lease says which Gateway synchronises the mailboxes (second review 11a, n°1).
    ...(opts.hub ? { secretsKey: randomBytes(32), webhooks: { pollMs: 20, stateLeaseMs: 300, streamSettleMs: 0 }, trunkWatchMs: 0 } : {}),
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

const message = (id: string, over: Partial<Voicemail> = {}): Voicemail => ({ id, from: '101', fromName: 'Alice Martin', receivedAt: '2026-10-18T02:12:04.000Z', durationSec: 7, unread: true, ...over })

describe('the mailboxes (step 11a)', () => {
  it('gives each holder of an extension a mailbox at the start, then hands them to the SIP server', async () => {
    const { app, wazo, sip } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    expect(wazo.syncs).toEqual(['101=alice,102=jean'])
    // Before the changes, none at its holder yet; then both.
    expect(sip.given[0]).toEqual([])
    expect(sip.given[1]).toEqual([
      { extension: '101', mailbox: '101@ctx' },
      { extension: '102', mailbox: '102@ctx' }
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
    expect(sip.given).toEqual([[], [{ extension: '102', mailbox: '102@ctx' }]])
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

  it('empties what the SIP server kept of mailboxes when the Gateway starts without a voicemail server (review 11a, n°14)', async () => {
    const { app, sip } = await setup({ voicemail: false })
    await until('the empty list', () => sip.given.length === 1)
    expect(sip.given).toEqual([[]])
    await app.close()
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
  it('synchronises them and purges the messages on the Gateway that leads only, from when it takes the lease (n°1)', async () => {
    const store = new MemoryStore()
    // Another Gateway leads when this one starts.
    expect(await store.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_other', 60_000, 99)).toBeTruthy()
    const { app, wazo, sip } = await setup({ store, hub: true, syncMs: 30, purgeMs: 30 })
    await new Promise(r => setTimeout(r, 250))
    expect(wazo.syncs).toEqual([])
    expect(wazo.purges).toEqual([])
    expect(sip.given).toEqual([])
    // It lets the lease go: this one takes it, synchronises and purges.
    await store.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_other', 0)
    await until('the mailboxes', () => sip.given.length >= 2, 5_000)
    expect(wazo.syncs[0]).toBe('101=alice,102=jean')
    await until('a purge', () => wazo.purges.length >= 1)
    await app.close()
  })

  it('leaves the mailboxes of the SIP server alone on a Gateway that does not lead, even with no voicemail server of its own (n°1)', async () => {
    const store = new MemoryStore()
    expect(await store.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_other', 60_000, 99)).toBeTruthy()
    const { app, sip } = await setup({ store, hub: true, voicemail: false })
    await new Promise(r => setTimeout(r, 250))
    expect(sip.given).toEqual([])
    // Once it leads, it says the SIP server has none.
    await store.takeWebhookLease(WEBHOOK_STATE_ROLE, 'gw_other', 0)
    await until('the mailboxes emptied', () => sip.given.length >= 1, 5_000)
    expect(sip.given[0]).toEqual([])
    await app.close()
  })

  it('tells the voicemail server which mailbox an event was of, for it to say whether it is the holder\'s (n°2)', async () => {
    const { app, wazo, sip, heard } = await setup()
    await until('the mailboxes', () => sip.given.length === 2)
    const jean = heard('jean')
    wazo.emit({ extension: '102', mailbox: '7', event: { type: 'voicemail.created', timestamp: '2026-10-18T02:12:07.000Z', payload: { voicemail: message('m1') } } })
    await until('the event', () => jean.length === 1)
    expect(wazo.owned).toEqual([{ extension: '102', userId: 'jean', mailbox: '7' }])
    await app.close()
  })

  it('keeps what a synchronisation held back for the administrators, and lets it go when one of them says so (n°9)', async () => {
    const { app, as, wazo, sip } = await setup({ syncMs: 40 })
    await until('the mailboxes', () => sip.given.length >= 2)
    expect((await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()).toEqual({})
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root') })).json()).toMatchObject({ code: 'VOICEMAIL_NOTHING_HELD' })
    expect((await app.inject({ url: '/api/v1/admin/voicemail', headers: as('jean') })).statusCode).toBe(403)
    // The next synchronisation holds three of four back: kept, with when it started.
    wazo.holdBack({ park: 3, of: 4 })
    const held = async () => (await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()
    let seen: { heldBack?: { park?: number; of?: number; since?: string } } = {}
    await until('held back', () => (void held().then(h => (seen = h)), !!seen.heldBack))
    expect(seen.heldBack).toMatchObject({ park: 3, of: 4, since: expect.any(String) })
    expect(wazo.releases.every(r => !r)).toBe(true)
    // An administrator says it is meant: the next synchronisation lets them go, and nothing is held any more.
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root') })
    expect([res.statusCode, res.json()]).toEqual([202, { release: 'asked' }])
    await until('the release', () => wazo.releases.includes(true))
    await until('nothing held', () => (void held().then(h => (seen = h)), !seen.heldBack && !('release' in seen)))
    expect(wazo.releases.filter(r => r)).toHaveLength(1)
    await app.close()
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
