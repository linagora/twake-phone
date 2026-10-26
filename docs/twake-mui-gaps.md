# What twake-mui lacks for TwakePhone

The web app (`apps/web`) draws everything with `@linagora/twake-mui` 18 (MUI 9), `@linagora/twake-icons` and the
`.u-*` classes of `@linagora/twake-css`. What they do not offer lives in `apps/web/src/ds/` or is noted here, meant to
move to [twake-ui](https://github.com/linagora/twake-ui) and disappear from the app.

| Gap | Where | Meanwhile | What twake-ui would need |
|---|---|---|---|
| `NavLink` is a `div` with `role="button"`, moved by `onClick`; its styled root drops Emotion's `as` | sidebar, `components/Layout.tsx` | `ds/NavRouteLink`: NavLinkRoot's styles on react-router's `NavLink` (a real link, `aria-current`, `.active` for `NavItem`) | `NavLink` taking a `component` prop |
| `Nav` renders a `<nav>` that takes no name | sidebar | `aria-label` on `Sidebar` (`<aside>`) | `Nav` passing its `aria-*` to the `<nav>` |
| `Content` sets `role="main"` inside `Main`, which is a `<main>`: two main landmarks | `components/Layout.tsx` | `role={undefined}` on `Content` | No role on `Content` |
| No skip link (RGAA 12.7) | `components/Layout.tsx` | `ds/SkipLink` | A `SkipLink` component |
| twake-icons writes a `<style>` as it loads, with no way to give it a CSP nonce | every page | its SHA-256 in the app's `style-src` (`server/policy.mjs`, checked against the installed package by `policy.spec.mjs`) | A nonce option, or the rules shipped in `twake-css` |
| The package's ESM imports its own files without extensions: Node refuses them | unit tests | `server.deps.inline` for twake-mui in `vitest.config.ts` | Extensions in the built imports |
| The barrel pulls `pdf-lib`, `react-markdown`, `react-virtuoso`…: the vendor chunk of the build is about 1.3 MB (360 kB gzip) | build | nothing | `sideEffects: false` and per-component entry points |
| `TwakeMuiThemeProvider` takes no Emotion cache, so no CSP nonce | `src/main.tsx` | `CacheProvider` with a cache built from the page's `<meta name="csp-nonce">` around the provider | A `nonce` (or `cache`) prop |
| The theme draws no visible keyboard focus on buttons and links (MUI's faint ripple halo only; fields keep their border) | every page | `ds/FocusRing`: a 3 px `primary.dark` outline on `:focus-visible`, as global styles | A focus ring in the theme (RGAA 10.7) |
| The `success`, `warning` and `error` `main` shades are below 3:1 on white (2.2:1, 2.3:1, 3.6:1) where `Chip`, outlined `Button` and `Fab` use them for text, borders or icons; white on the primary button is 3.65:1; a pressed `Fab` (`primary.light`) hardly stands out | presence and phone state chips (`presence.tsx`, `components/Layout.tsx`), admin status chips, the call screen's round buttons (`components/CallPanel.tsx`) | the colours as the theme gives them (Typography takes only the `main` shade of a palette without `sx`); « Manqué » and « Nouveau » are bold besides | `main` shades at 4.5:1 for text (3:1 for borders and icons), or components that use `dark` for text (RGAA 3.2, 3.3) |
| Below 1024 px `Sidebar` becomes a fixed bottom bar with `overflowX: hidden`: six entries (with Supervision and Administration) are cut at 320 px, and the bar may cover the end of the page | `components/Layout.tsx` | the theme as it is (to check on a phone) | A bottom bar that scrolls or folds extra entries into a menu, and pads the content above it (RGAA 10.11) |
| Buttons are 40 px high; the app's targets were 44 px | every page | the theme's 40 px | A 44 px minimum, or a size for touch screens |
| twake-icons has no play, pause, microphone or hang-up icon | voicemail player, call screen (`pages/Voicemail.tsx`, `components/CallPanel.tsx`) | `ds/MediaIcons`: `SvgIcon` paths | `Play`, `Pause`, `Mic`, `MicOff` and `CallEnd` icons |
