// Vendor-neutral domain model. No PBX/provider concept may appear here.

export type TenantId = string
export type UserId = string

export interface User {
  id: UserId
  tenantId: TenantId
  displayName: string
  extension?: string
}

export type EndpointType = 'browser' | 'desk-phone' | 'mobile' | 'external'

export interface Endpoint {
  id: string
  type: EndpointType
  label: string
}

export type PresenceStatus = 'available' | 'busy' | 'away' | 'dnd' | 'offline'
export type PresenceSource = 'user' | 'telephony' | 'calendar' | 'system'

export interface Presence {
  status: PresenceStatus
  source: PresenceSource
  since?: string
}

export type CallState =
  | 'new'
  | 'ringing'
  | 'connected'
  | 'held'
  | 'ended'
  | 'failed'
  | 'rejected'
  | 'missed'

export type CallDirection = 'inbound' | 'outbound'

export interface Call {
  id: string
  direction: CallDirection
  state: CallState
  remoteNumber: string
  startedAt?: string
  /** When the call was answered; absent for missed, rejected or failed calls. */
  connectedAt?: string
  endedAt?: string
}

export interface OriginateRequest {
  user: User
  target: string
  endpointId?: string
  idempotencyKey?: string
}

export interface Capabilities {
  calling: {
    outbound: boolean
    inbound: boolean
    answer: boolean
    hangup: boolean
    hold: boolean
    transfer: boolean
    dtmf: boolean
  }
  media: { browserAudio: boolean }
  presence: {
    read: boolean
    write: boolean
    realtime: boolean
    statuses: PresenceStatus[]
  }
  history: boolean
  conference: { dialIn: boolean; dialOut: boolean }
}

/** Media plane description handed to the client; opaque to the Gateway. */
export type MediaSession =
  | {
      type: 'sip-webrtc'
      websocketUrl: string
      username: string
      /** Short-lived credential, never a permanent SIP password. */
      credential: string
      iceServers: { urls: string[]; username?: string; credential?: string }[]
    }
  | { type: 'external' }

export interface Meeting {
  id: string
  tenantId: TenantId
}

export interface DialInConfiguration {
  numbers: { country: string; e164: string }[]
  meetingCode: string
  pin?: string
}

export interface ConferenceParticipant {
  id: string
  meetingId: string
  kind: 'web' | 'phone'
  displayName?: string
  /** Honours the tenant privacy setting: show | mask | hide. */
  number?: string
  muted: boolean
}

export type TelephonyEvent =
  | { type: 'call.created' | 'call.ringing' | 'call.connected' | 'call.held' | 'call.resumed' | 'call.ended' | 'call.failed'; timestamp: string; payload: { call: Call } }
  | { type: 'presence.changed'; timestamp: string; payload: { userId: UserId; presence: Presence } }
  | { type: 'endpoint.connected' | 'endpoint.disconnected'; timestamp: string; payload: { userId: UserId; endpoint: Endpoint } }
  | { type: 'conference.participant.joined' | 'conference.participant.left'; timestamp: string; payload: { participant: ConferenceParticipant } }

export type ProviderStatus = 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'ERROR'
