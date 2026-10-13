import { AsYouType, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'

/** Returns the E.164 form, or null when the input is not a valid number. */
export const toE164 = (input: string, defaultCountry?: CountryCode): string | null => {
  // libphonenumber ignores trailing garbage; a business reference must not pass as a number.
  if (/[^\d\s+().-]/.test(input)) return null
  const parsed = parsePhoneNumberFromString(input, defaultCountry)
  return parsed?.isValid() ? parsed.number : null
}

/**
 * Display form while typing: French national numbers in pairs ("06 12 4"), international
 * numbers through libphonenumber, anything else (internal extensions, * and #) as typed.
 */
export const formatNumber = (input: string, defaultCountry?: CountryCode): string => {
  if (/^0\d*$/.test(input)) return input.replace(/(\d{2})(?=\d)/g, '$1 ')
  if (input.startsWith('+')) return new AsYouType(defaultCountry).input(input)
  return input
}

const INTERNAL_EXTENSION = /^\d{2,6}$/

/**
 * What to hand to the Gateway: internal extensions as they are, anything else as E.164. Null when the input is
 * not a number (a business reference, text...): nothing must be dialled then.
 */
export const toDialTarget = (input: string, defaultCountry: CountryCode = 'FR'): string | null => {
  const trimmed = input.trim()
  return INTERNAL_EXTENSION.test(trimmed) ? trimmed : toE164(trimmed, defaultCountry)
}
