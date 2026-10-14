import type { SecretProvisioner } from '@twake/telephony-provider-sdk'

export type { SecretProvisioner }

export interface MiniPbxProvisionerOptions {
  /** Base URL of the PBX provisioning API, e.g. http://pbx:18081 */
  url: string
  token: string
  fetchImpl?: typeof fetch
}

/** Provisioning API of the POC's dev PBX (MiniPBX overlay, removed with the POC; see docs/PBX-REQUIREMENTS.md §7). */
export const miniPbxProvisioner = ({ url, token, fetchImpl = fetch }: MiniPbxProvisionerOptions): SecretProvisioner => ({
  async setSipSecret(extension, secret) {
    const res = await fetchImpl(`${url}/extensions/${encodeURIComponent(extension)}/secret`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-provision-token': token },
      body: JSON.stringify({ secret })
    })
    if (!res.ok) throw Object.assign(new Error(`PBX refused to provision extension ${extension}: ${res.status}`), { statusCode: 502 })
  }
})
