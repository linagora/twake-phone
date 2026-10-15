// Vendor-neutral domain model. No PBX/provider concept may appear here.

export type TenantId = string
export type UserId = string

export interface User {
  id: UserId
  tenantId: TenantId
  displayName: string
  extension?: string
}

export type ContactNumberType = 'extension' | 'work' | 'mobile'

export interface ContactNumber {
  type: ContactNumberType
  number: string
}

/** Someone one can call, as the organisation's directory describes them. Vendor-neutral: no LDAP notion here. */
export interface Contact {
  id: string
  displayName: string
  numbers: ContactNumber[]
  email?: string
  department?: string
  title?: string
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
  /** A status the person chose ends by itself at this instant (ISO 8601): a "do not disturb" until a meeting ends. */
  until?: string
  /** What the person wants callers to read while it lasts (a "do not disturb" refuses calls with it). */
  message?: string
}

/**
 * Where a person's calls go instead of ringing them, per extension. Targets are extensions of the organisation (a
 * number outside comes with the trunk). `noAnswer` also applies when nothing of theirs can be reached. Each one
 * absent: not forwarded in that case.
 */
export interface ForwardingRules {
  /** Every call, at once, without ringing. */
  always?: string
  /** When the person is already in a call or declines it. */
  busy?: string
  /** When nobody answers within `delaySec` seconds of ringing (at once when the person cannot be reached). */
  noAnswer?: { target: string; delaySec: number }
}

/**
 * A simultaneous ring group of the organisation: a number of its own (never an extension) that rings every member
 * extension at once; the first to answer takes the call. Set by an administrator.
 */
export interface RingGroup {
  /** What callers dial. */
  number: string
  /** What the members and the directory call it. */
  name: string
  /** The extensions that ring, in the order the administrator gave. */
  members: string[]
  /**
   * When listed: the members nobody holds right now (a person left). They stay members, as positions; nothing rings
   * there until someone holds the extension again.
   */
  vacant?: string[]
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
  /** The person can set where their calls go (`ForwardingRules`) and a "do not disturb" that refuses or forwards them. */
  forwarding?: boolean
  /** Administrators can set simultaneous ring groups (`RingGroup`). */
  groups?: boolean
  /**
   * A call to someone with no device online waits a while for one of theirs to come online, while the Gateway wakes
   * their browsers (Web Push): the provider tells it whom to wake (`call.wake`), and the Gateway tells it who can be
   * woken (`setWakeable`).
   */
  push?: boolean
  conference: { dialIn: boolean; dialOut: boolean }
}

/** Media plane description handed to the client; opaque to the Gateway. */
export type MediaSession =
  | {
      type: 'sip-webrtc'
      websocketUrl: string
      /** SIP domain of the identity (`sip:<username>@<domain>`); the WebSocket host when absent. */
      domain?: string
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
  /**
   * A call for this person, who has no device online: it waits `waitSec` seconds for one of theirs to come online
   * (the Gateway wakes their browsers). `group`: the ring group number the caller dialled, when it is through one.
   */
  | { type: 'call.wake'; timestamp: string; payload: { call: Call; waitSec: number; group?: string } }
  /**
   * A call this person was woken for (`call.wake`) was answered by someone else, `by` (the extension of the
   * colleague of the ring group who answered): it no longer waits for them, and it is no missed call of theirs.
   */
  | { type: 'call.taken'; timestamp: string; payload: { call: Call; by: string } }
  /** `extension`: the telephony identity the presence is about, so that a directory can show it next to a contact. */
  | { type: 'presence.changed'; timestamp: string; payload: { userId: UserId; extension?: string; presence: Presence } }
  | { type: 'endpoint.connected' | 'endpoint.disconnected'; timestamp: string; payload: { userId: UserId; endpoint: Endpoint } }
  | { type: 'conference.participant.joined' | 'conference.participant.left'; timestamp: string; payload: { participant: ConferenceParticipant } }

export type ProviderStatus = 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'ERROR'
