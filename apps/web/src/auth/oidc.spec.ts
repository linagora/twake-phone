import { describe, expect, it } from 'vitest'
import type { User } from 'oidc-client-ts'
import { DEFAULT_SCOPE, bearerOf, displayNameFor, displayNameOf, promptFor } from './oidc.js'

const user = (over: Partial<User>): User => ({ access_token: 'a.b.c', id_token: 'i.d.t', profile: { sub: 'alice' }, ...over } as unknown as User)

describe('bearerOf', () => {
  it('sends a JWT access token as is', () => {
    expect(bearerOf(user({}))).toBe('a.b.c')
  })
  it('never sends the ID token: an opaque access token is a configuration error, named as such', () => {
    expect(() => bearerOf(user({ access_token: 'opaque' }))).toThrow(/oidc\.resource/)
    expect(() => bearerOf(user({ access_token: 'a..c' }))).toThrow(/opaque/)
    expect(() => bearerOf(user({ access_token: '' }))).toThrow(/opaque/)
  })
})

describe('promptFor', () => {
  it('asks for consent when offline_access is in the scope, as OIDC Core requires for a refresh token', () => {
    expect(promptFor(DEFAULT_SCOPE)).toBe('consent')
    expect(promptFor('openid profile')).toBeUndefined()
  })
  it('lets config.json override it, an empty string meaning no prompt at all', () => {
    expect(promptFor(DEFAULT_SCOPE, '')).toBeUndefined()
    expect(promptFor('openid', 'login')).toBe('login')
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
