// A throwaway LDAP server for tests: a handful of inetOrgPerson entries, one reader account, no persistence.
// Matching is written here, like a real server does it: attribute names case-insensitive, text compared without
// case or accents (caseIgnoreMatch on UTF-8), numbers compared without spaces and dashes (telephoneNumberMatch),
// and a size limit answered with result code 4 (sizeLimitExceeded) after the allowed entries.
import ldap from 'ldapjs'

export const BASE_DN = 'ou=people,dc=example,dc=test'
export const READER_DN = 'cn=reader,dc=example,dc=test'
export const READER_PASSWORD = 'reader-secret'

export const PEOPLE = [
  { uid: 'jdupont', cn: 'Jean Dupont', sn: 'Dupont', givenName: 'Jean', mail: 'jean.dupont@example.test', telephoneNumber: '+33 1 23 45 67 01', mobile: '+33 6 12 34 56 01', ou: 'Support', title: 'Technicien' },
  { uid: 'amartin', cn: 'Alice Martin', sn: 'Martin', givenName: 'Alice', mail: 'alice.martin@example.test', telephoneNumber: '+33 1 23 45 67 02', ou: 'Direction' },
  { uid: 'bdurand', cn: 'Bob Durand', sn: 'Durand', givenName: 'Bob', mail: 'bob.durand@example.test', telephoneNumber: ['+33 1 23 45 67 03', '+33 1 23 45 67 04'], mobile: '+33 6 12 34 56 03', ou: 'Support' },
  { uid: 'zlefevre', cn: 'Zoé Lefèvre', sn: 'Lefèvre', givenName: 'Zoé', mail: 'zoe.lefevre@example.test', telephoneNumber: '+33 1 23 45 67 05', ou: 'Comptabilité' },
  { uid: 'mpetit', cn: 'Marc Petit', sn: 'Petit', givenName: 'Marc', mail: 'marc.petit@example.test', telephoneNumber: '+33 1 23 45 67 06', ou: 'Support' }
]

const NUMBER_ATTRS = new Set(['telephonenumber', 'mobile', 'homephone', 'facsimiletelephonenumber'])

/** Decodes the \xx escapes a filter value may carry (bytes of UTF-8), then folds case and accents. */
const unescape = v => {
  const bytes = []
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && /^[0-9a-fA-F]{2}$/.test(v.slice(i + 1, i + 3))) {
      bytes.push(parseInt(v.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(...Buffer.from(v[i], 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}
const fold = (attr, v) => (NUMBER_ATTRS.has(attr) ? v.replace(/[\s-]/g, '') : v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase())

const matches = (filter, entry) => {
  const kind = filter.constructor.name
  if (kind === 'AndFilter') return filter.clauses.every(c => matches(c, entry))
  if (kind === 'OrFilter') return filter.clauses.some(c => matches(c, entry))
  if (kind === 'NotFilter') return !matches(filter.filter, entry)
  const attr = filter.attribute.toLowerCase()
  const values = (entry[attr] ?? []).map(v => fold(attr, v))
  if (kind === 'PresenceFilter') return values.length > 0
  if (kind === 'EqualityFilter') return values.includes(fold(attr, unescape(filter.value)))
  if (kind === 'SubstringFilter') {
    const initial = fold(attr, unescape(filter.initial ?? ''))
    const final = fold(attr, unescape(filter.final ?? ''))
    const any = (filter.any ?? []).map(a => fold(attr, unescape(a)))
    return values.some(v => {
      if (!v.startsWith(initial) || !v.endsWith(final)) return false
      let at = initial.length
      for (const a of any) {
        const i = v.indexOf(a, at)
        if (i < 0) return false
        at = i + a.length
      }
      return at <= v.length - final.length
    })
  }
  throw new Error(`mock LDAP: unsupported filter ${kind}`)
}

/** Starts the server on `port` (0 for any). Resolves with the URL and a stop function. */
export const startLdapMock = ({ port = 0, people = PEOPLE } = {}) =>
  new Promise((resolve, reject) => {
    const server = ldap.createServer()
    server.bind(READER_DN, (req, res, next) => {
      if (req.credentials !== READER_PASSWORD) return next(new ldap.InvalidCredentialsError())
      res.end()
      return next()
    })
    server.search(BASE_DN, (req, res, next) => {
      // ldapjs compares requested attribute names as typed against lower-cased entry keys: ask it in lower case.
      res.attributes = res.attributes.map(a => a.toLowerCase())
      let sent = 0
      for (const p of people) {
        const attributes = { objectClass: ['inetOrgPerson'], ...p }
        const entry = Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v : [v]]))
        if (!matches(req.filter, entry)) continue
        if (req.sizeLimit && sent >= req.sizeLimit) {
          res.end(4) // sizeLimitExceeded: the entries already sent are kept by the client
          return next()
        }
        res.send({ dn: `uid=${p.uid},${BASE_DN}`, attributes })
        sent++
      }
      res.end()
      return next()
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address()
      resolve({ url: `ldap://127.0.0.1:${actual}`, stop: () => new Promise(r => server.close(r)) })
    })
  })
