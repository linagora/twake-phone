import { describe, expect, it } from 'vitest'
import { DIALPLAN_RULES, DIALPLAN_SQL, DP_CLASSIFY, DP_INBOUND, DP_NORMALISE, OUTBOUND_ALLOWABLE, OUTBOUND_ALLOWED, classify, translate } from './numbering.js'

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
    for (const n of ['16', '101', '102', '113', '116', '1120', '116118', '3949']) expect(classify(n), n).toBeNull()
  })

  it('classes other countries as international, the French overseas territories apart', () => {
    expect(classify('+442079460123')).toEqual({ number: '+442079460123', class: 'international' })
    expect(classify('00442079460123')).toEqual({ number: '+442079460123', class: 'international' })
    expect(classify('+262262000000')?.class).toBe('overseas')
    expect(classify('00590590000000')?.class).toBe('overseas')
  })

  it('classes the overseas numbers of the French plan as overseas however they are written, not as fixed or mobile', () => {
    // Réunion and Mayotte, Guadeloupe (with Saint-Martin and Saint-Barthélemy), Guiana, Martinique: fixed and mobile.
    for (const prefix of ['0262', '0263', '0269', '0590', '0594', '0596', '0639', '0690', '0691', '0692', '0693', '0694', '0696', '0697']) {
      const national = `${prefix}000000`
      const e164 = `+33${national.slice(1)}`
      for (const input of [national, e164, `0033${national.slice(1)}`]) expect(classify(input), input).toEqual({ number: e164, class: 'overseas' })
    }
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
    expect(DIALPLAN_SQL).toMatch(/^DELETE FROM dialplan WHERE dpid IN \(1, 2, 3\);/)
    expect(DIALPLAN_SQL).toContain("(1, 21, 1, '^\\+330?([1-9][0-9]{8})$', 0, '^\\+330?([1-9][0-9]{8})$', '+33\\1', 0, 'e164')")
    expect(DIALPLAN_SQL.match(/\n {2}\(/g)).toHaveLength(DIALPLAN_RULES.length)
  })
})
