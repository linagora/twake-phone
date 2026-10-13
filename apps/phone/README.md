# Twake Phone (application)

Application Twake/Cozy du clavier, des récents, de la présence et de l'appel en cours. Elle parle à la **Twake Telephony Gateway** (`apps/gateway`) et, quand le fournisseur le permet, porte l'audio dans le navigateur (softphone SIP.js, `packages/softphone`).

Elle expose deux intents (voir `manifest.webapp`) : `CALL` (rendre un numéro appelable depuis une autre application, via `@twake/phone-link`) et `OPEN` sur `io.twake.phone.widget` (carte d'appel compacte montée dans les autres applications, voir [docs/WIDGET.md](../../docs/WIDGET.md)).

## Développer

Une app Cozy est autonome : son propre `yarn install`. Les paquets `@twake/*` du monorepo ne sont pas installés mais résolus vers leur build (`rsbuild.config.mjs`, `jest.config.js`) : lancer d'abord `yarn install && yarn build` à la racine.

```bash
yarn install
yarn build        # dossier build/, monté dans cozy-stack par la stack de dev (voir README racine)
yarn watch        # reconstruit à chaque modification
yarn test         # jest
yarn lint         # eslint (cozy-app + react-compiler)
```

L'URL du Gateway vient du flag `phone.gateway-url` (cozy-flags). Sans le stack Twake, `test/preview.mjs` rend l'interface avec de faux services et enregistre des captures d'écran.

## Où est quoi

| Dossier | Rôle |
|---|---|
| `src/telephony/` | `PhoneProvider` (état de la téléphonie, actions, softphone), services, historique, formats |
| `src/components/` | écrans et composants (`Views/Dialer`, `Views/Recents`, `Views/Meetings`, `CallView`, `Widget`…) |
| `src/targets/intents/` | point d'entrée des intents (widget, relais CALL) |
| `src/locales/` | `en.json`, `fr.json` : toute chaîne visible passe par `t()` |
| `test/` | utilitaires de test, aperçu visuel, hôte cozy-interapp réel pour le widget |

Licence AGPL-3.0.
