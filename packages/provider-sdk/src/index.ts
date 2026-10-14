import type {
  Call,
  Capabilities,
  ConferenceParticipant,
  DialInConfiguration,
  Endpoint,
  MediaSession,
  Meeting,
  OriginateRequest,
  Presence,
  ProviderStatus,
  TelephonyEvent,
  User
} from '@twake/telephony-types'

/** An event plus the provider-side identity (User.extension) it concerns; the Gateway maps it back to a Twake user. */
export interface RoutedEvent {
  extension: string
  event: TelephonyEvent
}

export interface TelephonyProvider {
  readonly id: string
  getStatus(): ProviderStatus
  getCapabilities(): Promise<Capabilities>
  getPresence(user: User): Promise<Presence>
  setPresence(user: User, presence: Presence): Promise<void>
  originate(request: OriginateRequest): Promise<Call>
  /** Releases connections and stops event streams. */
  close(): Promise<void>
  answer(callId: string): Promise<void>
  hangup(callId: string): Promise<void>
  hold(callId: string): Promise<void>
  resume(callId: string): Promise<void>
  transfer(callId: string, destination: string): Promise<void>
  sendDTMF(callId: string, digits: string): Promise<void>
  subscribe(): AsyncIterable<RoutedEvent>
}

export interface MediaProvider {
  getSession(user: User, endpoint: Endpoint): Promise<MediaSession>
}

export interface ConferenceBridgeProvider {
  createDialIn(meeting: Meeting): Promise<DialInConfiguration>
  removeDialIn(meetingId: string): Promise<void>
  dialParticipant(meetingId: string, number: string): Promise<ConferenceParticipant>
  disconnectParticipant(participantId: string): Promise<void>
  muteParticipant(participantId: string): Promise<void>
}

/** Provider modules export a factory; config comes from the tenant settings, secrets from env/Vault. */
export interface ProviderContext {
  tenantId: string
  site: string
}

export interface ProviderFactory<C = unknown> {
  readonly type: string
  create(config: C, context?: ProviderContext): TelephonyProvider & Partial<MediaProvider>
}
