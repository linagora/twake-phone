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

Un fournisseur d'identité refuse en général d'être encadré (LemonLDAP::NG a une protection contre l'encadrement ; non vérifié sur une instance réelle). Encadrée (`window.self !== window.top`), l'app ouvre la connexion dans une fenêtre nommée `twakephone-signin` (`signinPopup`, `popupAbortOnClose` : fermée par la personne, la page le dit), au clic seulement : un navigateur bloque une fenêtre ouverte sans clic, donc l'app encadrée ne se connecte jamais d'elle-même (ouverte par la notification d'un appel, elle attend le clic). La page de retour dans cette fenêtre rend la réponse au cadre (`signinPopupCallback` : par `window.opener`, sinon par un `BroadcastChannel` d'oidc-client-ts) et se ferme ; le cadre termine l'échange. Hors cadre, rien ne change (redirection). La session encadrée se renouvelle par le jeton de rafraîchissement (`offline_access`, le défaut) : sans lui, oidc-client-ts essaierait un cadre caché chez le fournisseur, qui le refuse.

### 3. Click-to-call : l'intent `CALL` passe le numéro à une fenêtre visible, sinon l'app s'ouvre dessus

`phone-link` crée l'intent `CALL` (`io.twake.phone.number`). Le service de la coquille (`/intents`) valide le numéro (`toDialTarget`) et le confie, par un `BroadcastChannel` de son origine, à une fenêtre Twake Phone **visible**. La fenêtre qui obtient le verrou Web Lock de la demande le garde plus longtemps que la demande n'attend (une fenêtre qui l'entend en retard le trouve pris), le dit tout de suite (`dial-claim`), poste le numéro à son cadre (`twakephone.dial`, vers l'origine de TwakePhone) et attend sa réponse (`twakephone.dial-ack`, 1,5 s) : le cadre ne l'accepte que de son parent, ouvre `/?dial=` (ADR 0031 : rempli, jamais composé) et ne répond que s'il est connecté. Un navigateur sans Web Locks ne prend rien (il ne saurait le limiter à une fenêtre). Une fenêtre en arrière-plan ne le prend pas : elle remplirait un clavier que personne ne voit. Personne en 400 ms, ou un cadre qui ne répond pas : `phone-link` ouvre la coquille sur `#/bridge/?dial=<numéro>`, que le pont transmet au cadre comme `/?dial=`, dans un nouvel onglet coupé de la page (sans `opener`) ; un onglet bloqué par le navigateur est dit « non traité », jamais « ouvert ». Un intent qui ne répond pas en 4 s ouvre l'app de même (un navigateur n'ouvre un onglet que dans les 5 s qui suivent le clic).

Toute app de l'instance peut ainsi remplir le clavier : c'est le rôle de l'intent, et rien ne part sans « Appeler ».

## Ce qui reste

- **Le widget** (`@twake/phone-widget`, carte d'appel et appel entrant dans l'app hôte) : son service n'existe pas. La notification Web Push de l'étape 5 montre déjà un appel entrant quand on est dans Drive ; contrôler un appel en cours sans quitter Drive demande le widget, une PR à part.
- **Les apps hôtes** : Drive, Contacts et Mail n'utilisent pas encore `phone-link` ; c'est hors de ce dépôt.
- **Essai réel** : la popup sur LemonLDAP::NG (un `Cross-Origin-Opener-Policy` qui couperait le lien entre la popup et le cadre), et la publication sur le registre Cozy (`cozyPublish`, jeton d'éditeur), ne sont pas faites. L'e2e joue un faux cozy-stack et un fournisseur d'identité de test.
- **Le cloisonnement des navigateurs** : un `BroadcastChannel` et un verrou Web Lock sont cloisonnés par site de premier niveau. Si le domaine des instances est dans la liste des suffixes publics (`mycozy.cloud` l'est), Drive et Twake Phone sont deux sites : l'intent ne joint aucune fenêtre et l'app s'ouvre dans un onglet. Le délai pour ouvrir un onglet après le clic varie selon le navigateur (court dans Safari) : l'aller-retour de l'intent peut le dépasser, l'onglet est alors bloqué et dit « non traité ». L'e2e tourne sur un seul site, dans Chromium.
- **Notifications dans un cadre** : un navigateur qui isole le stockage des cadres tiers abonne le cadre à part de l'onglet autonome ; les notifications d'appel s'activent dans l'app ouverte seule (Réglages).

## Conséquences

- `phone-link` ouvre `#/bridge/?dial=` au lieu de `#/dialer?dial=` (l'app du POC).
- `yarn e2e:web` reste l'e2e de l'app ; `apps/workplace/test/workplace.e2e.mjs` joue la coquille (faux cozy-stack, app web servie par son serveur de production, connexion par la fenêtre, lien `#/bridge/?dial=`, intent `CALL` avec et sans fenêtre visible, texte refusé), dans un job CI à part.
- `FRAME_ANCESTORS` de TwakePhone doit nommer les origines de l'app `phone` des instances.

## Alternatives écartées

Remettre l'app Cozy du POC (deux applications à tenir, ADR 0006). Un intent qui compose (le POC le faisait en mode CTI ; ici un lien ne compose jamais, ADR 0031). Relayer à une fenêtre en arrière-plan (un clavier rempli que personne ne voit). La connexion dans le cadre par redirection (refusée par le fournisseur d'identité).
