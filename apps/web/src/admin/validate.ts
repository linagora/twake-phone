import {
  EXTENSION_FORMAT,
  FRAUD_PARAMS,
  OUTBOUND_CAPS,
  RESERVED_NUMBER,
  TRUNK_COUNTRY,
  TRUNK_COUNTRY_EXCLUDED,
  TRUNK_OUTBOUND_CLASSES,
  TRUNK_OUTBOUND_DEFAULT,
  type DidRange,
  type FraudRule,
  type FraudThreshold,
  type OutboundCaps,
  type OutboundProfile,
  type Trunk,
  type TrunkAuth,
  type TrunkCodec,
  type TrunkInput,
  type TrunkNumberFormat,
  type TrunkOutboundClass
} from '@twake/telephony-client'
import type { Key } from '../i18n/index.js'

// The administration forms (step 7) check what the Gateway checks (apps/gateway/src/trunks.ts and outbound.ts), with
// the same rules, before anything is sent: an administrator reads what is wrong next to the field, in their language.
// The Gateway checks everything again; its refusals are put into the same words (refusalOf).

/** What is wrong with a field: the words, and what they name. */
export interface Problem {
  key: Key
  params?: Record<string, string | number>
}
export type Problems<F extends string> = Partial<Record<F, Problem>>

const p = (key: Key, params?: Record<string, string | number>): Problem => (params ? { key, params } : { key })

export const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/
// No French number has a 0 after +33: « +33 (0)1 … » of the business cards, kept whole, is a wrong one (as the Gateway).
const E164 = /^\+(?!330)[1-9][0-9]{6,14}$/
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const CONTROL = /[\u0000-\u001f\u007f]/
/** Numbers in one range at most, as the Gateway (MAX_RANGE). */
export const MAX_RANGE = 10_000
/** A cap or a threshold at most (CAP_MAX, THRESHOLD_MAX). */
export const LIMIT_MAX = 1_000_000

const hostPort = (value: string) => {
  const m = /^([^:]+)(:(\d{1,5}))?$/.exec(value)
  if (!m) return false
  if (m[3] !== undefined && !(Number(m[3]) >= 1 && Number(m[3]) <= 65535)) return false
  return HOST.test(m[1]!) || IPV4.test(m[1]!)
}

/** The items of a list typed with commas, spaces or new lines, in order. */
export const splitList = (text: string) => text.split(/[\s,;]+/).filter(Boolean)

/**
 * A number as an administrator may type it (`01 99 00 01 00`, `+33 1 99…`, `0033…`, `+33 (0)1 99…`), in E.164 when it
 * reads as one; otherwise what was typed, without its spaces (the check says what is wrong). The « (0) » after a
 * country code is the trunk prefix of the national form: never dialled from abroad, so left out.
 */
export const normaliseNumber = (text: string): string => {
  const international = /^\s*(\+|00)/.test(text)
  const compact = (international ? text.replace(/\(\s*0\s*\)/g, '') : text).replace(/[\s.()-]/g, '')
  if (/^00[1-9]/.test(compact)) return `+${compact.slice(2)}`
  if (/^0[1-9][0-9]{8}$/.test(compact)) return `+33${compact.slice(1)}`
  return compact
}

const wholeNumber = (text: string, min: number, max: number) => /^[0-9]{1,7}$/.test(text.trim()) && Number(text) >= min && Number(text) <= max

/** An extension or a ring group's number: the internal plan, never a short number of the French plan. */
const internalTarget = (v: string) => EXTENSION_FORMAT.test(v) && !RESERVED_NUMBER.test(v)

// ---------------------------------------------------------------------------------------------------------------
// Trunks

export interface TrunkForm {
  id: string
  name: string
  auth: TrunkAuth
  domain: string
  proxies: string
  sources: string
  username: string
  password: string
  removePassword: boolean
  realm: string
  registrar: string
  registerExpires: string
  codecs: TrunkCodec[]
  numberFormat: TrunkNumberFormat
  assertIdentity: boolean
  allowed: TrunkOutboundClass[]
  countries: string
  isDefault: boolean
  defaultNumber: string
  fallbackTarget: string
}
export type TrunkField = Exclude<keyof TrunkForm, 'removePassword' | 'isDefault' | 'assertIdentity' | 'numberFormat' | 'auth'> | 'form'
/** The fields in the order of the form: the first one in error gets the focus. */
export const TRUNK_FIELDS: TrunkField[] = ['id', 'name', 'domain', 'proxies', 'sources', 'username', 'password', 'realm', 'registrar', 'registerExpires', 'codecs', 'defaultNumber', 'allowed', 'countries', 'fallbackTarget']

export const emptyTrunk = (): TrunkForm => ({
  id: '',
  name: '',
  auth: 'register',
  domain: '',
  proxies: '',
  sources: '',
  username: '',
  password: '',
  removePassword: false,
  realm: '',
  registrar: '',
  registerExpires: '',
  codecs: ['PCMA', 'PCMU'],
  numberFormat: 'e164',
  assertIdentity: false,
  allowed: [...TRUNK_OUTBOUND_DEFAULT],
  countries: '',
  isDefault: false,
  defaultNumber: '',
  fallbackTarget: ''
})

/** A trunk the Gateway listed, in the form (never a password: the field stays empty, `hasPassword` says one is kept). */
export const trunkForm = (t: Trunk): TrunkForm => ({
  id: t.id,
  name: t.name ?? '',
  auth: t.auth,
  domain: t.domain,
  proxies: (t.proxies ?? []).join(', '),
  sources: (t.sources ?? []).join(', '),
  username: t.username ?? '',
  password: '',
  removePassword: false,
  realm: t.realm ?? '',
  registrar: t.registrar ?? '',
  registerExpires: t.registerExpires ? String(t.registerExpires) : '',
  codecs: [...t.codecs],
  numberFormat: t.numberFormat,
  assertIdentity: !!t.assertIdentity,
  allowed: [...(t.allowed ?? TRUNK_OUTBOUND_DEFAULT)],
  countries: (t.countries ?? []).join(', '),
  isDefault: !!t.default,
  defaultNumber: t.defaultNumber,
  fallbackTarget: t.fallbackTarget ?? ''
})

const listOf = (text: string, max: number, check: (v: string) => boolean, problem: Problem): { items?: string[]; problem?: Problem } => {
  const items = splitList(text)
  if (items.length > max || !items.every(check) || new Set(items).size !== items.length) return { problem }
  return items.length ? { items } : {}
}

/**
 * The trunk as the Gateway takes it (PUT /admin/trunks/:id), or what is wrong. `current`: the trunk being changed (its
 * password is kept unless a new one is typed or its removal asked); `ids`: those of the other trunks.
 */
export const checkTrunk = (f: TrunkForm, ctx: { current?: Trunk; ids: readonly string[] }): { input?: TrunkInput; problems: Problems<TrunkField> } => {
  const problems: Problems<TrunkField> = {}
  const id = f.id.trim()
  if (!SLUG.test(id)) problems.id = p('admin.trunk.err.id')
  else if (!ctx.current && ctx.ids.includes(id)) problems.id = p('admin.trunk.err.idTaken')
  const name = f.name.trim()
  if (name.length > 64 || CONTROL.test(name)) problems.name = p('admin.trunk.err.name')
  const domain = f.domain.trim()
  if (!(HOST.test(domain) || IPV4.test(domain))) problems.domain = p('admin.trunk.err.domain')
  const proxies = listOf(f.proxies, 4, hostPort, p('admin.trunk.err.proxies'))
  if (proxies.problem) problems.proxies = proxies.problem
  const sources = listOf(f.sources, 16, v => IPV4.test(v), p('admin.trunk.err.sources'))
  if (sources.problem) problems.sources = sources.problem
  const username = f.username.trim()
  if (username && !SIP_USER.test(username)) problems.username = p('admin.trunk.err.username')
  const realm = f.realm.trim()
  if (realm && (realm.length > 128 || CONTROL.test(realm) || /["\\]/.test(realm))) problems.realm = p('admin.trunk.err.realm')
  const registrar = f.registrar.trim()
  if (registrar && !hostPort(registrar)) problems.registrar = p('admin.trunk.err.registrar')
  const expires = f.registerExpires.trim()
  if (expires && !wholeNumber(expires, 60, 3600)) problems.registerExpires = p('admin.trunk.err.registerExpires')
  if (!f.codecs.length) problems.codecs = p('admin.trunk.err.codecs')
  // A new password, none (removed), or the one kept. Removal asked wins over what the field (then disabled) still holds.
  const typed = f.removePassword ? '' : f.password
  if (typed && (typed.length > 64 || CONTROL.test(typed))) problems.password = p('admin.trunk.err.password')
  const willHavePassword = typed ? true : f.removePassword ? false : !!ctx.current?.hasPassword
  if (f.auth === 'register' && !username) problems.username ??= p('admin.trunk.err.registerNeeds')
  if (f.auth === 'register' && !willHavePassword) problems.password ??= p('admin.trunk.err.registerNeeds')
  if (!f.allowed.length) problems.allowed = p('admin.trunk.err.allowed')
  const international = f.allowed.includes('international')
  const countries = listOf(f.countries, 64, v => TRUNK_COUNTRY.test(v) && !TRUNK_COUNTRY_EXCLUDED.test(v), p('admin.trunk.err.countries'))
  if (countries.problem) problems.countries = countries.problem
  else if (countries.items?.some(c => c !== '1' && countries.items!.some(o => o !== c && o.startsWith(c)))) problems.countries = p('admin.trunk.err.countriesPrefix')
  else if (international && !countries.items) problems.countries = p('admin.trunk.err.countriesRequired')
  else if (!international && countries.items) problems.countries = p('admin.trunk.err.countriesWithout')
  const defaultNumber = normaliseNumber(f.defaultNumber)
  if (!E164.test(defaultNumber)) problems.defaultNumber = p('admin.trunk.err.defaultNumber')
  const fallbackTarget = f.fallbackTarget.trim()
  if (fallbackTarget && !internalTarget(fallbackTarget)) problems.fallbackTarget = p('admin.trunk.err.fallbackTarget')
  if (Object.keys(problems).length) return { problems }
  return {
    problems,
    input: {
      ...(name ? { name } : {}),
      auth: f.auth,
      domain,
      ...(proxies.items ? { proxies: proxies.items } : {}),
      ...(sources.items ? { sources: sources.items } : {}),
      ...(username ? { username } : {}),
      ...(realm ? { realm } : {}),
      ...(registrar ? { registrar } : {}),
      ...(expires ? { registerExpires: Number(expires) } : {}),
      codecs: f.codecs,
      numberFormat: f.numberFormat,
      ...(f.assertIdentity ? { assertIdentity: true } : {}),
      allowed: TRUNK_OUTBOUND_CLASSES.filter(c => f.allowed.includes(c)),
      ...(countries.items ? { countries: countries.items } : {}),
      // Unchecked says nothing: the default trunk stays so until another one is made the default (the Gateway's rule).
      ...(f.isDefault ? { default: true } : {}),
      defaultNumber,
      ...(fallbackTarget ? { fallbackTarget } : {}),
      ...(typed ? { password: typed } : f.removePassword && ctx.current?.hasPassword ? { password: null } : {})
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Direct numbers

export interface DidForm {
  id: string
  trunkId: string
  first: string
  last: string
  mode: 'target' | 'suffix'
  target: string
  suffixDigits: string
  fallbackTarget: string
}
export type DidField = Exclude<keyof DidForm, 'mode'> | 'form'
export const DID_FIELDS: DidField[] = ['id', 'trunkId', 'first', 'last', 'target', 'suffixDigits', 'fallbackTarget']

export const emptyDid = (trunkId = ''): DidForm => ({ id: '', trunkId, first: '', last: '', mode: 'target', target: '', suffixDigits: '3', fallbackTarget: '' })
export const didForm = (d: DidRange): DidForm => ({
  id: d.id,
  trunkId: d.trunkId,
  first: d.first,
  last: d.last === d.first ? '' : d.last,
  mode: d.suffixDigits ? 'suffix' : 'target',
  target: d.target ?? '',
  suffixDigits: String(d.suffixDigits ?? 3),
  fallbackTarget: d.fallbackTarget ?? ''
})

/** The short numbers of the French plan the last `digits` digits of the numbers first to last make (as the Gateway). */
export const reservedSuffixes = (first: string, last: string, digits: number): string[] => {
  const found = new Set<string>()
  const to = BigInt(last.slice(1))
  for (let n = BigInt(first.slice(1)); n <= to; n++) {
    const suffix = n.toString().slice(-digits)
    if (RESERVED_NUMBER.test(suffix)) found.add(suffix)
  }
  return [...found]
}

/** The range as the Gateway takes it (PUT /admin/dids/:id), or what is wrong. `others`: the ranges of the tenant. */
export const checkDid = (f: DidForm, ctx: { isNew: boolean; trunks: readonly Pick<Trunk, 'id'>[]; others: readonly DidRange[] }): { range?: DidRange; problems: Problems<DidField> } => {
  const problems: Problems<DidField> = {}
  const id = f.id.trim()
  if (!SLUG.test(id)) problems.id = p('admin.did.err.id')
  else if (ctx.isNew && ctx.others.some(o => o.id === id)) problems.id = p('admin.did.err.idTaken')
  if (!ctx.trunks.some(t => t.id === f.trunkId)) problems.trunkId = p('admin.did.err.trunkId')
  const first = normaliseNumber(f.first)
  if (!E164.test(first)) problems.first = p('admin.did.err.number')
  const last = f.last.trim() ? normaliseNumber(f.last) : first
  if (f.last.trim() && !E164.test(last)) problems.last = p('admin.did.err.number')
  else if (!problems.first && (last.length !== first.length || last < first)) problems.last = p('admin.did.err.lastOrder')
  else if (!problems.first && Number(last.slice(1)) - Number(first.slice(1)) + 1 > MAX_RANGE) problems.last = p('admin.did.err.lastSize', { max: MAX_RANGE })
  const target = f.mode === 'target' ? f.target.trim() : ''
  let suffixDigits: number | undefined
  if (f.mode === 'target') {
    if (!EXTENSION_FORMAT.test(target)) problems.target = p('admin.did.err.target')
    else if (RESERVED_NUMBER.test(target)) problems.target = p('admin.did.err.targetReserved', { target })
  } else {
    if (!wholeNumber(f.suffixDigits, 2, 6)) problems.suffixDigits = p('admin.did.err.suffixDigits')
    else {
      suffixDigits = Number(f.suffixDigits)
      if (!problems.first && !problems.last) {
        const reserved = reservedSuffixes(first, last, suffixDigits)
        if (reserved.length) problems.suffixDigits = p('admin.did.err.suffixReserved', { digits: suffixDigits, numbers: reserved.join(', ') })
      }
    }
  }
  if (!problems.first && !problems.last) {
    const clash = ctx.others.find(o => o.id !== id && o.first.length === first.length && o.first <= last && first <= o.last)
    if (clash) problems.first = p('admin.did.err.overlap', { range: clash.first === clash.last ? clash.first : `${clash.first} – ${clash.last}`, id: clash.id })
  }
  const fallbackTarget = f.fallbackTarget.trim()
  if (fallbackTarget && !internalTarget(fallbackTarget)) problems.fallbackTarget = p('admin.did.err.fallbackTarget')
  else if (fallbackTarget && fallbackTarget === target) problems.fallbackTarget = p('admin.did.err.fallbackLoop')
  if (Object.keys(problems).length) return { problems }
  return { problems, range: { id, trunkId: f.trunkId, first, last, ...(target ? { target } : {}), ...(suffixDigits ? { suffixDigits } : {}), ...(fallbackTarget ? { fallbackTarget } : {}) } }
}

// ---------------------------------------------------------------------------------------------------------------
// Caps and thresholds

export type CapKey = (typeof OUTBOUND_CAPS)[number]
/** One cap in a form: its default, none, or a value. */
export interface CapForm {
  mode: 'default' | 'none' | 'value'
  value: string
}
export type CapsForm = Record<CapKey, CapForm>

export const capsForm = (caps: OutboundCaps | undefined): CapsForm =>
  Object.fromEntries(OUTBOUND_CAPS.map(k => [k, caps?.[k] === undefined ? { mode: 'default', value: '' } : caps[k] === null ? { mode: 'none', value: '' } : { mode: 'value', value: String(caps[k]) }])) as CapsForm

/** The caps as the Gateway takes them (absent: its default; null: none), or what is wrong with each. */
export const checkCaps = (f: CapsForm): { caps?: OutboundCaps; problems: Partial<Record<CapKey, Problem>> } => {
  const problems: Partial<Record<CapKey, Problem>> = {}
  const caps: OutboundCaps = {}
  for (const k of OUTBOUND_CAPS) {
    const c = f[k]
    if (c.mode === 'none') caps[k] = null
    else if (c.mode === 'value') {
      if (!wholeNumber(c.value, 1, LIMIT_MAX)) problems[k] = p('admin.limits.err.cap', { max: LIMIT_MAX })
      else caps[k] = Number(c.value)
    }
  }
  if (Object.keys(problems).length) return { problems }
  return Object.keys(caps).length ? { problems, caps } : { problems }
}

export type FraudParam = (typeof FRAUD_PARAMS)[number]
/** One threshold in a form: its default, or set (an empty level: none). */
export interface ThresholdForm {
  mode: 'default' | 'custom'
  warning: string
  critical: string
}
export type FraudForm = Record<FraudParam, ThresholdForm>

export const fraudForm = (rule: FraudRule | undefined): FraudForm =>
  Object.fromEntries(
    FRAUD_PARAMS.map(k => {
      const t = rule?.[k]
      return [k, t ? { mode: 'custom', warning: t.warning ? String(t.warning) : '', critical: t.critical ? String(t.critical) : '' } : { mode: 'default', warning: '', critical: '' }]
    })
  ) as FraudForm

export const checkFraud = (f: FraudForm): { rule?: FraudRule; problems: Partial<Record<FraudParam, Problem>> } => {
  const problems: Partial<Record<FraudParam, Problem>> = {}
  const rule: FraudRule = {}
  for (const k of FRAUD_PARAMS) {
    const t = f[k]
    if (t.mode === 'default') continue
    const levels: FraudThreshold = {}
    let bad = false
    for (const level of ['warning', 'critical'] as const) {
      const v = t[level].trim()
      if (!v) continue
      if (!wholeNumber(v, 0, LIMIT_MAX)) bad = true
      else if (Number(v) > 0) levels[level] = Number(v)
    }
    if (bad) problems[k] = p('admin.limits.err.threshold', { max: LIMIT_MAX })
    else if (levels.warning && levels.critical && levels.warning > levels.critical) problems[k] = p('admin.limits.err.thresholdOrder')
    else rule[k] = levels
  }
  if (Object.keys(problems).length) return { problems }
  return Object.keys(rule).length ? { problems, rule } : { problems }
}

// ---------------------------------------------------------------------------------------------------------------
// Rights profiles

export interface ProfileForm {
  id: string
  name: string
  allowed: TrunkOutboundClass[]
  caps: CapsForm
}
export type ProfileField = 'id' | 'name' | 'allowed' | CapKey | 'form'
export const PROFILE_FIELDS: ProfileField[] = ['id', 'name', 'allowed', ...OUTBOUND_CAPS]

export const emptyProfile = (): ProfileForm => ({ id: '', name: '', allowed: [], caps: capsForm(undefined) })
export const profileForm = (pr: OutboundProfile): ProfileForm => ({ id: pr.id, name: pr.name ?? '', allowed: [...pr.allowed], caps: capsForm(pr.caps) })

/** Rights profiles of an organisation at most (MAX_PROFILES of the Gateway). */
export const MAX_PROFILES = 32

export const checkProfile = (f: ProfileForm, ctx: { isNew: boolean; ids: readonly string[] }): { profile?: OutboundProfile; problems: Problems<ProfileField> } => {
  const problems: Problems<ProfileField> = {}
  if (ctx.isNew && ctx.ids.length >= MAX_PROFILES) problems.form = p('admin.err.profileLimit', { max: MAX_PROFILES })
  const id = f.id.trim()
  if (!SLUG.test(id)) problems.id = p('admin.rights.err.id')
  else if (ctx.isNew && ctx.ids.includes(id)) problems.id = p('admin.rights.err.idTaken')
  const name = f.name.trim()
  if (name.length > 64 || CONTROL.test(name)) problems.name = p('admin.rights.err.name')
  const caps = checkCaps(f.caps)
  Object.assign(problems, caps.problems)
  if (Object.keys(problems).length) return { problems }
  return { problems, profile: { id, ...(name ? { name } : {}), allowed: TRUNK_OUTBOUND_CLASSES.filter(c => f.allowed.includes(c)), ...(caps.caps ? { caps: caps.caps } : {}) } }
}

// ---------------------------------------------------------------------------------------------------------------
// The Gateway's refusals

/** What the Gateway said when it refused (TelephonyClient's error: `status`, `code`, `detail`). */
const refusalParts = (err: unknown) => {
  const e = err as { status?: unknown; code?: unknown; detail?: unknown } | null
  return { status: typeof e?.status === 'number' ? e.status : undefined, code: typeof e?.code === 'string' ? e.code : undefined, detail: typeof e?.detail === 'string' ? e.detail : '' }
}

/** The field a refusal of the Gateway names first (`domain: …`, `policy.caps.concurrent: …`, `profile x: caps.daily…`). */
export const refusedField = (detail: string): string | undefined => /^(?:profile [a-z0-9-]+: )?([A-Za-z]+(?:\.[A-Za-z]+)*)(?:\[\d+\])?(?:\.[A-Za-z]+)*:/.exec(detail)?.[1] ?? /^(profile [a-z0-9-]+): /.exec(detail)?.[1]

/** The words for a refusal of the Gateway that names no field of the form, or no field at all. */
const GENERAL: Record<string, Key> = {
  TRUNK_DEFAULT: 'admin.err.trunkDefault',
  TRUNK_OTHER_TENANT: 'admin.err.trunkOtherTenant',
  TRUNK_RELOAD_FAILED: 'admin.err.reloadFailed',
  OUTBOUND_RELOAD_FAILED: 'admin.err.reloadFailed',
  TRUNK_LIMIT: 'admin.err.trunkLimit',
  DID_LIMIT: 'admin.err.didLimit',
  PROFILE_LIMIT: 'admin.err.profileLimit',
  OUTBOUND_STALE: 'admin.err.stale',
  ALERT_CHANGED: 'admin.alert.changed'
}

/** The words of GENERAL that name a number. */
const GENERAL_PARAMS: Record<string, Record<string, number>> = { PROFILE_LIMIT: { max: MAX_PROFILES } }

/** The code of a refusal of the Gateway (`OUTBOUND_STALE`, `ALERT_CHANGED`…), or its status (404) when it has none. */
export const refusalCode = (err: unknown) => refusalParts(err).code
export const refusalStatus = (err: unknown) => refusalParts(err).status

/**
 * A refusal of the Gateway in the administrator's words: on the field it names when the form has it (`fields`: the
 * Gateway's field, dotted, to the form's field and its words), else for the whole form.
 */
export const refusalOf = <F extends string>(err: unknown, fields: (gatewayField: string, code: string | undefined, detail: string) => { field: F; problem: Problem } | undefined): { field: F | 'form'; problem: Problem } => {
  const { status, code, detail } = refusalParts(err)
  if (code && GENERAL[code]) return { field: 'form', problem: p(GENERAL[code], GENERAL_PARAMS[code]) }
  if (status === 400 || status === 409) {
    const named = refusedField(detail)
    const found = fields(named ?? '', code, detail)
    if (found) return found
  }
  if (status === 403) return { field: 'form', problem: p('admin.err.forbidden') }
  if (status === 404 || status === 501) return { field: 'form', problem: p('admin.err.unavailable') }
  if (status === 503 && code === 'SYNC_RUNNING') return { field: 'form', problem: p('admin.groupSyncRunning') }
  if (status === 400 || status === 409) return { field: 'form', problem: p('admin.err.refused') }
  return { field: 'form', problem: p('admin.err.failed') }
}

/** The refusals of PUT /admin/trunks/:id, on the trunk form. */
export const trunkRefusal = (err: unknown) =>
  refusalOf<TrunkField>(err, (field, code, detail) => {
    if (code === 'FALLBACK_TARGET') return { field: 'fallbackTarget', problem: p('admin.err.targetUnknown') }
    if (field === 'countries') return { field: 'countries', problem: p('admin.trunk.err.countries') }
    if ((TRUNK_FIELDS as string[]).includes(field)) return { field: field as TrunkField, problem: p(`admin.trunk.err.${field}` as Key) }
    if (code === 'TRUNK_INVALID' && /^a trunk that registers/.test(detail)) return { field: 'password', problem: p('admin.trunk.err.registerNeeds') }
    return undefined
  })

/** The refusals of PUT /admin/outbound when a profile is saved, on the profile form. */
export const profileRefusal = (err: unknown) =>
  refusalOf<ProfileField>(err, (field, _code, detail) => {
    const cap = /^caps\.([A-Za-z]+)$/.exec(field)?.[1]
    if (cap && (OUTBOUND_CAPS as readonly string[]).includes(cap)) return { field: cap as CapKey, problem: p('admin.limits.err.cap', { max: LIMIT_MAX }) }
    if (field === 'id') return { field: 'id', problem: p('admin.rights.err.id') }
    if (/^profile [a-z0-9-]+: name/.test(detail)) return { field: 'name', problem: p('admin.rights.err.name') }
    return undefined
  })

/** A field of the caps and thresholds form: `tenant-<cap>`, `user-<cap>`, `national-<param>`, `international-<param>`. */
export type LimitsField = `${'tenant' | 'user'}-${CapKey}` | `${'national' | 'international'}-${FraudParam}` | 'form'
export const LIMITS_FIELDS: LimitsField[] = [...OUTBOUND_CAPS.map(k => `tenant-${k}` as const), ...OUTBOUND_CAPS.map(k => `user-${k}` as const), ...FRAUD_PARAMS.map(k => `national-${k}` as const), ...FRAUD_PARAMS.map(k => `international-${k}` as const)]

/** The refusals of PUT /admin/outbound when the caps and thresholds are saved. */
export const limitsRefusal = (err: unknown) =>
  refusalOf<LimitsField>(err, (field, _code, detail) => {
    const cap = /^policy\.(caps|userCaps)\.([A-Za-z]+)$/.exec(field)
    if (cap && (OUTBOUND_CAPS as readonly string[]).includes(cap[2]!)) return { field: `${cap[1] === 'caps' ? 'tenant' : 'user'}-${cap[2] as CapKey}`, problem: p('admin.limits.err.cap', { max: LIMIT_MAX }) }
    const fraud = /^policy\.fraud\.(national|international)\.([A-Za-z]+)(\.[a-z]+)?$/.exec(field)
    if (fraud && (FRAUD_PARAMS as readonly string[]).includes(fraud[2]!))
      return { field: `${fraud[1] as 'national' | 'international'}-${fraud[2] as FraudParam}`, problem: /comes before/.test(detail) ? p('admin.limits.err.thresholdOrder') : p('admin.limits.err.threshold', { max: LIMIT_MAX }) }
    return undefined
  })

/** The refusals of PUT /admin/dids/:id, on the range form. */
export const didRefusal = (err: unknown) =>
  refusalOf<DidField>(err, (field, code, detail) => {
    if (code === 'DID_OVERLAP') return { field: 'first', problem: p('admin.did.err.overlapServer', { detail: /^(\+[0-9]+(?: to \+[0-9]+)?) \(([a-z0-9-]+)\)/.exec(detail)?.slice(1).join(' : ') ?? '' }) }
    if (code === 'FALLBACK_LOOP') return { field: 'fallbackTarget', problem: p('admin.did.err.fallbackLoop') }
    if (code === 'DID_TARGET') return { field: 'target', problem: p('admin.err.targetUnknown') }
    if (code === 'FALLBACK_TARGET') return { field: 'fallbackTarget', problem: p('admin.err.targetUnknown') }
    if (code === 'DID_RESERVED') return field === 'suffixDigits' ? { field: 'suffixDigits', problem: p('admin.did.err.suffixReservedServer') } : { field: 'target', problem: p('admin.did.err.targetReserved', { target: /^target: ([0-9]+) /.exec(detail)?.[1] ?? '' }) }
    if (field === 'first' || field === 'last') return { field, problem: p(field === 'last' ? 'admin.did.err.lastOrder' : 'admin.did.err.number') }
    if ((DID_FIELDS as string[]).includes(field)) return { field: field as DidField, problem: p(`admin.did.err.${field}` as Key) }
    return undefined
  })

// ---------------------------------------------------------------------------------------------------------------
// Ring groups

export interface GroupForm {
  number: string
  name: string
  members: string
}
export type GroupField = keyof GroupForm | 'form'
export const GROUP_FIELDS: GroupField[] = ['number', 'name', 'members']
/** Members of a group at most (GROUP_MEMBERS_MAX of the Gateway: the branches of a call of the SIP server). */
export const GROUP_MEMBERS_MAX = 12

export const emptyGroup = (): GroupForm => ({ number: '', name: '', members: '' })

/** The members an administrator typed (`101, 102 103`): extensions in their order, each once. */
export const parseMembers = (text: string): string[] => [...new Set(splitList(text))]

/**
 * The group as the Gateway takes it (POST /admin/groups, PUT /admin/groups/:number), or what is wrong (the Gateway
 * checks the same, and whether the number is free and the members are extensions of the organisation).
 */
export const checkGroup = (f: GroupForm): { group?: { number: string; name: string; members: string[] }; problems: Problems<GroupField> } => {
  const problems: Problems<GroupField> = {}
  const number = f.number.trim()
  if (!EXTENSION_FORMAT.test(number)) problems.number = p('admin.groupNumberInvalid')
  else if (RESERVED_NUMBER.test(number)) problems.number = p('admin.groupNumberReserved')
  const name = f.name.trim()
  if (!name || name.length > 64 || CONTROL.test(name)) problems.name = p('admin.groupNameInvalid')
  const members = parseMembers(f.members)
  const wrong = members.filter(m => !EXTENSION_FORMAT.test(m))
  if (!members.length || members.length > GROUP_MEMBERS_MAX) problems.members = p('admin.groupMembersInvalid')
  else if (wrong.length) problems.members = p('admin.group.err.memberFormat', { members: wrong.join(', ') })
  if (Object.keys(problems).length) return { problems }
  return { problems, group: { number, name, members } }
}

/** The refusals of the ring group routes, on the field they are about. */
export const groupRefusal = (err: unknown) =>
  refusalOf<GroupField>(err, (_field, code) => {
    if (code === 'GROUP_NUMBER') return { field: 'number', problem: p('admin.groupNumberInvalid') }
    if (code === 'GROUP_NUMBER_TAKEN') return { field: 'number', problem: p('admin.groupNumberTaken') }
    if (code === 'GROUP_NUMBER_RESERVED') return { field: 'number', problem: p('admin.groupNumberReserved') }
    if (code === 'GROUP_EXISTS') return { field: 'number', problem: p('admin.groupExists') }
    if (code === 'GROUP_NAME') return { field: 'name', problem: p('admin.groupNameInvalid') }
    if (code === 'GROUP_MEMBERS') return { field: 'members', problem: p('admin.groupMembersInvalid') }
    if (code === 'GROUP_MEMBER_NOT_EXTENSION') return { field: 'members', problem: p('admin.groupMemberNotExtension') }
    return undefined
  })
