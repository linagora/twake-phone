import { describe, expect, it } from 'vitest'
import { formatNumber, toDialTarget, toE164 } from './phoneNumber.js'

describe('toE164', () => {
  it('normalises a French national number', () => {
    expect(toE164('06 12 34 56 78', 'FR')).toBe('+33612345678')
  })
  it('rejects garbage', () => {
    expect(toE164('0328001234x', 'FR')).toBeNull()
  })
})

describe('formatNumber', () => {
  it('groups a French number while typing and leaves extensions alone', () => {
    expect(formatNumber('0612489017', 'FR')).toBe('06 12 48 90 17')
    expect(formatNumber('061248', 'FR')).toBe('06 12 48')
    expect(formatNumber('06124', 'FR')).toBe('06 12 4')
    expect(formatNumber('+33612489017', 'FR')).toBe('+33 6 12 48 90 17')
    expect(formatNumber('102', 'FR')).toBe('102')
  })
})

describe('toDialTarget', () => {
  it('keeps extensions, normalises numbers, and refuses anything else', () => {
    expect(toDialTarget('102')).toBe('102')
    expect(toDialTarget(' 06 12 34 56 78 ')).toBe('+33612345678')
    expect(toDialTarget('+33 6 12 34 56 78')).toBe('+33612345678')
    expect(toDialTarget('0328001234x')).toBeNull()
    expect(toDialTarget('ref-4821')).toBeNull()
    expect(toDialTarget('')).toBeNull()
  })
})
