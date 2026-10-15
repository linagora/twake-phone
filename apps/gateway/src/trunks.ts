import { TRUNK_CODECS, TRUNK_OUTBOUND_CLASSES, type DidRange, type Trunk, type TrunkAuth, type TrunkCodec, type TrunkNumberFormat, type TrunkOutboundClass } from '@twake/telephony-types'
import { decrypt, encrypt } from './crypto.js'
import type { DidRecord, TrunkRecord } from './store/types.js'

// The trunks to an operator and their direct numbers (step 6, ADR 0016), as administrators write them: checked here,
// kept by the store (the password encrypted with SECRETS_KEY), handed whole to the provider (setTrunks), which writes
// what its SIP server reads.

export const TRUNK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const E164 = /^\+[1-9][0-9]{6,14}$/
/** A host name (labels of letters, digits and dashes). */
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
// IPv4 only, as OpenSIPS's trunk socket (TRUNK_LISTEN_IP of entrypoint.sh): an IPv6 address could never reach it.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** What may go into the user part of a SIP URI (and a quoted SQL literal of the SIP server), nothing else. */
const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const CONTROL = /[\u0000-\u001f\u007f]/
const AUTHS: TrunkAuth[] = ['register', 'ip']
const FORMATS: TrunkNumberFormat[] = ['e164', 'e164-no-plus', 'international-00', 'national']

export const MAX_TRUNKS = 8
export const MAX_DIDS = 500
/** Numbers in one range at most. */
export const MAX_RANGE = 10_000
const MAX_PROXIES = 4
const MAX_SOURCES = 16

/** A 400 whose `code` the app turns into the administrator's words; the message names the field. */
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400, code: 'TRUNK_INVALID' })

const hostPort = (value: string) => {
  const m = /^([^:]+)(:(\d{1,5}))?$/.exec(value)
  if (!m) return false
  if (m[3] !== undefined && !(Number(m[3]) >= 1 && Number(m[3]) <= 65535)) return false
  return HOST.test(m[1]!) || IPV4.test(m[1]!)
}

const text = (body: Record<string, unknown>, field: string, check: (v: string) => boolean, what: string): string | undefined => {
  const v = body[field]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !check(v.trim())) throw invalid(`${field}: ${what}`)
  return v.trim()
}

const list = (body: Record<string, unknown>, field: string, max: number, check: (v: string) => boolean, what: string): string[] | undefined => {
  const v = body[field]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > max || !v.every(x => typeof x === 'string' && check(x.trim()))) throw invalid(`${field}: at most ${max} ${what}`)
  const items = v.map(x => (x as string).trim())
  if (new Set(items).size !== items.length) throw invalid(`${field}: each once`)
  return items.length ? items : undefined
}

/**
 * A trunk as an administrator writes it (the body of PUT /admin/trunks/:id), checked whole. `password`: a new one
 * (kept encrypted), null to remove it, absent to keep the current one (`current`).
 */
export const parseTrunk = (body: unknown, current?: Pick<TrunkRecord, 'passwordEnc'>): { config: TrunkRecord['config']; password: string | null | undefined } => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('a trunk is a JSON object')
  const b = body as Record<string, unknown>
  if (!AUTHS.includes(b.auth as TrunkAuth)) throw invalid(`auth: ${AUTHS.join(' or ')}`)
  const auth = b.auth as TrunkAuth
  const domain = text(b, 'domain', v => HOST.test(v) || IPV4.test(v), 'the operator\'s SIP domain, a host name without port')
  if (!domain) throw invalid('domain: the operator\'s SIP domain is required')
  const name = text(b, 'name', v => v.length <= 64 && !CONTROL.test(v), '64 characters at most, on one line')
  const proxies = list(b, 'proxies', MAX_PROXIES, hostPort, 'servers, host[:port]')
  const sources = list(b, 'sources', MAX_SOURCES, v => IPV4.test(v), 'IPv4 addresses')
  const username = text(b, 'username', v => SIP_USER.test(v), 'letters, digits and . _ + - only, 64 at most')
  const realm = text(b, 'realm', v => v.length <= 128 && !CONTROL.test(v) && !/["\\]/.test(v), '128 characters at most, no quote')
  const registrar = text(b, 'registrar', hostPort, 'host[:port]')
  let registerExpires: number | undefined
  if (b.registerExpires !== undefined && b.registerExpires !== null) {
    if (!Number.isInteger(b.registerExpires) || (b.registerExpires as number) < 60 || (b.registerExpires as number) > 3600) throw invalid('registerExpires: seconds, from 60 to 3600')
    registerExpires = b.registerExpires as number
  }
  const codecs = b.codecs
  if (!Array.isArray(codecs) || !codecs.length || !codecs.every(c => TRUNK_CODECS.includes(c as TrunkCodec)) || new Set(codecs).size !== codecs.length) throw invalid(`codecs: some of ${TRUNK_CODECS.join(', ')}, each once (the operator is offered these only)`)
  const numberFormat = (b.numberFormat ?? 'e164') as TrunkNumberFormat
  if (!FORMATS.includes(numberFormat)) throw invalid(`numberFormat: ${FORMATS.join(', ')}`)
  if (b.assertIdentity !== undefined && typeof b.assertIdentity !== 'boolean') throw invalid('assertIdentity: true or false')
  // What it may call (step 6a): the emergency numbers always, premium ones never, the rest as chosen here; absent, the
  // metropolitan fixed, mobile, free and standard-rate numbers.
  let allowed: TrunkOutboundClass[] | undefined
  if (b.allowed !== undefined && b.allowed !== null) {
    const a = b.allowed
    if (!Array.isArray(a) || !a.length || !a.every(c => TRUNK_OUTBOUND_CLASSES.includes(c as TrunkOutboundClass)) || new Set(a).size !== a.length) throw invalid(`allowed: some of ${TRUNK_OUTBOUND_CLASSES.join(', ')}, each once`)
    allowed = a as TrunkOutboundClass[]
  }
  if (b.default !== undefined && typeof b.default !== 'boolean') throw invalid('default: true or false')
  const defaultNumber = text(b, 'defaultNumber', v => E164.test(v), 'an E.164 number (+ then 7 to 15 digits)')
  if (!defaultNumber) throw invalid('defaultNumber: the number presented by those without a direct number is required')
  let password: string | null | undefined
  if (b.password === null) password = null
  else if (b.password !== undefined) {
    if (typeof b.password !== 'string' || !b.password || b.password.length > 64 || CONTROL.test(b.password)) throw invalid('password: 1 to 64 characters, on one line')
    password = b.password
  }
  const hasPassword = password === undefined ? !!current?.passwordEnc : password !== null
  if (auth === 'register' && !(username && hasPassword)) throw invalid('a trunk that registers needs a username and a password')
  return {
    config: {
      ...(name ? { name } : {}),
      auth,
      domain,
      ...(proxies ? { proxies } : {}),
      ...(sources ? { sources } : {}),
      ...(username ? { username } : {}),
      ...(realm ? { realm } : {}),
      ...(registrar ? { registrar } : {}),
      ...(registerExpires !== undefined ? { registerExpires } : {}),
      codecs: codecs as TrunkCodec[],
      numberFormat,
      ...(b.assertIdentity ? { assertIdentity: true } : {}),
      ...(allowed ? { allowed } : {}),
      ...(b.default ? { default: true } : {}),
      defaultNumber
    },
    password
  }
}

/** Whether two ranges share a number. */
const overlap = (a: Pick<DidRange, 'first' | 'last'>, b: Pick<DidRange, 'first' | 'last'>) => a.first.length === b.first.length && a.first <= b.last && b.first <= a.last

/**
 * A range of direct numbers as an administrator writes it (PUT /admin/dids/:id), checked against the trunks and the
 * other ranges of the tenant: no number belongs to two of them.
 */
export const parseDid = (id: string, body: unknown, trunks: readonly Pick<TrunkRecord, 'id'>[], others: readonly DidRange[]): DidRange => {
  if (!TRUNK_ID.test(id)) throw invalid('id: lower case letters, digits and dashes, 32 at most')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('a direct number is a JSON object')
  const b = body as Record<string, unknown>
  if (typeof b.trunkId !== 'string' || !trunks.some(t => t.id === b.trunkId)) throw invalid('trunkId: one of the trunks')
  const first = text(b, 'first', v => E164.test(v), 'an E.164 number (+ then 7 to 15 digits)')
  if (!first) throw invalid('first: the (first) direct number is required')
  const last = text(b, 'last', v => E164.test(v), 'an E.164 number (+ then 7 to 15 digits)') ?? first
  if (last.length !== first.length || last < first) throw invalid('last: a number of the same length, from first on')
  if (Number(last.slice(1)) - Number(first.slice(1)) + 1 > MAX_RANGE) throw invalid(`last: ${MAX_RANGE} numbers in a range at most`)
  const target = text(b, 'target', v => SIP_USER.test(v), 'an extension or a group number')
  let suffixDigits: number | undefined
  if (b.suffixDigits !== undefined && b.suffixDigits !== null) {
    if (!Number.isInteger(b.suffixDigits) || (b.suffixDigits as number) < 2 || (b.suffixDigits as number) > 6) throw invalid('suffixDigits: from 2 to 6')
    suffixDigits = b.suffixDigits as number
  }
  if (!target === !suffixDigits) throw invalid('target (an extension or a group) or suffixDigits (the extension is the last digits of the number called), one of them')
  const clash = others.find(o => o.id !== id && overlap(o, { first, last }))
  if (clash) throw Object.assign(new Error(`${clash.first}${clash.last !== clash.first ? ` to ${clash.last}` : ''} (${clash.id}) has some of these numbers already`), { statusCode: 409, code: 'DID_OVERLAP' })
  return { id, trunkId: b.trunkId, first, last, ...(target ? { target } : {}), ...(suffixDigits ? { suffixDigits } : {}) }
}

/** A trunk as the API shows it: never its password, whether it has one. */
export const publicTrunk = (r: TrunkRecord): Trunk => ({ id: r.id, ...r.config, hasPassword: !!r.passwordEnc })

/** A range as the API shows it. */
export const publicDid = ({ tenantId: _tenant, ...d }: DidRecord): DidRange => d

/** The record to keep for a trunk checked by parseTrunk: a new password encrypted, the current one kept, or none. */
export const trunkRecord = (tenantId: string, id: string, parsed: ReturnType<typeof parseTrunk>, current: TrunkRecord | undefined, key: Buffer | undefined): TrunkRecord => {
  if (typeof parsed.password === 'string' && !key) throw Object.assign(new Error('SECRETS_KEY is required to keep the password of a trunk'), { statusCode: 501 })
  const passwordEnc = typeof parsed.password === 'string' ? encrypt(parsed.password, key!) : parsed.password === null ? undefined : current?.passwordEnc
  return { tenantId, id, config: parsed.config, ...(passwordEnc ? { passwordEnc } : {}) }
}

/**
 * The trunk whose number those without a direct number present, and through which they call: the one marked
 * `default`, else the first one.
 */
export const defaultTrunk = (records: readonly TrunkRecord[]): TrunkRecord | undefined => records.find(r => r.config.default) ?? records[0]

/**
 * What the provider is handed, the default trunk first: each trunk with its password in clear (OpenSIPS answers the
 * challenges with it).
 */
export const providerTrunks = (records: readonly TrunkRecord[], key: Buffer | undefined): (Trunk & { password?: string })[] => {
  const first = defaultTrunk(records)
  return [...(first ? [first] : []), ...records.filter(r => r !== first)].map(r => {
    if (r.passwordEnc && !key) throw new Error(`SECRETS_KEY is required to read the password of trunk ${r.id}`)
    return { id: r.id, ...r.config, ...(r.passwordEnc ? { password: decrypt(r.passwordEnc, key!) } : {}) }
  })
}

/**
 * A first trunk from the environment (the pilot kit), when the tenant has none: TRUNK_DOMAIN and TRUNK_DEFAULT_NUMBER
 * at least; TRUNK_AUTH (register by default), TRUNK_ID (operator), TRUNK_NAME, TRUNK_PROXIES and TRUNK_SOURCES
 * (comma-separated), TRUNK_USERNAME, TRUNK_PASSWORD, TRUNK_REALM, TRUNK_REGISTRAR, TRUNK_EXPIRES, TRUNK_CODECS
 * (PCMA,PCMU by default), TRUNK_NUMBER_FORMAT, TRUNK_ASSERT_IDENTITY=1, TRUNK_ALLOWED (comma-separated classes:
 * fixed, mobile, freephone, standard-rate by default; overseas, international on demand); TRUNK_DIDS, comma-separated
 * `FIRST[..LAST]=TARGET` where TARGET is an extension or a group, or `last:N` for the extension made of the last N
 * digits of the number called. Undefined without TRUNK_DOMAIN; throws on anything invalid (named).
 */
export const trunkFromEnv = (env: NodeJS.ProcessEnv): { id: string; parsed: ReturnType<typeof parseTrunk>; dids: DidRange[] } | undefined => {
  if (!env.TRUNK_DOMAIN) return undefined
  const csv = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const id = env.TRUNK_ID || 'operator'
  if (!TRUNK_ID.test(id)) throw new Error('TRUNK_ID: lower case letters, digits and dashes, 32 at most')
  const at = (what: string) => (err: unknown) => {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: ReturnType<typeof parseTrunk>
  try {
    parsed = parseTrunk({
      auth: env.TRUNK_AUTH || 'register',
      domain: env.TRUNK_DOMAIN,
      ...(env.TRUNK_NAME ? { name: env.TRUNK_NAME } : {}),
      ...(env.TRUNK_PROXIES ? { proxies: csv(env.TRUNK_PROXIES) } : {}),
      ...(env.TRUNK_SOURCES ? { sources: csv(env.TRUNK_SOURCES) } : {}),
      ...(env.TRUNK_USERNAME ? { username: env.TRUNK_USERNAME } : {}),
      ...(env.TRUNK_PASSWORD ? { password: env.TRUNK_PASSWORD } : {}),
      ...(env.TRUNK_REALM ? { realm: env.TRUNK_REALM } : {}),
      ...(env.TRUNK_REGISTRAR ? { registrar: env.TRUNK_REGISTRAR } : {}),
      ...(env.TRUNK_EXPIRES ? { registerExpires: Number(env.TRUNK_EXPIRES) } : {}),
      codecs: env.TRUNK_CODECS ? csv(env.TRUNK_CODECS) : ['PCMA', 'PCMU'],
      ...(env.TRUNK_NUMBER_FORMAT ? { numberFormat: env.TRUNK_NUMBER_FORMAT } : {}),
      ...(env.TRUNK_ASSERT_IDENTITY === '1' ? { assertIdentity: true } : {}),
      ...(env.TRUNK_ALLOWED ? { allowed: csv(env.TRUNK_ALLOWED) } : {}),
      defaultNumber: env.TRUNK_DEFAULT_NUMBER
    })
  } catch (err) {
    return at('TRUNK_*')(err)
  }
  const dids: DidRange[] = []
  csv(env.TRUNK_DIDS).forEach((entry, i) => {
    const m = /^(\+[0-9]+)(?:\.\.(\+[0-9]+))?=(?:last:(\d+)|([A-Za-z0-9._+-]+))$/.exec(entry)
    if (!m) throw new Error(`TRUNK_DIDS: "${entry}" is not FIRST[..LAST]=TARGET or FIRST..LAST=last:N`)
    try {
      dids.push(parseDid(`${id}-${i + 1}`, { trunkId: id, first: m[1], ...(m[2] ? { last: m[2] } : {}), ...(m[3] ? { suffixDigits: Number(m[3]) } : { target: m[4] }) }, [{ id }], dids))
    } catch (err) {
      at(`TRUNK_DIDS ${entry}`)(err)
    }
  })
  return { id, parsed, dids }
}
