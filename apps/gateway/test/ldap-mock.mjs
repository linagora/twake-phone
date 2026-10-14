// A throwaway LDAP server for tests: a handful of inetOrgPerson entries, one reader account, no persistence.
import ldap from 'ldapjs'

export const BASE_DN = 'ou=people,dc=example,dc=test'
export const READER_DN = 'cn=reader,dc=example,dc=test'
export const READER_PASSWORD = 'reader-secret'

export const PEOPLE = [
  { uid: 'jdupont', cn: 'Jean Dupont', sn: 'Dupont', givenName: 'Jean', mail: 'jean.dupont@example.test', telephoneNumber: '+33 1 23 45 67 01', mobile: '+33 6 12 34 56 01', ou: 'Support', title: 'Technicien' },
  { uid: 'amartin', cn: 'Alice Martin', sn: 'Martin', givenName: 'Alice', mail: 'alice.martin@example.test', telephoneNumber: '+33 1 23 45 67 02', ou: 'Direction' },
  { uid: 'bdurand', cn: 'Bob Durand', sn: 'Durand', givenName: 'Bob', mail: 'bob.durand@example.test', telephoneNumber: ['+33 1 23 45 67 03', '+33 1 23 45 67 04'], mobile: '+33 6 12 34 56 03', ou: 'Support' }
]

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
      // Like a real server: attribute names are case-insensitive (ldapjs compares the requested ones as typed),
      // and values match case-insensitively (ldapjs matches them as typed).
      res.attributes = res.attributes.map(a => a.toLowerCase())
      const filter = ldap.parseFilter(req.filter.toString().toLowerCase())
      let sent = 0
      for (const p of people) {
        const attributes = { objectClass: ['inetOrgPerson'], ...p }
        const lowered = Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k.toLowerCase(), (Array.isArray(v) ? v : [v]).map(x => x.toLowerCase())]))
        if (filter.matches(lowered)) {
          if (req.sizeLimit && sent >= req.sizeLimit) break
          res.send({ dn: `uid=${p.uid},${BASE_DN}`, attributes })
          sent++
        }
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
