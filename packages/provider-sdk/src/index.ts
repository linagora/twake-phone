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
  OutboundAssignment,
  OutboundPolicy,
  OutboundProfile,
  Presence,
  ProviderStatus,
  RingGroup,
  DidRange,
  TelephonyEvent,
  Trunk,
  TrunkStatus,
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
  /**
   * Lets a room of Meet call `number` at the name of `extension` once, within `ttlSec` seconds (step 8, ADR 0018): the
   * SIP server refuses a room's call it was not told of. `token` goes with the call (ConferenceBridgeProvider's
   * dialParticipant, `grant`); `revoke` withdraws it when the call never reached the SIP server; `taken` says which
   * call took it (review 8b, n°3).
   */
  grantRoomCall?(grant: RoomCallGrant): Promise<RoomCallGrantToken>
  /** Ends a call the SIP server has, by its Call-ID (a room's call that took a grant meant for another, review 8b, n°3). */
  endRoomCall?(callId: string): Promise<void>
  /**
   * A call in progress between two of the tenant's extensions, as the SIP server holds it (step 8b, ADR 0019): its
   * parties (the extensions where it reached, a ring group's member who answered, a forward's target) and the tags
   * of its dialog, which a room's call that takes its place names (Replaces). `external` for an answered call with
   * the public network or a room (no room's call takes its place: the platform has no B2BUA); undefined when the
   * SIP server has no such call answered (ringing, over, never there).
   */
  callBetweenExtensions?(callId: string): Promise<CallParties | 'external' | undefined>
  /**
   * The access number of Meet's rooms as the SIP server has it (step 8): `number` undefined when its rooms are off
   * there; undefined when it cannot say. The Gateway compares it with its own at its start.
   */
  getMeetAccess?(): Promise<{ number?: string } | undefined>
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
  /**
   * How the tenant's trunks are doing now (step 7): registration and servers, as the SIP server says. Undefined when
   * the provider cannot ask it (no control channel); throws when it asked and got no answer.
   */
  getTrunkStatus?(): Promise<TrunkStatus[] | undefined>
  /**
   * The outbound policy of the tenant, its rights profiles and who has which (capability `outboundPolicy`, step 6b):
   * replaces what the provider had. The Gateway checked them (ids, classes, caps, profiles named that exist).
   */
  setOutboundPolicy?(policy: OutboundPolicy, profiles: OutboundProfile[], assignments: OutboundAssignment[]): Promise<void>
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
  /**
   * `from`: the extension of whoever asked for the call (step 8): the call is theirs, at their name and with their
   * rights; `grant`: the token the SIP server gave for it (TelephonyProvider's grantRoomCall), carried with the call.
   */
  dialParticipant(meetingId: string, number: string, options?: { from?: string; grant?: string }): Promise<DialedParticipant>
  disconnectParticipant(participantId: string): Promise<void>
  muteParticipant(participantId: string): Promise<void>
}

/**
 * What a room's call may do (step 8 and 8b): `extension` calls `number`, once, within `ttlSec` seconds. `replaces`
 * (step 8b): it takes the place of that call of `number` (`callid;to-tag=…;from-tag=…`, the dialog as `number` sees
 * it), answered at once by the phone that has it and never sent elsewhere; `join`: it goes to `extension` itself
 * (`number` is theirs), carries that token (Twake-Join), and only the window that asked for it answers it.
 */
export interface RoomCallGrant {
  extension: string
  number: string
  ttlSec?: number
  replaces?: string
  join?: string
  /** The room of the conference the call is for (step 8b): the SIP server names it to the phone it calls. */
  room?: string
}

/**
 * A grant of a room's call (grantRoomCall). `taken`: the call that took it, as the SIP server saw it: the From tag
 * (LiveKit SIP makes it the id of its call, which dialParticipant returns as `sipCallId`) and the Call-ID; undefined
 * while no call took it.
 */
export interface RoomCallGrantToken {
  token: string
  revoke(): Promise<void>
  taken?(): Promise<{ tag: string; callId: string } | undefined>
}

/** A participant a room called (dialParticipant): `sipCallId`, the id of that call at the bridge, never shown to anyone. */
export type DialedParticipant = ConferenceParticipant & { sipCallId?: string }

/** The parties of a call between two extensions, and its dialog (callBetweenExtensions). */
export interface CallParties {
  callId: string
  /** The extension that placed it, and the From tag. */
  caller: string
  callerTag: string
  /** The extension it reached (who answered), and the To tag. */
  callee: string
  calleeTag: string
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
