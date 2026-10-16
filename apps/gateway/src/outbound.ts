import { createHash } from 'node:crypto'
import {
  FRAUD_PARAMS,
  OUTBOUND_CAPS,
  TRUNK_OUTBOUND_CLASSES,
  type FraudRule,
  type FraudThreshold,
  type OutboundAssignment,
  type OutboundCaps,
  type OutboundPolicy,
  type OutboundProfile
} from '@twake/telephony-types'

// The rules of the calls to the public network (step 6b, ADR 0017), as administrators write them: the rights
// profiles (what their holders may call, among what the trunks call), who has which, the caps of each profile and of
// the organisation, the volume thresholds. Checked here, kept by the store, handed whole to the provider
// (setOutboundPolicy), which writes what its SIP server reads. Emergency calls are outside all of it.

export const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
export const MAX_PROFILES = 32
export const MAX_ASSIGNMENTS = 10_000
/** A cap: whole calls or minutes, from 1 (absent: its default, OUTBOUND_CAP_DEFAULTS; null: none). */
export const CAP_MAX = 1_000_000
/** A threshold: whole calls or seconds, from 0 (none). */
export const THRESHOLD_MAX = 1_000_000

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const CONTROL = /[\u0000-\u001f\u007f]/

/** A 400 whose `code` the app turns into the administrator's words; the message names the field. */
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400, code: 'OUTBOUND_INVALID' })

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Caps as an administrator writes them: each one a whole number, `null` for none, absent for its default. */
export const parseCaps = (v: unknown, field: string): OutboundCaps | undefined => {
  if (v === undefined || v === null) return undefined
  if (!isObject(v)) throw invalid(`${field}: an object of ${OUTBOUND_CAPS.join(', ')}`)
  const caps: OutboundCaps = {}
  for (const [k, n] of Object.entries(v)) {
    if (!(OUTBOUND_CAPS as readonly string[]).includes(k)) throw invalid(`${field}.${k}: not a cap (${OUTBOUND_CAPS.join(', ')})`)
    if (n === undefined) continue
    if (n !== null && (!Number.isInteger(n) || (n as number) < 1 || (n as number) > CAP_MAX)) throw invalid(`${field}.${k}: a whole number from 1 to ${CAP_MAX}, or null for no cap (absent: its default)`)
    caps[k as keyof OutboundCaps] = n as number | null
  }
  return Object.keys(caps).length ? caps : undefined
}

const parseThreshold = (v: unknown, field: string): FraudThreshold => {
  if (!isObject(v)) throw invalid(`${field}: { warning, critical }`)
  const t: FraudThreshold = {}
  for (const level of ['warning', 'critical'] as const) {
    const n = v[level]
    if (n === undefined || n === null) continue
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > THRESHOLD_MAX) throw invalid(`${field}.${level}: a whole number from 0 (none) to ${THRESHOLD_MAX}`)
    t[level] = n as number
  }
  for (const k of Object.keys(v)) if (k !== 'warning' && k !== 'critical') throw invalid(`${field}.${k}: warning or critical`)
  if (t.warning && t.critical && t.warning > t.critical) throw invalid(`${field}: the warning comes before the critical threshold`)
  return t
}

const parseFraudRule = (v: unknown, field: string): FraudRule | undefined => {
  if (v === undefined || v === null) return undefined
  if (!isObject(v)) throw invalid(`${field}: an object of ${FRAUD_PARAMS.join(', ')}`)
  const rule: FraudRule = {}
  for (const [k, t] of Object.entries(v)) {
    if (!(FRAUD_PARAMS as readonly string[]).includes(k)) throw invalid(`${field}.${k}: not a threshold (${FRAUD_PARAMS.join(', ')})`)
    rule[k as keyof FraudRule] = parseThreshold(t, `${field}.${k}`)
  }
  return Object.keys(rule).length ? rule : undefined
}

export const parseProfile = (id: string, v: unknown): OutboundProfile => {
  if (!PROFILE_ID.test(id)) throw invalid('id: lower case letters, digits and dashes, 32 at most')
  if (!isObject(v)) throw invalid(`profile ${id}: a JSON object`)
  const name = v.name
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.trim().length > 64 || CONTROL.test(name))) throw invalid(`profile ${id}: name, 64 characters at most, on one line`)
  const a = v.allowed
  if (!Array.isArray(a) || !a.every(c => (TRUNK_OUTBOUND_CLASSES as readonly string[]).includes(c as string)) || new Set(a).size !== a.length)
    throw invalid(`profile ${id}: allowed, some of ${TRUNK_OUTBOUND_CLASSES.join(', ')}, each once (none: internal calls only)`)
  const caps = parseCaps(v.caps, `profile ${id}: caps`)
  return {
    id,
    ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    allowed: TRUNK_OUTBOUND_CLASSES.filter(c => (a as string[]).includes(c)),
    ...(caps ? { caps } : {})
  }
}

export interface Outbound {
  policy: OutboundPolicy
  profiles: OutboundProfile[]
  assignments: OutboundAssignment[]
}

/**
 * The whole outbound setting as an administrator writes it (PUT /admin/outbound): `profiles`, `policy` (default
 * profile, organisation caps, thresholds) and `assignments`, checked together: every profile named exists.
 */
export const parseOutbound = (body: unknown): Outbound => {
  if (!isObject(body)) throw invalid('a JSON object of policy, profiles and assignments')
  const rawProfiles = body.profiles ?? []
  if (!Array.isArray(rawProfiles)) throw invalid('profiles: a list')
  if (rawProfiles.length > MAX_PROFILES) throw Object.assign(new Error(`profiles: at most ${MAX_PROFILES}`), { statusCode: 400, code: 'PROFILE_LIMIT' })
  const profiles = rawProfiles.map(p => parseProfile(isObject(p) && typeof p.id === 'string' ? p.id : '', p))
  const ids = new Set(profiles.map(p => p.id))
  if (ids.size !== profiles.length) throw invalid('profiles: each id once')
  const p = body.policy ?? {}
  if (!isObject(p)) throw invalid('policy: a JSON object')
  const defaultProfile = p.defaultProfile
  if (defaultProfile !== undefined && defaultProfile !== null && (typeof defaultProfile !== 'string' || !ids.has(defaultProfile))) throw invalid('policy.defaultProfile: one of the profiles')
  const caps = parseCaps(p.caps, 'policy.caps')
  const userCaps = parseCaps(p.userCaps, 'policy.userCaps')
  const f = p.fraud
  if (f !== undefined && f !== null && !isObject(f)) throw invalid('policy.fraud: { national, international }')
  const national = parseFraudRule(f?.national, 'policy.fraud.national')
  const international = parseFraudRule(f?.international, 'policy.fraud.international')
  const policy: OutboundPolicy = {
    ...(typeof defaultProfile === 'string' ? { defaultProfile } : {}),
    ...(userCaps ? { userCaps } : {}),
    ...(caps ? { caps } : {}),
    ...(national || international ? { fraud: { ...(national ? { national } : {}), ...(international ? { international } : {}) } } : {})
  }
  const rawAssignments = body.assignments ?? []
  if (!Array.isArray(rawAssignments) || rawAssignments.length > MAX_ASSIGNMENTS) throw invalid(`assignments: at most ${MAX_ASSIGNMENTS}`)
  const seen = new Set<string>()
  const assignments = rawAssignments.map((a, i): OutboundAssignment => {
    if (!isObject(a) || typeof a.userId !== 'string' || !a.userId || a.userId.length > 255 || CONTROL.test(a.userId) || /\s/.test(a.userId)) throw invalid(`assignments[${i}].userId: a user id`)
    if (typeof a.profileId !== 'string' || !ids.has(a.profileId)) throw invalid(`assignments[${i}].profileId: one of the profiles`)
    if (seen.has(a.userId)) throw invalid(`assignments: ${a.userId} once`)
    seen.add(a.userId)
    return { userId: a.userId, profileId: a.profileId }
  })
  return { policy, profiles, assignments }
}

/** JSON with the keys of every object in order: the same setting reads the same, however it was stored (jsonb). */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : isObject(v) ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v)

/**
 * What an administrator read (step 7): a digest of the whole setting. A change sent with the version read is refused
 * when the setting changed since (409 OUTBOUND_STALE): a screen opened earlier never undoes what another administrator
 * did meanwhile (a right withdrawn from a compromised account, a cap lowered).
 */
/** The refusal of a change made to a setting that is no longer the one read. */
export const staleOutbound = () => Object.assign(new Error('The outbound rules changed since they were read: read them again'), { statusCode: 409, code: 'OUTBOUND_STALE' })

export const outboundVersion = (o: Outbound): string => createHash('sha256').update(canonical({ policy: o.policy, profiles: o.profiles, assignments: o.assignments })).digest('base64url').slice(0, 22)

/** Nothing set: no profile (what the trunks call), the default caps and thresholds. */
export const EMPTY_OUTBOUND: Outbound = { policy: {}, profiles: [], assignments: [] }
