import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICEMAIL_BOXES_SCHEMA, VOICEMAIL_FENCE_RESET, VoicemailBoxes } from '@twake/provider-opensips'
import { WazoVoicemail, holderKey, mailboxNumber, type WebSocketLike } from '@twake/provider-wazo'
import type { CallFlowRoute, ProviderFactory, RoutedEvent, TelephonyProvider, VoicemailBox, VoicemailBoxesWrite, VoicemailOwner, VoicemailProvider, VoicemailSubscribeOptions, VoicemailSync, VoicemailSyncOptions } from '@twake/telephony-provider-sdk'
import type { RingGroup, TelephonyEvent, Voicemail } from '@twake/telephony-types'
import { buildApp } from './app.js'
import { TicketStore } from './auth.js'
import { RateLimiter, type ContactDirectory } from './contacts.js'
import { StoreDirectory } from './directory.js'
import { DirectorySync } from './directory-sync.js'
import { EventBus } from './events.js'
import { ProviderRegistry } from './registry.js'
import { MemoryStore } from './store/memory.js'
import { absenceMsOf, holderRecordKeepMsOf, holderSecretOf, retentionDaysOf, voicemailMismatch, wazoFromEnv } from './voicemail.js'
import { voicemailRole } from './voicemail-lease.js'
import { fakeWazo, made } from '../../../packages/provider-wazo/test/fake-wazo.js'

const until = async (what: string, fn: () => boolean | Promise<boolean>, timeout = 3_000) => {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** The number of a person's mailbox, theirs whatever extension they hold (as provider-wazo). */
const NUMBERS: Record<string, string> = { alice: '1001', jean: '1002', marie: '1003', bob: '1004' }
const boxOf = (userId: string) => `${NUMBERS[userId] ?? [...userId].map(c => c.charCodeAt(0) % 10).join('')}@ctx`

/**
 * A voicemail server in memory: one mailbox per extension, for the holder of the last sync. As provider-wazo: its
 * status is what its last request left (a Gateway that makes none says nothing new), `probe`
 * asks it now, and it writes nothing unless it is given `mayWrite` and that says yes: what it
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
  /** What the next synchronisations hold back, and the `release` each one was given. */
  let heldBack: VoicemailSync['heldBack']
  const releases: string[] = []
  /** Called during a synchronisation, after the reads (another Gateway changing a holder meanwhile). */
  let during: (() => Promise<void>) | undefined
  /** Called once the voicemail server is written, before the synchronisation answers. */
  let after: (() => Promise<void>) | undefined
  /** Called during an erasure, before it answers (the person asking again meanwhile). */
  let erasing: (() => Promise<void>) | undefined
  /** What a synchronisation given a release finds held back instead (the mass changed since the administrator saw it). */
  let atRelease: VoicemailSync['heldBack']
  /** Synchronisations waiting for `hold`'s gate. */
  let waiting = 0
  const owned: VoicemailOwner[] = []
  /** The options of each synchronisation (where the mailboxes are reached, the removal without a retention period). */
  const seenOptions: VoicemailSyncOptions[] = []
  /** What the events were subscribed with (who holds which extension, read at each event). */
  let subscribedWith: VoicemailSubscribeOptions | undefined
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
      seenOptions.push(options)
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
    mailboxIsOf: (mailbox, userId) => mailbox === boxOf(userId),
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
    async eraseMessages(o, options = {}) {
      if (down) throw new Error('fetch failed')
      // As the provider: by the Gateway that writes the mailboxes only, asked before each deletion.
      if (!options.mayWrite) throw new Error('eraseMessages without mayWrite: the provider would delete without asking')
      if (!options.mayWrite()) throw new Error('stopped')
      erased.push(o.userId)
      await erasing?.()
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
    subscribe(given) {
      subscribedWith = given
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
    options: seenOptions,
    subscribedWith: () => subscribedWith,
    holdBack: (h: VoicemailSync['heldBack']) => void (heldBack = h),
    duringSync: (fn: (() => Promise<void>) | undefined) => void (during = fn),
    afterSync: (fn: (() => Promise<void>) | undefined) => void (after = fn),
    duringErase: (fn: (() => Promise<void>) | undefined) => void (erasing = fn),
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
  const hooks: { beforeSet?: (boxes: VoicemailBox[]) => Promise<void>; onSet?: (boxes: VoicemailBox[]) => Promise<void>; onWithdraw?: () => Promise<void>; failWithdraw: number; withdrawnOnce?: string[]; withdrawnAlways?: string[]; fenceNext?: number } = { failWithdraw: 0 }
  /** The codes of the writes the database refused. */
  const errors: string[] = []
  /** What each write was given to check (VoicemailBoxesWrite), and the number of the last withdrawal. */
  const writes: VoicemailBoxesWrite[] = []
  let mark = 0
  /** The number of the last withdrawal of each extension (voicemail_withdrawals), in memory. */
  const withdrawals = new Map<string, number>()
  /** Where each extension's calls go now (voicemail_boxes), in memory. */
  let rows: VoicemailBox[] = []
  /** The extensions with a line at Wazo as the SIP server was told (wazo_lines), and each telling, in memory. */
  let lines: string[] = []
  const linesTold: string[][] = []
  const linesHook: { onTold?: (extensions: string[]) => void } = {}
  /** The call flows the SIP server was told Wazo runs (call_flows), each telling, and the ring groups it has (call_groups). */
  let flowRoutes: CallFlowRoute[] = []
  const flowsTold: CallFlowRoute[][] = []
  const flowsHook: { onTold?: (routes: CallFlowRoute[]) => void } = {}
  const groups: RingGroup[] = []
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
              hooks.fenceNext--
              throw Object.assign(new Error('written under a later lease'), { code: 'VOICEMAIL_FENCED' })
            } else {
              // As VoicemailBoxes: an extension withdrawn after the mark the round read is left out.
              left = hooks.withdrawnAlways ?? hooks.withdrawnOnce ?? (write.since !== undefined ? boxes.filter(b => (withdrawals.get(b.extension) ?? 0) > write.since!).map(b => b.extension) : undefined)
              hooks.withdrawnOnce = undefined
              if (left) boxes = boxes.filter(b => !left!.includes(b.extension))
              rows = boxes
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
            mark++
            for (const e of extensions) withdrawals.set(e, mark)
            rows = rows.filter(r => !extensions.includes(r.extension))
            withdrawn.push(extensions)
            order.push(`withdraw ${extensions.join(',')}`)
          },
          voicemailMark: async () => (db ? db.mark() : mark),
          listVoicemailBoxes: async () => (db ? db.list() : rows),
          setWazoLines: async (extensions: string[]) => {
            lines = [...extensions].sort()
            linesTold.push(lines)
            linesHook.onTold?.(lines)
          },
          listWazoLines: async () => lines,
          setCallFlowRoutes: async (routes: CallFlowRoute[]) => {
            flowRoutes = [...routes].sort((a, b) => (a.number < b.number ? -1 : 1))
            flowsTold.push(flowRoutes)
            flowsHook.onTold?.(flowRoutes)
          },
          listCallFlowRoutes: async () => flowRoutes,
          listGroups: async () => groups,
          setGroup: async (g: RingGroup) => void groups.push(g),
          deleteGroup: async () => false
        }
      : {}),
    subscribe: async function* () {},
    close: async () => {}
  }
  const factory: ProviderFactory<unknown> = { type: 'sip', create: () => provider as unknown as TelephonyProvider }
  /** A withdrawal by another Gateway (the same SIP server). */
  const withdraw = (extensions: string[]) => (provider as unknown as { withdrawVoicemailBoxes(e: string[]): Promise<void> }).withdrawVoicemailBoxes(extensions)
  return { factory, given, withdrawn, asked, order, hooks, writes, errors, withdraw, lines: () => lines, linesTold, linesHook, flows: () => flowRoutes, flowsTold, flowsHook, groups }
}

const setup = async (opts: { withMailboxes?: boolean; access?: boolean | 'error'; voicemail?: boolean | 'other-tenant'; directorySync?: DirectorySync; store?: MemoryStore; slow?: boolean; retentionDays?: number; purgeMs?: number; syncMs?: number; hub?: boolean; accessCacheMs?: number; changeMs?: number; alertMs?: number; mapped?: boolean; db?: VoicemailBoxes; erasureLimiter?: RateLimiter; voicemailProvider?: VoicemailProvider; retryMs?: number[] } = {}) => {
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
    ...(opts.voicemail === false ? {} : { voicemail: (t: string) => (t === (opts.voicemail === 'other-tenant' ? 'B' : 'A') ? (opts.voicemailProvider ?? wazo.vm) : undefined) }),
    ...(opts.directorySync ? { directorySync: opts.directorySync } : {}),
    admin: { adminRole: 'twakephone-admin', adminUsers: new Set(['A:root']) },
    ...(opts.retentionDays !== undefined ? { voicemailRetentionDays: opts.retentionDays } : {}),
    ...(opts.purgeMs !== undefined ? { voicemailPurgeMs: opts.purgeMs } : {}),
    ...(opts.syncMs !== undefined ? { voicemailSyncMs: opts.syncMs } : {}),
    ...(opts.accessCacheMs !== undefined ? { voicemailAccessCacheMs: opts.accessCacheMs } : {}),
    ...(opts.changeMs !== undefined ? { voicemailChangeMs: opts.changeMs } : {}),
    ...(opts.alertMs !== undefined ? { voicemailAlertMs: opts.alertMs } : {}),
    ...(opts.erasureLimiter ? { erasureLimiter: opts.erasureLimiter } : {}),
    // The hub of the webhooks (its lease no longer says who writes the mailboxes: their own does).
    ...(opts.hub ? { secretsKey: randomBytes(32), webhooks: { pollMs: 20, stateLeaseMs: 300, streamSettleMs: 0 }, trunkWatchMs: 0 } : {}),
    // The lease of the mailboxes, short: renewed every 100 ms, the next holder writing 100 ms after the last one could.
    voicemailLeaseMs: 300,
    voicemailRetryMs: opts.retryMs ?? [20]
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

type Person = { id: string; displayName: string; numbers: { type: 'extension'; number: string }[] }
const person = (id: string, extension: string): Person => ({ id, displayName: `Person ${id}`, numbers: [{ type: 'extension', number: extension }] })

/**
 * The Gateway's own path against provider-wazo and a Wazo in memory: the directory lists `people` (`list` changes it,
 * then synchronises it), each of them given a mailbox. `db`: `voicemail_boxes` on PostgreSQL.
 */
const throughTheGateway = async (people: Person[], db?: VoicemailBoxes, absenceMs?: number, lineKey?: string) => {
  const secret = Buffer.alloc(32, 9)
  const wazo = fakeWazo(userId => mailboxNumber(holderKey(secret, userId)))
  // wazo-websocketd as it spoke on the Docker stack: init, then start; `created` sends the news of a message.
  const sockets: WebSocketLike[] = []
  const socket = (): WebSocketLike => {
    const ws: WebSocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        if ((JSON.parse(data) as { op?: string }).op === 'start') queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ op: 'start', code: 0, data: { message: 'success' } }) }))
      },
      close() {}
    }
    sockets.push(ws)
    queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ op: 'init', code: 0, data: { version: 2 } }) }))
    return ws
  }
  const vm = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: secret, ...(lineKey ? { lineKey } : {}), fetch: wazo.fetch, webSocket: socket, logger: { info() {}, warn() {}, error() {} } })
  const store = new MemoryStore()
  let listed = people
  const directory = { listAll: async () => listed } as unknown as ContactDirectory
  const directorySync = new DirectorySync({ store, directory, tenantId: 'A', ...(absenceMs !== undefined ? { absenceMs } : {}) })
  await directorySync.run()
  const { app, sip, as, heard } = await setup({ store, directorySync, mapped: false, voicemailProvider: vm, changeMs: 30, ...(db ? { db } : {}) })
  /** A message left in the mailbox at the number of `userId`, as wazo-websocketd tells it. */
  const created = (userId: string, id: string) => {
    const message = { caller_id_name: 'Alice Martin', caller_id_num: '101', timestamp: 1792289524, folder: { type: 'new', name: 'inbox', id: 1 }, duration: 7, id }
    const data = { name: 'user_voicemail_message_created', tenant_uuid: 'ignored', required_acl: 'events.users.x.voicemails', data: { voicemail_id: wazo.boxOf(userId)!.id, message_id: id, message } }
    for (const ws of sockets) ws.onmessage?.({ data: JSON.stringify({ op: 'event', code: 0, data }) })
  }
  const reached = () => (sip.given.at(-1) ?? []).map(b => b.extension).sort()
  await until('the mailboxes reached', () => reached().length === people.length && wazo.state.voicemails.length === people.length, 5_000)
  const list = async (now: Person[]) => {
    listed = now
    await directorySync.run()
  }
  /** The messages in the mailbox at the number of `userId` (a holder id: `p2\u00001` the second holder of p2). */
  const messagesOf = (userId: string) => wazo.state.messages.get(wazo.boxOf(userId)!.id) ?? []
  /** Every message of every mailbox, by id: none ever erased unless said. */
  const allMessages = () => [...wazo.state.messages.values()].flat().map(m => m.id).sort()
  /** Each mailbox's name (TwakePhone, or aside since when), by the holder id at its number. */
  const nameOf = (userId: string) => wazo.nameOf(userId)
  return { wazo, store, app, sip, as, heard, created, reached, list, messagesOf, allMessages, nameOf }
}


/**
 * The guard of a mass set aside, through the Gateway's own path: six people of the directory have their mailbox; the
 * directory comes back with two of them (a filter changed, an OU moved). The synchronisation of the directory removes
 * the four mappings; their extensions, left to nobody, keep their row (no withdrawal); the round finds four of six
 * gone: held back, the administrators told, nothing set aside, each still reached, no message erased.
 * Then `release`: let go once an administrator says that very mass is meant (set aside, their messages kept: one of
 * them listed again has theirs back); or `return`: the directory comes back whole, nothing withdrawn on the way (each
 * row already at its holder's own mailbox), nothing erased. `db`: `voicemail_boxes` on PostgreSQL.
 */
const massGoneThroughTheGateway = async (db?: VoicemailBoxes, then: 'release' | 'return' = 'release') => {
  const six = Array.from({ length: 6 }, (_, i) => person(`p${i}`, String(201 + i)))
  const { wazo, store, app, sip, as, reached, list, messagesOf } = await throughTheGateway(six, db)
  messagesOf('p3').push(wazo.msg('m-p3'))
  await list(six.slice(0, 2))
  expect((await store.listMappings('A')).map(m => m.extension)).toEqual(['201', '202'])
  await until('held back', async () => !!(await store.getOperatorState('A', 'voicemail:held')), 5_000)
  expect(await store.getOperatorState('A', 'voicemail:held')).toMatchObject({ park: 4, of: 6 })
  const alerts = (await store.listAlerts('A', {})).filter(a => a.alert.param === 'held-back')
  expect(alerts.map(a => [a.alert.value, a.alert.threshold])).toEqual([[4, 6]])
  // Nothing set aside, nothing withdrawn: the four still reached at their extension.
  expect(wazo.state.voicemails.map(v => v.name)).toEqual(six.map(() => 'TwakePhone'))
  expect(sip.withdrawn.flat()).toEqual([])
  expect(reached()).toEqual(six.map(p => p.numbers[0]!.number))
  expect(messagesOf('p3')).toHaveLength(1)
  if (then === 'return') {
    // The directory whole again: each of the four back at the extension whose row is already at their mailbox.
    await list(six)
    await until('no longer held back', async () => !(await store.getOperatorState('A', 'voicemail:held')), 5_000)
    expect(sip.withdrawn.flat()).toEqual([])
    expect(reached()).toEqual(six.map(p => p.numbers[0]!.number))
    expect(messagesOf('p3')).toHaveLength(1)
  } else {
    // An administrator says those four left: set aside, no longer reached, their messages kept (eighth review 11a: a
    // release erases nothing, it can be wrong).
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/release', headers: as('root'), payload: { park: 4, of: 6 } })).statusCode).toBe(202)
    await until('set aside', () => wazo.state.voicemails.filter(v => v.name.startsWith('TwakePhone aside ')).length === 4, 5_000)
    await until('no longer reached', () => reached().join() === '201,202', 5_000)
    expect(messagesOf('p3')).toHaveLength(1)
    expect(await store.listOperatorState('A', 'voicemail:erase:')).toEqual([])
    // It was wrong for one of them: listed again, theirs again, messages and all.
    await list([...six.slice(0, 2), six[3]!])
    await until('theirs again', () => wazo.boxOf('p3')?.name === 'TwakePhone' && reached().join() === '201,202,204', 5_000)
    // Settled: a withdrawal the directory's change asked, done once the round wrote, is undone by the round after it.
    await sleep(300)
    await until('still theirs', () => reached().join() === '201,202,204' && !!sip.given.length, 5_000)
    expect(messagesOf('p3')).toHaveLength(1)
  }
  await app.close()
  for (const state of made.splice(0)) expect(state.denied).toEqual([])
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
      { extension: '101', mailbox: '1001@ctx' },
      { extension: '102', mailbox: '1002@ctx' }
    ])
    await app.close()
  })

  it('tries again until the voicemail server answers, and empties nothing while it fails', async () => {
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

  it('hands the SIP server the mailboxes at their holder only before the voicemail server changes anything, and withdraws an extension given to someone else at once', async () => {
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

  it('withdraws a mailbox whose holder changed while it synchronised, synchronises once more, and again on a schedule', async () => {
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

  it("synchronises out of the tenant's turn: a person's presence never waits behind a slow voicemail server", async () => {
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
    // A SIP server that says it sends no call to the mailboxes (started without Wazo) too.
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

  it('leaves the mailboxes of the SIP server alone when the Gateway has no voicemail server', async () => {
    for (const voicemail of [false, 'other-tenant'] as const) {
      const { app, sip, store } = await setup({ voicemail })
      await sleep(300)
      expect([sip.given, sip.withdrawn]).toEqual([[], []])
      // It takes no lease of the mailboxes: another Gateway takes it at once, at the lowest weight.
      expect(await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 300, 1)).toBeTruthy()
      await app.close()
    }
  })

  it("streams a recording, and breaks the answer off when it passes the provider's bound", async () => {
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

  it("erases the person's messages with their history, by the Gateway that writes the mailboxes at its round, Wazo down or not", async () => {
    const { app, as, wazo, sip, store } = await setup({ changeMs: 30 })
    await until('the mailboxes', () => sip.given.length === 2)
    wazo.messages.get('102')!.push(message('m1'), message('m2'))
    wazo.messages.get('101')!.push(message('m3'))
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })
    expect([res.statusCode, res.json()]).toEqual([200, { deleted: 0, voicemailErasure: 'asked' }])
    await until('the erasure', () => wazo.messages.get('102')!.length === 0)
    expect(wazo.messages.get('101')).toHaveLength(1)
    expect(await store.listOperatorState('A', 'voicemail:erase:')).toEqual([])
    // Wazo down: asked all the same, kept until it answers, then done.
    wazo.down(true)
    wazo.messages.get('102')!.push(message('m4'))
    const down = await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })
    expect([down.statusCode, down.json()]).toEqual([200, { deleted: 0, voicemailErasure: 'asked' }])
    await sleep(100)
    expect((await store.listOperatorState('A', 'voicemail:erase:')).map(e => e.key)).toEqual(['voicemail:erase:jean'])
    wazo.down(false)
    await until('the erasure, Wazo back', () => wazo.messages.get('102')!.length === 0)
    await until('the request done', async () => (await store.listOperatorState('A', 'voicemail:erase:')).length === 0)
    await app.close()
    const off = await setup({ voicemail: false })
    expect((await off.app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: off.as('jean') })).json()).toEqual({ deleted: 0 })
    await off.app.close()
  })

  it('never erases from a Gateway that does not write the mailboxes, and bounds the erasures of each person', async () => {
    const store = new MemoryStore()
    const { app, as, wazo, sip } = await setup({ store, changeMs: 30, erasureLimiter: new RateLimiter(2, 60_000) })
    await until('the mailboxes', () => sip.given.length === 2)
    // Another Gateway writes the mailboxes now: this one only asks.
    await steal(store)
    await sleep(150)
    wazo.messages.get('102')!.push(message('m1'))
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).statusCode).toBe(200)
    await sleep(150)
    expect(wazo.erased).toEqual([])
    expect(wazo.messages.get('102')).toHaveLength(1)
    expect((await store.listOperatorState('A', 'voicemail:erase:')).map(e => e.key)).toEqual(['voicemail:erase:jean'])
    // Two an hour here: the third erases the history all the same, and asks nothing of the voicemail server.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).statusCode).toBe(200)
    const before = await store.getOperatorState('A', 'voicemail:erase:jean')
    await store.addHistory({ tenantId: 'A', userId: 'jean', callId: 'c-1', direction: 'inbound', remoteNumber: '101', startedAt: '2026-10-18T08:00:00.000Z', durationSec: 0, state: 'ended', answered: false })
    const third = await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })
    expect([third.statusCode, third.json()]).toEqual([200, { deleted: 1, voicemailErasure: 'limited' }])
    expect(await store.getOperatorState('A', 'voicemail:erase:jean')).toEqual(before)
    const erasure = async (user: string) => (await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as(user) })).json().voicemailErasure
    expect(await erasure('alice')).toBe('asked')
    // Someone whose id is `admin` has their own count, not the administrators' of the tenant.
    expect(await erasure('admin')).toBe('asked')
    await app.close()
  })

  it('never bounds the erasure of the history alone, without a voicemail server', async () => {
    const { app, as } = await setup({ voicemail: false, erasureLimiter: new RateLimiter(1, 60_000) })
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).statusCode).toBe(200)
    await app.close()
  })

  it('keeps an erasure asked again while the round erased, for the next round, even in the same millisecond', async () => {
    const { app, as, wazo, sip } = await setup({ changeMs: 30 })
    await until('the mailboxes', () => sip.given.length === 2)
    let again = true
    wazo.duringErase(async () => {
      if (!again) return
      again = false
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).statusCode).toBe(200)
    })
    // The clock stopped: both asked at the same millisecond, told apart by their own mark only.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).statusCode).toBe(200)
      let n = 0
      while (wazo.erased.filter(u => u === 'jean').length < 2 && n++ < 1_000) await sleep(10)
      expect(wazo.erased.filter(u => u === 'jean')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
    await app.close()
  }, 20_000)

  it('keeps an erasure a person asked before they left the directory as it was: done even while a mass is held back', async () => {
    const store = new MemoryStore()
    let people: Person[] = [person('alice', '101'), person('jean', '102')]
    const directorySync = new DirectorySync({ store, directory: { listAll: async () => people } as unknown as ContactDirectory, tenantId: 'A' })
    await directorySync.run()
    const { app, as, wazo, sip } = await setup({ store, directorySync, mapped: false, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    // Asked while another Gateway writes the mailboxes, then Jean leaves; a mass held back when this one writes again.
    await steal(store)
    await sleep(150)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('jean') })).json().voicemailErasure).toBe('asked')
    people = [person('alice', '101')]
    await directorySync.run()
    await sleep(50)
    wazo.holdBack({ park: 3, of: 4 })
    await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 0)
    await until('erased', () => wazo.erased.includes('jean'), 3_000)
    await app.close()
  })

  it('withdraws every extension changed when the store does not say who holds them', async () => {
    const store = new MemoryStore()
    let people: Person[] = [person('alice', '101'), person('jean', '102')]
    const directorySync = new DirectorySync({ store, directory: { listAll: async () => people } as unknown as ContactDirectory, tenantId: 'A' })
    await directorySync.run()
    const { app, sip } = await setup({ store, directorySync, mapped: false, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    store.getMappingByExtension = async () => {
      throw new Error('store out of reach')
    }
    // Jean leaves: his extension, left to nobody, keeps its row unless the holders cannot be read.
    people = [person('alice', '101')]
    await directorySync.run()
    await until('withdrawn', () => sip.withdrawn.flat().includes('102'))
    await app.close()
  })

  it('withdraws the extensions left to nobody once the synchronisation has failed a while, never a mass, held back or not', async () => {
    const store = new MemoryStore()
    for (const [userId, extension] of [['bob', '103'], ['paul', '104'], ['luc', '105']] as const) await store.upsertMapping({ tenantId: 'A', userId, extension })
    const { app, wazo, sip } = await setup({ store, changeMs: 30, alertMs: 400 })
    await until('the mailboxes', () => sip.given.length >= 2 && sip.given.at(-1)!.length === 5)
    await sleep(50)
    // Jean holds no extension any more, the voicemail server's API down from now on: nothing before voicemailAlertMs.
    wazo.failNext(1_000_000)
    await store.deleteMapping('A', 'jean')
    await changed(store)
    await sleep(150)
    expect(sip.withdrawn.flat()).toEqual([])
    // Two more: three of five rows, a mass, kept for the round past it too.
    for (const userId of ['paul', 'luc']) await store.deleteMapping('A', userId)
    await sleep(400)
    expect(sip.withdrawn.flat()).toEqual([])
    // Two of them back: one left to nobody, but a mass held back since: kept too.
    await store.upsertMapping({ tenantId: 'A', userId: 'paul', extension: '104' })
    await store.upsertMapping({ tenantId: 'A', userId: 'luc', extension: '105' })
    await store.putOperatorState('A', 'voicemail:held', { park: 3, of: 5, since: new Date().toISOString() })
    await sleep(200)
    expect(sip.withdrawn.flat()).toEqual([])
    await store.deleteOperatorState('A', 'voicemail:held')
    await until('withdrawn', () => sip.withdrawn.flat().includes('102'))
    expect(sip.withdrawn.flat()).toEqual(['102'])
    await app.close()
  })

  it('tells each guard of a mass held back on its own: those set aside of those reached, those removed', async () => {
    const { app, wazo, sip, store } = await setup({ changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    const told = async () => (await store.listAlerts('A', {})).filter(a => a.alert.param.startsWith('held-back')).map(a => [a.alert.param, a.alert.value, a.alert.threshold])
    wazo.holdBack({ remove: 3, of: 4 })
    await changed(store)
    await until('told', async () => (await told()).length > 0)
    expect(await told()).toEqual([['held-back-remove', 3, undefined]])
    wazo.holdBack({ park: 4, remove: 5, of: 6 })
    await changed(store)
    await until('told again', async () => (await told()).length === 2)
    expect((await told()).sort()).toEqual([['held-back', 4, 6], ['held-back-remove', 5, undefined]].sort())
    await app.close()
  })

  it('erases the messages of someone who left, as an administrator asks, never those of someone who holds an extension or the directory still lists, a few an hour', async () => {
    const store = new MemoryStore()
    const people = [
      { id: 'alice', displayName: 'Alice Martin', numbers: [{ type: 'extension' as const, number: '101' }] },
      { id: 'jean', displayName: 'Jean', numbers: [{ type: 'extension' as const, number: '102' }] },
      // Between two extensions: no mapping, an account all the same.
      { id: 'marie', displayName: 'Marie', numbers: [] }
    ]
    const directory = { listAll: async () => people } as unknown as ContactDirectory
    const directorySync = new DirectorySync({ store, directory, tenantId: 'A' })
    const { app, as, wazo, sip } = await setup({ store, directorySync, changeMs: 30, erasureLimiter: new RateLimiter(3, 60_000) })
    await until('the mailboxes', () => sip.given.length === 2)
    const erase = (userId: unknown, user = 'root') => app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/erase', headers: as(user), payload: { userId } })
    expect((await erase('paul', 'jean')).statusCode).toBe(403)
    expect([(await erase('jean')).statusCode, (await erase('jean')).json().code]).toEqual([409, 'VOICEMAIL_ERASE_HOLDER'])
    for (const bad of ['', 'a b', 42, 'x'.repeat(256)]) expect([bad, (await erase(bad)).json().code]).toEqual([bad, 'VOICEMAIL_ERASE_USER'])
    const listed = await erase('marie')
    expect([listed.statusCode, listed.json().code]).toEqual([409, 'VOICEMAIL_ERASE_LISTED'])
    const asked = await erase('paul')
    expect([asked.statusCode, asked.json().erasure]).toEqual([202, 'asked'])
    await until('the erasure', () => wazo.erased.includes('paul'))
    // Three an hour here for the administrators of the tenant, those asked only (marie's refusal costs none): the
    // fourth refused, nothing asked.
    expect((await erase('paul')).statusCode).toBe(202)
    expect((await erase('louise')).statusCode).toBe(202)
    const past = await erase('pierre')
    expect([past.statusCode, past.json().code]).toEqual([429, 'ERASURE_RATE'])
    await sleep(100)
    expect(wazo.erased.includes('pierre')).toBe(false)
    // Someone whose id is `admin` has their own count, apart from the administrators' spent here.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('admin') })).json().voicemailErasure).toBe('asked')
    await app.close()
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

  it('holds back the mailboxes of a directory come back with two of six people, through the synchronisation of the directory and the round, tells the administrators, and lets them go once one says it is meant', async () => {
    await massGoneThroughTheGateway()
  }, 15_000)

  it('withdraws nothing when a directory come back half empty is whole again, its rows already at their holders', async () => {
    await massGoneThroughTheGateway(undefined, 'return')
  }, 15_000)

  it('keeps the messages of two of six people a listing missed once: set aside, theirs again when listed again (eighth review 11a, n°1)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => person(`p${i}`, String(201 + i)))
    const { wazo, store, app, reached, list, messagesOf, allMessages, nameOf } = await throughTheGateway(six)
    messagesOf('p4').push(wazo.msg('m-p4'))
    messagesOf('p5').push(wazo.msg('m-p5'))
    // A group emptied by mistake, a replica late: p4 and p5 not listed once. Not a mass: set aside, nothing erased.
    await list(six.slice(0, 4))
    await until('set aside', () => !!nameOf('p4')?.startsWith('TwakePhone aside ') && !!nameOf('p5')?.startsWith('TwakePhone aside '), 5_000)
    await until('no longer reached', () => reached().join() === '201,202,203,204', 5_000)
    expect(allMessages()).toEqual(['m-p4', 'm-p5'])
    expect(await store.listOperatorState('A', 'voicemail:erase:')).toEqual([])
    // Listed again: the same people, their own mailboxes, messages and all.
    await list(six)
    await until('theirs again', () => nameOf('p4') === 'TwakePhone' && nameOf('p5') === 'TwakePhone' && reached().length === 6, 5_000)
    expect([messagesOf('p4').map(m => m.id), messagesOf('p5').map(m => m.id)]).toEqual([['m-p4'], ['m-p5']])
    expect(wazo.state.voicemails).toHaveLength(6)
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('never erases the messages of four of ten people missing: set aside, theirs again when listed again (eighth review 11a, n°1)', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => person(`p${i}`, String(201 + i)))
    const { wazo, app, reached, list, messagesOf, allMessages, nameOf } = await throughTheGateway(ten)
    for (const i of [6, 7, 8, 9]) messagesOf(`p${i}`).push(wazo.msg(`m-p${i}`))
    await list(ten.slice(0, 6))
    await until('set aside', () => [6, 7, 8, 9].every(i => nameOf(`p${i}`)?.startsWith('TwakePhone aside ')), 5_000)
    await until('no longer reached', () => reached().length === 6, 5_000)
    expect(allMessages()).toEqual(['m-p6', 'm-p7', 'm-p8', 'm-p9'])
    await list(ten)
    await until('theirs again', () => [6, 7, 8, 9].every(i => nameOf(`p${i}`) === 'TwakePhone') && reached().length === 10, 5_000)
    expect([6, 7, 8, 9].map(i => messagesOf(`p${i}`).length)).toEqual([1, 1, 1, 1])
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('holds back an id attribute switched (the same six people under new ids), erases nothing, and gives each their own back when switched back (eighth review 11a, n°2)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => person(`p${i}`, String(201 + i)))
    const { wazo, store, app, reached, list, messagesOf, allMessages, nameOf } = await throughTheGateway(six)
    messagesOf('p3').push(wazo.msg('m-p3'))
    // uid to entryUUID: each extension given to a new id, the rows of the old mailboxes withdrawn at once.
    const renamed = six.map(p => ({ ...p, id: `uuid-${p.id}` }))
    await list(renamed)
    await until('held back', async () => !!(await store.getOperatorState('A', 'voicemail:held')), 5_000)
    expect(await store.getOperatorState('A', 'voicemail:held')).toMatchObject({ park: 6, of: 6 })
    const alerts = (await store.listAlerts('A', {})).filter(a => a.alert.param === 'held-back')
    expect(alerts.map(a => [a.alert.value, a.alert.threshold])).toEqual([[6, 6]])
    // Rounds after: still held, nobody new given a mailbox, nothing set aside, nothing erased.
    await sleep(300)
    expect(await store.getOperatorState('A', 'voicemail:held')).toMatchObject({ park: 6, of: 6 })
    expect(wazo.state.voicemails.map(v => v.name)).toEqual(six.map(() => 'TwakePhone'))
    expect(renamed.map(p => nameOf(p.id))).toEqual(six.map(() => undefined))
    expect(allMessages()).toEqual(['m-p3'])
    // Switched back: the same people, their own mailboxes, messages and all.
    await list(six)
    await until('no longer held back', async () => !(await store.getOperatorState('A', 'voicemail:held')), 5_000)
    await until('reached again', () => reached().length === 6, 5_000)
    expect(messagesOf('p3').map(m => m.id)).toEqual(['m-p3'])
    expect(wazo.state.voicemails).toHaveLength(6)
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('keeps the messages of someone missed once and then listed without an extension, theirs again with one (eighth review 11a, n°3)', async () => {
    const { wazo, app, reached, list, messagesOf, nameOf } = await throughTheGateway([person('p0', '201'), person('p1', '202'), person('p2', '203')], undefined, 60_000)
    messagesOf('p2').push(wazo.msg('m-p2'))
    await list([person('p0', '201'), person('p1', '202')])
    await until('set aside', () => !!nameOf('p2')?.startsWith('TwakePhone aside '), 5_000)
    await list([person('p0', '201'), person('p1', '202'), { ...person('p2', '203'), numbers: [] }])
    await sleep(200)
    expect(messagesOf('p2')).toHaveLength(1)
    await list([person('p0', '201'), person('p1', '202'), person('p2', '205')])
    await until('theirs again', () => nameOf('p2') === 'TwakePhone' && reached().includes('205'), 5_000)
    expect(messagesOf('p2').map(m => m.id)).toEqual(['m-p2'])
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('gives someone new under the id of a person gone for good a mailbox of their own, empty, never the other\'s messages; a single listing missed is no absence (eighth review 11a)', async () => {
    const { wazo, app, as, heard, created, reached, list, messagesOf, allMessages, nameOf } = await throughTheGateway([person('p0', '201'), person('p1', '202'), person('p2', '203')], undefined, 150)
    messagesOf('p2').push(wazo.msg('m-p2'))
    // Missed once, listed again long after without a run between: the same p2, theirs again.
    await list([person('p0', '201'), person('p1', '202')])
    await until('set aside', () => !!nameOf('p2')?.startsWith('TwakePhone aside '), 5_000)
    await sleep(200)
    await list([person('p0', '201'), person('p1', '202'), person('p2', '203')])
    await until('theirs again', () => nameOf('p2') === 'TwakePhone' && reached().includes('203'), 5_000)
    expect(messagesOf('p2').map(m => m.id)).toEqual(['m-p2'])
    // Gone, confirmed at each run past the absence: someone new given that id later has a mailbox of their own.
    await list([person('p0', '201'), person('p1', '202')])
    await until('set aside again', () => !!nameOf('p2')?.startsWith('TwakePhone aside '), 5_000)
    await sleep(200)
    await list([person('p0', '201'), person('p1', '202')])
    await list([person('p0', '201'), person('p1', '202'), person('p2', '204')])
    await until('a mailbox of their own', () => nameOf('p2\u00001') === 'TwakePhone' && reached().includes('204'), 5_000)
    expect(messagesOf('p2\u00001')).toEqual([])
    expect(nameOf('p2')).toMatch(/^TwakePhone aside /)
    // The other's messages kept aside, for the retention period, and never shown to the newcomer.
    expect(allMessages()).toEqual(['m-p2'])
    const theirs = await app.inject({ method: 'GET', url: '/api/v1/voicemails', headers: as('p2') })
    expect([theirs.statusCode, theirs.json().items]).toEqual([200, []])
    // The news of their own mailbox theirs; none of the other's.
    const news = heard('p2')
    created('p2', '1792289524-00000009')
    created('p2\u00001', '1792289524-00000010')
    await until('their news', () => news.length >= 1, 3_000)
    await sleep(100)
    expect(news.map(e => (e.payload as { voicemail?: { id?: string } }).voicemail?.id)).toEqual(['1792289524-00000010'])
    // Their erasure erases their messages, never the other's.
    messagesOf('p2\u00001').push(wazo.msg('m-new'))
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/history', headers: as('p2') })).json().voicemailErasure).toBe('asked')
    await until('their messages erased', () => messagesOf('p2\u00001').length === 0, 5_000)
    expect(allMessages()).toEqual(['m-p2'])
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('records an absence and gives someone new under that id no call to the other\'s mailbox while Wazo is down: its row withdrawn at once, a mailbox of their own once Wazo answers (eighth review 11a, n°5)', async () => {
    const { wazo, sip, app, reached, list, messagesOf, allMessages, nameOf } = await throughTheGateway([person('p0', '201'), person('p1', '202'), person('p2', '203')], undefined, 150)
    messagesOf('p2').push(wazo.msg('m-p2'))
    // Wazo down: no round sets anything aside; the directory's synchronisation records the absence all the same.
    wazo.state.down = true
    await list([person('p0', '201'), person('p1', '202')])
    await sleep(200)
    await list([person('p0', '201'), person('p1', '202')])
    expect(reached()).toContain('203')
    // Someone new given p2 and 203: the row at the other's mailbox withdrawn at once, Wazo down or not.
    await list([person('p0', '201'), person('p1', '202'), person('p2', '203')])
    await until('withdrawn', () => sip.withdrawn.flat().includes('203'), 3_000)
    wazo.state.down = false
    await until('a mailbox of their own', () => nameOf('p2\u00001') === 'TwakePhone' && reached().includes('203'), 5_000)
    expect(sip.given.at(-1)!.find(b => b.extension === '203')!.mailbox.split('@')[0]).toBe(wazo.boxOf('p2\u00001')!.number)
    expect(nameOf('p2')).toMatch(/^TwakePhone aside /)
    expect([messagesOf('p2\u00001'), allMessages()]).toEqual([[], ['m-p2']])
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('gives four of six people a group emptied by mistake held back their own again, messages and all, however long the hold lasted past the absence (ninth review 11a, n°1)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => person(`p${i}`, String(201 + i)))
    const { wazo, store, app, as, reached, list, messagesOf, nameOf } = await throughTheGateway(six, undefined, 150)
    messagesOf('p3').push(wazo.msg('m-p3'))
    await list(six.slice(0, 2))
    await until('held back', async () => !!(await store.getOperatorState('A', 'voicemail:held')), 5_000)
    const seen = (await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()
    expect(seen.effect.park).toMatch(/within VOICEMAIL_GRACE_DAYS of their absence \(the time held back does not count/)
    // The directory's synchronisation confirms the absence, well past it, while the mass is held back: it stands still.
    for (let i = 0; i < 3; i++) {
      await sleep(200)
      await list(six.slice(0, 2))
    }
    // The group mended: the same four, their own mailboxes, the hold gone by itself.
    await list(six)
    await until('no longer held back', async () => !(await store.getOperatorState('A', 'voicemail:held')), 5_000)
    await until('reached again', () => reached().length === 6, 5_000)
    expect([nameOf('p3'), messagesOf('p3').map(m => m.id)]).toEqual(['TwakePhone', ['m-p3']])
    expect(wazo.state.voicemails).toHaveLength(6)
    expect((await store.listOperatorState('A', 'voicemail:holder:')).map(r => r.value)).toEqual([{}, {}, {}, {}])
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('gives the same people their own mailboxes back once an id attribute switched is switched back, however long the hold lasted; meanwhile says who waits and that the voicemail is off (ninth review 11a, n°1 and n°2)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => person(`p${i}`, String(201 + i)))
    const { wazo, store, app, as, reached, list, messagesOf } = await throughTheGateway(six, undefined, 150)
    messagesOf('p3').push(wazo.msg('m-p3'))
    const renamed = six.map(p => ({ ...p, id: `uuid-${p.id}` }))
    await list(renamed)
    await until('held back', async () => !!(await store.getOperatorState('A', 'voicemail:held')), 5_000)
    const seen = (await app.inject({ url: '/api/v1/admin/voicemail', headers: as('root') })).json()
    expect(seen.heldBack).toMatchObject({ park: 6, of: 6, waiting: 6, noneReached: true })
    expect(seen.effect).toMatchObject({ waiting: expect.stringMatching(/^6 new holder/), voicemail: expect.stringMatching(/^off for the tenant/) })
    const alert = (await store.listAlerts('A', {})).find(a => a.alert.param === 'held-back')!.alert
    expect([alert.value, alert.threshold, alert.waiting, alert.noneReached]).toEqual([6, 6, 6, true])
    expect(reached()).toEqual([])
    for (let i = 0; i < 3; i++) {
      await sleep(200)
      await list(renamed)
    }
    await list(six)
    await until('no longer held back', async () => !(await store.getOperatorState('A', 'voicemail:held')), 5_000)
    await until('reached again', () => reached().length === 6, 5_000)
    expect(messagesOf('p3').map(m => m.id)).toEqual(['m-p3'])
    expect(wazo.state.voicemails).toHaveLength(6)
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it('reads the holders before their ranks in a round: a synchronisation of the directory between the two never gives someone new the previous holder\'s mailbox (ninth review 11a, n°9)', async () => {
    const { wazo, store, sip, app, reached, list, messagesOf, nameOf } = await throughTheGateway([person('p0', '201'), person('p1', '202'), person('p2', '203')], undefined, 150)
    messagesOf('p2').push(wazo.msg('m-p2'))
    await list([person('p0', '201'), person('p1', '202')])
    await until('set aside', () => !!nameOf('p2')?.startsWith('TwakePhone aside '), 5_000)
    await sleep(200)
    await list([person('p0', '201'), person('p1', '202')])
    await sleep(100)
    // Someone new given p2 and 204 by a synchronisation of the directory that ends while the next round reads the holders.
    const listMappings = store.listMappings.bind(store)
    let armed = true
    store.listMappings = async (tenantId: string) => {
      if (armed) {
        armed = false
        await list([person('p0', '201'), person('p1', '202'), person('p2', '204')])
      }
      return listMappings(tenantId)
    }
    // The previous holder's mailbox watched all along: never given back (out of aside) to anyone.
    const names = new Set<string | undefined>()
    const watch = setInterval(() => names.add(nameOf('p2')), 1)
    await changed(store)
    await until('a mailbox of their own', () => nameOf('p2\u00001') === 'TwakePhone' && reached().includes('204'), 5_000)
    await sleep(100)
    clearInterval(watch)
    expect([...names].every(n => n?.startsWith('TwakePhone aside '))).toBe(true)
    const old = `${wazo.boxOf('p2')!.number}@`
    expect(sip.given.flat().filter(b => b.extension === '204' && b.mailbox.startsWith(old))).toEqual([])
    expect(messagesOf('p2\u00001')).toEqual([])
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

  it("erases the messages of the holder an erasure was asked for, never those of someone given the id since (ninth review 11a, n°5)", async () => {
    const { wazo, app, as, reached, list, messagesOf, allMessages, nameOf } = await throughTheGateway([person('p0', '201'), person('p1', '202'), person('p2', '203')], undefined, 150)
    messagesOf('p2').push(wazo.msg('m-p2'))
    await list([person('p0', '201'), person('p1', '202')])
    await until('set aside', () => !!nameOf('p2')?.startsWith('TwakePhone aside '), 5_000)
    // Asked while Wazo is down; p2's id given to someone new before the round that applies it.
    wazo.state.down = true
    const asked = await app.inject({ method: 'POST', url: '/api/v1/admin/voicemail/erase', headers: as('root'), payload: { userId: 'p2' } })
    expect(asked.statusCode).toBe(202)
    await sleep(200)
    await list([person('p0', '201'), person('p1', '202')])
    await list([person('p0', '201'), person('p1', '202'), person('p2', '204')])
    wazo.state.down = false
    await until('a mailbox of their own', () => nameOf('p2\u00001') === 'TwakePhone' && reached().includes('204'), 5_000)
    messagesOf('p2\u00001').push(wazo.msg('m-new'))
    await until('the departed holder\'s messages erased', () => messagesOf('p2').length === 0, 5_000)
    expect(allMessages()).toEqual(['m-new'])
    await app.close()
    for (const state of made.splice(0)) expect(state.denied).toEqual([])
  }, 15_000)

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

describe('the mailboxes, with several Gateways', () => {
  it('synchronises them and purges the messages on the Gateway that holds the lease of the mailboxes only, from when it takes it', async () => {
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

  it('never lets a Gateway without a voicemail server write the mailboxes, nor stop the one that has one', async () => {
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

  it('gives the mailboxes to a Gateway that reaches its voicemail server over one that does not', async () => {
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

  it('stops before the voicemail server writes once it lost the lease mid-round, and leaves the release asked', async () => {
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
    // The voicemail server wrote nothing of that round.
    expect(wazo.written.length).toBe(written)
    // The release is left for the Gateway that writes them now, and what was held stays held.
    expect(await held()).toMatchObject({ heldBack: { park: 3, of: 4 }, release: { park: 3, of: 4, by: 'root', state: 'asked' } })
    await app.close()
  })

  it('hands the SIP server nothing more once it lost the lease after the voicemail server wrote', async () => {
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

  it('starts no other round once it lost the lease after its last write, though one more was asked, and keeps nothing of it', async () => {
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

  it('hears of a change of holder another Gateway made, at once, and tries a withdrawal that failed again', async () => {
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

  it('never undoes a withdrawal with a round that read the holders before it', async () => {
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

  it('tells the administrators when the synchronisation keeps failing', async () => {
    const store = new MemoryStore()
    const { app, wazo } = await setup({ store, alertMs: 60 })
    wazo.failNext(1_000)
    let alerted = false
    await until('the alert', () => (void store.listAlerts('A').then(a => (alerted = a.some(x => x.alert.kind === 'voicemail' && x.alert.param === 'sync-failing'))), alerted), 5_000)
    const alerts = await store.listAlerts('A')
    expect(alerts.filter(a => a.alert.kind === 'voicemail')).toHaveLength(1)
    await app.close()
  })

  it('tells the voicemail server which mailbox an event was of, for it to say whether it is the holder\'s', async () => {
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

  it('keeps what a synchronisation held back for the administrators, and lets go the very mass one of them saw', async () => {
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
    // What a release would do, said: a set aside can be undone (eighth review 11a, n°4).
    expect(Object.keys((seen as { effect?: object }).effect ?? {})).toEqual(['park'])
    expect((seen as { effect?: { park?: string } }).effect?.park).toMatch(/reversible/)
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
    expect([res.statusCode, res.json()]).toEqual([202, { release: 'asked', applied: 'at the next synchronisation of the mailboxes', effect: { park: expect.stringMatching(/reversible/) } }])
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

  it('answers the administrators from the store on every Gateway, one without a voicemail server too', async () => {
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

  it('reads whether the SIP server sends calls to the mailboxes once in a while, and says nothing when it did not answer', async () => {
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

describe('the mailboxes, at the junction with the providers', () => {
  it('lets the voicemail server write only once it is given mayWrite, and writes nothing more once the lease is lost', async () => {
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

  it('hands the SIP server the fencing token of its lease and the mark read before the holders, and goes round again when it says it left an extension out', async () => {
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

  it('pauses before the round it starts again for an extension left out as withdrawn since, never a loop on the databases, and starts none once it closes', async () => {
    const { app, wazo, sip, store } = await setup({ changeMs: 30, retryMs: [200] })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    // A SIP server that says so at every write (a withdrawal counter out of step).
    sip.hooks.withdrawnAlways = ['102']
    const syncs = wazo.syncs.length
    await changed(store)
    await until('the first round', () => wazo.syncs.length > syncs)
    await sleep(500)
    // One round every 200 ms at most: three or four in that time, never dozens.
    expect(wazo.syncs.length - syncs).toBeLessThanOrEqual(5)
    expect(wazo.syncs.length - syncs).toBeGreaterThanOrEqual(2)
    // Closed during a pause: no round after it.
    await until('a write', () => sip.given.length > 0)
    const given = sip.given.length
    await sleep(20)
    const before = wazo.syncs.length
    await app.close()
    expect(wazo.syncs.length).toBe(before)
    expect(sip.given.length).toBeLessThanOrEqual(given + 1)
  })

  it('stops at once when the SIP server refuses a write under the lease it holds, gives the lease back and writes again under the next one; refused again under that one, tells the administrators, once until a write passes', async () => {
    const { app, wazo, sip, store } = await setup({ changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    const fence = sip.writes.at(-1)!.fence!
    const told = async () => (await store.listAlerts('A', {})).filter(a => a.alert.param === 'sync-fenced').map(a => a.count)
    // Refused once (a lease another Gateway took for its weight, its window still open a moment): no alarm.
    sip.hooks.fenceNext = 1
    const syncs = wazo.syncs.length
    const written = wazo.written.length
    await changed(store)
    await until('the refusal', () => sip.hooks.fenceNext === 0)
    await sleep(20)
    // That round stopped there: no write of the voicemail server after the refusal, no retry of it.
    expect(wazo.syncs.length).toBe(syncs + 1)
    expect(wazo.written.length).toBe(written)
    // The lease given back, taken again: a greater token, written under it.
    await until('written under the next lease', () => sip.given.length > 0 && sip.writes.at(-1)!.fence === fence + 1 && sip.errors.length === 0, 3_000)
    await sleep(200)
    expect(await told()).toEqual([])
    // Refused under this lease and under the next one too: told.
    sip.hooks.fenceNext = 2
    await changed(store)
    await until('the alert', async () => (await told()).length > 0, 3_000)
    await until('written under the third lease after it', () => sip.hooks.fenceNext === 0 && sip.writes.at(-1)!.fence === fence + 3, 3_000)
    await sleep(200)
    expect(await told()).toEqual([1])
    // A write passed since: refused once, no alarm again; refused twice, told again.
    sip.hooks.fenceNext = 1
    await changed(store)
    await until('written under the next lease again', () => sip.hooks.fenceNext === 0 && sip.writes.at(-1)!.fence === fence + 4, 3_000)
    await sleep(200)
    expect(await told()).toEqual([1])
    sip.hooks.fenceNext = 2
    await changed(store)
    await until('told again', async () => (await told())[0] === 2, 3_000)
    await app.close()
  })

  it('forgets a refusal of long ago: refused once, the lease lost, refused once more past voicemailAlertMs is no alarm', async () => {
    const { app, sip, store } = await setup({ changeMs: 30, alertMs: 200 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    const fence = sip.writes.at(-1)!.fence!
    const told = async () => (await store.listAlerts('A', {})).filter(a => a.alert.param === 'sync-fenced')
    sip.hooks.fenceNext = 1
    await changed(store)
    await until('the refusal', () => sip.hooks.fenceNext === 0)
    // Another Gateway takes the lease for its weight before this one writes again, and gives it back later.
    await steal(store)
    await sleep(400)
    sip.hooks.fenceNext = 1
    await store.takeWebhookLease(voicemailRole('A'), 'gw_other', 0)
    await changed(store)
    await until('refused once more', () => sip.hooks.fenceNext === 0, 3_000)
    await until('written under a later lease', () => sip.writes.at(-1)!.fence! > fence + 1 && sip.errors.length === 0, 3_000)
    await sleep(200)
    expect(await told()).toEqual([])
    await app.close()
  })

  it('reads the mark of the withdrawals before the holders: a withdrawal made right after the holders were read is left out of both writes of the round', async () => {
    const store = new MemoryStore()
    const { app, wazo, sip } = await setup({ store, changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    // Another Gateway gives 102 to Marie and withdraws it right after this one's round read the holders.
    const list = store.listMappings.bind(store)
    let armed = true
    store.listMappings = async (tenantId: string) => {
      const read = await list(tenantId)
      if (armed && tenantId === 'A') {
        armed = false
        await store.deleteMapping('A', 'jean')
        await store.upsertMapping({ tenantId: 'A', userId: 'marie', extension: '102' })
        await sip.withdraw(['102'])
      }
      return read
    }
    const from = sip.given.length
    await changed(store)
    await until('the round with Marie', () => wazo.syncs.at(-1) === '101=alice,102=marie', 3_000)
    // From the withdrawal on, 102 never went to Jean's mailbox again: not in the round that read Jean there.
    expect(sip.given.slice(from).flat().filter(b => b.extension === '102' && b.mailbox === '1002@ctx')).toEqual([])
    expect(armed).toBe(false)
    await app.close()
  })

  it("leaves out of the round's last write a withdrawal made after its first one, under the same mark", async () => {
    const { app, wazo, sip, store } = await setup({ changeMs: 30 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(100)
    // Between the write before the voicemail server's changes and the one after them, another Gateway withdraws 102.
    wazo.duringSync(async () => {
      wazo.duringSync(undefined)
      await sip.withdraw(['102'])
    })
    const from = sip.given.length
    await changed(store)
    await until('both writes', () => sip.given.length >= from + 2)
    expect(sip.given.slice(from, from + 2).map(g => g.map(b => b.extension))).toEqual([['101', '102'], ['101']])
    await app.close()
  })

  it('tells the voicemail server where each mailbox is reached as the SIP server has it, to remove those of people gone with their messages without a retention period, and who holds what for its events', async () => {
    const { app, wazo, sip, store } = await setup({ changeMs: 30, retentionDays: 0 })
    await until('the mailboxes', () => sip.given.length >= 2)
    await sleep(50)
    await changed(store)
    await until('a second round', () => wazo.options.length >= 2)
    expect(wazo.options.at(-1)!.reached).toEqual([
      { extension: '101', mailbox: '1001@ctx' },
      { extension: '102', mailbox: '1002@ctx' }
    ])
    expect(wazo.options.every(o => o.removeAsideWithMessages === true)).toBe(true)
    expect((await wazo.subscribedWith()!.holders!()).map(h => `${h.extension}=${h.userId}`).sort()).toEqual(['101=alice', '102=jean'])
    await app.close()
    const kept = await setup({ retentionDays: 30 })
    await until('the mailboxes', () => kept.sip.given.length >= 2)
    expect(kept.wazo.options.every(o => o.removeAsideWithMessages === undefined)).toBe(true)
    await kept.app.close()
  })

  it('tells the administrators once while the synchronisation keeps failing, and once while the voicemail server keeps refusing mailboxes', async () => {
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

  it('forgets what it saw failing when it loses the lease: once it takes it again, it counts from then', async () => {
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

  it('marks a change of the directory for the Gateway that writes the mailboxes before it withdraws, a name too', async () => {
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

  it('records a release replaced before any round read it, keeps 20 of them, and says which one a round that stopped half-way was given', async () => {
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
  describe("the mailboxes in the SIP server's database, with two Gateways", () => {
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

    it('writes again once the fence is put back as documented, a withdrawal made while it refused left out once, without going round in a loop', async () => {
      const store = new MemoryStore()
      const a = await setup({ store, changeMs: 30, db: db() })
      await until('the mailboxes', async () => (await rows()).join() === '101>1001@ctx,102>1002@ctx', 5_000)
      // A later fence than any lease of this store (a store put back, another stack on this database): refused.
      await pool.query("UPDATE voicemail_writers SET fence = 1000000 WHERE tenant_id = 'A'")
      // Meanwhile 102 passes to Marie, withdrawn at once.
      await store.deleteMapping('A', 'jean')
      await store.upsertMapping({ tenantId: 'A', userId: 'marie', extension: '102' })
      await a.sip.withdraw(['102'])
      await changed(store)
      await until('told', async () => (await store.listAlerts('A', {})).some(x => x.alert.param === 'sync-fenced'), 5_000)
      expect(await rows()).toEqual(['101>1001@ctx'])
      await pool.query(VOICEMAIL_FENCE_RESET, ['A'])
      await until("Marie's mailbox at 102", async () => (await rows()).join() === '101>1001@ctx,102>1003@ctx', 5_000)
      // Settled: no more rounds than the schedule asks (none here), the withdrawal seen once.
      await sleep(300)
      const syncs = a.wazo.syncs.length
      await sleep(500)
      expect(a.wazo.syncs.length - syncs).toBeLessThanOrEqual(1)
      expect((await pool.query("SELECT count(*)::int AS n FROM voicemail_withdrawals WHERE tenant_id = 'A'")).rows[0].n).toBe(0)
      await a.app.close()
    })

    it('holds back the mailboxes of a directory come back with two of six people, their rows kept in voicemail_boxes', async () => {
      await massGoneThroughTheGateway(db())
      // The two kept, and the one listed again after the release, at their own mailbox.
      expect((await rows()).map(r => r.split('>')[0])).toEqual(['201', '202', '204'])
    }, 15_000)

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
      // A's round read Jean at 102; just before its write, B gives 102 to Marie and withdraws it. A's write leaves 102
      // out, in the database's transaction, and says so.
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

describe('voicemailMismatch', () => {
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
    // No retention period: a mailbox aside goes with its messages past its grace period, a day at least then.
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_GRACE_DAYS: '0', VOICEMAIL_RETENTION_DAYS: '0' }, key)).toThrow(/VOICEMAIL_GRACE_DAYS must be at least 1 day with VOICEMAIL_RETENTION_DAYS=0/)
    expect(wazoFromEnv({ ...urls, ...creds, VOICEMAIL_GRACE_DAYS: '1', VOICEMAIL_RETENTION_DAYS: '0' }, key)).toBeDefined()
  })

  it('keys the holders with a key of its own derived from SECRETS_KEY, required with Wazo', () => {
    expect(() => wazoFromEnv({ ...urls, ...creds }, undefined)).toThrow(/SECRETS_KEY/)
    expect(holderSecretOf(key)).toHaveLength(32)
    expect(holderSecretOf(key).equals(key)).toBe(false)
    expect(holderSecretOf(key).equals(holderSecretOf(Buffer.alloc(32, 2)))).toBe(false)
  })

  it('reads the bounds and the retention period of the messages, and refuses those that are none', () => {
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_MESSAGES: '0' }, key)).toThrow(/VOICEMAIL_MAX_MESSAGES/)
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '3 min' }, key)).toThrow(/VOICEMAIL_MAX_SEC/)
    // A message longer than a call to a mailbox lasts: refused at the start.
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '600' }, key)).toThrow(/VOICEMAIL_MAX_SEC \(600 s\) is longer than a call to a mailbox lasts \(VOICEMAIL_MAX_CALL_SEC, 300 s\)/)
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '200', VOICEMAIL_MAX_CALL_SEC: '120' }, key)).toThrow(/VOICEMAIL_MAX_CALL_SEC, 120 s/)
    expect(() => wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_CALL_SEC: '10' }, key)).toThrow(/30 to 3600/)
    expect(wazoFromEnv({ ...urls, ...creds, VOICEMAIL_MAX_SEC: '600', VOICEMAIL_MAX_CALL_SEC: '900' }, key)).toBeDefined()
    expect(retentionDaysOf({})).toBe(30)
    expect(retentionDaysOf({ VOICEMAIL_RETENTION_DAYS: '0' })).toBe(0)
    expect(retentionDaysOf({ VOICEMAIL_RETENTION_DAYS: '90' })).toBe(90)
    expect(() => retentionDaysOf({ VOICEMAIL_RETENTION_DAYS: '-1' })).toThrow(/VOICEMAIL_RETENTION_DAYS/)
    // The absence before an id is someone else's: VOICEMAIL_GRACE_DAYS, a day at least, refused when it is no number of
    // days, on every Gateway that synchronises the directory (Wazo or not).
    const DAY = 86_400_000
    expect([absenceMsOf({}), absenceMsOf({ VOICEMAIL_GRACE_DAYS: '0' }), absenceMsOf({ VOICEMAIL_GRACE_DAYS: '30' })]).toEqual([7 * DAY, DAY, 30 * DAY])
    for (const bad of ['7d', '-1', '366', '1.5']) expect(() => absenceMsOf({ VOICEMAIL_GRACE_DAYS: bad })).toThrow(/VOICEMAIL_GRACE_DAYS must be a whole number of days from 0 to 365/)
    expect([holderRecordKeepMsOf({}), holderRecordKeepMsOf({ VOICEMAIL_GRACE_DAYS: '10', VOICEMAIL_RETENTION_DAYS: '0' })]).toEqual([38 * DAY, 11 * DAY])
  })

  it('refuses half a configuration, a URL that is none or carries credentials', () => {
    expect(() => wazoFromEnv({ WAZO_AUTH_URL: urls.WAZO_AUTH_URL, ...creds }, key)).toThrow(/WAZO_URL/)
    expect(() => wazoFromEnv({ ...urls }, key)).toThrow(/WAZO_USER and WAZO_PASSWORD/)
    expect(() => wazoFromEnv({ ...urls, WAZO_CALLD_URL: 'not a url', ...creds }, key)).toThrow(/calldUrl is not a URL/)
    expect(() => wazoFromEnv({ ...urls, WAZO_WEBSOCKETD_URL: 'http://127.0.0.1:9502/', ...creds }, key)).toThrow(/ws: or wss:/)
    expect(() => wazoFromEnv({ ...urls, WAZO_CONFD_URL: 'http://user:pass@127.0.0.1:9486/1.1', ...creds }, key)).toThrow(/credentials/)
  })
})

describe('the lines of Wazo (step 11c-1, ADR 0027)', () => {
  const lineKey = 'twake-wazo-line-test-key-0123456789abcdef'
  const lineNames = (wazo: { state: { endpoints: { name: string; line: unknown }[] } }) => wazo.state.endpoints.filter(e => e.line).map(e => e.name).sort()

  it('makes a line at Wazo for each extension someone holds and tells the SIP server once it is there; a person gone loses it there only after the SIP server stopped registering it', async () => {
    const { wazo, sip, list } = await throughTheGateway([person('p1', '201'), person('p2', '202')], undefined, undefined, lineKey)
    await until('the lines told', () => sip.lines().join() === '201,202')
    expect(lineNames(wazo)).toEqual(['201', '202'])
    // Never told before Wazo had them.
    expect(sip.linesTold.at(0)).toEqual(['201', '202'])
    // p2 goes: the SIP server is told first (without 202), while Wazo still has its line; then Wazo drops it.
    const seen: [string[], string[]][] = []
    sip.linesHook.onTold = told => void seen.push([told, lineNames(wazo)])
    await list([person('p1', '201')])
    await until('the line withdrawn', () => lineNames(wazo).join() === '201' && sip.lines().join() === '201', 5_000)
    expect(seen[0]).toEqual([['201'], ['201', '202']])
  })

  it('makes no line without its key: nothing at Wazo, nothing told to the SIP server', async () => {
    const { wazo, sip, reached } = await throughTheGateway([person('p1', '201')])
    await until('the mailboxes', () => reached().length === 1)
    await sleep(100)
    expect(wazo.state.endpoints).toEqual([])
    expect(sip.linesTold).toEqual([])
  })

  it('asks for WAZO_LINES=1 and a key of its own, the same as OpenSIPS has', () => {
    const urls = { WAZO_AUTH_URL: 'http://127.0.0.1:9497/0.1', WAZO_CONFD_URL: 'http://127.0.0.1:9486/1.1', WAZO_CALLD_URL: 'http://127.0.0.1:9500/1.0', WAZO_WEBSOCKETD_URL: 'ws://127.0.0.1:9502/', WAZO_USER: 'twakephone', WAZO_PASSWORD: 'not-a-real-password' }
    const secret = Buffer.alloc(32, 1)
    expect(wazoFromEnv({ ...urls }, secret)?.linesOn).toBe(false)
    expect(wazoFromEnv({ ...urls, WAZO_LINES: '0', WAZO_LINE_KEY: 'short' }, secret)?.linesOn).toBe(false)
    expect(wazoFromEnv({ ...urls, WAZO_LINES: '1', WAZO_LINE_KEY: lineKey }, secret)?.linesOn).toBe(true)
    expect(() => wazoFromEnv({ ...urls, WAZO_LINES: '1' }, secret)).toThrow(/WAZO_LINE_KEY/)
    expect(() => wazoFromEnv({ ...urls, WAZO_LINES: '1', WAZO_LINE_KEY: 'short' }, secret)).toThrow(/WAZO_LINE_KEY/)
    expect(() => wazoFromEnv({ ...urls, WAZO_LINES: 'yes', WAZO_LINE_KEY: lineKey }, secret)).toThrow(/WAZO_LINES must be/)
    expect(() => wazoFromEnv({ ...urls, WAZO_MEMBERS_CONTEXT: 'a b;c' }, secret)).toThrow(/WAZO_MEMBERS_CONTEXT/)
    expect(() => wazoFromEnv({ ...urls, WAZO_MEMBERS_CONTEXT: 'users' }, secret)).not.toThrow()
  })
})

describe('the call flows (step 11c-2, ADR 0028)', () => {
  const lineKey = 'twake-wazo-line-test-key-0123456789abcdef'
  const root = { 'x-dev-user': 'root', 'x-dev-tenant': 'A' }
  const flowOf = (over: Record<string, unknown>) => ({ number: '810', name: 'Astreinte', kind: 'sequential', members: ['201', '202'], ringSec: 8, ...over })
  const post = (g: Awaited<ReturnType<typeof throughTheGateway>>, body: Record<string, unknown>, headers: Record<string, string> = root) => g.app.inject({ method: 'POST', url: '/api/v1/admin/flows', headers, payload: body })
  const labels = (g: Awaited<ReturnType<typeof throughTheGateway>>) => g.wazo.state.groups.map(x => x.label).sort()

  it('has Wazo run a sequential group, a queue and a menu an administrator sets, and tells the SIP server once each is there (never before)', async () => {
    const g = await throughTheGateway([person('p1', '201'), person('p2', '202'), person('p3', '203')], undefined, undefined, lineKey)
    const seenAtTelling: string[][] = []
    g.sip.flowsHook.onTold = () => void seenAtTelling.push(labels(g))
    expect((await post(g, flowOf({}))).statusCode).toBe(201)
    expect((await post(g, flowOf({ number: '801', name: 'Support', kind: 'queue', members: ['203', '201'], ringSec: 12, waitSec: 90 }))).statusCode).toBe(201)
    expect((await post(g, { number: '800', name: 'Standard', kind: 'menu', choices: { '1': '801', '2': '810', '3': '203' }, greeting: 'custom/accueil' })).statusCode).toBe(201)
    await until('the three flows told to the SIP server', () => g.sip.flows().length === 3, 5_000)
    expect(labels(g)).toEqual(['TwakePhone 801', 'TwakePhone 810'])
    const named = (number: string) => g.wazo.state.groups.find(x => x.label === `TwakePhone ${number}`)!.name
    expect(g.sip.flows()).toEqual([
      { number: '800', route: `menu|1=q:${named('801')}:90~2=q:${named('810')}:18~3=e:203|custom/accueil` },
      { number: '801', route: `queue|${named('801')}|90` },
      { number: '810', route: `seq|${named('810')}|18` }
    ])
    // Nothing was told to the SIP server about a group Wazo did not have yet.
    for (const seen of seenAtTelling) expect(seen.length).toBeGreaterThan(0)
    const listed = (await g.app.inject({ method: 'GET', url: '/api/v1/admin/flows', headers: root })).json().items
    expect(listed.map((f: { number: string; kind: string; ready: boolean }) => [f.number, f.kind, f.ready])).toEqual([['800', 'menu', true], ['801', 'queue', true], ['810', 'sequential', true]])
    expect(listed.find((f: { number: string }) => f.number === '801')).toMatchObject({ members: ['203', '201'], vacant: [], ringSec: 12, waitSec: 90 })
    // Only an administrator reads or sets them; each person sees the capability only where it is run.
    expect((await g.app.inject({ method: 'GET', url: '/api/v1/admin/flows', headers: g.as('p1') })).statusCode).toBe(403)
    expect((await g.app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: g.as('p1') })).json().callFlows).toBe(true)
  })

  it('changes a flow in place and removes one: the SIP server stops sending calls there first, then Wazo drops the group', async () => {
    const g = await throughTheGateway([person('p1', '201'), person('p2', '202')], undefined, undefined, lineKey)
    await post(g, flowOf({}))
    await until('told', () => g.sip.flows().length === 1, 5_000)
    const changed = await g.app.inject({ method: 'PUT', url: '/api/v1/admin/flows/810', headers: root, payload: flowOf({ members: ['202', '201'], ringSec: 20 }) })
    expect(changed.statusCode).toBe(200)
    await until('the group changed', () => g.wazo.state.groups[0]?.user_timeout === 20, 5_000)
    expect(g.wazo.state.groups[0]!.members.extensions.map(e => e.exten)).toEqual(['202', '201'])
    expect(g.wazo.state.groupStrategyEdits).toEqual([])
    const seen: [string[], string[]][] = []
    g.sip.flowsHook.onTold = told => void seen.push([told.map(r => r.number), labels(g)])
    expect((await g.app.inject({ method: 'DELETE', url: '/api/v1/admin/flows/810', headers: root })).statusCode).toBe(204)
    await until('the group gone', () => g.wazo.state.groups.length === 0 && g.sip.flows().length === 0, 5_000)
    // First told without 810 while Wazo still had its group, then (nothing left) told again.
    expect(seen[0]).toEqual([[], ['TwakePhone 810']])
    expect((await g.app.inject({ method: 'DELETE', url: '/api/v1/admin/flows/810', headers: root })).statusCode).toBe(404)
    expect((await g.app.inject({ method: 'PUT', url: '/api/v1/admin/flows/810', headers: root, payload: flowOf({}) })).statusCode).toBe(404)
  })

  it('refuses a number that is an extension, a ring group\'s or another flow\'s, a menu that leads to what is no flow of the organisation, and a flow that a menu leads to going', async () => {
    const g = await throughTheGateway([person('p1', '201'), person('p2', '202')], undefined, undefined, lineKey)
    g.sip.groups.push({ number: '200', name: 'Accueil', members: ['201'] })
    for (const [body, status, code] of [
      [flowOf({ number: '201' }), 409, 'FLOW_NUMBER_TAKEN'],
      [flowOf({ number: '200' }), 409, 'FLOW_NUMBER_TAKEN'],
      [flowOf({ number: '112' }), 400, 'FLOW_NUMBER_RESERVED'],
      [flowOf({ number: '0810' }), 400, 'FLOW_NUMBER'],
      [flowOf({ name: '' }), 400, 'FLOW_NAME'],
      [flowOf({ kind: 'carousel' }), 400, 'FLOW_KIND'],
      [flowOf({ members: ['999'] }), 400, 'FLOW_MEMBER_NOT_EXTENSION'],
      [flowOf({ members: [] }), 400, 'FLOW_MEMBERS'],
      [flowOf({ ringSec: 2 }), 400, 'FLOW_RING'],
      [flowOf({ waitSec: 60 }), 400, 'FLOW_WAIT'],
      [flowOf({ kind: 'queue', waitSec: 5 }), 400, 'FLOW_WAIT'],
      [{ number: '800', name: 'M', kind: 'menu', choices: {} }, 400, 'FLOW_CHOICES'],
      [{ number: '800', name: 'M', kind: 'menu', choices: { a: '201' } }, 400, 'FLOW_CHOICES'],
      [{ number: '800', name: 'M', kind: 'menu', choices: { '1': '200' } }, 400, 'FLOW_CHOICE_TARGET'],
      [{ number: '800', name: 'M', kind: 'menu', choices: { '1': '800' } }, 400, 'FLOW_CHOICE_TARGET'],
      [{ number: '800', name: 'M', kind: 'menu', choices: { '1': '201' }, greeting: 'a;b' }, 400, 'FLOW_GREETING']
    ] as const) {
      const res = await post(g, body)
      expect([res.statusCode, res.json().code], JSON.stringify(body)).toEqual([status, code])
    }
    expect((await post(g, flowOf({}))).statusCode).toBe(201)
    expect((await post(g, flowOf({ name: 'Autre' }))).json().code).toBe('FLOW_EXISTS')
    expect((await post(g, { number: '800', name: 'M', kind: 'menu', choices: { '1': '810' } })).statusCode).toBe(201)
    // A menu in a menu, a flow turned into a menu while one leads to it, and the removal of what a menu leads to.
    expect((await post(g, { number: '801', name: 'M2', kind: 'menu', choices: { '1': '800' } })).json().code).toBe('FLOW_CHOICE_TARGET')
    expect((await g.app.inject({ method: 'PUT', url: '/api/v1/admin/flows/810', headers: root, payload: { name: 'M', kind: 'menu', choices: { '1': '201' } } })).json().code).toBe('FLOW_IN_USE')
    expect((await g.app.inject({ method: 'DELETE', url: '/api/v1/admin/flows/810', headers: root })).json().code).toBe('FLOW_IN_USE')
    // A group cannot take a flow's number either.
    const group = await g.app.inject({ method: 'POST', url: '/api/v1/admin/groups', headers: root, payload: { number: '810', name: 'G', members: ['201'] } })
    expect([group.statusCode, group.json().code]).toEqual([409, 'GROUP_NUMBER_TAKEN'])
  })

  it('is not there without lines: 501, no capability, nothing at Wazo', async () => {
    const g = await throughTheGateway([person('p1', '201')])
    expect((await g.app.inject({ method: 'GET', url: '/api/v1/admin/flows', headers: root })).statusCode).toBe(501)
    expect((await post(g, flowOf({}))).statusCode).toBe(501)
    expect((await g.app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: g.as('p1') })).json().callFlows).toBeUndefined()
    expect(g.wazo.state.groups).toEqual([])
  })

  it('keeps the members nobody holds any more, as positions (vacant), and drops them only when an administrator does', async () => {
    const g = await throughTheGateway([person('p1', '201'), person('p2', '202')], undefined, undefined, lineKey)
    await post(g, flowOf({}))
    await g.list([person('p1', '201')])
    const read = async () => (await g.app.inject({ method: 'GET', url: '/api/v1/admin/flows', headers: root })).json().items[0]
    await until('202 vacant', async () => (await read()).vacant?.join() === '202', 5_000)
    expect((await g.app.inject({ method: 'PUT', url: '/api/v1/admin/flows/810', headers: root, payload: flowOf({ members: ['202', '201'] }) })).statusCode).toBe(200)
    expect((await g.app.inject({ method: 'PUT', url: '/api/v1/admin/flows/810', headers: root, payload: flowOf({ members: ['203'] }) })).json().code).toBe('FLOW_MEMBER_NOT_EXTENSION')
  })
})
