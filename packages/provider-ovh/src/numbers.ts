/**
 * Numbers as OVHcloud's API writes them: international with `00` (`0033612345678`), sometimes national (`0612345678`,
 * France). E.164 on our side.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/

/** A number OVH wrote, in E.164 when it is one (00 and the country code, or a French national number); as written otherwise (`anonymous`, a short number). */
export const fromOvhNumber = (n: string): string => {
  const v = n.trim().replace(/[\s.-]/g, '')
  if (E164.test(v)) return v
  const intl = /^00([1-9][0-9]{6,14})$/.exec(v)
  if (intl) return `+${intl[1]}`
  const national = /^0([1-9][0-9]{8})$/.exec(v)
  if (national) return `+33${national[1]}`
  return n.trim()
}

/** An E.164 number as OVH takes it (`+33612345678` → `0033612345678`). */
export const toOvhNumber = (e164: string): string => {
  if (!E164.test(e164)) throw new Error('an E.164 number')
  return `00${e164.slice(1)}`
}
