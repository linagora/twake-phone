import { EXTENSION_FORMAT, isReservedNumber, type Contact } from '@twake/telephony-types'
import type { ContactDirectory } from './contacts.js'
import type { Store, UserMapping } from './store/types.js'

/** What one synchronisation did. Shown on the administration screen; never a credential or a server address. */
export interface SyncReport {
  startedAt: string
  finishedAt: string
  durationMs: number
  /** People the directory listed. */
  seen: number
  /** Of them, people with an extension: the ones that get a mapping. */
  withExtension: number
  created: number
  updated: number
  unchanged: number
  /** Mappings the synchronisation had written earlier for people the directory no longer lists with an extension. */
  removed: number
  /**
   * Extensions the directory gives to two people, or that someone else keeps, or that are the number of a call group
   * (`group`, `heldBy` empty), or an emergency number or another short number of the French plan, which calls go to
   * the operator with (`reserved`, `heldBy` empty), or no extension of the internal plan, 2 to 6 digits, the first not 0
   * (`invalid`, `heldBy` empty): these people keep the mapping they had.
   */
  conflicts: { userId: string; extension: string; heldBy: string; group?: true; reserved?: true; invalid?: true }[]
  /** Why the run failed, in words safe to show (no address, no filter, no credential). */
  error?: string
}

export interface SyncStatus {
  running: boolean
  /** Interval of the scheduled runs, in milliseconds; absent when nothing is scheduled. */
  intervalMs?: number
  last?: SyncReport
}

export interface DirectorySyncOptions {
  store: Store
  directory: ContactDirectory
  tenantId: string
  log?: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void }
  now?: () => Date
  /**
   * The numbers of the tenant that are not extensions (its call groups, ADR 0014): nobody is given one. A failure to
   * read them stops the run before any change.
   */
  reserved?: (tenantId: string) => Promise<Iterable<string>>
  /** How long `exclusive` waits for a run in progress (EXCLUSIVE_WAIT_MS by default). */
  exclusiveWaitMs?: number
  /** How long an absence must be confirmed before the id is someone else's (HolderRecord; ABSENCE_MS by default). */
  absenceMs?: number
  /**
   * How long after a person left their record is kept once their absence is decided (HolderRecord): past it, no
   * mailbox of theirs is left (aside past the grace period, its messages past the retention period). By default
   * `absenceMs` and 31 days.
   */
  recordKeepMs?: number
}

/**
 * The record of a person whose mapping this synchronisation removed (operator state `voicemail:holder:<id>`): since
 * when the directory no longer lists them (`absentSince`), until when the synchronisations since confirmed it, each one
 * that listed them not (`absentConfirmed`), and which holder of that id they are (`epoch`, 0 for the first). A person the directory lists
 * again, in any form (with or without an extension, in conflict), or who holds a mapping an administrator gave, is
 * the same person, their record gone back to their epoch alone; one listed again only after an absence confirmed over
 * `absenceMs` is someone else given that id: one more epoch. The mailboxes know each holder by `holderIdOf`, so that
 * someone given an id that was another person's gets a mailbox of their own, the other's set aside, and that no single
 * listing (a group emptied by mistake, a replica late, an entry without a name) ever changes anyone's mailbox.
 */
export const HOLDER_RECORD = 'voicemail:holder:'
export interface HolderRecord {
  epoch?: number
  absentSince?: string
  absentConfirmed?: string
}
/** The id the mailboxes know a person by: their id, and once it was given to someone after them, which holder of it. */
export const holderIdOf = (userId: string, record?: HolderRecord) => (record?.epoch ? `${userId}\u0000${record.epoch}` : userId)
/** How long a person must be confirmed absent before their id, listed again, is someone else's: 7 days by default. */
export const ABSENCE_MS = 7 * 86_400_000
/**
 * What the synchronisation of the mailboxes holds back, too many at once (written by the Gateway that writes them):
 * while a set-aside is held back, the absences do not run (HolderRecord), so that nobody it holds back comes back as
 * someone else however long the administrators take.
 */
export const VOICEMAIL_HELD = 'voicemail:held'

/** How long a change of the groups waits for a synchronisation that runs (DirectorySync.exclusive). */
export const EXCLUSIVE_WAIT_MS = 10_000

const syncRunning = () => Object.assign(new Error('A synchronisation of the directory is running; try again in a moment'), { statusCode: 503, code: 'SYNC_RUNNING' })

/** The first extension of a contact: what the PBX rings. */
export const extensionOf = (c: Contact): string | undefined => c.numbers.find(n => n.type === 'extension')?.number.replace(/\s/g, '') || undefined

const same = (a: UserMapping, b: UserMapping) => a.extension === b.extension && (a.displayName ?? '') === (b.displayName ?? '') && (a.department ?? '') === (b.department ?? '')

/**
 * Copies the directory's accounts into the Gateway's user ↔ extension mappings (cahier §34). The directory is the
 * truth for the people it knows: their mapping follows it. People it does not know keep the mapping an administrator
 * gave them. A person who leaves the directory, or loses their extension, loses the mapping the synchronisation wrote.
 */
export class DirectorySync {
  private current: Promise<SyncReport> | null = null
  /** The runs and the `exclusive` tasks, one after the other. */
  private chain: Promise<void> = Promise.resolve()
  private pending = 0
  private last: SyncReport | undefined
  private timer: NodeJS.Timeout | undefined
  private intervalMs: number | undefined
  private readonly listeners: ((tenantId: string, extensions: string[]) => void)[] = []

  constructor(private readonly opts: DirectorySyncOptions) {}

  /** The Gateway's logger, once it exists. */
  useLogger(log: NonNullable<DirectorySyncOptions['log']>) {
    this.opts.log = log
  }

  /**
   * HolderRecord for this run: each person the directory no longer lists confirmed absent, each one present again back
   * to their epoch, or given the next one when their absence was confirmed long enough. An absence already confirmed
   * that long is decided: not written again. Each person whose mapping goes now is recorded: absent from now when not
   * listed; when listed (no extension any more), known, so that their absence later is one even without a mapping.
   * While a set-aside is held back (VOICEMAIL_HELD), the absences stand still: each one confirmed keeps the length it
   * had, so that the time held back never counts. A decided absence's record goes once no mailbox of theirs can be left
   * (`recordKeepMs` after they left), unless something is held back.
   */
  private async recordAbsences(present: Set<string>, released: Set<string>, at: string) {
    const { store, tenantId } = this.opts
    const absenceMs = this.opts.absenceMs ?? ABSENCE_MS
    const keepMs = this.opts.recordKeepMs ?? absenceMs + 31 * 86_400_000
    const held = (await store.getOperatorState(tenantId, VOICEMAIL_HELD)) as { park?: number } | undefined
    const still = held?.park !== undefined
    const now = Date.parse(at)
    const records = new Map((await store.listOperatorState(tenantId, HOLDER_RECORD)).map(r => [r.key.slice(HOLDER_RECORD.length), r.value as HolderRecord]))
    const long = (r: HolderRecord) => !!r.absentSince && Date.parse(r.absentConfirmed ?? r.absentSince) - Date.parse(r.absentSince) >= absenceMs
    for (const [userId, r] of records) {
      const key = `${HOLDER_RECORD}${userId}`
      if (present.has(userId)) {
        if (!r.absentSince) continue
        const epoch = (r.epoch ?? 0) + (long(r) ? 1 : 0)
        if (long(r)) this.opts.log?.info({ userId }, 'directory synchronisation: an id listed again after a long absence, someone new: a mailbox of their own')
        await store.putOperatorState(tenantId, key, epoch ? { epoch } : {})
      } else if (long(r)) {
        if (!held && now - Date.parse(r.absentSince!) >= keepMs) await store.deleteOperatorState(tenantId, key, r)
      } else {
        // Held back: the absence moved along, its length as it was.
        const since = !r.absentSince ? at : still ? new Date(now - (Date.parse(r.absentConfirmed ?? r.absentSince) - Date.parse(r.absentSince))).toISOString() : r.absentSince
        await store.putOperatorState(tenantId, key, { ...r, absentSince: since, absentConfirmed: at })
      }
    }
    for (const userId of released) if (!records.has(userId)) await store.putOperatorState(tenantId, `${HOLDER_RECORD}${userId}`, present.has(userId) ? {} : { absentSince: at, absentConfirmed: at })
  }

  /**
   * Called after a run that created, changed or removed a mapping (who holds which extension changed), with the
   * extensions that passed to someone else or to nobody (those given to someone else lose their mailbox at once).
   */
  onChange(listener: (tenantId: string, extensions: string[]) => void) {
    this.listeners.push(listener)
  }

  /**
   * Whether the directory still lists this person (they have an account there, a new extension to come perhaps), as
   * it answers now; undefined for a tenant it does not synchronise.
   */
  async lists(tenantId: string, userId: string): Promise<boolean | undefined> {
    if (tenantId !== this.opts.tenantId) return undefined
    const { directory } = this.opts
    const people = typeof directory.getMany === 'function' ? await directory.getMany(tenantId, [userId]) : ((await directory.listAll?.(tenantId)) ?? [])
    return people.some(p => p.id === userId)
  }

  status(): SyncStatus {
    return { running: this.current !== null, ...(this.intervalMs ? { intervalMs: this.intervalMs } : {}), ...(this.last ? { last: this.last } : {}) }
  }

  /** Runs every `intervalMs`, the first time after `firstDelayMs` (the directory may not be ready at startup). */
  start(intervalMs: number, firstDelayMs = 10_000) {
    if (!(intervalMs > 0 && intervalMs <= MAX_INTERVAL_MS) || firstDelayMs > MAX_INTERVAL_MS) throw new Error('interval out of range')
    this.stop()
    this.intervalMs = intervalMs
    const tick = () => {
      this.timer = setTimeout(tick, intervalMs)
      this.timer.unref()
      void this.run()
    }
    this.timer = setTimeout(tick, firstDelayMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.intervalMs = undefined
  }

  /** One run at a time: a second caller gets the run in progress. */
  run(): Promise<SyncReport> {
    if (!this.current) {
      this.current = this.serial(() => this.execute()).finally(() => {
        this.current = null
      })
    }
    return this.current
  }

  /**
   * Runs `fn` while no synchronisation runs, and holds the next one back until it ends: what checks that a number
   * is no extension and writes a group with it (ADR 0014), so that a run cannot give that number away in between.
   * Waits `waitMs` at most for its turn (a run of a large directory, or one that hangs): then 503 `SYNC_RUNNING`,
   * and `fn` never runs.
   */
  exclusive<T>(fn: () => Promise<T>, waitMs = this.opts.exclusiveWaitMs ?? EXCLUSIVE_WAIT_MS): Promise<T> {
    if (this.pending === 0) return this.serial(fn)
    let gaveUp = false
    let timer: NodeJS.Timeout | undefined
    const task = this.serial(() => {
      clearTimeout(timer)
      return gaveUp ? Promise.reject(syncRunning()) : fn()
    })
    return new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        gaveUp = true
        reject(syncRunning())
      }, waitMs)
      task.then(resolve, (err: unknown) => {
        if (!gaveUp) reject(err)
      })
    })
  }

  /** Starts `fn` at once when nothing runs, else after what runs and waits. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const start = () => {
      try {
        return fn()
      } catch (err) {
        return Promise.reject(err)
      }
    }
    const next = this.pending === 0 ? start() : this.chain.then(start)
    this.pending++
    const done = () => {
      this.pending--
    }
    this.chain = next.then(done, done)
    return next
  }

  private async execute(): Promise<SyncReport> {
    const now = this.opts.now ?? (() => new Date())
    const started = now()
    const report: SyncReport = { startedAt: started.toISOString(), finishedAt: started.toISOString(), durationMs: 0, seen: 0, withExtension: 0, created: 0, updated: 0, unchanged: 0, removed: 0, conflicts: [] }
    const finish = () => {
      const ended = now()
      report.finishedAt = ended.toISOString()
      report.durationMs = ended.getTime() - started.getTime()
      this.last = report
      return report
    }
    const { store, directory, tenantId } = this.opts
    let people: Contact[]
    try {
      if (!directory.listAll) throw new Error('this directory cannot be listed')
      people = await directory.listAll(tenantId)
    } catch (err) {
      // The cause stays in the log: the screen says the directory could not be read, not where it lives.
      this.opts.log?.error({ err }, 'directory synchronisation: listing failed')
      report.error = `the directory could not be listed (${err instanceof Error && /LDAP_ATTR_EXTENSION/.test(err.message) ? 'no extension attribute is configured' : 'see the Gateway log'})`
      return finish()
    }
    report.seen = people.length
    let reserved: Set<string>
    try {
      reserved = new Set(this.opts.reserved ? await this.opts.reserved(tenantId) : [])
    } catch (err) {
      this.opts.log?.error({ err }, 'directory synchronisation: the call groups could not be read')
      report.error = 'the call groups could not be read: nothing was changed (see the Gateway log)'
      return finish()
    }
    const syncedAt = started.toISOString()
    const previous = new Map((await store.listMappings(tenantId)).map(m => [m.userId, m]))
    const synced = [...previous.values()].filter(m => m.source === 'ldap')

    // An empty listing is far more often a wrong filter or a reader without rights than an organisation with
    // nobody in it: it must not wipe every extension in one run.
    if (people.length === 0 && synced.length > 0) {
      this.opts.log?.error({ synced: synced.length }, 'directory synchronisation: the listing is empty, nothing removed')
      report.error = 'the directory listed nobody: nothing was removed (check the user filter and the reader account)'
      return finish()
    }

    // What the directory says each person's mapping should be. An extension the directory gives to two people stays
    // with the one who already holds it from an earlier run, else with the first listed; the other is a conflict.
    const byExtension = new Map([...previous.values()].map(m => [m.extension, m]))
    const wanted = new Map<string, UserMapping>()
    const claimed = new Map<string, { userId: string; mapping: UserMapping }>()
    // People the directory gives a group's number: a conflict, and they keep what they had.
    const blocked = new Set<string>()
    for (const person of people) {
      const extension = extensionOf(person)
      if (!extension) continue
      report.withExtension++
      if (reserved.has(extension)) {
        report.conflicts.push({ userId: person.id, extension, heldBy: '', group: true })
        blocked.add(person.id)
        continue
      }
      // Dialled, it would reach the emergency services (or the operator), never this person.
      if (isReservedNumber(extension)) {
        report.conflicts.push({ userId: person.id, extension, heldBy: '', reserved: true })
        blocked.add(person.id)
        continue
      }
      // Not of the internal plan (2 to 6 digits, not 0 first): dialled, it would be taken for a public number.
      if (!EXTENSION_FORMAT.test(extension)) {
        report.conflicts.push({ userId: person.id, extension, heldBy: '', invalid: true })
        blocked.add(person.id)
        continue
      }
      const mapping: UserMapping = { tenantId, userId: person.id, extension, ...(person.displayName ? { displayName: person.displayName } : {}), ...(person.department ? { department: person.department } : {}), source: 'ldap', syncedAt }
      const other = claimed.get(extension)
      if (!other) {
        claimed.set(extension, { userId: person.id, mapping })
        continue
      }
      const current = byExtension.get(extension)
      // The current holder keeps it, whatever the listing order; the listing order decides between two newcomers.
      const keep = current?.userId === person.id ? { userId: person.id, mapping } : other
      const lose = keep === other ? person.id : other.userId
      claimed.set(extension, keep)
      report.conflicts.push({ userId: lose, extension, heldBy: keep.userId })
    }
    for (const { userId, mapping } of claimed.values()) wanted.set(userId, mapping)

    // Rows that will go: mappings of people the directory knows whose extension changes (rewritten), and mappings
    // this synchronisation wrote for people it no longer lists (removed). Everything else keeps its extension.
    const released = new Set<string>()
    for (const m of previous.values()) {
      const next = wanted.get(m.userId)
      if (blocked.has(m.userId)) continue
      if (next ? next.extension !== m.extension : m.source === 'ldap') released.add(m.userId)
    }
    // An extension someone else keeps (a manual mapping of a person unknown to the directory, above all) is not
    // taken away: the person who wanted it is a conflict and keeps the mapping they had. Settled before any write,
    // so a conflict never costs a mapping; repeated because a kept mapping can hold an extension someone else wanted.
    let settled = false
    while (!settled) {
      settled = true
      for (const next of wanted.values()) {
        const holder = byExtension.get(next.extension)
        if (!holder || holder.userId === next.userId || released.has(holder.userId)) continue
        report.conflicts.push({ userId: next.userId, extension: next.extension, heldBy: holder.userId })
        wanted.delete(next.userId)
        if (released.delete(next.userId)) settled = false
      }
    }

    // Who is absent, who is back (HolderRecord), written before any mapping changes: a run that cannot write them
    // changes nothing (no mapping of someone it no longer lists goes, nobody back after a long absence is given the
    // previous holder's mailbox), and the next run tries again.
    const listed = new Set(people.map(p => p.id))
    const present = new Set([...listed, ...[...previous.values()].filter(m => m.source !== 'ldap').map(m => m.userId)])
    try {
      await this.recordAbsences(present, released, syncedAt)
    } catch (err) {
      this.opts.log?.error({ err }, 'directory synchronisation: who left or came back not recorded, nothing changed')
      report.error = 'who left the directory could not be recorded: nothing was changed (see the Gateway log)'
      return finish()
    }
    // Rows that go, first: that frees the extensions before they are given to someone else (two people swapping).
    for (const userId of released) {
      // Their erasure goes only when they left the directory (fourth review 10b, n°2): given another extension, or
      // none, it stays (until purged).
      await store.deleteMapping(tenantId, userId, { left: !listed.has(userId) })
      if (!wanted.has(userId)) report.removed++
    }
    // The extensions whose holder changed: those let go, and those given to someone who did not hold them.
    const changed = new Set([...released].map(userId => previous.get(userId)!.extension))
    for (const next of wanted.values()) {
      const before = previous.get(next.userId)
      if (before && before.source === 'ldap' && same(before, next)) {
        report.unchanged++
        continue
      }
      if (byExtension.get(next.extension)?.userId !== next.userId) changed.add(next.extension)
      try {
        await store.upsertMapping(next)
        if (before) report.updated++
        else report.created++
      } catch (err) {
        // Another process wrote meanwhile (two Gateways synchronising at once): reported, repaired by the next run.
        this.opts.log?.error({ err, userId: next.userId }, 'directory synchronisation: mapping not written')
        report.conflicts.push({ userId: next.userId, extension: next.extension, heldBy: '?' })
      }
    }
    this.opts.log?.info({ ...report }, 'directory synchronisation done')
    if (report.created || report.updated || report.removed || released.size) {
      for (const listener of this.listeners) {
        try {
          listener(tenantId, [...changed].sort())
        } catch (err) {
          this.opts.log?.error({ err }, 'directory synchronisation: a listener failed')
        }
      }
    }
    return finish()
  }
}

/** The longest delay a timer takes (2^31 - 1 ms, about 24.8 days); above it Node fires at once. */
export const MAX_INTERVAL_MS = 2_147_483_647

/** "15m", "1h", "90s", "0" (off) or a number of seconds; at most 24 days. */
export const parseInterval = (spec: string | undefined, fallbackMs: number): number => {
  if (spec === undefined || spec === '') return fallbackMs
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(spec.trim())
  if (!m) throw new Error(`invalid interval: ${spec} (examples: 15m, 1h, 0)`)
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const ms = Number(m[1]) * (units[m[2] ?? 's'] ?? 1000)
  if (ms > MAX_INTERVAL_MS) throw new Error(`invalid interval: ${spec} (at most 24 days)`)
  return ms
}
