import { describe, expect, it } from 'vitest'
import { parseConfig } from './config.js'

describe('parseConfig', () => {
  const ok = { gatewayUrl: 'https://phone.example.fr/', oidc: { authority: 'https://auth.example.fr', clientId: 'twakephone-web', scope: 'openid', resource: 'urn:gw' } }

  it('keeps the fields it knows and trims the gateway URL', () => {
    expect(parseConfig(ok)).toEqual({ gatewayUrl: 'https://phone.example.fr', oidc: { authority: 'https://auth.example.fr', clientId: 'twakephone-web', scope: 'openid', resource: 'urn:gw' } })
  })

  it('names the missing field', () => {
    expect(() => parseConfig({ ...ok, gatewayUrl: 'phone.example.fr' })).toThrow(/gatewayUrl/)
    expect(() => parseConfig({ ...ok, oidc: { ...ok.oidc, clientId: '' } })).toThrow(/clientId/)
    expect(() => parseConfig({ gatewayUrl: ok.gatewayUrl })).toThrow(/oidc/)
    expect(() => parseConfig('nope')).toThrow(/object/)
  })

  it('leaves optional fields out when absent', () => {
    expect(parseConfig({ gatewayUrl: 'http://gw', oidc: { authority: 'http://idp', clientId: 'c' } }).oidc).toEqual({ authority: 'http://idp', clientId: 'c' })
  })
})
