import { describe, expect, it } from 'vitest'
import { detectLang, translate } from './index.js'
import en from './en.json'
import fr from './fr.json'

describe('i18n', () => {
  it('has the same keys in French and English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort())
  })

  it('substitutes placeholders and keeps unknown ones visible', () => {
    expect(translate('fr', 'auth.extension', { extension: '101' })).toBe('Poste 101')
    expect(translate('en', 'auth.error', {})).toBe('Sign-in failed: {reason}')
  })

  it('prefers the stored language, then the browser, then French', () => {
    expect(detectLang('en-GB', 'fr')).toBe('fr')
    expect(detectLang('en-US', null)).toBe('en')
    expect(detectLang('de-DE', null)).toBe('fr')
    expect(detectLang('de-DE', 'xx')).toBe('fr')
  })
})
