import { describe, expect, it } from 'vitest'
import { isWorkplaceContact, nameOf, toContact, workplaceContactOf } from './workplaceContacts.js'

describe('Workplace contacts', () => {
  const camille = toContact({ _id: 'c1', displayName: 'Camille Martin', company: 'Acme', phone: [{ number: '06 12 34 56 78', type: 'cell' }, { number: '01 23 45 67 89' }], email: [{ address: 'c@acme.test', primary: true }] })!

  it('turns an io.cozy.contacts document into a person of the app, never mistaken for a directory card', () => {
    expect(camille).toEqual({ id: 'workplace:c1', displayName: 'Camille Martin', department: 'Acme', email: 'c@acme.test', numbers: [{ type: 'mobile', number: '06 12 34 56 78' }, { type: 'work', number: '01 23 45 67 89' }] })
    expect(isWorkplaceContact(camille)).toBe(true)
    expect(isWorkplaceContact({ id: 'jdupont' })).toBe(false)
    expect(toContact({ fullname: 'Sans Numéro', phone: [] })).toBeNull()
    expect(toContact({ phone: [{ number: '0612' }] })).toBeNull()
  })

  it('finds the one contact of a number as dialled (0… and +33… alike), and nobody for a number two contacts share', () => {
    expect(workplaceContactOf([camille], '+33612345678')).toBe(camille)
    expect(workplaceContactOf([camille], '0699999999')).toBeNull()
    const twin = toContact({ _id: 'c2', displayName: 'Standard', phone: [{ number: '+33612345678' }] })!
    expect(workplaceContactOf([camille, twin], '0612345678')).toBeNull()
  })

  it('never names an extension, even from a contact saved with a short number', () => {
    const desk = toContact({ _id: 'c3', displayName: 'Bureau', phone: [{ number: '102' }] })!
    expect(workplaceContactOf([desk], '102')).toBeNull()
  })

  it('names a call the SIP server left unnamed, keeps a name it gave, and never touches the call', () => {
    // A call is a live object of the softphone, with methods: it is read, never copied.
    class Call {
      constructor(public remoteNumber: string, public remoteName?: string) {}
      answer() {
        return 'answered'
      }
    }
    const call = new Call('+33123456789')
    expect(nameOf(call, [camille])).toBe('Camille Martin')
    expect(call.remoteName).toBeUndefined()
    expect(call.answer()).toBe('answered')
    expect(nameOf(new Call('+33123456789', 'Jean Dupont'), [camille])).toBe('Jean Dupont')
    expect(nameOf(new Call('+33123456789', 'anonymous'), [camille])).toBe('Camille Martin')
    expect(nameOf(call, [])).toBeUndefined()
  })
})
