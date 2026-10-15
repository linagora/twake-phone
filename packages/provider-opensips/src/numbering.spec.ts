import { EXTENSION_FORMAT, RESERVED_NUMBER } from '@twake/telephony-types'
import { describe, expect, it } from 'vitest'
import { DIALPLAN_RULES, DIALPLAN_SQL, DP_CLASSIFY, DP_INBOUND, DP_NANP_AREA, DP_NORMALISE, OUTBOUND_ALLOWABLE, OUTBOUND_ALLOWED, classify, countryAllowed, translate } from './numbering.js'

// Fictional numbers only: ARCEP reserves 01 99 00 xx xx and 06 39 98 xx xx for fiction (the latter in the block of
// Mayotte, 0639: an overseas number), Ofcom 020 7946 0xxx. The other kinds of numbers are written with a subscriber
// part of zeros.

describe('the numbering plan (dialplan, dpid 1 then 2)', () => {
  it('writes a French number in E.164 whichever way it is dialled or received', () => {
    for (const input of ['0199000101', '+33199000101', '+330199000101', '0033199000101', '00330199000101', '33199000101'])
      expect(classify(input), input).toEqual({ number: '+33199000101', class: 'fixed' })
    expect(classify('0600000000')).toEqual({ number: '+33600000000', class: 'mobile' })
    expect(classify('0900000000')).toEqual({ number: '+33900000000', class: 'fixed' })
    expect(classify('0700000000')).toEqual({ number: '+33700000000', class: 'mobile' })
  })

  it('tells free, standard-rate and premium numbers apart', () => {
    expect(classify('0800000000')?.class).toBe('freephone')
    expect(classify('0805000000')?.class).toBe('freephone')
    expect(classify('0806000000')?.class).toBe('standard-rate')
    expect(classify('0809000000')?.class).toBe('standard-rate')
    for (const premium of ['0810000000', '0821000000', '0890000000', '0899000000', '+33899000000']) expect(classify(premium)?.class, premium).toBe('premium')
  })

  it('takes every French emergency number for one, before anything else', () => {
    for (const n of ['15', '17', '18', '112', '114', '115', '119', '191', '196', '197', '116000', '116117']) expect(classify(n), n).toEqual({ number: n, class: 'emergency' })
    // Neighbours of theirs are extensions or groups, as before.
    for (const n of ['16', '101', '102', '113', '116', '1120', '1161', '11600', '1160000', '3949']) expect(classify(n), n).toBeNull()
  })

  it('calls the European harmonised numbers (116xxx) as dialled, free, and never the directory enquiries (118xxx)', () => {
    // 116006 (victims), 116111 (children): no longer a 404 nobody explains, a free number the trunk calls.
    for (const n of ['116006', '116111', '116123', '116999']) expect(classify(n), n).toEqual({ number: n, class: 'freephone' })
    for (const n of ['118000', '118218', '118712']) expect(classify(n), n).toEqual({ number: n, class: 'premium' })
  })

  it('reserves for the public network every short number it routes or refuses, and none other (RESERVED_NUMBER)', () => {
    // No extension or group may take one (the Gateway refuses it): dialled, it never rings anyone inside.
    const short = [...Array(1000).keys()].flatMap(i => [String(i), String(i).padStart(2, '0'), String(i).padStart(3, '0'), `116${String(i).padStart(3, '0')}`, `118${String(i).padStart(3, '0')}`, `117${String(i).padStart(3, '0')}`, `1${i}`])
    for (const n of new Set(short)) {
      const c = classify(n)
      expect(RESERVED_NUMBER.test(n), n).toBe(c !== null && c.class !== 'invalid')
    }
  })

  it('classes other countries as international, the French overseas territories apart', () => {
    expect(classify('+442079460123')).toEqual({ number: '+442079460123', class: 'international' })
    expect(classify('00442079460123')).toEqual({ number: '+442079460123', class: 'international' })
    expect(classify('+262262000000')?.class).toBe('overseas')
    expect(classify('00590590000000')?.class).toBe('overseas')
  })

  it('never takes the codes of no country for international: satellites, international networks, premium and shared cost', () => {
    for (const n of ['+870000000000', '+881600000000', '+882340000000', '+883130000000', '+979000000000', '+80012345678', '+80812345678', '+878100000000', '+888000000000', '+991000000000', '00881600000000'])
      expect(classify(n)?.class, n).toBe('premium')
    for (const n of ['+87100000000', '+88000000000', '+886200000000', '+97100000000', '+3220000000', '+12025550100']) expect(classify(n)?.class, n).toBe('international')
  })

  it('opens with a country code its geographic and mobile numbers only, never its premium, shared-cost or personal ranges', () => {
    // United States, Canada: 900, 976 in any area, 700, the 5XX personal numbers; their ordinary numbers are international.
    for (const n of ['+19005550123', '+12129760123', '+14169760000', '+17005550123', '+15005550123', '+15215550123', '+15885550123'])
      expect(classify(n)?.class, n).toBe('premium')
    for (const n of ['+12125550123', '+14165550123', '+18005550123', '+15105550123', '+12129750123', '+19095550123']) expect(classify(n)?.class, n).toBe('international')
    // United Kingdom: 9, 70, 84, 87; Germany: 900, 137, 138, 180, 118, 700, 12.
    for (const n of ['+449098790000', '+447000000000', '+448450000000', '+448700000000', '+499000000000', '+491370000000', '+491380000000', '+491800000000', '+49118000', '+497000000000', '+4912000000'])
      expect(classify(n)?.class, n).toBe('premium')
    for (const n of ['+442079460123', '+447700900123', '+448000000000', '+493000000000', '+491510000000']) expect(classify(n)?.class, n).toBe('international')
    // And the others listed most: Belgium, Switzerland, Spain, Italy, Netherlands, Austria, Portugal, Luxembourg, Poland.
    for (const n of ['+3290000000', '+3270000000', '+41900000000', '+41840000000', '+34803000000', '+34901000000', '+39899000000', '+31900000000', '+43900000000', '+43810000000', '+351600000000', '+351707000000', '+35290000000', '+48700000000'])
      expect(classify(n)?.class, n).toBe('premium')
    for (const n of ['+3220000000', '+41210000000', '+34910000000', '+390600000000', '+31200000000', '+4310000000', '+351210000000', '+352200000', '+48220000000']) expect(classify(n)?.class, n).toBe('international')
  })

  it('takes the North American plan per area: `1` for the United States and Canada, every other country by its own area', () => {
    // The countries of the plan that are not the United States nor Canada (dialplan's set 4), Caribbean and Bermuda.
    for (const n of ['+18765550123', '+18095550123', '+18295550123', '+12425550123', '+12465550123', '+14415550123', '+16585550123', '+17215550123', '+18685550123'])
      expect(translate(DP_NANP_AREA, n), n).not.toBeNull()
    for (const n of ['+12125550123', '+14165550123', '+17875550123', '+16715550123', '+13405550123']) expect(translate(DP_NANP_AREA, n), n).toBeNull()
    expect(countryAllowed('+12125550123', ['1'])).toBe(true)
    expect(countryAllowed('+14165550123', ['1'])).toBe(true)
    expect(countryAllowed('+18765550123', ['1'])).toBe(false)
    expect(countryAllowed('+18095550123', ['1', '1876'])).toBe(false)
    expect(countryAllowed('+18765550123', ['1876'])).toBe(true)
    expect(countryAllowed('+12125550123', ['1876'])).toBe(false)
    // Any other code: its one to three digits.
    expect(countryAllowed('+442079460123', ['44'])).toBe(true)
    expect(countryAllowed('+442079460123', ['33', '1'])).toBe(false)
    expect(countryAllowed('+35220000000', ['352'])).toBe(true)
    expect(countryAllowed('+35220000000', ['351'])).toBe(false)
  })

  it('leaves to the internal plan every extension or group number it allows: none of them is a public number', () => {
    // EXTENSION_FORMAT (2 to 6 digits, the first not 0) less the reserved short numbers: never classified, so never
    // sent to the operator, and no public number is ever dialled for one.
    const normalise = DIALPLAN_RULES.filter(r => r.dpid === DP_NORMALISE).map(r => new RegExp(r.match))
    let checked = 0
    for (let i = 10; i <= 999999; i++) {
      const n = String(i)
      if (!EXTENSION_FORMAT.test(n) || RESERVED_NUMBER.test(n)) continue
      checked++
      if (normalise.some(r => r.test(n))) expect(classify(n), n).toBeNull()
    }
    expect(checked).toBeGreaterThan(900000)
    for (const n of ['0101', '01', '+33199000101', '1234567', '1', 'alice']) expect(EXTENSION_FORMAT.test(n), n).toBe(false)
  })

  it('classes the overseas numbers of the French plan as overseas however they are written, not as fixed or mobile', () => {
    // Réunion and Mayotte, Guadeloupe (with Saint-Martin and Saint-Barthélemy), Guiana, Martinique: fixed and mobile.
    for (const prefix of ['0262', '0263', '0269', '0590', '0594', '0596', '0639', '0690', '0691', '0692', '0693', '0694', '0696', '0697']) {
      const national = `${prefix}000000`
      const e164 = `+33${national.slice(1)}`
      for (const input of [national, e164, `0033${national.slice(1)}`]) expect(classify(input), input).toEqual({ number: e164, class: 'overseas' })
    }
    // Their non-geographic numbers (0976x: ARCEP decision 06-0509, annex 3), not the metropolitan 09 ones.
    for (const n of ['0976000000', '0976900000', '+33976000000']) expect(classify(n)?.class, n).toBe('overseas')
    for (const n of ['0970000000', '0975000000', '0977000000', '0950000000']) expect(classify(n)?.class, n).toBe('fixed')
    // ARCEP's fictional mobile numbers are in the block of Mayotte.
    expect(classify('06 39 98 00 01'.replace(/ /g, ''))).toEqual({ number: '+33639980001', class: 'overseas' })
    // Their metropolitan neighbours stay fixed or mobile.
    for (const n of ['0261000000', '0264000000', '0591000000', '0595000000']) expect(classify(n)?.class, n).toBe('fixed')
    for (const n of ['0638000000', '0640000000', '0698000000', '0699000000']) expect(classify(n)?.class, n).toBe('mobile')
  })

  it('reads the nine-digit national form some operators send, only for what they send', () => {
    expect(classify('199000101', { inbound: true })).toEqual({ number: '+33199000101', class: 'fixed' })
    expect(classify('639980002', { inbound: true })).toEqual({ number: '+33639980002', class: 'overseas' })
    expect(translate(DP_INBOUND, '199000101')).toEqual({ output: '+33199000101', attrs: 'e164' })
    // Dialled, nine digits are no public number (an extension could have them); the rules of dpid 1 come first.
    expect(classify('199000101')).toBeNull()
    expect(classify('0199000101', { inbound: true })).toEqual({ number: '+33199000101', class: 'fixed' })
    expect(classify('12345678', { inbound: true })).toBeNull()
  })

  it('refuses what looks like a public number and is none, rather than taking it for an extension', () => {
    for (const n of ['0', '06399800', '063998000123', '+33', '+3363998', '+336399800012', '+0123456789', '0033', '+12', '00']) expect(classify(n)?.class, n).toBe('invalid')
  })

  it('leaves extensions, groups and anything else alone', () => {
    for (const n of ['101', '104', '200', 'alice', 'anonymous', '']) expect(classify(n), n).toBeNull()
  })

  it('lets out, by default, the metropolitan numbers that cost nothing more than a call; overseas and abroad only when a trunk allows them, premium never', () => {
    expect([...OUTBOUND_ALLOWED].sort()).toEqual(['fixed', 'freephone', 'mobile', 'standard-rate'])
    expect([...OUTBOUND_ALLOWABLE].sort()).toEqual(['fixed', 'freephone', 'international', 'mobile', 'overseas', 'standard-rate'])
  })

  it('tries the rules in ascending priority, as dp_translate does', () => {
    expect(translate(DP_NORMALISE, '0639980001')).toEqual({ output: '+33639980001', attrs: 'e164' })
    expect(translate(DP_CLASSIFY, '+33639980001')).toEqual({ output: '+33639980001', attrs: 'overseas' })
    expect(translate(DP_CLASSIFY, '+33600000000')).toEqual({ output: '+33600000000', attrs: 'mobile' })
    const shuffled = [...DIALPLAN_RULES].reverse()
    expect(translate(DP_NORMALISE, '112', shuffled)).toEqual({ output: '112', attrs: 'emergency' })
  })

  it('fits the columns of the dialplan table and writes them in place of its own rules', () => {
    for (const r of DIALPLAN_RULES) {
      // dp_translate's output is empty for a rule without a replacement.
      expect(r.subst && r.repl, r.match).toBeTruthy()
      expect(r.match.length).toBeLessThanOrEqual(64)
      expect((r.subst ?? '').length).toBeLessThanOrEqual(64)
      expect((r.repl ?? '').length).toBeLessThanOrEqual(32)
      expect(() => new RegExp(r.match)).not.toThrow()
    }
    expect(DIALPLAN_SQL).toMatch(/^DELETE FROM dialplan WHERE dpid IN \(1, 2, 3, 4\);/)
    expect(DIALPLAN_SQL).toContain("(1, 21, 1, '^\\+330?([1-9][0-9]{8})$', 0, '^\\+330?([1-9][0-9]{8})$', '+33\\1', 0, 'e164')")
    expect(DIALPLAN_SQL.match(/\n {2}\(/g)).toHaveLength(DIALPLAN_RULES.length)
  })
})
