# Contribuer à TwakePhone

## Le cycle

1. Une fonctionnalité ou un correctif = une branche depuis `main` = une PR. Rien n'est poussé sur `main` directement.
2. La PR suit le gabarit (`.github/pull_request_template.md`) : avant, après, comment, étape du plan, preuves.
3. La CI (`.github/workflows/ci.yml`) joue build, typecheck, tests unitaires et contrat de stockage sur PostgreSQL, puis lint, tests et build de l'app.
4. Une revue indépendante « roast » est menée par un relecteur sans le contexte de l'auteur, avec consigne de chercher ce qui casse. Chaque constat est corrigé ou reçoit une réponse argumentée dans la PR.
5. À la fin d'une étape du plan (README), les e2e de la stack Docker sont joués et le scénario de démo est rejoué avant fusion.

Une décision d'architecture prise ou changée dans une PR donne un ADR dans `docs/adr/`.

## Avant d'ouvrir une PR

```bash
yarn install && yarn build
yarn typecheck && yarn test            # packages et Gateway
(cd apps/phone && yarn lint && yarn test)
```

Les trois doivent être verts. Les tests d'intégration (`yarn e2e:*`, `docker/meet-sip/platform.e2e.mjs`) demandent la stack de dev : voir le [README](README.md).

## Conventions

- **Frontières** : aucune notion d'un fournisseur hors de son `packages/provider-*` (Asterisk aujourd'hui, OpenSIPS à l'étape 4, OVHcloud à l'étape 10, Wazo à l'étape 11), aucune notion LiveKit/Meet hors `packages/conference-livekit`. Le Gateway et l'application ne parlent que le modèle de `telephony-types`.
- **Application** (`apps/phone`) : celles des guidelines Twake (React 18, cozy-ui, `useQuery` pour les données Cozy, aucune chaîne visible en dur : `en.json` et `fr.json` ensemble, tests Testing Library sans instantanés).
- **Gateway** : toute lecture ou écriture de données passe par le `Store` avec le tenant ; un nouveau comportement de stockage s'ajoute au contrat partagé (`src/store/contract.ts`), qui tourne contre la mémoire et PostgreSQL (`TEST_DATABASE_URL`).
- **Tests** : un test n'est jamais désactivé ni mis en quarantaine pour passer. Un test qui simule le réseau ne remplace pas un essai réel. Pour tout ce qui touche à Meet, LiveKit, au PBX ou à l'authentification, ajouter ou étendre une étape de `docker/meet-sip/platform.e2e.mjs` ou de `yarn e2e:live`. Les erreurs de type `tsc` d'un fichier de test font échouer le build Docker du Gateway : toujours lire la sortie complète d'un `docker compose build`.
- **Secrets** : jamais dans le dépôt. `docker/.env` est ignoré, `docker/.env.example` liste ce qu'il faut ; les valeurs de démonstration de la stack de dev sont signalées comme telles.
- **Commits** : [Conventional Commits](https://www.conventionalcommits.org), à l'impératif.

## Dépôts de référence et correctifs

`references/` n'est pas versionné : `scripts/setup-references.sh` y clone la stack Twake, Drive et MiniPBX à des révisions précises et applique `docker/stack/*.patch`. Pour modifier un correctif, éditez le dépôt cloné puis régénérez le patch :

```bash
git -C references/twake-workplace-docker diff -- cozy_stack meet_app twake_auth/docker-compose.yml > docker/stack/twake-workplace-docker.patch
```
