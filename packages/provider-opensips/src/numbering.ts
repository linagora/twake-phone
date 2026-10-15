// The numbering plan OpenSIPS applies to the numbers of the public network (step 6, ADR 0016), as rules of its
// `dialplan` module: written into its table by trunk.sql (docker/opensips/entrypoint.sh) and by ensureSchema(), and
// evaluated here the way dp_translate does, so that the unit tests prove what OpenSIPS will do with a number.

/** dpid of the rules that turn what was dialled (or what the operator sent) into E.164, or say what it is instead. */
export const DP_NORMALISE = 1
/** dpid of the rules that say what kind of number an E.164 number is. */
export const DP_CLASSIFY = 2
/**
 * dpid of the rules tried on what the operator sends when DP_NORMALISE knows none: the national forms some operators
 * use and nobody dials (nine digits without the 0). Never for what a person dials: 612345678 could be an extension.
 */
export const DP_INBOUND = 3

/**
 * What a number is. `emergency`: a French emergency number (routed to the operator as dialled, whatever the policy);
 * `e164`: normalised, then classified; `invalid`: looks like a public number (a leading 0 or +) and is none. For an
 * E.164 number: `fixed` (+33 1 to 5 and 9), `mobile` (+33 6 and 7), `freephone` (+33 800 to 805), `standard-rate`
 * (+33 806 to 809, charged as a normal call), `premium` (the other +33 8), `overseas` (the French overseas
 * departments and territories, whether dialled with their own country code or as a French number: +33 262, 263 and
 * 269, 590, 594 and 596, 639, 690 to 697), `international`. Two short numbers are classified as dialled: the European
 * harmonised ones (116xxx) are `freephone`, the directory enquiries (118xxx) `premium`; so are the codes of no country
 * (satellites, international premium rate...).
 */
export type NumberClass = 'emergency' | 'e164' | 'invalid' | 'fixed' | 'mobile' | 'freephone' | 'standard-rate' | 'premium' | 'overseas' | 'international'

/**
 * A row of OpenSIPS's `dialplan` table (match_op 1, a PCRE; match_flags 0, case sensitive). `subst` and `repl`
 * together rewrite the number (`\1` names the first group): dp_translate's output is empty without them, so each rule
 * has them, KEEP for a number that goes through as it is. `attrs`: its class, which dp_translate hands back.
 */
export interface DialplanRule {
  dpid: number
  pr: number
  match: string
  subst?: string
  repl?: string
  attrs: NumberClass
}

/** The rewrite of a rule that keeps the number as it is. */
const KEEP = '^(.*)$'

/**
 * The emergency numbers of France: 15, 17, 18, 112, 114 (deaf and hard of hearing), 115, 119, 191, 196, 197, 116000,
 * and 116117 (the doctors on duty). Routed to the operator as they are (ADR 0016).
 */
const EMERGENCY = '^(1[578]|11[2459]|19[167]|116000|116117)$'
/**
 * The non-geographic codes of no country, charged as premium whatever the operator: international freephone and
 * shared cost (800, 808), satellites (870 Inmarsat, 881 global mobile satellite systems), international networks (882,
 * 883), personal telecommunication and trials (878, 888, 991), international premium rate (979): the classic
 * destinations of fraud (IRSF). Never called (premium), whatever a trunk allows.
 */
const NON_GEOGRAPHIC = '^\\+(80[08]|87[08]|88[1238]|979|991)'

/**
 * The rules, by dpid and priority (dp_translate tries them in ascending `pr`). A number no rule of DP_NORMALISE
 * matches is not a public number: an extension or a group, routed as before.
 */
export const DIALPLAN_RULES: readonly DialplanRule[] = [
  { dpid: DP_NORMALISE, pr: 10, match: EMERGENCY, subst: KEEP, repl: '\\1', attrs: 'emergency' },
  // The other short numbers of the French plan the platform knows (RESERVED_NUMBER of @twake/telephony-types: no
  // extension or group may have them): the European harmonised numbers 116xxx (free: 116006 for victims, 116111 for
  // children...), as dialled; the directory enquiries 118xxx, charged (premium).
  { dpid: DP_NORMALISE, pr: 11, match: '^116[0-9]{3}$', subst: KEEP, repl: '\\1', attrs: 'freephone' },
  { dpid: DP_NORMALISE, pr: 12, match: '^118[0-9]{3}$', subst: KEEP, repl: '\\1', attrs: 'premium' },
  // French numbers, whichever way they are written: national, +33, 0033, 33 (and a 0 left after the country code).
  { dpid: DP_NORMALISE, pr: 20, match: '^0([1-9][0-9]{8})$', subst: '^0([1-9][0-9]{8})$', repl: '+33\\1', attrs: 'e164' },
  { dpid: DP_NORMALISE, pr: 21, match: '^\\+330?([1-9][0-9]{8})$', subst: '^\\+330?([1-9][0-9]{8})$', repl: '+33\\1', attrs: 'e164' },
  { dpid: DP_NORMALISE, pr: 22, match: '^00330?([1-9][0-9]{8})$', subst: '^00330?([1-9][0-9]{8})$', repl: '+33\\1', attrs: 'e164' },
  { dpid: DP_NORMALISE, pr: 23, match: '^33([1-9][0-9]{8})$', subst: '^33([1-9][0-9]{8})$', repl: '+33\\1', attrs: 'e164' },
  // Any other country: + or 00, then 7 to 15 digits (E.164).
  { dpid: DP_NORMALISE, pr: 30, match: '^\\+[1-9][0-9]{6,14}$', subst: KEEP, repl: '\\1', attrs: 'e164' },
  { dpid: DP_NORMALISE, pr: 31, match: '^00([1-9][0-9]{6,14})$', subst: '^00([1-9][0-9]{6,14})$', repl: '+\\1', attrs: 'e164' },
  // Looks like a public number, is none: refused (484) rather than taken for an extension.
  { dpid: DP_NORMALISE, pr: 90, match: '^[+0]', subst: KEEP, repl: '\\1', attrs: 'invalid' },

  // The overseas departments and territories numbered in the French plan (ARCEP): Réunion and Mayotte (262, 263, 269,
  // 639, 692, 693), Guadeloupe, Saint-Martin and Saint-Barthélemy (590, 690, 691), Guiana (594, 694), Martinique (596,
  // 696, 697), and their non-geographic numbers (0976: ARCEP decision 06-0509, annex 3). Before the fixed and mobile
  // numbers they would otherwise be.
  { dpid: DP_CLASSIFY, pr: 9, match: '^\\+33(26[239]|59[046]|639|69[0-7]|976)[0-9]{6}$', subst: KEEP, repl: '\\1', attrs: 'overseas' },
  { dpid: DP_CLASSIFY, pr: 10, match: '^\\+33[1-59][0-9]{8}$', subst: KEEP, repl: '\\1', attrs: 'fixed' },
  { dpid: DP_CLASSIFY, pr: 11, match: '^\\+33[67][0-9]{8}$', subst: KEEP, repl: '\\1', attrs: 'mobile' },
  { dpid: DP_CLASSIFY, pr: 12, match: '^\\+3380[0-5][0-9]{6}$', subst: KEEP, repl: '\\1', attrs: 'freephone' },
  { dpid: DP_CLASSIFY, pr: 13, match: '^\\+3380[6-9][0-9]{6}$', subst: KEEP, repl: '\\1', attrs: 'standard-rate' },
  { dpid: DP_CLASSIFY, pr: 14, match: '^\\+338[1-9][0-9]{7}$', subst: KEEP, repl: '\\1', attrs: 'premium' },
  // +33 of any other length or prefix: no French number.
  { dpid: DP_CLASSIFY, pr: 15, match: '^\\+33', subst: KEEP, repl: '\\1', attrs: 'invalid' },
  // Réunion and Mayotte, Saint-Pierre-et-Miquelon, Guadeloupe and the French Antilles, Guiana, Martinique, Wallis and
  // Futuna, New Caledonia, French Polynesia: charged as abroad by most operators.
  { dpid: DP_CLASSIFY, pr: 20, match: '^\\+(262|508|59[046]|68[179])', subst: KEEP, repl: '\\1', attrs: 'overseas' },
  { dpid: DP_CLASSIFY, pr: 25, match: NON_GEOGRAPHIC, subst: KEEP, repl: '\\1', attrs: 'premium' },
  // Any other country: as far as the trunk lists its country code (`countries`).
  { dpid: DP_CLASSIFY, pr: 30, match: '^\\+', subst: KEEP, repl: '\\1', attrs: 'international' },

  { dpid: DP_INBOUND, pr: 10, match: '^([1-9][0-9]{8})$', subst: '^([1-9][0-9]{8})$', repl: '+33\\1', attrs: 'e164' }
]

/**
 * The classes a trunk calls when its administrator says nothing (`allowed`): everything else is refused
 * (route[outbound_policy] and route[trunk_out_loaded] of opensips.cfg.tpl, where step 6b's rights and caps will plug
 * in). An administrator may add `overseas` and `international` to a trunk; `premium` never goes out in 6a.
 */
export const OUTBOUND_ALLOWED: readonly NumberClass[] = ['fixed', 'mobile', 'freephone', 'standard-rate']
/** What a trunk may be allowed to call. */
export const OUTBOUND_ALLOWABLE: readonly NumberClass[] = [...OUTBOUND_ALLOWED, 'overseas', 'international']

/** dp_translate on these rules: the first match of `dpid` by priority, rewritten, with its class; null when none. */
export const translate = (dpid: number, input: string, rules: readonly DialplanRule[] = DIALPLAN_RULES): { output: string; attrs: NumberClass } | null => {
  const candidates = rules.filter(r => r.dpid === dpid).sort((a, b) => a.pr - b.pr)
  for (const rule of candidates) {
    if (!new RegExp(rule.match).test(input)) continue
    // As dialplan does: no replacement, no output.
    const output = rule.subst && rule.repl !== undefined ? input.replace(new RegExp(rule.subst), rule.repl.replace(/\\(\d)/g, '$$$1')) : ''
    return { output, attrs: rule.attrs }
  }
  return null
}

/**
 * What OpenSIPS makes of a number dialled (or, `inbound`, received from the operator): its E.164 form and class,
 * `emergency` or `invalid` as they are, or null for an extension or a group.
 */
export const classify = (input: string, { inbound = false } = {}): { number: string; class: NumberClass } | null => {
  const normalised = translate(DP_NORMALISE, input) ?? (inbound ? translate(DP_INBOUND, input) : null)
  if (!normalised) return null
  if (normalised.attrs !== 'e164') return { number: normalised.output, class: normalised.attrs }
  const kind = translate(DP_CLASSIFY, normalised.output)
  return { number: normalised.output, class: kind?.attrs ?? 'invalid' }
}

const quote = (s: string | undefined) => (s === undefined ? 'NULL' : `'${s.replace(/'/g, "''")}'`)

/**
 * The SQL that puts these rules in place of those of the same dpids, in one statement list (one implicit
 * transaction): OpenSIPS loads them at its start, and again on MI `dp_reload`.
 */
export const DIALPLAN_SQL = `DELETE FROM dialplan WHERE dpid IN (${DP_NORMALISE}, ${DP_CLASSIFY}, ${DP_INBOUND});
INSERT INTO dialplan (dpid, pr, match_op, match_exp, match_flags, subst_exp, repl_exp, disabled, attrs) VALUES
${DIALPLAN_RULES.map(r => `  (${r.dpid}, ${r.pr}, 1, ${quote(r.match)}, 0, ${quote(r.subst)}, ${quote(r.repl)}, 0, ${quote(r.attrs)})`).join(',\n')};
`
