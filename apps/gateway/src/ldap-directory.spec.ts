import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ATTRIBUTES, LdapDirectory, contactOf, ldapDirectoryFromEnv, searchFilter } from './ldap-directory.js'
// @ts-expect-error plain JavaScript test helper, shared with the browser e2e
import { BASE_DN, READER_DN, READER_PASSWORD, startLdapMock } from '../test/ldap-mock.mjs'

describe('searchFilter', () => {
  it('requires every word somewhere, and escapes what the user typed', () => {
    const f = searchFilter('jean du', DEFAULT_ATTRIBUTES, '(objectClass=inetOrgPerson)')
    expect(f.startsWith('(&(objectClass=inetOrgPerson)(|(cn=*jean*)')).toBe(true)
    expect(f).toContain('(|(cn=*du*)')
    expect(searchFilter('a)(uid=*', DEFAULT_ATTRIBUTES, '(x=1)')).toContain('(cn=*a\\29\\28uid=\\2a*)')
  })
})

describe('contactOf', () => {
  it('maps an entry, multi-valued numbers included, and drops what has no id or name', () => {
    const c = contactOf({ dn: 'x', uid: 'bd', cn: 'Bob Durand', telephoneNumber: ['01', '02'], mobile: Buffer.from('06'), mail: ' bob@x ', ou: 'Support' }, DEFAULT_ATTRIBUTES)
    expect(c).toEqual({ id: 'bd', displayName: 'Bob Durand', numbers: [{ type: 'work', number: '01' }, { type: 'work', number: '02' }, { type: 'mobile', number: '06' }], email: 'bob@x', department: 'Support' })
    expect(contactOf({ dn: 'x', cn: 'No Id' }, DEFAULT_ATTRIBUTES)).toBeNull()
  })
  it('reads an internal extension from its own attribute when the schema has one', () => {
    const c = contactOf({ dn: 'x', uid: 'bd', cn: 'Bob', employeeNumber: '103', telephoneNumber: '01' }, { ...DEFAULT_ATTRIBUTES, extension: 'employeeNumber' })
    expect(c?.numbers).toEqual([{ type: 'extension', number: '103' }, { type: 'work', number: '01' }])
  })
})

describe('ldapDirectoryFromEnv', () => {
  it('is off without LDAP_URL and refuses LDAP_URL without a base DN', () => {
    expect(ldapDirectoryFromEnv({})).toBeUndefined()
    expect(() => ldapDirectoryFromEnv({ LDAP_URL: 'ldap://x' })).toThrow(/LDAP_BASE_DN/)
    expect(ldapDirectoryFromEnv({ LDAP_URL: 'ldap://x', LDAP_BASE_DN: 'dc=x', LDAP_ATTR_EXTENSION: 'employeeNumber' })).toBeInstanceOf(LdapDirectory)
  })
})

describe('LdapDirectory against a real LDAP server', () => {
  let ldap: { url: string; stop: () => Promise<void> }
  let dir: LdapDirectory
  beforeAll(async () => {
    ldap = await startLdapMock()
    dir = new LdapDirectory({ url: ldap.url, bindDn: READER_DN, bindPassword: READER_PASSWORD, baseDn: BASE_DN, userFilter: '(objectClass=inetOrgPerson)', attributes: DEFAULT_ATTRIBUTES })
  })
  afterAll(() => ldap.stop())

  it('finds people by a part of their name, number or department', async () => {
    expect((await dir.search('t', 'dup', 10)).map(c => c.displayName)).toEqual(['Jean Dupont'])
    expect((await dir.search('t', 'support', 10)).map(c => c.displayName)).toEqual(['Bob Durand', 'Jean Dupont'])
    expect((await dir.search('t', 'jean support', 10)).map(c => c.displayName)).toEqual(['Jean Dupont'])
    expect((await dir.search('t', '67 03', 10)).map(c => c.id)).toEqual(['bdurand'])
    expect(await dir.search('t', 'nobody', 10)).toEqual([])
    expect(await dir.search('t', '   ', 10)).toEqual([])
  })

  it('honours the limit', async () => {
    expect(await dir.search('t', 'example.test', 2)).toHaveLength(2)
  })

  it('returns a contact with its numbers and department', async () => {
    const [jean] = await dir.getMany('t', ['jdupont'])
    expect(jean).toEqual({
      id: 'jdupont', displayName: 'Jean Dupont', email: 'jean.dupont@example.test', department: 'Support', title: 'Technicien',
      numbers: [{ type: 'work', number: '+33 1 23 45 67 01' }, { type: 'mobile', number: '+33 6 12 34 56 01' }]
    })
  })

  it('resolves many ids in the order asked and skips unknown ones', async () => {
    expect((await dir.getMany('t', ['bdurand', 'ghost', 'jdupont'])).map(c => c.id)).toEqual(['bdurand', 'jdupont'])
    expect(await dir.getMany('t', [])).toEqual([])
  })

  it('cannot be tricked into a wider search by filter characters', async () => {
    expect(await dir.search('t', '*', 10)).toEqual([])
    expect(await dir.getMany('t', ['*'])).toEqual([])
  })

  it('reports a wrong bind as an error, not as an empty directory', async () => {
    const wrong = new LdapDirectory({ url: ldap.url, bindDn: READER_DN, bindPassword: 'nope', baseDn: BASE_DN, userFilter: '(objectClass=inetOrgPerson)', attributes: DEFAULT_ATTRIBUTES })
    await expect(wrong.search('t', 'dup', 10)).rejects.toThrow()
  })
})
