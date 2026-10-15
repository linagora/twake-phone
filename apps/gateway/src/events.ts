import type { TelephonyEvent, TenantId, UserId } from '@twake/telephony-types'

type Listener = (event: TelephonyEvent) => void

/**
 * In-process fan-out of events per tenant/user. Single instance only: for
 * multi-replica deployments swap the implementation for Redis pub/sub
 * (same interface), see cahier §108-109.
 */
export class EventBus {
  /** Per user. */
  private readonly listeners = new Map<string, Set<Listener>>()
  /** Per tenant, apart: no user id, whatever it looks like, reaches the whole tenant. */
  private readonly tenantListeners = new Map<TenantId, Set<Listener>>()

  private key(tenantId: TenantId, userId: UserId) {
    return `${tenantId}\u0000${userId}`
  }

  private static add<K>(map: Map<K, Set<Listener>>, key: K, listener: Listener): () => void {
    const set = map.get(key) ?? new Set()
    set.add(listener)
    map.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size === 0 && map.get(key) === set) map.delete(key)
    }
  }

  subscribe(tenantId: TenantId, userId: UserId, listener: Listener): () => void {
    return EventBus.add(this.listeners, this.key(tenantId, userId), listener)
  }

  publish(tenantId: TenantId, userId: UserId, event: TelephonyEvent) {
    this.listeners.get(this.key(tenantId, userId))?.forEach(l => l(event))
  }

  /** What everyone of a tenant hears (the presence of the others). */
  subscribeTenant(tenantId: TenantId, listener: Listener): () => void {
    return EventBus.add(this.tenantListeners, tenantId, listener)
  }

  broadcast(tenantId: TenantId, event: TelephonyEvent) {
    this.tenantListeners.get(tenantId)?.forEach(l => l(event))
  }
}
