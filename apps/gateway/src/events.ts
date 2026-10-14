import type { TelephonyEvent, TenantId, UserId } from '@twake/telephony-types'

type Listener = (event: TelephonyEvent) => void

/**
 * In-process fan-out of events per tenant/user. Single instance only: for
 * multi-replica deployments swap the implementation for Redis pub/sub
 * (same interface), see cahier §108-109.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>()

  private key(tenantId: TenantId, userId: UserId) {
    return `${tenantId}:${userId}`
  }

  subscribe(tenantId: TenantId, userId: UserId, listener: Listener): () => void {
    const key = this.key(tenantId, userId)
    const set = this.listeners.get(key) ?? new Set()
    set.add(listener)
    this.listeners.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(key)
    }
  }

  publish(tenantId: TenantId, userId: UserId, event: TelephonyEvent) {
    this.listeners.get(this.key(tenantId, userId))?.forEach(l => l(event))
  }
}
