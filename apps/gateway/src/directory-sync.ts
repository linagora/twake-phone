import type { Contact } from '@twake/telephony-types'
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
  /** Mappings the synchronisation had written earlier and that no longer have a reason to exist. */
  removed: number
  /** Extensions the directory gives to two people, or that a manual mapping already holds: left as they were. */
  conflicts: { userId: string; extension: string; heldBy: string }[]
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
}

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
  private last: SyncReport | undefined
  private timer: NodeJS.Timeout | undefined
  private intervalMs: number | undefined

  constructor(private readonly opts: DirectorySyncOptions) {}

  /** The Gateway's logger, once it exists. */
  useLogger(log: NonNullable<DirectorySyncOptions['log']>) {
    this.opts.log = log
  }

  status(): SyncStatus {
    return { running: this.current !== null, ...(this.intervalMs ? { intervalMs: this.intervalMs } : {}), ...(this.last ? { last: this.last } : {}) }
  }

  /** Runs every `intervalMs`, the first time after `firstDelayMs` (the directory may not be ready at startup). */
  start(intervalMs: number, firstDelayMs = 10_000) {
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
      this.current = this.execute().finally(() => {
        this.current = null
      })
    }
    return this.current
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
    const syncedAt = started.toISOString()

    // What the directory says each person's mapping should be. The first person to claim an extension keeps it.
    const wanted = new Map<string, UserMapping>()
    const claimed = new Map<string, string>()
    for (const person of people) {
      const extension = extensionOf(person)
      if (!extension) continue
      report.withExtension++
      const holder = claimed.get(extension)
      if (holder) {
        report.conflicts.push({ userId: person.id, extension, heldBy: holder })
        continue
      }
      claimed.set(extension, person.id)
      wanted.set(person.id, { tenantId, userId: person.id, extension, ...(person.displayName ? { displayName: person.displayName } : {}), ...(person.department ? { department: person.department } : {}), source: 'ldap', syncedAt })
    }

    const previous = new Map((await store.listMappings(tenantId)).map(m => [m.userId, m]))
    // Mappings this synchronisation wrote earlier and that it no longer wants, or wants with another extension, go
    // first: that frees the extensions before they are given to someone else (two people swapping numbers).
    for (const m of previous.values()) {
      if (m.source !== 'ldap') continue
      const next = wanted.get(m.userId)
      if (!next) {
        await store.deleteMapping(tenantId, m.userId)
        report.removed++
      } else if (next.extension !== m.extension) await store.deleteMapping(tenantId, m.userId)
    }
    for (const next of wanted.values()) {
      const before = previous.get(next.userId)
      if (before && before.source === 'ldap' && same(before, next)) {
        report.unchanged++
        continue
      }
      // An extension a manual mapping holds for someone else is not taken away: the administrator decided it.
      const holder = await store.getMappingByExtension(tenantId, next.extension)
      if (holder && holder.userId !== next.userId) {
        report.conflicts.push({ userId: next.userId, extension: next.extension, heldBy: holder.userId })
        continue
      }
      try {
        await store.upsertMapping(next)
        before ? report.updated++ : report.created++
      } catch (err) {
        this.opts.log?.error({ err, userId: next.userId }, 'directory synchronisation: mapping not written')
        report.conflicts.push({ userId: next.userId, extension: next.extension, heldBy: '?' })
      }
    }
    this.opts.log?.info({ ...report }, 'directory synchronisation done')
    return finish()
  }
}

/** "15m", "1h", "90s", "0" (off) or a number of seconds. */
export const parseInterval = (spec: string | undefined, fallbackMs: number): number => {
  if (spec === undefined || spec === '') return fallbackMs
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(spec.trim())
  if (!m) throw new Error(`invalid interval: ${spec} (examples: 15m, 1h, 0)`)
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Number(m[1]) * (units[m[2] ?? 's'] ?? 1000)
}
