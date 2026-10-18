import type {
  Call,
  Capabilities,
  ConferenceParticipant,
  DialInConfiguration,
  Endpoint,
  ForwardingRules,
  MediaSession,
  Meeting,
  OperatorCdr,
  OperatorFallback,
  OperatorLineForwards,
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
  User,
  Voicemail
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
  /**
   * Whether the provider hears its events now: false while its stream is down (the Gateway leaves telling the changes
   * of state to another one that hears them, ADR 0020). Absent: it has no stream to lose.
   */
  eventsConnected?(): boolean
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
   * dialParticipant, `grant`); `revoke` withdraws it if no call took it (one taken stays, to be read); `taken` says
   * which call took it (review 8b, n°3).
   */
  grantRoomCall?(grant: RoomCallGrant): Promise<RoomCallGrantToken>
  /**
   * Ends a call the SIP server has, by its Call-ID (a room's call that took a grant meant for another, review 8b, n°3),
   * and says what it was (third review 8b, n°1): `answered` (in progress, a BYE to both sides), `ringing` (not answered
   * yet, cancelled), undefined if it has no such call (over, never there).
   */
  endRoomCall?(callId: string): Promise<'answered' | 'ringing' | undefined>
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
  /**
   * Whether the SIP server sends calls to the mailboxes (step 11a): undefined when it cannot say. The Gateway gives
   * the capability `voicemail` only when it does.
   */
  getVoicemailAccess?(): Promise<boolean | undefined>
  /**
   * The mailboxes of the tenant (step 11a, ADR 0022), as the voicemail server named them (VoicemailProvider's
   * syncMailboxes): replaces the list. A call to one of these extensions that nobody answers, that its "do not disturb"
   * refuses, busy or that reaches nobody goes to `mailbox`; an extension not in it has none.
   */
  setVoicemailBoxes?(boxes: VoicemailBox[]): Promise<void>
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

/** A person's mailbox, where the SIP server sends the calls of `extension` it cannot get through (step 11a). */
export interface VoicemailBox {
  extension: string
  /** The voicemail server's own address of the mailbox (`number@context` for Wazo's Asterisk); opaque to the Gateway. */
  mailbox: string
}

/**
 * Whose mailbox: the extension, and the person the Gateway holds it for now. The mailbox of an extension is only ever
 * read for its holder: an extension just given to someone else still has the old holder's until the next
 * syncMailboxes, and nobody hears another's messages.
 */
export interface VoicemailOwner {
  extension: string
  userId: string
}

/**
 * The voicemail server of a tenant (step 11a, ADR 0022; Wazo's, provider-wazo): one mailbox per extension, for the
 * person who holds it, and the messages left there. A mailbox is its holder's: when an extension passes to someone
 * else, its messages go with the old mailbox, never to the new holder.
 */
export interface VoicemailProvider {
  readonly id: string
  getStatus(): ProviderStatus
  /** Why the status is not CONNECTED, in a few words without addresses or secrets. */
  getStatusReason?(): string | undefined
  /**
   * Who holds each extension of the tenant now: each gets a mailbox (kept, moved with its messages from the extension
   * its holder had, or made). The others are set aside with their messages, out of reach of any call, and removed only
   * after a grace period if their holder has not come back. Returns the mailboxes, for the SIP server
   * (TelephonyProvider's setVoicemailBoxes).
   */
  syncMailboxes(holders: { extension: string; userId: string; displayName?: string }[]): Promise<VoicemailBox[]>
  /** Whether the mailbox of `owner.extension` is `owner.userId`'s (the events of a mailbox go to its holder only). */
  owns(owner: VoicemailOwner): Promise<boolean>
  /** The messages of the owner's mailbox, newest first; none when they have no mailbox. */
  listMessages(owner: VoicemailOwner): Promise<Voicemail[]>
  /**
   * The recording of a message (WAV), as a stream read once (`size`: its length in bytes when known), undefined when
   * the owner's mailbox has no such message. The stream fails past the provider's bound of a recording.
   */
  getRecording(owner: VoicemailOwner, id: string): Promise<{ contentType: string; size?: number; body: AsyncIterable<Uint8Array> } | undefined>
  /** Marks a message as read (listened to); false when the owner's mailbox has no such message. */
  markRead(owner: VoicemailOwner, id: string): Promise<boolean>
  /** Deletes a message; false when the owner's mailbox has no such message. */
  deleteMessage(owner: VoicemailOwner, id: string): Promise<boolean>
  /** Deletes every message of the person, in any mailbox held for them (step 10's erasure); how many. */
  eraseMessages(owner: Pick<VoicemailOwner, 'userId'>): Promise<number>
  /** Deletes the messages left before `before`, in every mailbox (the retention period); how many. */
  purgeMessages(before: Date): Promise<number>
  /**
   * The `voicemail.*` events, by the extension of the mailbox (a message left, read, deleted), whichever screen or
   * phone did it. The Gateway tells them to the extension's holder if it is the mailbox's (owns).
   */
  subscribe(): AsyncIterable<RoutedEvent>
  close(): Promise<void>
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
  /** Withdraws the grant if no call took it yet; once taken, it stays (`taken` reads it, second review 8b, n°1). */
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

/**
 * The operator of the trunks (step 10b, ADR 0021), next to the PBX: what its own API says of the lines that carry the
 * trunks' calls, and the fallback forward it applies to them. OVHcloud's (`provider-ovh`) first. Its errors carry an
 * HTTP-like `statusCode` and a `code` (OperatorError), never a key.
 */
export interface OperatorProvider {
  /** `ovh`, the source named in the history. */
  readonly id: string
  /** The forwards set on a line now, each as it is (to a number, the voicemail...). */
  getForwards(line: string): Promise<OperatorLineForwards>
  /** Sets them to one fallback: `number` E.164; both off removes the forwards. Nothing else of the line is touched. */
  setFallback(line: string, fallback: OperatorFallback): Promise<void>
  /**
   * Sets them as given, each to a number, the voicemail or a fax (third review 10b, n°8: what was there before the
   * platform took the line, put back); absent: off. A forward elsewhere (`other`) cannot be written: refused.
   */
  setForwards(line: string, forwards: OperatorLineForwards): Promise<void>
  /**
   * The ids of the line's records of calls (CDR) dated from `from` to `to` (ISO 8601), all of them (however many
   * pages, whatever billing period they are in), each once.
   */
  listCdrIds(line: string, from: string, to: string): Promise<string[]>
  /** One of them; undefined when the operator no longer has it; `invalid` when it cannot be read as a call. */
  getCdr(line: string, id: string): Promise<OperatorCdr | undefined>
}

/**
 * How an operator's API failed, in words without keys nor addresses: `unauthorized` (the keys are refused),
 * `forbidden` (the consumer key has no right to that call), `not-found` (no such line or record), `refused` (it
 * refused the values, its words in the log), `rate` (too many requests), `unreachable` (no answer, a time out, a 5xx).
 */
export type OperatorErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'refused' | 'rate' | 'unreachable'

export class OperatorError extends Error {
  constructor(
    readonly code: OperatorErrorCode,
    message: string,
    readonly statusCode = code === 'not-found' ? 404 : 502
  ) {
    super(message)
    this.name = 'OperatorError'
  }
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
