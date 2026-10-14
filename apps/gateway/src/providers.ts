import { AsteriskProvider, miniPbxProvisioner, type AsteriskConfig } from '@twake/provider-asterisk'
import type { ProviderContext, ProviderFactory } from '@twake/telephony-provider-sdk'
import type { SipSecrets } from './sip-secrets.js'
import type { Store } from './store/types.js'

/** What is stored in provider_configs for an Asterisk provider. Secrets are references, never values. */
export interface StoredAsteriskConfig {
  ari: { url: string; user: string; passwordRef: string; app?: string }
  websocketUrl: string
  iceServers?: { urls: string[] }[]
  trunkEndpoint?: string
  /** Dialplan context that rings every window of an extension (see provider-asterisk). */
  originateContext?: string
  /** Route external numbers through a PBX dialplan context (applies the PBX's own outbound rules). */
  externalDial?: { context: string; e164Prefix?: string; nationalPrefix?: string }
  /** Per-user SIP secrets pushed to the PBX. Without it, `staticSipSecretRef` is used (dev only). */
  provisioning?: { url: string; tokenRef: string }
  staticSipSecretRef?: string
}

/** "env:NAME" -> value of the environment variable. A vault scheme would plug in here. */
export const resolveRef = (ref: string, env: NodeJS.ProcessEnv = process.env): string => {
  const m = /^env:([A-Z0-9_]+)$/.exec(ref)
  if (!m) throw new Error(`Unsupported secret reference: ${ref.split(':')[0]}:…`)
  const value = env[m[1]!]
  if (value === undefined) throw new Error(`Secret reference ${ref} is not set`)
  return value
}

export interface FactoryDeps {
  store: Store
  /** Absent when provisioning is not configured. */
  secretsFor?: (provisioningUrl: string, token: string) => SipSecrets
  env?: NodeJS.ProcessEnv
}

/** Builds Asterisk providers from their stored configuration. */
export const storedAsteriskFactory = ({ store, secretsFor, env = process.env }: FactoryDeps): ProviderFactory<StoredAsteriskConfig> => ({
  type: 'asterisk',
  create(config, context?: ProviderContext) {
    const tenantId = context?.tenantId ?? 'default'
    const secrets = config.provisioning && secretsFor ? secretsFor(config.provisioning.url, resolveRef(config.provisioning.tokenRef, env)) : undefined
    const staticSecret = config.staticSipSecretRef ? resolveRef(config.staticSipSecretRef, env) : undefined

    const sipSecretFor: AsteriskConfig['sipSecretFor'] = async extension => {
      if (secrets) {
        const mapping = await store.getMappingByExtension(tenantId, extension)
        if (!mapping) throw Object.assign(new Error('Extension is not mapped to a user'), { statusCode: 404 })
        return secrets.getOrCreate(tenantId, mapping.userId, extension)
      }
      if (!staticSecret) throw Object.assign(new Error('No SIP secret source configured'), { statusCode: 500 })
      return staticSecret
    }

    return new AsteriskProvider({
      ari: { url: config.ari.url, user: config.ari.user, password: resolveRef(config.ari.passwordRef, env), ...(config.ari.app ? { app: config.ari.app } : {}) },
      websocketUrl: config.websocketUrl,
      ...(config.iceServers ? { iceServers: config.iceServers } : {}),
      ...(config.trunkEndpoint ? { trunkEndpoint: config.trunkEndpoint } : {}),
      ...(config.originateContext ? { originateContext: config.originateContext } : {}),
      ...(config.externalDial ? { externalDial: config.externalDial } : {}),
      sipSecretFor
    })
  }
})

export { miniPbxProvisioner }
