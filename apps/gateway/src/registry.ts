import type { ProviderFactory, TelephonyProvider } from '@twake/telephony-provider-sdk'
import type { ProviderRecord } from './store/types.js'

/** Resolves the provider of a tenant (one per tenant and site; sites are not routed yet). */
export class ProviderRegistry {
  private readonly cache = new Map<string, TelephonyProvider>()
  private readonly factories = new Map<string, ProviderFactory<any>>()
  /** Called once per provider instance, e.g. to start pumping its events. */
  onCreate?: (tenantId: string, provider: TelephonyProvider) => void

  constructor(
    private readonly records: ProviderRecord[],
    factories: ProviderFactory<any>[] = []
  ) {
    for (const f of factories) this.factories.set(f.type, f)
  }

  /** Whether the tenant has a provider this Gateway can build. */
  serves(tenantId: string): boolean {
    const record = this.records.find(r => r.tenantId === tenantId)
    return !!record && this.factories.has(record.type)
  }

  forTenant(tenantId: string): TelephonyProvider {
    const cached = this.cache.get(tenantId)
    if (cached) return cached
    const record = this.records.find(r => r.tenantId === tenantId)
    const factory = record && this.factories.get(record.type)
    if (!record || !factory) {
      throw Object.assign(new Error('No provider for tenant'), { statusCode: 404 })
    }
    const provider = factory.create(record.config, { tenantId, site: record.site ?? 'default' })
    this.cache.set(tenantId, provider)
    this.onCreate?.(tenantId, provider)
    return provider
  }

  /**
   * Instantiates every configured provider (so event streams run before the first request). A record of a type
   * no factory builds (an `asterisk` one, from before step 4c) is reported and skipped: its tenant has no provider.
   */
  startAll(warn: (message: string) => void = console.warn) {
    for (const r of this.records) {
      if (!this.factories.has(r.type)) {
        warn(`Tenant ${r.tenantId}: no provider of type "${r.type}" in this Gateway; remove or replace its provider_configs row`)
        continue
      }
      this.forTenant(r.tenantId)
    }
  }

  async closeAll() {
    await Promise.all(this.all().map(p => p.close()))
  }

  all(): TelephonyProvider[] {
    return [...this.cache.values()]
  }
}

export type { ProviderRecord }
