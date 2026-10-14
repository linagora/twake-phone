import type { MediaProvider } from '@twake/telephony-provider-sdk'
import type { Endpoint, MediaSession, User } from '@twake/telephony-types'

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface SipCredential {
  username: string
  /** Prefer a short-lived credential; a static one is only acceptable on dev PBXs. */
  credential: string
}

export interface SipWebrtcMediaConfig {
  websocketUrl: string
  iceServers: IceServer[]
  /** Resolves the SIP identity for a Twake user. Secrets come from the secret manager, never from a doctype. */
  credentialFor(user: User, endpoint: Endpoint): Promise<SipCredential>
}

/** Media plane shared by every provider whose endpoints are SIP-over-WebSocket WebRTC clients. */
export class SipWebrtcMediaProvider implements MediaProvider {
  constructor(private readonly config: SipWebrtcMediaConfig) {}

  async getSession(user: User, endpoint: Endpoint): Promise<MediaSession> {
    if (endpoint.type !== 'browser') return { type: 'external' }
    const { username, credential } = await this.config.credentialFor(user, endpoint)
    return {
      type: 'sip-webrtc',
      websocketUrl: this.config.websocketUrl,
      username,
      credential,
      iceServers: this.config.iceServers
    }
  }
}
