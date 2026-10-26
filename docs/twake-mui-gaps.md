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
| The theme draws no keyboard focus on buttons, fields and links (only `ListItemButton`) | every page | nothing: the theme as it is | A focus ring in the theme (RGAA 10.7) |
| Buttons are 40 px high; the app's targets were 44 px | every page | the theme's 40 px | A 44 px minimum, or a size for touch screens |
| twake-icons has no play, pause, microphone or hang-up icon | voicemail player, call screen (`pages/Voicemail.tsx`, `components/CallPanel.tsx`) | `ds/MediaIcons`: `SvgIcon` paths | `Play`, `Pause`, `Mic`, `MicOff` and `CallEnd` icons |
| `ListItem` has no "actions shown on hover" variant | lists of people (`components/ContactList.tsx`, `pages/Recents.tsx`, `pages/Voicemail.tsx`) | `ds/HoverActions`: the row's actions fade in on hover or focus with a fine pointer, always shown on a touch screen | A `secondaryActionOnHover` (or similar) on `ListItem` |
| No shared entrance preset: each app picks its own `Fade` timings | call panel, voicemail player (`components/CallPanel.tsx`, `pages/Voicemail.tsx`) | `ds/Appear`: `Fade`, ease-out in, nothing out | An `Appear` (or theme default transition props) |
| The theme keeps MUI's `motion.reducedMotion: 'never'`: transitions ignore `prefers-reduced-motion` | every transition | `themeOptions={{ motion: { reducedMotion: 'system' } }}` on `TwakeMuiThemeProvider` (`src/main.tsx`) | `reducedMotion: 'system'` in `makeTheme` |
