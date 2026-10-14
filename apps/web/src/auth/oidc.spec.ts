import { describe, expect, it } from 'vitest'
import type { User } from 'oidc-client-ts'
import { bearerOf, displayNameFor, displayNameOf } from './oidc.js'

const user = (over: Partial<User>): User => ({ access_token: 'a.b.c', id_token: 'i.d.t', profile: { sub: 'alice' }, ...over } as unknown as User)

describe('bearerOf', () => {
  it('sends a JWT access token as is', () => {
    expect(bearerOf(user({}))).toBe('a.b.c')
  })
  it('falls back to the ID token when the access token is opaque', () => {
    expect(bearerOf(user({ access_token: 'opaque' }))).toBe('i.d.t')
  })
})

describe('displayNameOf', () => {
  it('prefers name, then preferred_username, then email, then sub', () => {
    expect(displayNameOf(user({ profile: { sub: 'alice', name: 'Alice Martin' } as User['profile'] }))).toBe('Alice Martin')
    expect(displayNameOf(user({ profile: { sub: 'alice', preferred_username: 'amartin' } as User['profile'] }))).toBe('amartin')
    expect(displayNameOf(user({ profile: { sub: 'alice', email: 'a@x.fr' } as User['profile'] }))).toBe('a@x.fr')
    expect(displayNameOf(user({}))).toBe('alice')
  })
})

describe('displayNameFor', () => {
  const alice = user({ profile: { sub: 'alice', name: 'Alice Martin' } as User['profile'] })
  it('prefers a real name from the Gateway directory', () => {
    expect(displayNameFor({ id: 'alice', displayName: 'Alice M. (LDAP)' }, alice)).toBe('Alice M. (LDAP)')
  })
  it('falls back to the identity provider when the Gateway only knows the id', () => {
    expect(displayNameFor({ id: 'alice', displayName: 'alice' }, alice)).toBe('Alice Martin')
    expect(displayNameFor(null, alice)).toBe('Alice Martin')
  })
  it('shows what it has when nobody is signed in', () => {
    expect(displayNameFor({ id: 'alice', displayName: 'alice' }, null)).toBe('alice')
    expect(displayNameFor(null, null)).toBe('')
  })
})
