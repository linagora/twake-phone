import type { TrunkHealth, TrunkStatus, WebhookEvent } from '@twake/telephony-types'
import { randomEventId } from './webhook-events.js'
import type { Store } from './store/types.js'

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
  store: Store
  /** The tenants whose trunks to read now. */
  tenants: () => string[]
  /** How a tenant's trunks are doing (the SIP server's word); undefined when it cannot say. */
  read: (tenantId: string) => Promise<TrunkStatus[] | undefined>
  /** The names administrators gave the tenant's trunks. */
  names: (tenantId: string) => Promise<Map<string, string | undefined>>
  publish: (tenantId: string, event: Extract<WebhookEvent, { type: 'trunk.degraded' }>) => Promise<unknown>
  /** How often (default 30 s). */
  everyMs?: number
  /** Reads in a row a worse health must be seen before it is told (default 2: a registration renewed at the wrong instant is no outage). */
  confirm?: number
  now?: () => number
  logger?: { warn(obj: object, msg?: string): void }
}

/**
 * Reads the trunks of the tenants on a schedule and tells `trunk.degraded` when one gets worse (step 10a, ADR 0020):
 * from up (or never read) to degraded or down, from degraded to down; seen `confirm` reads in a row. The health is
 * kept in the store, which says which Gateway saw the change first: told once whatever the Gateways. Back to up, it is
 * kept, without an event.
 */
export class TrunkWatch {
  private readonly seen = new Map<string, { health: TrunkHealth; reads: number }>()
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
      if (health !== 'up' && reads < confirm) continue
      const at = new Date((this.options.now ?? Date.now)()).toISOString()
      const previous = (await this.options.store.setWebhookState(tenantId, `trunk:${status.id}`, health, at)) as TrunkHealth | undefined | null
      if (previous === null || RANK[health] <= RANK[previous ?? 'up']) continue
      names ??= await this.options.names(tenantId)
      const name = names.get(status.id)
      await this.options.publish(tenantId, {
        id: randomEventId(),
        type: 'trunk.degraded',
        occurred_at: at,
        tenant: tenantId,
        trunk: {
          id: status.id,
          ...(name ? { name } : {}),
          state: health as Exclude<TrunkHealth, 'up'>,
          ...(previous ? { previous } : {}),
          ...(status.registration ? { registration: status.registration.state } : {}),
          servers: status.servers.map(s => ({ address: s.address, state: s.state }))
        }
      })
    }
  }
}
