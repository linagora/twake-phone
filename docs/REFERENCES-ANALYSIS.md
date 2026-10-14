# Analyse des références Twake pour Twake Phone

Analyse faite pendant le POC sur des dépôts clonés (shallow) par son script de mise en place, retiré à la PR 3c : `twake-drive`, `twake-workplace-docker`, `twake-guidelines`, `cozy-app-template`, `cozy-twakechat`, `cozy-contacts`.

## 1. Constats clés

| Sujet | Ce que fait Twake aujourd'hui | Conséquence pour Twake Phone |
|---|---|---|
| Forme d'app | Deux formes : *pure cozy app* (backend = cozy-stack, ex. Drive) ou *coquille* (`client_url_flag` = `<slug>.embedded-app-url`, ex. Chat). Source : `twake-guidelines/skills/twake-create-app` | Twake Phone = **pure cozy app** côté UI (cozy-client + doctypes), le Gateway étant un service externe. Le flag `phone.gateway-url` (nom à valider) donne l'URL du Gateway. |
| Scaffold | `cozy/cozy-app-template` (rsbuild + `rsbuild-config-cozy-app`), pas `create-cozy-app` | Partir du template. |
| Stack UI | Drive : React 18.2, `cozy-ui` 142, `cozy-ui-plus`, `@linagora/twake-icons`, `twake-i18n`, `cozy-client` 60.x, `cozy-realtime`, `cozy-flags`, `cozy-intent`, `cozy-interapp`, `cozy-bar` 36 | Même set de versions. `twake-react-app` vise React 19 + twake-mui mais **bloqué** (twake-mui déclare react ^18) : rester sur React 18 + cozy-ui. |
| Auth | Le token cozy est injecté dans `data-cozy` du DOM (`{domain, token, locale}`) ; `new CozyClient({uri, token, appMetadata, schema})`. SSO = LemonLDAP-NG (OIDC provider, `auth.<domain>/oauth2/*`), instances créées par SCIM | Pas de login propre. Le Gateway doit valider l'identité Twake : voir §3. |
| Intents | Manifest : `intents: [{action, type[], href}]` + route `/intents` + entrée rsbuild `hasIntents: true`. Service côté fournisseur : `new Intents({client}).createService(intentId, window)` (`cozy-interapp`) puis `notifyReadyToUse()` / `terminate(result)`. Drive expose OPEN/PICK `io.cozy.files`, Contacts expose PICK/CREATE/LIST `io.cozy.contacts` | `CALL` n'existe pas dans le catalogue Cozy : à définir (cf. §2). |
| Temps réel | `RealtimePlugin` de `cozy-realtime` + `cozy-flags` plugin enregistrés dans `registerClientPlugins.js` | Le flux d'événements d'appel vient du Gateway (WS), pas de cozy-realtime. |
| Contacts | doctype `io.cozy.contacts`, champ `phone: [{number, type, label, primary}]` | Résolution numéro → contact via cozy-client ; permission `io.cozy.contacts` GET. |
| CSP | Prod stricte (`connect-src` self) ; dev souvent `--disable-csp` | **Le Gateway (REST/WS) et les `wss://` SIP devront être autorisés dans la CSP du contexte cozy-stack**, ou proxifiés sous le domaine de l'instance. Point bloquant à traiter tôt. |
| Dev env | `twake-workplace-docker` : `./wrapper.sh up --drive -d`, `COZY_DEV_APP_SLUG` + `COZY_DEV_APP_BUILD` dans `.env`, `scripts/twake users add` (SCIM), `install-dev-app.sh`, URL `https://user1-<slug>.twake.local`. Ne jamais utiliser `serve --dev`. | Ajouter `phone` comme app dev ; la stack contient déjà **LiveKit** (`meet_app`, `livekit.<domain>`, clé API de dev) et un OIDC RP `meet` dans `lmConf-1.json` → modèle pour déclarer un RP `telephony-gateway`. |
| Qualité | `AGENTS.md` Drive : `useQuery` pour toute donnée cozy, pas de `fetch` ad hoc vers la stack, `AppLinker` pour les liens inter-apps, strings dans toutes les locales, tests RTL sans snapshot, Sentry obligatoire (`errors.cozycloud.cc`), AGPL-3.0 | S'applique à l'UI. Le Gateway n'est pas couvert par ces guidelines (Node/TS ou Go : libre). |

## 2. Intent CALL — proposition

Manifest de `phone` :

```json
"intents": [
  { "action": "CALL", "type": ["io.twake.phone.number"], "href": "/intents" }
],
"routes": { "/intents": { "folder": "/intents", "index": "index.html", "public": false } }
```

Côté appelant : `new Intents({client}).create('CALL', 'io.twake.phone.number', { number: '+33612345678' })` (cozy-interapp), ouvert en iframe/service. Le service Phone lance l'appel via le Gateway puis `terminate`.

Réserves à valider :
- `type` d'un intent est un nom de doctype dans la convention Cozy ; un pseudo-doctype `io.twake.phone.number` est cohérent avec ça mais n'est pas dans le registre officiel.
- Une iframe d'intent est éphémère : **la réception d'appels (cahier §85) ne peut pas vivre dans l'iframe**. Il faut un singleton persistant (service worker + onglet Phone, ou composant monté dans la cozy-bar/Home). C'est le point d'architecture le plus risqué : à prototyper avant tout le reste.
- `PhoneLink` : paquet partagé (cf. `cozy-ui-plus`) qui normalise en E.164 (libphonenumber-js), appelle l'intent, et sinon retombe sur un lien `tel:`.

## 3. Authentification vers le Gateway

Options compatibles avec la stack existante :
1. **JWT/OIDC via LemonLDAP** : déclarer un RP `telephony-gateway` (comme `meet` dans `lmConf-1.json`), le Gateway valide les tokens via `auth.<domain>/oauth2/jwks`. Le front obtient un token par flux OIDC silencieux. Option cible, cohérente avec Meet.
2. **Token cozy** (celui de `data-cozy`) validé par le Gateway auprès de cozy-stack (`/settings/...`). Plus simple, mais couple le Gateway à cozy-stack.

Recommandation : 1, avec `tenant` dérivé du domaine/org de l'instance (`COZY_ORG_ID`).

## 4. Meet / LiveKit

`meet_app` fournit déjà LiveKit (`livekit.<domain>:7880`, UDP 7881), backend Django LaSuite Meet (`ALLOW_UNREGISTERED_ROOMS: False`, clé API de dev) et frontend LinTO. **Aucun LiveKit SIP n'est présent** : il faut ajouter `livekit/sip` + Redis (déjà `valkey`) à la stack, et un Asterisk de dev. La création de salle Meet passe par le backend Django : le Gateway devra soit appeler son API, soit utiliser directement l'API LiveKit (clé/secret) en mappant `code → room`. À trancher.

## 5. Plan de démarrage suggéré

1. Scaffold `twake-phone/app` depuis `cozy-app-template` ; manifest (slug `phone`, `name_prefix: Twake`, permissions `io.cozy.contacts` GET, apps, settings, banners) ; branché dans `twake-workplace-docker` via `COZY_DEV_APP_*`.
2. Monorepo : `packages/telephony-types`, `telephony-client`, `provider-sdk`, `gateway`, `provider-asterisk`, `conference-livekit` (choix « monorepo possible » du §104).
3. **Spike** (1) singleton d'appel entrant persistant, (2) CSP + WSS Gateway/SIP, (3) token OIDC → Gateway. Ces trois risques conditionnent le reste.
4. Gateway MVP : `/me`, `/capabilities`, `/calls`, `/events` WS, présence ; provider Asterisk (ARI + PJSIP WebRTC) en Docker.
5. UI : dialer, appel en cours piloté par capabilities, historique, présence/DND, intent CALL + `PhoneLink`, puis Meet dial-in/out.

## 6. Questions ouvertes

- Langage du Gateway (TS/Node aligne avec `telephony-client` et les types partagés ; Go/FastAPI possibles).
- Où héberger le singleton de réception d'appels (voir §2).
- Pseudo-doctype et nom de flag à faire valider par l'équipe Twake/Cozy.
- React 18 (aujourd'hui) vs 19 + twake-mui (cible, bloquée).
