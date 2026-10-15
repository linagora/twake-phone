import type {
  Call,
  Capabilities,
  ConferenceParticipant,
  DialInConfiguration,
  Endpoint,
  ForwardingRules,
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
  /** Why the status is not CONNECTED, in a few words without addresses or secrets (it may be shown unauthenticated). */
  getStatusReason?(): string | undefined
  getCapabilities(): Promise<Capabilities>
  getPresence(user: User): Promise<Presence>
  setPresence(user: User, presence: Presence): Promise<void>
  /**
   * The presences the Gateway kept for the users of the tenant (what each person chose), handed back when the
   * provider starts: the provider applies them, and forgets any it applied for someone not in the list.
   */
  restorePresences?(entries: { user: User; presence: Presence }[]): Promise<void>
  /**
   * Who holds each extension of the tenant now, handed when the provider starts and after any change of the
   * mappings: what a provider keeps per extension for its holder (forwards, "do not disturb") does not pass to the
   * next one.
   */
  syncExtensions?(holders: { extension: string; userId: string }[]): Promise<void>
  /** Where the calls of the user's extension go (capability `forwarding`). */
  getForwarding?(user: User): Promise<ForwardingRules>
  /** Replaces those rules; targets are extensions the Gateway checked. */
  setForwarding?(user: User, rules: ForwardingRules): Promise<void>
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

/** Pushes a user's SIP secret where the SIP server checks it. The Gateway generates and keeps the secret. */
export interface SecretProvisioner {
  setSipSecret(extension: string, secret: string): Promise<void>
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
