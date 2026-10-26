/** Where MUI keeps the colour mode it applies (`modeStorageKey` of its ThemeProvider, which twake-mui does not change). */
export const MODE_KEY = 'mui-mode'

/**
 * The app is light unless someone chose otherwise. An earlier version stored `system` here, which made the app dark
 * on a dark operating system: that value goes, so the provider falls back on its default (light). An explicit `light`
 * or `dark` is kept. Storage refused (private window, blocked site data): nothing to do.
 */
export const forgetSystemMode = (given?: Pick<Storage, 'getItem' | 'removeItem'>) => {
  try {
    // Reading `localStorage` itself throws where site data is blocked.
    const storage = given ?? globalThis.localStorage
    if (storage?.getItem(MODE_KEY) === 'system') storage.removeItem(MODE_KEY)
  } catch {
    // ponytail: no storage, no stored mode
  }
}
