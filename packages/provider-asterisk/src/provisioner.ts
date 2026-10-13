/** Pushes a SIP secret to the PBX. Asterisk-specific: the Gateway only sees this interface. */
export interface SecretProvisioner {
  setSipSecret(extension: string, secret: string): Promise<void>
}

export interface MiniPbxProvisionerOptions {
  /** Base URL of the PBX provisioning API, e.g. http://pbx:18081 */
  url: string
  token: string
  fetchImpl?: typeof fetch
}

/** Provisioning API of the dev PBX (docker/minipbx-dev/overlay/provision.py). */
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
