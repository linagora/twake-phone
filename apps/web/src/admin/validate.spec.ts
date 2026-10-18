import { describe, expect, it } from 'vitest'
import type { DidRange, Trunk } from '@twake/telephony-client'
import en from '../i18n/en.json'
import fr from '../i18n/fr.json'
import { ADMIN_SECTIONS, adminSectionOf } from './sections.js'
import {
  DID_FIELDS,
  MAX_PROFILES,
  TRUNK_FIELDS,
  capsForm,
  checkCaps,
  checkDid,
  checkFraud,
  checkGroup,
  checkProfile,
  checkTrunk,
  didRefusal,
  droppedOperatorLines,
  emptyDid,
  emptyProfile,
  emptyTrunk,
  fraudForm,
  groupRefusal,
  limitsRefusal,
  newOperatorLines,
  normaliseNumber,
  parseMembers,
  profileRefusal,
  refusedField,
  reservedSuffixes,
  sameValue,
  trunkForm,
  trunkRefusal,
  type TrunkForm
} from './validate.js'

const refused = (status: number, code: string, detail: string) => Object.assign(new Error(detail), { status, code, detail })

const operator: TrunkForm = {
  ...emptyTrunk(),
  id: 'operator',
  name: 'Opérateur',
  domain: 'sip.operator.example',
  proxies: 'sip1.operator.example:5060, 192.0.2.10',
  username: 'login',
  password: 'secret',
  defaultNumber: '01 99 00 01 00'
}
const kept: Trunk = { id: 'operator', auth: 'register', domain: 'sip.operator.example', username: 'login', hasPassword: true, codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000100' }

describe('the trunk form (step 7)', () => {
  it('takes numbers as an administrator types them, in E.164', () => {
    expect(normaliseNumber('01 99 00 01 00')).toBe('+33199000100')
    expect(normaliseNumber('0033 1 99 00 01 00')).toBe('+33199000100')
    expect(normaliseNumber('+44 20 7946 0123')).toBe('+442079460123')
  })

  it('leaves out the « (0) » of the business cards, and refuses a French number with a 0 after +33 (review 7 n°4)', () => {
    expect(normaliseNumber('+33 (0)1 99 00 01 00')).toBe('+33199000100')
    expect(normaliseNumber('0033 (0) 1 99 00 01 00')).toBe('+33199000100')
    expect(normaliseNumber('+44 (0)20 7946 0123')).toBe('+442079460123')
    expect(checkTrunk({ ...operator, defaultNumber: '+33 (0)1 99 00 01 00' }, { ids: [] }).input?.defaultNumber).toBe('+33199000100')
    // Typed whole, without the parentheses: no French number is +330…, refused as the Gateway refuses it.
    expect(checkTrunk({ ...operator, defaultNumber: '+330199000100' }, { ids: [] }).problems.defaultNumber?.key).toBe('admin.trunk.err.defaultNumber')
    expect(checkDid({ ...emptyDid('operator'), id: 'x', first: '+330199000101', target: '101' }, { isNew: true, trunks: [{ id: 'operator' }], others: [] }).problems.first?.key).toBe('admin.did.err.number')
  })

  it('keeps the « (0) » where the 0 is dialled from abroad: Italy, San Marino, the Vatican (review 7 bis, n°9)', () => {
    expect(normaliseNumber('+39 (0)6 1234 5678')).toBe('+390612345678')
    expect(normaliseNumber('0039 (0)6 1234 5678')).toBe('+390612345678')
    expect(normaliseNumber('+378 (0)549 123456')).toBe('+3780549123456')
    expect(normaliseNumber('+379 (0)6 6988 1234')).toBe('+3790669881234')
    // Only those: the Netherlands (+31) and the United Kingdom leave it out.
    expect(normaliseNumber('+31 (0)20 123 4567')).toBe('+31201234567')
    expect(normaliseNumber('+44 (0)20 7946 0123')).toBe('+442079460123')
  })

  it('says what is wrong with an empty form, as the Gateway would, field by field', () => {
    const { input, problems } = checkTrunk(emptyTrunk(), { ids: [] })
    expect(input).toBeUndefined()
    expect(Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.key]))).toEqual({
      id: 'admin.trunk.err.id',
      domain: 'admin.trunk.err.domain',
      username: 'admin.trunk.err.registerNeeds',
      password: 'admin.trunk.err.registerNeeds',
      defaultNumber: 'admin.trunk.err.defaultNumber'
    })
  })

  it('makes the Gateway input of a registering trunk, its password sent once', () => {
    const { input, problems } = checkTrunk(operator, { ids: ['other'] })
    expect(problems).toEqual({})
    expect(input).toEqual({
      name: 'Opérateur',
      auth: 'register',
      domain: 'sip.operator.example',
      proxies: ['sip1.operator.example:5060', '192.0.2.10'],
      username: 'login',
      codecs: ['PCMA', 'PCMU'],
      numberFormat: 'e164',
      allowed: ['fixed', 'mobile', 'freephone', 'standard-rate'],
      defaultNumber: '+33199000100',
      password: 'secret'
    })
    expect(checkTrunk(operator, { ids: ['operator'] }).problems.id?.key).toBe('admin.trunk.err.idTaken')
  })

  it('keeps the password kept when none is typed, removes it only when asked, and never shows it', () => {
    const form = trunkForm(kept)
    expect(form.password).toBe('')
    expect(checkTrunk(form, { current: kept, ids: ['operator'] }).input).not.toHaveProperty('password')
    // Removing it leaves a registering trunk without one: refused before anything is sent.
    expect(checkTrunk({ ...form, removePassword: true }, { current: kept, ids: [] }).problems.password?.key).toBe('admin.trunk.err.registerNeeds')
    expect(checkTrunk({ ...form, auth: 'ip', removePassword: true }, { current: kept, ids: [] }).input?.password).toBeNull()
    // A password typed, then its removal asked (the field disabled, still holding it): removed, never sent (review 7 n°6).
    expect(checkTrunk({ ...form, auth: 'ip', password: 'typed-then-removed', removePassword: true }, { current: kept, ids: [] }).input?.password).toBeNull()
    expect(checkTrunk({ ...form, password: 'typed-then-removed', removePassword: true }, { current: kept, ids: [] }).problems.password?.key).toBe('admin.trunk.err.registerNeeds')
  })

  it('asks for the countries when international calls are allowed, and only then', () => {
    const intl: TrunkForm = { ...operator, allowed: [...operator.allowed, 'international'] }
    expect(checkTrunk(intl, { ids: [] }).problems.countries?.key).toBe('admin.trunk.err.countriesRequired')
    expect(checkTrunk({ ...intl, countries: '32, 44' }, { ids: [] }).input?.countries).toEqual(['32', '44'])
    expect(checkTrunk({ ...intl, countries: '4, 44' }, { ids: [] }).problems.countries?.key).toBe('admin.trunk.err.countriesPrefix')
    expect(checkTrunk({ ...intl, countries: '33' }, { ids: [] }).problems.countries?.key).toBe('admin.trunk.err.countries')
    expect(checkTrunk({ ...operator, countries: '32' }, { ids: [] }).problems.countries?.key).toBe('admin.trunk.err.countriesWithout')
  })

  it('asks the word of the administrator before a first fallback at the operator replaces what is set there (review 10b, n°13)', () => {
    const managed: TrunkForm = { ...operator, operatorLines: '0033199000100', fallbackManaged: true, operatorNumber: '+33639980001', onUnavailable: true }
    expect(checkTrunk(managed, { ids: [] }).problems).toEqual({ replaceConfirmed: { key: 'admin.trunk.err.replaceConfirmed' } })
    expect(checkTrunk({ ...managed, replaceConfirmed: true }, { ids: [] }).input?.operator).toEqual({ lines: ['0033199000100'], fallback: { number: '+33639980001', onUnavailable: true } })
    // Kept already: nothing more to confirm; none asked: neither.
    expect(checkTrunk(managed, { current: { ...kept, operator: { lines: ['0033199000100'], fallback: { number: '+33639980001', onUnavailable: true } } }, ids: ['operator'] }).problems).toEqual({})
    expect(checkTrunk({ ...managed, fallbackManaged: false }, { ids: [] }).problems).toEqual({})
    expect(trunkRefusal(refused(409, 'OPERATOR_LINE_SHARED', 'operator.lines: trunk b keeps another fallback on 0033199000100: one fallback a line'))).toEqual({ field: 'form', problem: { key: 'admin.err.operatorLineShared' } })
  })

  it('asks the same word for a line added to a trunk that keeps a fallback, and names the lines dropped (second review 10b, n°8, n°9)', () => {
    const current: Trunk = { ...kept, operator: { lines: ['0033199000100', '0033199000200'], fallback: { number: '+33639980001', onUnavailable: true } } }
    const managed: TrunkForm = { ...operator, operatorLines: '0033199000100, 0033199000300', fallbackManaged: true, operatorNumber: '+33639980001', onUnavailable: true }
    expect(newOperatorLines(managed, current)).toEqual(['0033199000300'])
    expect(droppedOperatorLines(managed, current)).toEqual(['0033199000200'])
    expect(checkTrunk(managed, { current, ids: ['operator'] }).problems).toEqual({ replaceConfirmed: { key: 'admin.trunk.err.replaceConfirmed' } })
    expect(checkTrunk({ ...managed, replaceConfirmed: true }, { current, ids: ['operator'] }).problems).toEqual({})
    // A first fallback: all its lines; none asked: none; a trunk that asks none loses nothing.
    expect(newOperatorLines(managed, null)).toEqual(['0033199000100', '0033199000300'])
    expect(newOperatorLines({ ...managed, fallbackManaged: false }, current)).toEqual([])
    expect(droppedOperatorLines(managed, { ...current, operator: { lines: current.operator!.lines } })).toEqual([])
    // Unticked, the lines kept lose nothing at saving; those dropped do.
    expect(droppedOperatorLines({ ...managed, fallbackManaged: false }, current)).toEqual(['0033199000200'])
  })

  it('says a round of the operator that failed (second review 10b, n°6), and a loop either way (n°7)', () => {
    expect(trunkRefusal(refused(502, 'OPERATOR_ROUND', 'The operator could not be read'))).toEqual({ field: 'form', problem: { key: 'admin.err.operatorRound' } })
    expect(trunkRefusal(refused(504, 'OPERATOR_ROUND', 'The operator was not read in time'))).toEqual({ field: 'form', problem: { key: 'admin.err.operatorRound' } })
    expect(trunkRefusal(refused(409, 'OPERATOR_FALLBACK_LOOP', '+33199000300 is the fallback trunk a keeps at the operator: it cannot be a line or the number of a trunk'))).toEqual({ field: 'form', problem: { key: 'admin.err.operatorLoop' } })
  })

  it('refuses what the Gateway refuses: a short number as fallback, a bad port, a period out of bounds', () => {
    const { problems } = checkTrunk({ ...operator, fallbackTarget: '112', proxies: 'sip.example:70000', registerExpires: '30', codecs: [] }, { ids: [] })
    expect(Object.keys(problems).sort()).toEqual(['codecs', 'fallbackTarget', 'proxies', 'registerExpires'])
  })

  it("puts the Gateway's refusals on the field they name, in the administrator's words", () => {
    expect(refusedField('proxies[1]: a host')).toBe('proxies')
    expect(trunkRefusal(refused(400, 'TRUNK_INVALID', 'domain: the operator’s SIP domain'))).toEqual({ field: 'domain', problem: { key: 'admin.trunk.err.domain' } })
    expect(trunkRefusal(refused(400, 'TRUNK_INVALID', 'a trunk that registers needs a username and a password')).field).toBe('password')
    expect(trunkRefusal(refused(400, 'FALLBACK_TARGET', 'fallbackTarget: 999 is neither an extension nor a group'))).toEqual({ field: 'fallbackTarget', problem: { key: 'admin.err.targetUnknown' } })
    expect(trunkRefusal(refused(409, 'TRUNK_DEFAULT', 'the default trunk'))).toEqual({ field: 'form', problem: { key: 'admin.err.trunkDefault' } })
    expect(trunkRefusal(refused(502, 'TRUNK_RELOAD_FAILED', 'x')).problem.key).toBe('admin.err.reloadFailed')
    expect(trunkRefusal(refused(403, 'FORBIDDEN', 'x')).problem.key).toBe('admin.err.forbidden')
    expect(trunkRefusal(new TypeError('Failed to fetch')).problem.key).toBe('admin.err.failed')
  })
})

describe('the direct numbers form (step 7)', () => {
  const trunks = [{ id: 'operator' }]
  const staff: DidRange = { id: 'staff', trunkId: 'operator', first: '+33199000100', last: '+33199000109', suffixDigits: 3 }

  it('makes a single number or a range, with a target or the last digits', () => {
    expect(checkDid({ ...emptyDid('operator'), id: 'accueil', first: '01 99 00 02 00', target: '101' }, { isNew: true, trunks, others: [] }).range).toEqual({ id: 'accueil', trunkId: 'operator', first: '+33199000200', last: '+33199000200', target: '101' })
    expect(checkDid({ ...emptyDid('operator'), id: 'staff', first: '+33199000100', last: '+33199000109', mode: 'suffix' }, { isNew: true, trunks, others: [] }).range).toEqual(staff)
  })

  it('refuses a range whose last digits make an emergency number, naming them', () => {
    expect(reservedSuffixes('+33199000100', '+33199000199', 3)).toEqual(['112', '114', '115', '119', '191', '196', '197'])
    const { problems } = checkDid({ ...emptyDid('operator'), id: 'staff', first: '+33199000100', last: '+33199000199', mode: 'suffix' }, { isNew: true, trunks, others: [] })
    expect(problems.suffixDigits).toEqual({ key: 'admin.did.err.suffixReserved', params: { digits: 3, numbers: '112, 114, 115, 119, 191, 196, 197' } })
  })

  it('refuses an overlap, a reversed range, an emergency number as target, a fallback that is the target', () => {
    const others = [staff]
    expect(checkDid({ ...emptyDid('operator'), id: 'more', first: '+33199000105', target: '101' }, { isNew: true, trunks, others }).problems.first?.key).toBe('admin.did.err.overlap')
    expect(checkDid({ ...emptyDid('operator'), id: 'x', first: '+33199000300', last: '+33199000200', target: '101' }, { isNew: true, trunks, others }).problems.last?.key).toBe('admin.did.err.lastOrder')
    expect(checkDid({ ...emptyDid('operator'), id: 'x', first: '+33199000300', target: '112' }, { isNew: true, trunks, others }).problems.target).toEqual({ key: 'admin.did.err.targetReserved', params: { target: '112' } })
    expect(checkDid({ ...emptyDid('operator'), id: 'x', first: '+33199000300', target: '101', fallbackTarget: '101' }, { isNew: true, trunks, others }).problems.fallbackTarget?.key).toBe('admin.did.err.fallbackLoop')
    expect(checkDid({ ...emptyDid(''), id: 'x', first: '+33199000300', target: '101' }, { isNew: true, trunks, others }).problems.trunkId?.key).toBe('admin.did.err.trunkId')
    // The range being changed does not overlap itself.
    expect(checkDid({ ...emptyDid('operator'), id: 'staff', first: '+33199000100', last: '+33199000105', target: '101' }, { isNew: false, trunks, others }).problems).toEqual({})
  })

  it("puts the Gateway's refusals on the field they name", () => {
    expect(didRefusal(refused(400, 'DID_TARGET', 'target: 555 is neither an extension nor a group'))).toEqual({ field: 'target', problem: { key: 'admin.err.targetUnknown' } })
    expect(didRefusal(refused(409, 'DID_OVERLAP', '+33199000100 to +33199000109 (staff) has some of these numbers already'))).toEqual({ field: 'first', problem: { key: 'admin.did.err.overlapServer', params: { detail: '+33199000100 to +33199000109 : staff' } } })
    expect(didRefusal(refused(400, 'DID_RESERVED', 'target: 112 is a number the platform sends to the operator'))).toEqual({ field: 'target', problem: { key: 'admin.did.err.targetReserved', params: { target: '112' } } })
    expect(didRefusal(refused(400, 'TRUNK_INVALID', 'last: a number of the same length, from first on')).problem.key).toBe('admin.did.err.lastOrder')
  })
})

describe('the caps, thresholds and profiles forms (step 7)', () => {
  it('reads absent as the default, none as null, and refuses what is not a whole number in bounds', () => {
    expect(capsForm({ concurrent: 4, dailyMinutes: null }).dailyMinutes).toEqual({ mode: 'none', value: '' })
    const form = capsForm({ concurrent: 4, dailyMinutes: null })
    expect(checkCaps(form).caps).toEqual({ concurrent: 4, dailyMinutes: null })
    expect(checkCaps(capsForm(undefined))).toEqual({ problems: {} })
    expect(checkCaps({ ...form, monthlyCalls: { mode: 'value', value: '0' } }).problems.monthlyCalls?.key).toBe('admin.limits.err.cap')
    expect(checkCaps({ ...form, monthlyCalls: { mode: 'value', value: '1000001' } }).problems.monthlyCalls?.key).toBe('admin.limits.err.cap')
  })

  it('keeps a threshold set to none, and refuses a warning above the critical one', () => {
    const form = fraudForm({ callsPerMinute: { warning: 4 } })
    expect(form.callsPerMinute).toEqual({ mode: 'custom', warning: '4', critical: '' })
    expect(checkFraud({ ...form, dailyAttempts: { mode: 'custom', warning: '', critical: '' } }).rule).toEqual({ callsPerMinute: { warning: 4 }, dailyAttempts: {} })
    expect(checkFraud({ ...form, callsPerMinute: { mode: 'custom', warning: '9', critical: '3' } }).problems.callsPerMinute?.key).toBe('admin.limits.err.thresholdOrder')
  })

  it('makes a profile, internal calls only when nothing is allowed', () => {
    expect(checkProfile({ ...emptyProfile(), id: 'interne' }, { isNew: true, ids: [] }).profile).toEqual({ id: 'interne', allowed: [] })
    expect(checkProfile({ ...emptyProfile(), id: 'interne' }, { isNew: true, ids: ['interne'] }).problems.id?.key).toBe('admin.rights.err.idTaken')
    expect(checkProfile({ ...emptyProfile(), id: 'Bad id' }, { isNew: true, ids: [] }).problems.id?.key).toBe('admin.rights.err.id')
  })

  it('says there are as many profiles as there can be, before sending, and when the Gateway says so (review 7 n°14)', () => {
    const ids = Array.from({ length: MAX_PROFILES }, (_, i) => `p${i}`)
    expect(checkProfile({ ...emptyProfile(), id: 'one-more' }, { isNew: true, ids }).problems.form).toEqual({ key: 'admin.err.profileLimit', params: { max: 32 } })
    // Changing one of them is no new one.
    expect(checkProfile({ ...emptyProfile(), id: 'p3' }, { isNew: false, ids }).profile).toEqual({ id: 'p3', allowed: [] })
    expect(profileRefusal(refused(400, 'PROFILE_LIMIT', 'profiles: at most 32'))).toEqual({ field: 'form', problem: { key: 'admin.err.profileLimit', params: { max: 32 } } })
    // A setting changed by someone else meanwhile, and an alert repeated since it was shown: said as such.
    expect(profileRefusal(refused(409, 'OUTBOUND_STALE', 'changed since')).problem.key).toBe('admin.err.stale')
    expect(limitsRefusal(refused(409, 'OUTBOUND_STALE', 'changed since')).problem.key).toBe('admin.err.stale')
  })

  it("puts the Gateway's refusals of the outbound setting on their field", () => {
    expect(limitsRefusal(refused(400, 'OUTBOUND_INVALID', 'policy.caps.concurrent: a whole number from 1 to 1000000')).field).toBe('tenant-concurrent')
    expect(limitsRefusal(refused(400, 'OUTBOUND_INVALID', 'policy.userCaps.dailyMinutes: a whole number')).field).toBe('user-dailyMinutes')
    expect(limitsRefusal(refused(400, 'OUTBOUND_INVALID', 'policy.fraud.international.callsPerMinute: the warning comes before the critical threshold'))).toEqual({ field: 'international-callsPerMinute', problem: { key: 'admin.limits.err.thresholdOrder' } })
    expect(limitsRefusal(refused(400, 'OUTBOUND_INVALID', 'policy.fraud.national.callSeconds.warning: a whole number')).field).toBe('national-callSeconds')
    expect(profileRefusal(refused(400, 'OUTBOUND_INVALID', 'profile interne: caps.dailyMinutes: a whole number')).field).toBe('dailyMinutes')
    expect(profileRefusal(refused(400, 'OUTBOUND_INVALID', 'profile interne: name, 64 characters at most, on one line')).field).toBe('name')
    expect(profileRefusal(refused(502, 'OUTBOUND_RELOAD_FAILED', 'x')).problem.key).toBe('admin.err.reloadFailed')
  })
})

describe('the ring group form (review 7 n°7)', () => {
  it('reads the members as typed, in order, each once', () => {
    expect(parseMembers(' 101, 102 ;103\n101 ')).toEqual(['101', '102', '103'])
    expect(parseMembers('  ')).toEqual([])
  })

  it('checks what the Gateway checks before sending, field by field', () => {
    expect(checkGroup({ number: '200', name: ' Accueil ', members: '101, 102' })).toEqual({ problems: {}, group: { number: '200', name: 'Accueil', members: ['101', '102'] } })
    const keys = (f: Parameters<typeof checkGroup>[0]) => Object.fromEntries(Object.entries(checkGroup(f).problems).map(([k, v]) => [k, v.key]))
    expect(keys({ number: '', name: '', members: '' })).toEqual({ number: 'admin.groupNumberInvalid', name: 'admin.groupNameInvalid', members: 'admin.groupMembersInvalid' })
    expect(keys({ number: '0200', name: 'x'.repeat(65), members: '101' })).toEqual({ number: 'admin.groupNumberInvalid', name: 'admin.groupNameInvalid' })
    expect(keys({ number: '112', name: 'Accueil', members: '101' })).toEqual({ number: 'admin.groupNumberReserved' })
    expect(keys({ number: '200', name: 'Accueil', members: Array.from({ length: 13 }, (_, i) => String(101 + i)).join(',') })).toEqual({ members: 'admin.groupMembersInvalid' })
    expect(checkGroup({ number: '200', name: 'Accueil', members: '101, 0102, alice' }).problems.members).toEqual({ key: 'admin.group.err.memberFormat', params: { members: '0102, alice' } })
  })

  it("puts the Gateway's refusals on the field they are about", () => {
    expect(groupRefusal(refused(409, 'GROUP_NUMBER_TAKEN', '102 is an extension'))).toEqual({ field: 'number', problem: { key: 'admin.groupNumberTaken' } })
    expect(groupRefusal(refused(409, 'GROUP_EXISTS', 'exists'))).toEqual({ field: 'number', problem: { key: 'admin.groupExists' } })
    expect(groupRefusal(refused(400, 'GROUP_NUMBER_RESERVED', 'x')).field).toBe('number')
    expect(groupRefusal(refused(400, 'GROUP_NAME', 'x')).field).toBe('name')
    expect(groupRefusal(refused(400, 'GROUP_MEMBER_NOT_EXTENSION', 'x'))).toEqual({ field: 'members', problem: { key: 'admin.groupMemberNotExtension' } })
    expect(groupRefusal(refused(503, 'SYNC_RUNNING', 'x'))).toEqual({ field: 'form', problem: { key: 'admin.groupSyncRunning' } })
  })

  it('compares values whatever the order of their keys, as PostgreSQL and the Gateway write them (review 7 ter, n°4)', () => {
    expect(sameValue({ id: 'world', caps: { dailyCalls: 5, concurrent: 2 }, name: 'Monde', allowed: ['fixed'] }, { id: 'world', name: 'Monde', allowed: ['fixed'], caps: { concurrent: 2, dailyCalls: 5 } })).toBe(true)
    expect(sameValue({ allowed: ['fixed', 'mobile'] }, { allowed: ['mobile', 'fixed'] })).toBe(false)
    expect(sameValue({ caps: { concurrent: null } }, { caps: {} })).toBe(false)
    expect(sameValue({ name: 'Monde' }, { name: 'Monde entier' })).toBe(false)
  })

  it('says a group, a trunk or a range removed meanwhile is gone, not that the platform cannot (review 7 bis, n°11)', () => {
    expect(groupRefusal(refused(404, '', 'No such group'))).toEqual({ field: 'form', problem: { key: 'admin.err.gone' } })
    expect(trunkRefusal(refused(404, '', 'No such trunk'))).toEqual({ field: 'form', problem: { key: 'admin.err.gone' } })
    expect(didRefusal(refused(404, '', 'No such range'))).toEqual({ field: 'form', problem: { key: 'admin.err.gone' } })
    // No SIP server for the organisation, and a platform without the feature: that is the platform.
    expect(groupRefusal(refused(404, '', 'No provider for tenant'))).toEqual({ field: 'form', problem: { key: 'admin.err.unavailable' } })
    expect(trunkRefusal(refused(501, '', 'Trunks are not available on this platform'))).toEqual({ field: 'form', problem: { key: 'admin.err.unavailable' } })
  })
})

describe('the words of the administration (step 7)', () => {
  it('has words in French and English for every field the Gateway may refuse', () => {
    for (const dict of [fr, en] as Record<string, string>[]) {
      for (const f of TRUNK_FIELDS) expect(dict, f).toHaveProperty([`admin.trunk.err.${f}`])
      for (const f of DID_FIELDS.filter(f => f !== 'first' && f !== 'last')) expect(dict, f).toHaveProperty([`admin.did.err.${f}`])
      for (const [, key] of ADMIN_SECTIONS) expect(dict).toHaveProperty([key])
    }
  })

  it('names each part of the administration from its address, /admin itself by the page', () => {
    expect(adminSectionOf('/admin/trunks')).toBe('admin.nav.trunks')
    expect(adminSectionOf('/admin/numbers/')).toBe('admin.nav.numbers')
    expect(adminSectionOf('/admin')).toBeUndefined()
    expect(adminSectionOf('/admin/unknown')).toBeUndefined()
  })
})
