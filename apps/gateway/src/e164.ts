/**
 * A number in E.164 when it is one: `+…`, `00…`, or a French national number. As written otherwise (`anonymous`, an
 * extension). Migration 016 computes the same in PostgreSQL (`e164_of`, the column `call_history.remote_e164`): one
 * changes with the other.
 */
export const e164Of = (n: string): string => {
  const v = n.replace(/[\s.()-]/g, '')
  if (/^\+[1-9][0-9]{6,14}$/.test(v)) return v
  const intl = /^00([1-9][0-9]{6,14})$/.exec(v)
  if (intl) return `+${intl[1]}`
  const national = /^0([1-9][0-9]{8})$/.exec(v)
  return national ? `+33${national[1]}` : v
}
