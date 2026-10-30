# ADR 0032 : TwakePhone dans Twake Workplace, par une coquille Cozy qui l'encadre

Date : 2026-10-30. État : proposée. Décidée à l'étape 9 du plan, dans le fil de discussion du projet (« faire ce qu'il manque pour arriver au niveau du POC ») ; précise l'ADR 0006 (app autonome) et s'appuie sur l'ADR 0031 (`/?dial=`) ; remplacé par : aucun.

## Contexte

Le POC était une app Cozy dans Twake Workplace : TwakePhone dans la grille d'apps et sous la barre Twake, l'intent `CALL` qui rendait cliquable un numéro de Drive, Contacts ou Mail (`@twake/phone-link`). L'ADR 0006 a remplacé l'app Cozy par une app web autonome (OIDC) et l'a retirée à la PR 3c : depuis, TwakePhone n'est plus dans Workplace, et `phone-link` ouvre une app qui n'existe plus. La fiche produit « Integrated Softphone » (TWP-633) et la réponse au CCTP CANUT §7.4.6.2 demandent pourtant les deux : un écran « Softphonie » dans Workplace, et le click-to-call sur tout numéro affiché.

Twake Workplace a une forme pour les apps qui ont leur propre service : la **coquille** (`cozy-twakechat`, `cozy-twakemail`), une vraie app Cozy qui affiche la barre Twake et encadre le service à l'adresse d'un drapeau (`client_url_flag`, `<slug>.embedded-app-url`), avec `cozy-external-bridge-container` pour lui transmettre le chemin.

## Scénario de démo (écrit avant le code)

1. L'administrateur installe l'app `phone` et règle le drapeau `phone.embedded-app-url` sur l'adresse de TwakePhone ; TwakePhone autorise l'instance à l'encadrer (`FRAME_ANCESTORS`).
2. Alice ouvre « Twake Phone » dans la grille : la barre Twake, et TwakePhone dessous. Elle clique « Se connecter » : une fenêtre du fournisseur d'identité s'ouvre et se ferme (SSO), TwakePhone est connecté dans le cadre.
3. Dans Drive, Alice clique un numéro (`phone-link`) : TwakePhone, ouvert à côté, a ce numéro dans son clavier ; rien n'est composé tant qu'elle n'appuie pas sur « Appeler ». Sans TwakePhone à l'écran, un onglet Twake Phone s'ouvre sur le numéro.

## Décisions

### 1. Une coquille, pas une seconde application

`apps/workplace` reprend `cozy-twakechat` (même licence) : `manifest.webapp` (slug `phone`, `client_url_flag: phone.embedded-app-url`), barre Twake (`cozy-bar`), et TwakePhone (`apps/web`) dans une iframe `allow="microphone; autoplay; clipboard-write"`. Aucune dépendance Cozy n'entre dans `apps/web` ; l'ADR 0006 tient (app autonome, OIDC). Comme les apps Cozy, la coquille a son propre lockfile, hors des workspaces ; elle prend `toDialTarget` dans `packages/telephony-client` construit, par alias. Elle attend les drapeaux avant son premier rendu (sans quoi elle dirait « non configuré »).

### 2. Encadré, TwakePhone se connecte dans une fenêtre

Un fournisseur d'identité refuse d'être encadré (LemonLDAP::NG le fait par défaut). Encadrée (`window.self !== window.top`), l'app ouvre la connexion dans une fenêtre nommée `twakephone-signin` (`signinPopup`), au clic de la personne ; la page de retour dans cette fenêtre rend la réponse au cadre (`signinPopupCallback`) et se ferme, le cadre termine l'échange. Hors cadre, rien ne change (redirection).

### 3. Click-to-call : l'intent `CALL` passe le numéro à une fenêtre visible, sinon l'app s'ouvre dessus

`phone-link` crée l'intent `CALL` (`io.twake.phone.number`). Le service de la coquille (`/intents`) valide le numéro (`toDialTarget`) et le confie, par un `BroadcastChannel` de son origine, à une fenêtre Twake Phone **visible** (un verrou Web Lock choisit une seule fenêtre) ; celle-ci le poste à son cadre (`postMessage` `twakephone.dial`, vers l'origine de TwakePhone), qui ne l'accepte que de son parent et ouvre `/?dial=` (ADR 0031 : rempli, jamais composé). Une fenêtre en arrière-plan ne le prend pas : elle remplirait un clavier que personne ne voit. Sans fenêtre visible (400 ms), `phone-link` ouvre la coquille sur `#/bridge/?dial=<numéro>`, que le pont transmet au cadre comme `/?dial=`.

## Ce qui reste

- **Le widget** (`@twake/phone-widget`, carte d'appel et appel entrant dans l'app hôte) : son service n'existe pas. La notification Web Push de l'étape 5 montre déjà un appel entrant quand on est dans Drive ; contrôler un appel en cours sans quitter Drive demande le widget, une PR à part.
- **Les apps hôtes** : Drive, Contacts et Mail n'utilisent pas encore `phone-link` ; c'est hors de ce dépôt.
- **Essai réel** : la popup sur LemonLDAP::NG (un `Cross-Origin-Opener-Policy` qui couperait le lien entre la popup et le cadre), et la publication sur le registre Cozy (`cozyPublish`, jeton d'éditeur), ne sont pas faites. L'e2e joue un faux cozy-stack et un fournisseur d'identité de test.
- **Notifications dans un cadre** : un navigateur qui isole le stockage des cadres tiers abonne le cadre à part de l'onglet autonome ; les notifications d'appel s'activent dans l'app ouverte seule (Réglages).

## Conséquences

- `phone-link` ouvre `#/bridge/?dial=` au lieu de `#/dialer?dial=` (l'app du POC).
- `yarn e2e:web` reste l'e2e de l'app ; `apps/workplace/test/workplace.e2e.mjs` joue la coquille (faux cozy-stack, app web servie par son serveur de production, connexion par la fenêtre, lien `#/bridge/?dial=`, intent `CALL` avec et sans fenêtre visible, texte refusé), dans un job CI à part.
- `FRAME_ANCESTORS` de TwakePhone doit nommer les origines de l'app `phone` des instances.

## Alternatives écartées

Remettre l'app Cozy du POC (deux applications à tenir, ADR 0006). Un intent qui compose (le POC le faisait en mode CTI ; ici un lien ne compose jamais, ADR 0031). Relayer à une fenêtre en arrière-plan (un clavier rempli que personne ne voit). La connexion dans le cadre par redirection (refusée par le fournisseur d'identité).
