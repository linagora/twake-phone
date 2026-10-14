import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { detectLang, readStoredLang, storeLang, translate, type Key, type Lang } from './index.js'

interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: Key, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18n | null>(null)

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [lang, setLangState] = useState<Lang>(() => detectLang(undefined, readStoredLang()))
  const setLang = useCallback((l: Lang) => {
    storeLang(l)
    setLangState(l)
  }, [])
  // The document language follows the UI language, at load as well as on change (RGAA 8.3).
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const t = useCallback((key: Key, params?: Record<string, string | number>) => translate(lang, key, params), [lang])
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useT = (): I18n => {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT outside I18nProvider')
  return ctx
}
