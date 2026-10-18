/**
 * A number in E.164 when it is one: `+…`, `00…`, or a French national number. As written otherwise (`anonymous`, an
 * extension). Migration 017 computes the same in PostgreSQL (`e164_of`, the column `call_history.remote_e164`): one
 * changes with the other.
 */
export const e164Of = (n: string): string => {
  // The characters named one by one, as migration 017 does (second review 10b, n°12): the ASCII spaces, the no-break
  // spaces (U+00A0, U+202F) and .()-; not every Unicode space `\s` takes.
  const v = n.replace(/[\t\n\v\f\r \u00a0\u202f.()-]/g, '')
  if (/^\+[1-9][0-9]{6,14}$/.test(v)) return v
  const intl = /^00([1-9][0-9]{6,14})$/.exec(v)
  if (intl) return `+${intl[1]}`
  const national = /^0([1-9][0-9]{8})$/.exec(v)
  return national ? `+33${national[1]}` : v
}
