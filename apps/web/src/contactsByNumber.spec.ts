import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '@twake/telephony-client'
import { contactOfNumber, forgetContactsByNumber } from './contactsByNumber.js'
import { canCallNumber } from './useCallNumber.js'

// Fictitious numbers (ARCEP ranges for fiction).
const jean: Contact = { id: 'jd', displayName: 'Jean Dupont', numbers: [{ type: 'work', number: '01 99 00 01 01' }] }
const jeanne: Contact = { id: 'jn', displayName: 'Jeanne Martin', numbers: [{ type: 'work', number: '+33 1 99 00 01 10' }] }

describe('contactOfNumber', () => {
  beforeEach(forgetContactsByNumber)

  it('finds the person whose number it is, written either way, and not one whose number merely contains it', async () => {
    const searchDirectory = vi.fn(async () => ({ items: [jeanne, jean], truncated: false }))
    expect(await contactOfNumber({ searchDirectory }, '+33199000101')).toBe(jean)
    expect(searchDirectory).toHaveBeenCalledWith('199000101', 5)
    expect(await contactOfNumber({ searchDirectory }, '0199000110')).toBe(jeanne)
    expect(await contactOfNumber({ searchDirectory }, '0199000199')).toBeNull()
  })

  it('asks once per number, asks a failed one again, and never for a hidden number', async () => {
    const searchDirectory = vi.fn().mockRejectedValueOnce(new Error('Gateway 429')).mockResolvedValue({ items: [jean], truncated: false })
    expect(await contactOfNumber({ searchDirectory }, '0199000101')).toBeNull()
    expect(await contactOfNumber({ searchDirectory }, '0199000101')).toBe(jean)
    expect(await contactOfNumber({ searchDirectory }, '+33 1 99 00 01 01')).toBe(jean)
    expect(await contactOfNumber({ searchDirectory }, 'anonymous')).toBeNull()
    expect(searchDirectory).toHaveBeenCalledTimes(2)
  })
})

describe('canCallNumber', () => {
  it('refuses a hidden caller, text, and the person\'s own extension', () => {
    expect(['102', '0199000101', '+33199000101'].map(n => canCallNumber(n, '101'))).toEqual([true, true, true])
    expect(['anonymous', 'abc', '', '101'].map(n => canCallNumber(n, '101'))).toEqual([false, false, false, false])
  })
})
