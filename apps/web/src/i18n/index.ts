import en from './en.json'
import fr from './fr.json'

export type Lang = 'fr' | 'en'
export type Key = keyof typeof fr

const DICTS: Record<Lang, Record<string, string>> = { fr, en }
const STORAGE_KEY = 'twakephone.lang'

export const LANGS: Lang[] = ['fr', 'en']

/** Browser language, then French: the first deployments are French administrations. */
export const detectLang = (navigatorLang = typeof navigator === 'undefined' ? 'fr' : navigator.language, stored?: string | null): Lang => {
  if (stored === 'fr' || stored === 'en') return stored
  return navigatorLang.toLowerCase().startsWith('en') ? 'en' : 'fr'
}

export const readStoredLang = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export const storeLang = (lang: Lang) => {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // Private mode or blocked storage: the choice lasts for the session only.
  }
}

/** Translates a key, substituting {name} placeholders. A missing key shows the key itself, never a blank. */
export const translate = (lang: Lang, key: Key, params: Record<string, string | number> = {}): string => {
  const text = DICTS[lang][key] ?? DICTS.fr[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`))
}
