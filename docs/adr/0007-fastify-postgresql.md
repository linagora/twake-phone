# ADR 0007 : passerelle Fastify en TypeScript et PostgreSQL

Date : 2026-10-13. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun.

## Contexte

La Twake Telephony Gateway du POC est en Fastify 5 et TypeScript, avec un `Store` à contrat partagé (mémoire et PostgreSQL), OpenAPI, WebSocket d'événements, auth Cozy ou OIDC, secrets SIP par utilisateur chiffrés en AES-256-GCM.

## Décision

- La passerelle TwakePhone est cette passerelle, conservée (`apps/gateway`, `fastify` ^5, `pg` ^8).
- PostgreSQL est le seul stockage de production ; le `MemoryStore` sert aux tests. PostgreSQL sert aussi à OpenSIPS (`OPENSIPS_DB_URL`) : une base, des tables des deux côtés.
- Les secrets sont référencés par `env:NOM` dans la configuration ; les secrets SIP sont chiffrés par `SECRETS_KEY` (`apps/gateway/src/crypto.ts`).
- Tout nouveau comportement de stockage s'ajoute au contrat `apps/gateway/src/store/contract.ts`, qui tourne contre la mémoire et PostgreSQL (`TEST_DATABASE_URL`).
- L'appartenance des appels, en mémoire dans le POC, passera en base puis en Redis pour plusieurs réplicas (lot Exploitation, non fait).

## Compromis

- Gagné : un contrat de stockage testé deux fois ; un seul langage de la passerelle au navigateur ; Fastify ([MIT](https://github.com/fastify/fastify)) et PostgreSQL ([licence PostgreSQL](https://github.com/postgres/postgres/blob/master/COPYRIGHT)) sont libres.
- Perdu / coût : Node n'est pas fait pour tenir des états d'appel en mémoire entre réplicas ; la passerelle est un seul processus en l'état.
- Limite connue : pas de redondance de la passerelle ni de PostgreSQL ; rien n'a été mesuré en charge.

## Alternatives écartées

- Réécrire en NestJS ou en Go : rien à gagner, les tests à refaire.

## Code

`apps/gateway/src`, `apps/gateway/src/store/contract.ts`, `apps/gateway/src/store/pg.ts`.
