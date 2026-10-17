import type { TrunkHealth, TrunkStatus, WebhookEventType } from '@twake/telephony-types'
import { randomEventId, type PublishedWebhookEvent } from './webhook-events.js'

/** Registration states that leave the trunk without calls: the operator refused it, never answered, or it lapsed. */
const LOST: ReadonlySet<string> = new Set(['refused', 'timeout', 'error', 'unregistered'])

/**
 * A trunk's health from what the SIP server says of it (step 7, TrunkStatus): `down` when its registration is lost
 * or none of its servers answers its probes, `degraded` when some do not, `up` otherwise (a registration under way
 * included: it renews itself). Undefined for a trunk an administrator disabled whole: not watched.
 */
export const trunkHealthOf = (s: TrunkStatus): TrunkHealth | undefined => {
  const servers = s.servers.filter(x => x.state !== 'disabled')
  const registration = s.registration?.state
  if (!servers.length && (!registration || registration === 'disabled')) return undefined
  if (registration && LOST.has(registration)) return 'down'
  if (servers.length && servers.every(x => x.state === 'probing')) return 'down'
  if (servers.some(x => x.state === 'probing')) return 'degraded'
  return 'up'
}

export interface TrunkWatchOptions {
  /** The tenants whose trunks to read now. */
  tenants: () => string[]
  /** How a tenant's trunks are doing (the SIP server's word); undefined when it cannot say. */
  read: (tenantId: string) => Promise<TrunkStatus[] | undefined>
  /**
   * The names administrators gave the tenant's trunks, for each trunk the store keeps: one the SIP server leaves out
   * of a read but the store still has is no trunk removed (a partial read: a reload under way).
   */
  names: (tenantId: string) => Promise<Map<string, string | undefined>>
  /**
   * What was told of the tenant's trunks (Store.listWebhookStates, `trunk:`), read once each time this Gateway starts
   * telling: one told degraded then removed while another Gateway told is still told recovered.
   */
  told?: (tenantId: string) => Promise<{ subject: string; state: string }[]>
  /** Whether this Gateway tells the changes of state now (WebhookHub.leading): the others read nothing. */
  leading: () => boolean
  /** Tells a change of state once (WebhookHub.publishChange). */
  publishChange: (tenantId: string, subject: string, state: string, types: WebhookEventType[], make: (previous: string | undefined, at: string) => PublishedWebhookEvent | null) => Promise<number | null>
  /** How often (default 30 s). */
  everyMs?: number
  /** Reads in a row a new health must be seen before it is told, worse or better (default 2: a registration renewed at the wrong instant is no outage). */
  confirm?: number
  /** Tenants read at the same time (default 8): a round over a hundred of them stays within its 30 s. */
  parallel?: number
  logger?: { warn(obj: object, msg?: string): void }
}

const TYPES: WebhookEventType[] = ['trunk.degraded', 'trunk.recovered']
/** The state kept of a trunk no longer watched (disabled whole, or deleted): purged after the retention. */
const REMOVED = 'removed'

/**
 * Reads the trunks of the tenants on a schedule and tells their changes of health (step 10a, ADR 0020), each seen
 * `confirm` reads in a row whichever way it goes: `trunk.degraded` when its health is no longer up and changes (from
 * up, or never read, to degraded or down; from degraded to down; from down to degraded, a partial recovery),
 * `trunk.recovered` when one told degraded or down is up again, or is no longer watched (`removed`: an administrator
 * disabled or deleted it, as the store and the SIP server both say, `confirm` reads in a row too). Only the Gateway that holds the lease of the changes of state reads them; the health told
 * is kept in the store, which never lets an older one through: told once whatever the Gateways.
 */
export class TrunkWatch {
  private readonly seen = new Map<string, { health: TrunkHealth | typeof REMOVED; reads: number }>()
  /** What was last written for each trunk of each tenant (by this Gateway, or read from the store): the same costs no write. */
  private readonly written = new Map<string, Map<string, string>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false
  private skipped = 0

  constructor(private readonly options: TrunkWatchOptions) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.options.everyMs ?? 30_000)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** One round over the tenants, several at a time (the schedule runs it; tests call it). */
  async tick() {
    if (this.busy) {
      // A round longer than the schedule: said, once per round that runs over.
      if (!this.skipped++) this.options.logger?.warn({}, 'trunk health: a round is still going, the next one is skipped')
      return
    }
    // Another Gateway tells: what this one saw is forgotten (it counts its reads afresh once it tells).
    if (!this.options.leading()) {
      this.seen.clear()
      this.written.clear()
      return
    }
    this.busy = true
    this.skipped = 0
    try {
      const tenants = this.options.tenants()
      let next = 0
      const worker = async () => {
        while (next < tenants.length) {
          const tenantId = tenants[next++]!
          await this.tenant(tenantId).catch((err: unknown) => this.options.logger?.warn({ err, tenantId }, 'trunk health not read'))
        }
      }
      await Promise.all(Array.from({ length: Math.min(this.options.parallel ?? 8, tenants.length) }, worker))
    } finally {
      this.busy = false
    }
  }

  /** What was written of the tenant's trunks: read from the store the first time (this Gateway starts telling). */
  private async writtenOf(tenantId: string) {
    let w = this.written.get(tenantId)
    if (!w) {
      const told = (await this.options.told?.(tenantId)) ?? []
      w = this.written.get(tenantId) ?? new Map(told.filter(t => t.subject.startsWith('trunk:')).map(t => [t.subject.slice('trunk:'.length), t.state]))
      this.written.set(tenantId, w)
    }
    return w
  }

  private async tenant(tenantId: string) {
    const statuses = await this.options.read(tenantId)
    if (!statuses) return
    const written = await this.writtenOf(tenantId)
    const confirm = this.options.confirm ?? 2
    let names: Map<string, string | undefined> | undefined
    const watched = new Set<string>()
    const describe = async (status: TrunkStatus | undefined, id: string) => {
      names ??= await this.options.names(tenantId)
      const name = names.get(id)
      return {
        id,
        ...(name ? { name } : {}),
        ...(status?.registration ? { registration: status.registration.state } : {}),
        servers: (status?.servers ?? []).map(s => ({ address: s.address, state: s.state }))
      }
    }
    for (const status of statuses) {
      const health = trunkHealthOf(status)
      if (!health) continue
      watched.add(status.id)
      const k = `${tenantId}\u0000${status.id}`
      const before = this.seen.get(k)
      const reads = before?.health === health ? before.reads + 1 : 1
      this.seen.set(k, { health, reads })
      if (reads < confirm || written.get(status.id) === health) continue
      const trunk = await describe(status, status.id)
      const queued = await this.options.publishChange(tenantId, `trunk:${status.id}`, health, TYPES, (was, at): PublishedWebhookEvent | null => {
        const previous = was === REMOVED ? undefined : (was as TrunkHealth | undefined)
        const base = { id: randomEventId(), occurred_at: at, tenant: tenantId }
        if (health !== 'up' && health !== previous) return { ...base, type: 'trunk.degraded', trunk: { ...trunk, state: health, ...(previous ? { previous } : {}) } }
        if (health === 'up' && previous && previous !== 'up') return { ...base, type: 'trunk.recovered', trunk: { ...trunk, state: 'up', previous } }
        return null
      })
      // Not asked of the store (nobody subscribed yet, this Gateway no longer leads): asked again at the next read.
      if (queued !== null) written.set(status.id, health)
    }
    // A trunk no longer watched (disabled whole, or deleted): told recovered if it was told degraded or down, then
    // kept `removed` (purged after the retention). Only once the store says so as well (deleted from it, or the SIP
    // server reads it disabled whole), `confirm` reads in a row: a read that leaves it out while the store still has
    // it is partial, not a removal.
    for (const [id, state] of [...written]) {
      if (watched.has(id) || state === REMOVED) continue
      const status = statuses.find(s => s.id === id)
      names ??= await this.options.names(tenantId)
      const k = `${tenantId}\u0000${id}`
      if (!status && names.has(id)) {
        this.seen.delete(k)
        continue
      }
      const before = this.seen.get(k)
      const reads = before?.health === REMOVED ? before.reads + 1 : 1
      this.seen.set(k, { health: REMOVED, reads })
      if (reads < confirm) continue
      this.seen.delete(k)
      const trunk = await describe(status, id)
      const queued = await this.options.publishChange(tenantId, `trunk:${id}`, REMOVED, TYPES, (was, at): PublishedWebhookEvent | null => {
        if (was !== 'degraded' && was !== 'down') return null
        return { id: randomEventId(), occurred_at: at, tenant: tenantId, type: 'trunk.recovered', trunk: { ...trunk, state: 'up', previous: was, removed: true } }
      })
      if (queued !== null) written.set(id, REMOVED)
    }
  }
}
