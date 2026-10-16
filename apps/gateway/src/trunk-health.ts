import type { TrunkHealth, TrunkStatus, WebhookEventType } from '@twake/telephony-types'
import { randomEventId, type PublishedWebhookEvent } from './webhook-events.js'

/** Registration states that leave the trunk without calls: the operator refused it, never answered, or it lapsed. */
const LOST: ReadonlySet<string> = new Set(['refused', 'timeout', 'error', 'unregistered'])
const RANK: Record<TrunkHealth, number> = { up: 0, degraded: 1, down: 2 }

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
  /** The names administrators gave the tenant's trunks. */
  names: (tenantId: string) => Promise<Map<string, string | undefined>>
  /** Whether this Gateway tells the changes of state now (WebhookHub.leading): the others read nothing. */
  leading: () => boolean
  /** Tells a change of state once (WebhookHub.publishChange). */
  publishChange: (tenantId: string, subject: string, state: string, types: WebhookEventType[], make: (previous: string | undefined, at: string) => PublishedWebhookEvent | null) => Promise<number | null>
  /** How often (default 30 s). */
  everyMs?: number
  /** Reads in a row a new health must be seen before it is told, worse or better (default 2: a registration renewed at the wrong instant is no outage). */
  confirm?: number
  logger?: { warn(obj: object, msg?: string): void }
}

const TYPES: WebhookEventType[] = ['trunk.degraded', 'trunk.recovered']

/**
 * Reads the trunks of the tenants on a schedule and tells their changes of health (step 10a, ADR 0020), each seen
 * `confirm` reads in a row whichever way it goes: `trunk.degraded` when one gets worse (from up, or never read, to
 * degraded or down; from degraded to down), `trunk.recovered` when one told degraded or down is up again. Only the
 * Gateway that holds the lease of the changes of state reads them; the health told is kept in the store, which never
 * lets an older one through: told once whatever the Gateways.
 */
export class TrunkWatch {
  private readonly seen = new Map<string, { health: TrunkHealth; reads: number }>()
  /** What this Gateway last had written for each trunk: the same health again costs no write. */
  private readonly written = new Map<string, TrunkHealth>()
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false

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

  /** One round over the tenants (the schedule runs it; tests call it). */
  async tick() {
    if (this.busy) return
    // Another Gateway tells: what this one saw is forgotten (it counts its reads afresh once it tells).
    if (!this.options.leading()) {
      this.seen.clear()
      this.written.clear()
      return
    }
    this.busy = true
    try {
      for (const tenantId of this.options.tenants()) await this.tenant(tenantId).catch((err: unknown) => this.options.logger?.warn({ err, tenantId }, 'trunk health not read'))
    } finally {
      this.busy = false
    }
  }

  private async tenant(tenantId: string) {
    const statuses = await this.options.read(tenantId)
    if (!statuses) return
    const confirm = this.options.confirm ?? 2
    let names: Map<string, string | undefined> | undefined
    for (const status of statuses) {
      const health = trunkHealthOf(status)
      if (!health) continue
      const k = `${tenantId}\u0000${status.id}`
      const before = this.seen.get(k)
      const reads = before?.health === health ? before.reads + 1 : 1
      this.seen.set(k, { health, reads })
      if (reads < confirm || this.written.get(k) === health) continue
      names ??= await this.options.names(tenantId)
      const name = names.get(status.id)
      const trunk = {
        id: status.id,
        ...(name ? { name } : {}),
        ...(status.registration ? { registration: status.registration.state } : {}),
        servers: status.servers.map(s => ({ address: s.address, state: s.state }))
      }
      const queued = await this.options.publishChange(tenantId, `trunk:${status.id}`, health, TYPES, (was, at): PublishedWebhookEvent | null => {
        const previous = was as TrunkHealth | undefined
        const base = { id: randomEventId(), occurred_at: at, tenant: tenantId }
        if (health !== 'up' && RANK[health] > RANK[previous ?? 'up']) return { ...base, type: 'trunk.degraded', trunk: { ...trunk, state: health, ...(previous ? { previous } : {}) } }
        if (health === 'up' && previous && previous !== 'up') return { ...base, type: 'trunk.recovered', trunk: { ...trunk, state: 'up', previous } }
        return null
      })
      // Not asked of the store (nobody subscribed yet, this Gateway no longer leads): asked again at the next read.
      if (queued !== null) this.written.set(k, health)
    }
  }
}
