# Contribuer à TwakePhone

## Le cycle

1. Une fonctionnalité ou un correctif = une branche depuis `main` = une PR. Rien n'est poussé sur `main` directement.
2. La PR suit le gabarit (`.github/pull_request_template.md`) : avant, après, comment, étape du plan, preuves.
3. La CI (`.github/workflows/ci.yml`) joue build, typecheck (specs comprises), lint (ESLint, `eslint.config.mjs`), tests unitaires et contrat de stockage sur PostgreSQL, puis les e2e de l'app web et de la stack SIP.
4. Une revue indépendante « roast » est menée par un relecteur sans le contexte de l'auteur, avec consigne de chercher ce qui casse. Chaque constat est corrigé ou reçoit une réponse argumentée dans la PR.
5. À la fin d'une étape du plan (README), les e2e de la stack Docker sont joués et le scénario de démo est rejoué avant fusion.

Une décision d'architecture prise ou changée dans une PR donne un ADR dans `docs/adr/`.

Ce que le dépôt n'enforce pas encore et qui est à régler par un administrateur : protection de la branche `main` (PR obligatoire, CI verte, une approbation) et scan de secrets en CI. Jusque-là, les cases « revue faite » et « aucun secret » du gabarit sont déclaratives.

## Avant d'ouvrir une PR

Node 24 et plus (`@linagora/twake-css` le demande ; `.nvmrc`).

```bash
yarn install && yarn build
yarn typecheck && yarn lint && yarn test   # packages, Gateway, app web (lint après build : l'app web et les specs lisent les dist des paquets)
yarn e2e:web                           # app web dans Chromium, sans Docker (une fois : npx playwright-core install chromium)
```

Les trois doivent être verts. `yarn e2e:sip` demande la stack SIP en Docker Compose : voir le [README](README.md).

## Conventions

- **Frontières** : aucune notion d'un fournisseur hors de son `packages/provider-*` (OpenSIPS, OVHcloud à l'étape 10, Wazo à l'étape 11), aucune notion LiveKit/Meet hors `packages/conference-livekit`. Le Gateway et l'application ne parlent que le modèle de `telephony-types`.
- **Application** (`apps/web`) : React 18, aucune chaîne visible en dur (`fr` et `en` ensemble), tests Testing Library sans instantanés.
- **Gateway** : toute lecture ou écriture de données passe par le `Store` avec le tenant ; un nouveau comportement de stockage s'ajoute au contrat partagé (`src/store/contract.ts`), qui tourne contre la mémoire et PostgreSQL (`TEST_DATABASE_URL`).
- **Tests** : un test n'est jamais désactivé ni mis en quarantaine pour passer. Un test qui simule le réseau ne remplace pas un essai réel. Pour tout ce qui touche au serveur SIP, au média ou à l'authentification, ajouter ou étendre une étape de `yarn e2e:sip` ou de `yarn e2e:web`. Les erreurs de type `tsc` d'un fichier de test font échouer le build Docker du Gateway : toujours lire la sortie complète d'un `docker compose build`.
- **Secrets** : jamais dans le dépôt, jamais dans un `.env` commité ; les valeurs de démonstration de la stack SIP de dev (`docker/`) sont signalées comme telles.
- **Commits** : [Conventional Commits](https://www.conventionalcommits.org), à l'impératif.
