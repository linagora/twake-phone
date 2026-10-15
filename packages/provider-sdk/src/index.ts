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
  RingGroup,
  DidRange,
  TelephonyEvent,
  Trunk,
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
   * next one. `displayName` is the holder's name in the directory: what the SIP server shows the people they call.
   */
  syncExtensions?(holders: { extension: string; userId: string; displayName?: string }[]): Promise<void>
  /**
   * Who of the tenant can be woken for a call (capability `push`): the people with a browser subscribed to
   * notifications, with the extension they hold. Replaces the tenant's list; a call to one of them while nothing of
   * theirs is online waits for a device to come online, and the provider tells the Gateway to wake them (`call.wake`).
   */
  setWakeable?(holders: { extension: string; userId: string }[]): Promise<void>
  /** One person's line of `setWakeable`: whether they can be woken now (`on`), the others untouched. */
  setWakeableOne?(holder: { extension: string; userId: string }, on: boolean): Promise<void>
  /** Where the calls of the user's extension go (capability `forwarding`). */
  getForwarding?(user: User): Promise<ForwardingRules>
  /** Replaces those rules; targets are extensions the Gateway checked. */
  setForwarding?(user: User, rules: ForwardingRules): Promise<void>
  /** The simultaneous ring groups of the tenant (capability `groups`), by number. */
  listGroups?(): Promise<RingGroup[]>
  /**
   * Creates a group (`create`: 409 with code GROUP_EXISTS when the tenant has one of that number, GROUP_NUMBER_TAKEN
   * when the PBX has that number already) or replaces one (`replace`: 404 when the tenant has none). The Gateway
   * checked its number is no extension and its members are, or were already members.
   */
  setGroup?(group: RingGroup, mode: 'create' | 'replace'): Promise<void>
  /** Removes a group; false when the tenant has none with that number. */
  deleteGroup?(number: string): Promise<boolean>
  /**
   * The trunks of the tenant with their passwords, and its direct numbers (capability `trunks`): replaces what the
   * provider had. The Gateway checked them (ids, numbers, ranges that do not overlap).
   */
  setTrunks?(trunks: (Trunk & { password?: string })[], dids: DidRange[]): Promise<void>
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
  /** `holder`: the user the extension's account is for (the Gateway's user id), when the SIP server keeps it. */
  setSipSecret(extension: string, secret: string, holder?: string): Promise<void>
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
