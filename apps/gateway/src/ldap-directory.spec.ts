import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ATTRIBUTES, LdapDirectory, contactOf, digitsOf, ldapDirectoryFromEnv, searchFilter, searchWords } from './ldap-directory.js'
// @ts-expect-error plain JavaScript test helper, shared with the browser e2e
import { BASE_DN, PEOPLE, READER_DN, READER_PASSWORD, startLdapMock } from '../test/ldap-mock.mjs'

const FILTER = '(objectClass=inetOrgPerson)'

describe('searchWords and digitsOf', () => {
  it('drops one-letter words and keeps at most five', () => {
    expect(searchWords('a jean b dup')).toEqual(['jean', 'dup'])
    expect(searchWords('a a a a a a')).toEqual([])
    expect(searchWords('w1 w2 w3 w4 w5 w6 w7')).toHaveLength(5)
  })
  it('recognises a number typed with spaces, dots, dashes or a plus', () => {
    expect(digitsOf('+33 1 23-45.67 01')).toBe('33123456701')
    expect(digitsOf('(01) 23')).toBe('0123')
    expect(digitsOf('12')).toBe('')
    expect(digitsOf('dup')).toBe('')
  })
})

describe('searchFilter', () => {
  it('matches every word by prefix on names, email, department and id, and escapes what the user typed', () => {
    const f = searchFilter('jean du', DEFAULT_ATTRIBUTES, FILTER)!
    expect(f.startsWith(`(&${FILTER}(|(cn=jean*)(sn=jean*)(givenName=jean*)(mail=jean*)(ou=jean*)(uid=jean*))`)).toBe(true)
    expect(f).toContain('(|(cn=du*)')
    expect(searchFilter('a)(uid=*', DEFAULT_ATTRIBUTES, '(x=1)')).toContain('(cn=a\\29\\28uid=\\2a*)')
    expect(searchFilter('a', DEFAULT_ATTRIBUTES, FILTER)).toBeNull()
  })
  it('matches a number on its last digits, national or international', () => {
    expect(searchFilter('0123456701', DEFAULT_ATTRIBUTES, FILTER)).toContain('(telephoneNumber=*23456701)(mobile=*23456701)')
    expect(searchFilter('+33 1 23 45 67 01', DEFAULT_ATTRIBUTES, FILTER)).toContain('(telephoneNumber=*23456701)')
    expect(searchFilter('101', { ...DEFAULT_ATTRIBUTES, extension: 'employeeNumber' }, FILTER)).toContain('(employeeNumber=*101)')
  })
  it('leaves out the name parts a schema does not have', () => {
    expect(searchFilter('dup', { ...DEFAULT_ATTRIBUTES, surname: '', givenName: '' }, FILTER)).not.toContain('(sn=')
  })
})

describe('contactOf', () => {
  it('maps an entry whatever the case of the attribute names, multi-valued numbers included', () => {
    const c = contactOf({ dn: 'x', UID: 'bd', cn: 'Bob Durand', telephonenumber: ['01', '02'], MOBILE: Buffer.from('06'), mail: ' bob@x ', ou: 'Support' }, DEFAULT_ATTRIBUTES)
    expect(c).toEqual({ id: 'bd', displayName: 'Bob Durand', numbers: [{ type: 'work', number: '01' }, { type: 'work', number: '02' }, { type: 'mobile', number: '06' }], email: 'bob@x', department: 'Support' })
    expect(contactOf({ dn: 'x', cn: 'No Id' }, DEFAULT_ATTRIBUTES)).toBeNull()
    expect(contactOf({ dn: 'x', uid: 'u', displayName: 'Named' }, { ...DEFAULT_ATTRIBUTES, name: 'DisplayName' })?.displayName).toBe('Named')
  })
  it('reads an internal extension from its own attribute when the schema has one', () => {
    const c = contactOf({ dn: 'x', uid: 'bd', cn: 'Bob', employeeNumber: '103', telephoneNumber: '01' }, { ...DEFAULT_ATTRIBUTES, extension: 'employeeNumber' })
    expect(c?.numbers).toEqual([{ type: 'extension', number: '103' }, { type: 'work', number: '01' }])
  })
})

describe('ldapDirectoryFromEnv', () => {
  it('is off without LDAP_URL, refuses LDAP_URL without a base DN, and a malformed filter', () => {
    expect(ldapDirectoryFromEnv({})).toBeUndefined()
    expect(() => ldapDirectoryFromEnv({ LDAP_URL: 'ldap://x' })).toThrow(/LDAP_BASE_DN/)
    expect(() => ldapDirectoryFromEnv({ LDAP_URL: 'ldap://x', LDAP_BASE_DN: 'dc=x', LDAP_USER_FILTER: '(objectClass=person' })).toThrow(/paren/i)
    expect(() => ldapDirectoryFromEnv({ LDAP_URL: 'ldap://x', LDAP_BASE_DN: 'dc=x', LDAP_USER_FILTER: '' })).toThrow()
    const d = ldapDirectoryFromEnv({ LDAP_URL: 'ldap://localhost', LDAP_BASE_DN: 'dc=x', LDAP_TENANT: 'acme', LDAP_ATTR_EXTENSION: 'employeeNumber' })
    expect(d).toBeInstanceOf(LdapDirectory)
    expect(d!.servesTenant('acme')).toBe(true)
    expect(d!.servesTenant('other')).toBe(false)
  })
  it('warns about a clear-text bind on a remote host and about a disabled certificate check', () => {
    const warnings: string[] = []
    ldapDirectoryFromEnv({ LDAP_URL: 'ldap://ldap.corp', LDAP_BASE_DN: 'dc=x', LDAP_BIND_DN: 'cn=r', LDAP_TLS_REJECT_UNAUTHORIZED: '0' }, m => warnings.push(m))
    expect(warnings.join('\n')).toMatch(/clear text/)
    expect(warnings.join('\n')).toMatch(/not verified/)
    const quiet: string[] = []
    ldapDirectoryFromEnv({ LDAP_URL: 'ldaps://ldap.corp', LDAP_BASE_DN: 'dc=x', LDAP_BIND_DN: 'cn=r' }, m => quiet.push(m))
    expect(quiet).toEqual([])
  })
})

describe('LdapDirectory against a real LDAP server', () => {
  let ldap: { url: string; stop: () => Promise<void> }
  let dir: LdapDirectory
  const make = (over: Partial<ConstructorParameters<typeof LdapDirectory>[0]> = {}) =>
    new LdapDirectory({ url: ldap.url, tenantId: 't', bindDn: READER_DN, bindPassword: READER_PASSWORD, baseDn: BASE_DN, userFilter: FILTER, attributes: DEFAULT_ATTRIBUTES, ...over })
  beforeAll(async () => {
    ldap = await startLdapMock()
    dir = make()
  })
  afterAll(() => ldap.stop())

  it('finds people by the start of a name, a department, or several words', async () => {
    expect((await dir.search('t', 'dup', 10)).items.map(c => c.displayName)).toEqual(['Jean Dupont'])
    expect((await dir.search('t', 'support', 10)).items.map(c => c.displayName)).toEqual(['Bob Durand', 'Jean Dupont', 'Marc Petit'])
    expect((await dir.search('t', 'jean support', 10)).items.map(c => c.displayName)).toEqual(['Jean Dupont'])
    expect((await dir.search('t', 'nobody', 10)).items).toEqual([])
    expect((await dir.search('t', '   ', 10)).items).toEqual([])
  })

  it('finds accented names typed with or without accents, in any case', async () => {
    for (const q of ['zoé', 'Zoe', 'LEFÈVRE', 'lefevre', 'comptabilité']) expect((await dir.search('t', q, 10)).items.map(c => c.id), q).toEqual(['zlefevre'])
  })

  it('finds a number as people type it', async () => {
    for (const q of ['0123456701', '+33123456701', '+33 1 23 45 67 01', '01 23 45 67 01', '23456701']) expect((await dir.search('t', q, 10)).items.map(c => c.id), q).toEqual(['jdupont'])
    expect((await dir.search('t', '06 12 34 56 03', 10)).items.map(c => c.id)).toEqual(['bdurand'])
  })

  it('says when more matched than it returned, and keeps within the limit (the server answers sizeLimitExceeded)', async () => {
    const page = await dir.search('t', 'support', 1)
    expect(page.items).toHaveLength(1)
    expect(page.truncated).toBe(true)
    expect((await dir.search('t', 'support', 3)).truncated).toBe(false)
  })

  it('accepts a user filter written without parentheses', async () => {
    expect((await make({ userFilter: 'objectClass=inetOrgPerson' }).search('t', 'dup', 10)).items.map(c => c.id)).toEqual(['jdupont'])
  })

  it('returns a contact with its numbers and department', async () => {
    const [jean] = await dir.getMany('t', ['jdupont'])
    expect(jean).toEqual({
      id: 'jdupont', displayName: 'Jean Dupont', email: 'jean.dupont@example.test', department: 'Support', title: 'Technicien',
      numbers: [{ type: 'work', number: '+33 1 23 45 67 01' }, { type: 'mobile', number: '+33 6 12 34 56 01' }]
    })
  })

  it('resolves many ids in the order asked, in batches, and skips unknown ones', async () => {
    expect((await dir.getMany('t', ['bdurand', 'ghost', 'jdupont'])).map(c => c.id)).toEqual(['bdurand', 'jdupont'])
    expect(await dir.getMany('t', [])).toEqual([])
    const many = [...Array(120).keys()].map(i => `ghost${i}`)
    expect((await dir.getMany('t', [...many, 'amartin'])).map(c => c.id)).toEqual(['amartin'])
  })

  it('cannot be tricked into a wider search by filter characters', async () => {
    expect((await dir.search('t', '**', 10)).items).toEqual([])
    expect(await dir.getMany('t', ['*'])).toEqual([])
  })

  it('lists everyone with their extension for the synchronisation, in pages, and refuses without an extension attribute', async () => {
    const withExtension = make({ attributes: { ...DEFAULT_ATTRIBUTES, extension: 'ipPhone' } })
    const all = await withExtension.listAll('t')
    expect(all.map(c => c.id).sort()).toEqual(['amartin', 'bdurand', 'jdupont', 'mpetit', 'zlefevre'])
    expect(all.find(c => c.id === 'amartin')?.numbers).toContainEqual({ type: 'extension', number: '101' })
    expect(all.find(c => c.id === 'zlefevre')?.numbers.some(n => n.type === 'extension')).toBe(false)
    await expect(dir.listAll('t')).rejects.toThrow(/LDAP_ATTR_EXTENSION/)
  })

  it("gives a person's Matrix user id from its own attribute only, nothing for someone else nor for a filter typed (step 11b)", async () => {
    const people = (PEOPLE as Record<string, unknown>[]).map(p => (p.uid === 'jdupont' ? { ...p, twakeMatrixId: '@jean.dupont:chat.example.test' } : p))
    const mock = await startLdapMock({ people })
    try {
      const d = make({ url: mock.url, matrixAttribute: 'twakeMatrixId' })
      expect(await d.matrixIdOf('t', 'jdupont')).toBe('@jean.dupont:chat.example.test')
      expect(await d.matrixIdOf('t', 'amartin')).toBeUndefined()
      expect(await d.matrixIdOf('t', 'nobody')).toBeUndefined()
      expect(await d.matrixIdOf('t', 'jd*')).toBeUndefined()
      expect(await d.matrixIdOf('t', '*)(uid=jdupont')).toBeUndefined()
      // The directory matches an id whatever its case: the entry found is not the one asked for.
      expect(await d.matrixIdOf('t', 'JDUPONT')).toBeUndefined()
      // Without LDAP_ATTR_MATRIX: none, the directory not even asked.
      expect(await make({ url: mock.url }).matrixIdOf('t', 'jdupont')).toBeUndefined()
      // Never in a contact shown.
      expect(JSON.stringify((await d.search('t', 'dupont', 10)).items)).not.toContain('chat.example.test')
    } finally {
      await mock.stop()
    }
  })

  it('takes no Matrix id when two entries have the id asked, nor when the entry gives two (step 11b)', async () => {
    const twin = { uid: 'twin', cn: 'Twin', sn: 'Twin', twakeMatrixId: '@twin.one:chat.example.test' }
    const people = [...(PEOPLE as Record<string, unknown>[]), twin, { ...twin, cn: 'Twin Two', twakeMatrixId: '@twin.two:chat.example.test' }, { uid: 'multi', cn: 'Multi', sn: 'Multi', twakeMatrixId: ['@multi.a:chat.example.test', '@multi.b:chat.example.test'] }]
    const mock = await startLdapMock({ people })
    try {
      const d = make({ url: mock.url, matrixAttribute: 'twakeMatrixId' })
      await expect(d.matrixIdOf('t', 'twin')).rejects.toMatchObject({ code: 'MATRIX_ID_AMBIGUOUS' })
      await expect(d.matrixIdOf('t', 'multi')).rejects.toMatchObject({ code: 'MATRIX_ID_AMBIGUOUS' })
    } finally {
      await mock.stop()
    }
  })

  it('describes itself without the bind password', () => {
    const d = make({ url: 'ldaps://reader:secret@ldap.example.test:636' })
    expect(d.describe()).toEqual({ type: 'ldap', url: 'ldaps://ldap.example.test:636', tenantId: 't', baseDn: BASE_DN, userFilter: FILTER, attributes: DEFAULT_ATTRIBUTES })
    expect(JSON.stringify(d.describe())).not.toMatch(/secret/)
  })

  it('reports a wrong bind as an error, not as an empty directory', async () => {
    await expect(make({ bindPassword: 'nope' }).search('t', 'dup', 10)).rejects.toThrow()
  })

  it('gives up on a server that accepts the connection and never answers', async () => {
    const silent = createServer(() => {})
    await new Promise<void>(r => silent.listen(0, '127.0.0.1', r))
    const { port } = silent.address() as { port: number }
    const started = Date.now()
    await expect(make({ url: `ldap://127.0.0.1:${port}`, operationTimeoutMs: 300 }).search('t', 'dup', 10)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
    silent.close()
  })
})
