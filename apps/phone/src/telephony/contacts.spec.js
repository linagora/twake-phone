import { findContactByNumber } from './contacts'

const alice = {
  displayName: 'Alice Martin',
  phone: [{ number: '06 12 34 56 78' }]
}

describe('findContactByNumber', () => {
  it('matches national and international formats of the same number', () => {
    expect(findContactByNumber([alice], '+33612345678')).toBe(alice)
  })

  it('does not match another number nor a business reference', () => {
    expect(findContactByNumber([alice], '+33698765432')).toBe(null)
    expect(findContactByNumber([alice], '0328001234')).toBe(null)
  })

  it('matches internal extensions only when identical', () => {
    const bob = { displayName: 'Bob', phone: [{ number: '102' }] }
    expect(findContactByNumber([bob], '102')).toBe(bob)
    expect(findContactByNumber([bob], '103')).toBe(null)
  })
})

describe('findContactByPrefix', () => {
  const { findContactByPrefix, getPhoneKind } = require('./contacts')
  it('suggests a contact once three digits are typed', () => {
    expect(findContactByPrefix([alice], '06')).toBe(null)
    expect(findContactByPrefix([alice], '0612')).toBe(alice)
    expect(findContactByPrefix([alice], '+3361')).toBe(alice)
    expect(findContactByPrefix([alice], '0799')).toBe(null)
  })

  it('reports the kind of the matched phone number', () => {
    const c = { phone: [{ number: '0612345678', type: 'cell' }] }
    expect(getPhoneKind(c, '+33612345678')).toBe('mobile')
  })
})
