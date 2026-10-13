import { toE164 } from '@twake/telephony-client'

const sameNumber = (a, b, country) => {
  const x = toE164(a, country) ?? a
  const y = toE164(b, country) ?? b
  return x === y
}

/**
 * Finds the contact owning a phone number. Numbers are compared in E.164 so that
 * "06 12 34 56 78" and "+33612345678" match; unparseable values (internal
 * extensions) only match when identical.
 */
export const findContactByNumber = (contacts, number, country = 'FR') =>
  (contacts ?? []).find(contact =>
    (contact.phone ?? []).some(
      p => p.number && sameNumber(p.number, number, country)
    )
  ) ?? null

export const getContactName = contact =>
  contact?.displayName ?? contact?.fullname ?? null

const digits = value => (value ?? '').replace(/[^\d+]/g, '')

/** Contact whose number starts with what has been typed so far (at least 3 digits). */
export const findContactByPrefix = (contacts, typed, country = 'FR') => {
  const wanted = digits(typed)
  if (wanted.replace('+', '').length < 3) return null
  return (
    (contacts ?? []).find(contact =>
      (contact.phone ?? []).some(p => {
        if (!p.number) return false
        const national = digits(p.number)
        const e164 = digits(toE164(p.number, country) ?? '')
        return national.startsWith(wanted) || e164.startsWith(wanted)
      })
    ) ?? null
  )
}

const PHONE_LABELS = {
  cell: 'mobile',
  work: 'work',
  home: 'home',
  voice: 'voice'
}

/** The phone entry of the contact that matches `number`, with a normalised kind. */
export const getPhoneKind = (contact, number, country = 'FR') => {
  const entry = (contact?.phone ?? []).find(
    p => p.number && sameNumber(p.number, number, country)
  )
  return PHONE_LABELS[entry?.type] ?? null
}
