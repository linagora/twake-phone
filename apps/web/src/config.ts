/** Runtime configuration, served next to the app as config.json so one build runs on any platform. */
export interface AppConfig {
  gatewayUrl: string
  oidc: {
    authority: string
    clientId: string
    /** Scopes to ask; the default adds offline_access for a refresh token. */
    scope?: string
    /** Prompt sent at sign-in; the default is "consent" when offline_access is asked (OIDC Core 11), "" sends none. */
    prompt?: string
    /** Resource indicator (RFC 8707): makes the identity provider issue an access token for the Gateway. */
    resource?: string
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Validates what config.json says: a missing field is a deployment error, named as such. */
export const parseConfig = (raw: unknown): AppConfig => {
  if (!isRecord(raw)) throw new Error('config.json: not an object')
  const { gatewayUrl, oidc } = raw
  if (typeof gatewayUrl !== 'string' || !/^https?:\/\//.test(gatewayUrl)) throw new Error('config.json: gatewayUrl must be an http(s) URL')
  if (!isRecord(oidc)) throw new Error('config.json: oidc is required')
  if (typeof oidc.authority !== 'string' || !/^https?:\/\//.test(oidc.authority)) throw new Error('config.json: oidc.authority must be an http(s) URL')
  if (typeof oidc.clientId !== 'string' || !oidc.clientId) throw new Error('config.json: oidc.clientId is required')
  return {
    gatewayUrl: gatewayUrl.replace(/\/+$/, ''),
    oidc: {
      authority: oidc.authority,
      clientId: oidc.clientId,
      ...(typeof oidc.scope === 'string' ? { scope: oidc.scope } : {}),
      ...(typeof oidc.prompt === 'string' ? { prompt: oidc.prompt } : {}),
      ...(typeof oidc.resource === 'string' ? { resource: oidc.resource } : {})
    }
  }
}

export const loadConfig = async (fetchImpl: typeof fetch = fetch): Promise<AppConfig> => {
  const res = await fetchImpl('/config.json', { cache: 'no-store' })
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`)
  return parseConfig(await res.json())
}
