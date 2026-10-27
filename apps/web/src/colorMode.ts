/** Where MUI keeps the colour mode it applies (`modeStorageKey` of its ThemeProvider, which twake-mui does not change). */
export const MODE_KEY = 'mui-mode'
/** Which scheme MUI applies in light mode (`colorSchemeStorageKey`-light): `dark` there would darken the light mode. */
export const LIGHT_SCHEME_KEY = 'mui-color-scheme-light'

/**
 * The app is light: it offers no choice of theme, so a mode stored by an earlier version (`system`, which made the app
 * dark on a dark operating system) or by anything else goes, and the provider falls back on its default (light). When
 * a theme setting comes, its explicit choice is what stays. Storage refused (private window, blocked site data):
 * nothing to do.
 */
export const forgetStoredMode = (given?: Pick<Storage, 'getItem' | 'removeItem'>) => {
  try {
    // Reading `localStorage` itself throws where site data is blocked.
    const storage = given ?? globalThis.localStorage
    if (!storage) return
    if (storage.getItem(MODE_KEY) !== 'light') storage.removeItem(MODE_KEY)
    if (storage.getItem(LIGHT_SCHEME_KEY) !== 'light') storage.removeItem(LIGHT_SCHEME_KEY)
  } catch {
    // ponytail: no storage, no stored mode
  }
}
