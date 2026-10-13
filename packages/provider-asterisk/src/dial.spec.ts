import { describe, expect, it } from 'vitest'
import { externalDialString } from './index.js'

const fr = { context: 'minipbx-internal', e164Prefix: '+33', nationalPrefix: '0' }

describe('externalDialString', () => {
  it('turns a number of the PBX country into the national form its dialplan matches', () => {
    expect(externalDialString('+33612345678', fr)).toBe('0612345678')
    expect(externalDialString('+33142000000', fr)).toBe('0142000000')
  })

  it('turns any other country into the 00 international form, which such a dialplan can block', () => {
    expect(externalDialString('+4930123456', fr)).toBe('004930123456')
    expect(externalDialString('+14155550100', fr)).toBe('0014155550100')
  })

  it('leaves a non-E.164 string alone', () => {
    expect(externalDialString('0612345678', fr)).toBe('0612345678')
  })
})
