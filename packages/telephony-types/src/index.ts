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

/**
 * How the platform authenticates to its operator: it registers with a login and a password (`register`), or the
 * operator recognises the address it sends from (`ip`; a password may still answer its challenges).
 */
export type TrunkAuth = 'register' | 'ip'
/** How numbers are written to the operator: +33612345678, 33612345678, 0033612345678 or 0612345678 (French numbers). */
export type TrunkNumberFormat = 'e164' | 'e164-no-plus' | 'international-00' | 'national'
/** The audio codecs a trunk may carry (the browser's side is always Opus or G.711 over DTLS-SRTP). */
export const TRUNK_CODECS = ['PCMA', 'PCMU', 'G722', 'opus'] as const
export type TrunkCodec = (typeof TRUNK_CODECS)[number]
/**
 * The kinds of numbers a trunk may be allowed to call. The emergency numbers are always called, premium numbers never
 * (step 6b adds rights per profile and caps); `international` only to the countries the trunk lists (`countries`).
 */
export const TRUNK_OUTBOUND_CLASSES = ['fixed', 'mobile', 'freephone', 'standard-rate', 'overseas', 'international'] as const
export type TrunkOutboundClass = (typeof TRUNK_OUTBOUND_CLASSES)[number]
/** What a trunk calls when its administrator does not say: metropolitan fixed, mobile, free and standard-rate numbers. */
export const TRUNK_OUTBOUND_DEFAULT: readonly TrunkOutboundClass[] = ['fixed', 'mobile', 'freephone', 'standard-rate']

/**
 * The short numbers of the French plan the SIP server routes to the operator or refuses itself, before any
 * extension or group (ADR 0016): the emergency numbers (15, 17, 18, 112, 114, 115, 119, 191, 196, 197, 116000,
 * 116117), the European harmonised numbers (116xxx) and the directory enquiries (118xxx). No extension, ring group or
 * target of a direct number may be one: dialled, it never rings anyone inside.
 */
export const RESERVED_NUMBER = /^(1[578]|11[2459]|19[167]|116[0-9]{3}|118[0-9]{3})$/
/** Whether `number` is a short number of the French plan that no extension or group may have (RESERVED_NUMBER). */
export const isReservedNumber = (number: string) => RESERVED_NUMBER.test(number)

/**
 * The internal plan: an extension, or the number of a ring group, is 2 to 6 digits, the first not 0. Dialled, anything
 * else would be taken for a public number by the SIP server's numbering plan (a 0 or a + first, 33 and nine digits: to
 * the operator, or refused as incomplete) or be no number at all. With RESERVED_NUMBER left out, the plan reads none of
 * these as a public number (proven against its rules in provider-opensips).
 */
export const EXTENSION_FORMAT = /^[1-9][0-9]{1,5}$/
/** Whether `number` may be an extension or a group's number: the internal plan (EXTENSION_FORMAT), not reserved. */
export const isValidExtension = (number: string) => EXTENSION_FORMAT.test(number) && !isReservedNumber(number)

/**
 * E.164 country codes no trunk may list in `countries`: France and its overseas departments and territories (their
 * own classes, `overseas`), and the codes of no country, charged as premium (satellites, international networks and
 * premium rate: never called).
 */
export const TRUNK_COUNTRY_EXCLUDED = /^(33|262|508|59[046]|68[179]|80[08]|87[08]|88[1238]|979|991)$/
/**
 * What a trunk lists in `countries`: an E.164 country code, without the + ("32", "44"), or an area of the North
 * American plan ("1876"). A country code opens the country's geographic, mobile and free numbers, never the premium,
 * shared-cost and personal ranges the SIP server knows for it (step 6a: the countries most listed). `1` opens the
 * United States and Canada only; another country of that plan (Jamaica, the Dominican Republic, Bermuda...) is listed
 * by its area.
 */
export const TRUNK_COUNTRY = /^(1|[2-9][0-9]{0,2}|1[2-9][0-9]{2})$/

/**
 * Caps on the calls to the public network (step 6b, ADR 0017), of a person (their rights profile, or the caps of those
 * without one) or of the whole organisation: calls at the same time, and answered calls or minutes per calendar day
 * and month (Europe/Paris). Each one absent: its default (OUTBOUND_CAP_DEFAULTS, none for those it does not list);
 * `null`: no cap at all, as an administrator says it. Emergency calls are outside every cap and never count.
 */
export interface OutboundCaps {
  /** Calls to the public network at the same time. */
  concurrent?: number | null
  dailyCalls?: number | null
  dailyMinutes?: number | null
  monthlyCalls?: number | null
  monthlyMinutes?: number | null
}
export const OUTBOUND_CAPS = ['concurrent', 'dailyCalls', 'dailyMinutes', 'monthlyCalls', 'monthlyMinutes'] as const

/**
 * The caps that hold before any setting (ADR 0017), so that a stolen account costs a bounded amount from the first
 * day: per person, two calls at the same time and 300 minutes a day; for the organisation, 20 calls at the same time
 * and 3000 minutes a day. A minute cap is shared between the calls in progress (each one is allotted, when it starts,
 * what is left divided by those calls plus itself, all of it when alone, and ends when that is used). Raised, or lifted (`null`), by an
 * administrator: `caps` of a profile, `userCaps` and `caps` of the policy.
 */
export const OUTBOUND_CAP_DEFAULTS: { user: OutboundCaps; tenant: OutboundCaps } = {
  user: { concurrent: 2, dailyMinutes: 300 },
  tenant: { concurrent: 20, dailyMinutes: 3000 }
}

/**
 * A rights profile (FR-H3): what its holders may call on the public network, among what the trunk calls
 * (`allowed` of the trunk; international to its countries only); none of them (`allowed` empty): internal calls only.
 * Emergency numbers are always called, whatever the profile. Set by an administrator.
 */
export interface OutboundProfile {
  /** Lower case letters, digits and dashes. */
  id: string
  name?: string
  allowed: TrunkOutboundClass[]
  caps?: OutboundCaps
}

/** The rights profile an administrator gave a person (FR-H3); one without: the organisation's default profile. */
export interface OutboundAssignment {
  userId: UserId
  profileId: string
}

/** A warning (an alert to the administrators) and a critical (the call is refused) threshold; 0 or absent: none. */
export interface FraudThreshold {
  warning?: number
  critical?: number
}
/**
 * Volume thresholds per person, as the SIP server watches them (OpenSIPS `fraud_detection`, ADR 0017): calls in the
 * last minute, attempts of the day (every call placed, refused and unanswered ones included), calls at the same time,
 * calls in a row to the same number, and the duration of a call in seconds (past its critical threshold, the call is
 * ended).
 */
export interface FraudRule {
  callsPerMinute?: FraudThreshold
  dailyAttempts?: FraudThreshold
  concurrentCalls?: FraudThreshold
  sequentialCalls?: FraudThreshold
  callSeconds?: FraudThreshold
}
export const FRAUD_PARAMS = ['callsPerMinute', 'dailyAttempts', 'concurrentCalls', 'sequentialCalls', 'callSeconds'] as const

/**
 * The thresholds when an administrator says nothing: a person dialling numbers in France faster than a person does,
 * or abroad more than a few times, raises an alert; far beyond, the calls are refused. A call lasts 4 hours at most in
 * France, 1 hour abroad and overseas. The international ones apply to the French overseas numbers too, however
 * dialled (+262..., or 0262... in the French plan).
 */
export const FRAUD_DEFAULTS: { national: FraudRule; international: FraudRule } = {
  national: { callsPerMinute: { warning: 6, critical: 20 }, dailyAttempts: { warning: 150, critical: 500 }, concurrentCalls: { warning: 3 }, sequentialCalls: { warning: 10, critical: 40 }, callSeconds: { warning: 7200, critical: 14400 } },
  international: { callsPerMinute: { warning: 3, critical: 6 }, dailyAttempts: { warning: 20, critical: 60 }, concurrentCalls: { warning: 2, critical: 4 }, sequentialCalls: { warning: 5, critical: 15 }, callSeconds: { warning: 1800, critical: 3600 } }
}

/**
 * What applies to the calls of the organisation to the public network (step 6b): the profile of those an
 * administrator gave none (none: what the trunk calls, with `userCaps`), the caps of those without a profile, the caps
 * of the organisation as a whole, and the volume thresholds of numbers in France (+33) and elsewhere (FRAUD_DEFAULTS
 * for those not given).
 */
export interface OutboundPolicy {
  defaultProfile?: string
  userCaps?: OutboundCaps
  caps?: OutboundCaps
  fraud?: { national?: FraudRule; international?: FraudRule }
}

/**
 * Something the administrators should look at, raised by the SIP server: a volume threshold crossed (`fraud-warning`,
 * the call goes on; `fraud-critical`, it is refused), a cap reached (`limit`, the call refused), a number outside the
 * caller's rights (`rights`, refused: dialling abroad from an "internal" profile is how a stolen account shows), or
 * emergency calls in a row from one extension (`emergency`, never refused). `param`: which (callsPerMinute... for a
 * threshold; concurrent, dailyCalls... for a cap, with `scope` user or tenant; the class of the number for rights).
 */
export interface TelephonyAlert {
  /**
   * `meet`: the access number of the rooms (step 8): the tries of a room's PIN by phone of all callers together
   * (`param` 'pin-tries'), or the calls to it at the same time (`param` 'meet-calls'); raised by the Gateway (review 8b,
   * n°3), a room's call whose grant another call took (`call-diverted`: ended), or LiveKit's outbound trunk found
   * pointed elsewhere than the SIP server (`trunk-changed`: written back, the call not placed). `webhook`: raised by
   * the Gateway's webhook hub (step 10a), a subscription disabled after failing for a day in a row (`param` 'disabled').
   */
  kind: 'fraud-warning' | 'fraud-critical' | 'limit' | 'rights' | 'emergency' | 'meet' | 'webhook'
  param: string
  scope?: 'user' | 'tenant'
  value?: number
  threshold?: number
  /** The extension that called, and the number it called (E.164). */
  extension?: string
  number?: string
  /** Who holds the extension, as the Gateway knows them. */
  userId?: UserId
}

/**
 * A SIP trunk: where calls to and from the public network go (step 6, ADR 0016). The password is write-only: it is
 * never returned, `hasPassword` tells whether one is kept.
 */
export interface Trunk {
  /** Lower case letters, digits and dashes. */
  id: string
  /** What administrators call it. */
  name?: string
  auth: TrunkAuth
  /** The operator's SIP domain: host of the Request-URI, the From of outbound calls, the address of record. */
  domain: string
  /** The operator's servers, `host[:port]`, tried in this order (the outbound proxy); the domain by default. */
  proxies?: string[]
  /** Other IP addresses the operator's calls may come from (its servers' own are accepted already). */
  sources?: string[]
  /** Login (authentication user name) at the operator; the user part of the address of record when it registers. */
  username?: string
  /** Digest realm of the operator, when known: the password is then kept by OpenSIPS as a hash for it. */
  realm?: string
  /** Where to register, `host[:port]` (the domain by default). */
  registrar?: string
  /** Seconds a registration lasts (60 to 3600, 600 by default). */
  registerExpires?: number
  /**
   * The codecs the operator's side may use: what the browser offers is kept to these (no transcoding: a codec the
   * browser does not offer, or one the operator does not take, leaves the call without one).
   */
  codecs: TrunkCodec[]
  numberFormat: TrunkNumberFormat
  /** Also asserts the number presented in a P-Asserted-Identity (some operators want it). */
  assertIdentity?: boolean
  /** E.164 number presented for those who have no direct number of their own. */
  defaultNumber: string
  /** The kinds of numbers it calls (TRUNK_OUTBOUND_DEFAULT when absent). */
  allowed?: TrunkOutboundClass[]
  /**
   * The countries its international numbers may be in, as E.164 country codes without the + ("32", "44", "1"), or
   * areas of the North American plan ("1876", TRUNK_COUNTRY): required with `international` in `allowed`, which calls
   * these only, never a whole world, nor their premium ranges.
   */
  countries?: string[]
  /**
   * The trunk of those who have no direct number (and of the emergency numbers they call): one per tenant. Absent on
   * every trunk: the first one written.
   */
  default?: boolean
  /**
   * The fallback (FR-C8): an extension or a ring group of the organisation that a call to one of its direct numbers
   * rings when nobody answers there, everyone is busy or nothing can be reached, unless the direct number has its own
   * (never after a decline or a "do not disturb"). A number outside is set at the operator (its forward on no answer or
   * unreachable, ADR 0017), never here.
   */
  fallbackTarget?: string
  /** Read only. */
  hasPassword?: boolean
}

/** What an administrator writes: the trunk without its id, with a password to keep (or to change, or `null` to remove). */
export type TrunkInput = Omit<Trunk, 'id' | 'hasPassword'> & { password?: string | null }

/**
 * Where a trunk's registration stands, as the SIP server says it (step 7): `registered`; `registering` (sent, or
 * answering a challenge); `unregistered`; `refused` (the operator refused the login or the password); `timeout` (the
 * registrar did not answer); `error` (it answered an error, or the SIP server could not send); `disabled`.
 */
export type TrunkRegistrationState = 'registered' | 'registering' | 'unregistered' | 'refused' | 'timeout' | 'error' | 'disabled'
/** One of a trunk's servers as the SIP server probes it: answering (`up`), not answering its probes (`probing`: no call goes there), or `disabled`. */
export type TrunkServerState = 'up' | 'probing' | 'disabled'

/** How a trunk is doing now (step 7): its registration when it registers, and each of its servers, in order. Nothing secret. */
export interface TrunkStatus {
  id: string
  registration?: { state: TrunkRegistrationState }
  servers: { address: string; state: TrunkServerState }[]
}

/**
 * Direct numbers (SDA/DID): one E.164 number or a range of them (same length, at most 10 000) and where their calls
 * go: an extension or a group (`target`), or the extension that ends with the last `suffixDigits` digits of the number
 * called. The extension a direct number reaches presents it when it calls out.
 */
export interface DidRange {
  id: string
  trunkId: string
  first: string
  /** Same as `first` for a single number. */
  last: string
  target?: string
  suffixDigits?: number
  /** Its own fallback, an extension or a ring group, in place of its trunk's (`Trunk.fallbackTarget`). */
  fallbackTarget?: string
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
  /**
   * A call that took the place of another one of this person's in a conference (step 8b, ADR 0019): the room called
   * them in it. `remoteNumber` is then whoever made the conference (themselves, for that person).
   */
  conference?: boolean
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
  /** Calls to and from the public network through SIP trunks that administrators set (`Trunk`, `DidRange`). */
  trunks?: boolean
  /**
   * Administrators set rights profiles, caps and volume thresholds for the calls to the public network
   * (`OutboundProfile`, `OutboundPolicy`), and the provider raises alerts (`alert.raised`).
   */
  outboundPolicy?: boolean
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
   * A call this person was woken for (`call.wake`), or whose ring group rang their phone (`rang`), was answered by
   * someone else, `by` (the extension of the colleague of the ring group who answered): it no longer waits for them,
   * and it is no missed call of theirs.
   */
  | { type: 'call.taken'; timestamp: string; payload: { call: Call; by: string; rang?: boolean } }
  /** `extension`: the telephony identity the presence is about, so that a directory can show it next to a contact. */
  | { type: 'presence.changed'; timestamp: string; payload: { userId: UserId; extension?: string; presence: Presence } }
  | { type: 'endpoint.connected' | 'endpoint.disconnected'; timestamp: string; payload: { userId: UserId; endpoint: Endpoint } }
  | { type: 'conference.participant.joined' | 'conference.participant.left'; timestamp: string; payload: { participant: ConferenceParticipant } }
  /** For the administrators, never the person: a volume threshold crossed or a cap reached (step 6b). */
  | { type: 'alert.raised'; timestamp: string; payload: { alert: TelephonyAlert } }

export type ProviderStatus = 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'ERROR'

/**
 * What TwakePhone publishes to the tools an administrator subscribes (step 10a, ADR 0020): one model whatever the
 * source (OpenSIPS now, OVHcloud with step 10b, Wazo later), delivered signed to webhooks. Not TelephonyEvent above,
 * what a provider tells the Gateway (per extension, internal): these are per person and public, written in
 * snake_case as the plan describes them, and carry a phone number only where the event needs one.
 */
export const WEBHOOK_EVENT_TYPES = ['call.ringing', 'call.answered', 'call.ended', 'call.missed', 'presence.changed', 'trunk.degraded', 'trunk.recovered'] as const
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]
/**
 * Kept for later, never emitted yet and never asked for by a subscription: the voicemail with Wazo (step 11), the
 * quality of the calls with the QoS lot. The model is open to them.
 */
export const WEBHOOK_EVENT_TYPES_LATER = ['voicemail.created', 'voicemail.transcribed', 'quality.alert'] as const

/**
 * How a call ended, for one of its parties. `unanswered`: placed, nobody answered (given up, no reply).
 * `answered_elsewhere`: a call of a ring group that rang this member, answered by a colleague.
 */
export type WebhookCallOutcome = 'answered' | 'missed' | 'declined' | 'failed' | 'unanswered' | 'answered_elsewhere'

/**
 * A call as one person of the organisation lived it (`user`, at `extension`): who called whom (`from`, `to`: an
 * extension or an E.164 number), and what is known of it so far.
 */
export interface WebhookCall {
  /** The call's identifier on the SIP server: the same for both parties of a call between two people. */
  id: string
  direction: CallDirection
  from: string
  to: string
  user: UserId
  extension: string
  started_at?: string
  answered_at?: string
  ended_at?: string
  /** Seconds in communication, on `call.ended` and `call.missed` (0 when never answered). */
  duration_sec?: number
  /** On `call.ended` and `call.missed`. */
  outcome?: WebhookCallOutcome
  /** A conference's call (step 8b): the room called this person. */
  conference?: true
  /** Where TwakePhone knows the call from: `opensips` now, `ovh` too once its CDRs are reconciled (step 10b). */
  source: string[]
}

/** A trunk's health as the Gateway reads it (step 10a): `down` when no call goes through it, `degraded` when one of its servers is out. */
export type TrunkHealth = 'up' | 'degraded' | 'down'

interface WebhookEventBase {
  /** Unique per event: the idempotency key a subscriber ignores a repeat by (the same at each attempt and replay). */
  id: string
  occurred_at: string
  tenant: TenantId
}

export type WebhookEvent =
  | (WebhookEventBase & { type: 'call.ringing' | 'call.answered' | 'call.ended' | 'call.missed'; call: WebhookCall })
  /** A person's telephony presence; nothing of what they wrote for their callers. */
  | (WebhookEventBase & { type: 'presence.changed'; presence: { user: UserId; extension?: string; status: PresenceStatus } })
  | (WebhookEventBase & {
      type: 'trunk.degraded'
      trunk: {
        id: string
        name?: string
        state: Exclude<TrunkHealth, 'up'>
        previous?: TrunkHealth
        registration?: TrunkRegistrationState
        servers: { address: string; state: TrunkServerState }[]
      }
    })
  /** A trunk told degraded or down is up again (seen up as many reads in a row as its degradation was). */
  | (WebhookEventBase & {
      type: 'trunk.recovered'
      trunk: {
        id: string
        name?: string
        state: 'up'
        previous: Exclude<TrunkHealth, 'up'>
        registration?: TrunkRegistrationState
        servers: { address: string; state: TrunkServerState }[]
      }
    })
  /** What an administrator sends from the administration to check a subscription. */
  | (WebhookEventBase & { type: 'webhook.test'; subscription: string })
