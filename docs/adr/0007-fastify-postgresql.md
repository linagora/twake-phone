# ADR 0007 : passerelle Fastify et PostgreSQL

Date : 2026-10-13. État : acceptée.

## Contexte

La Twake Telephony Gateway du POC est en Fastify 5 et TypeScript, avec un `Store` à contrat partagé (mémoire et PostgreSQL), OpenAPI, WebSocket d'événements, auth Cozy ou OIDC, secrets SIP par utilisateur chiffrés en AES-256-GCM.

## Décision

La passerelle TwakePhone est cette passerelle, conservée telle quelle. PostgreSQL est le seul stockage de production ; le `MemoryStore` sert aux tests. Les secrets sont référencés par `env:NOM` dans la configuration.

## Conséquences

- Tout nouveau comportement de stockage s'ajoute au contrat `src/store/contract.ts`, qui tourne contre la mémoire et PostgreSQL (`TEST_DATABASE_URL`).
- L'appartenance des appels, en mémoire dans le POC, passera en base puis en Redis pour plusieurs réplicas (lot Exploitation).

## Alternatives écartées

Réécrire en NestJS ou en Go : rien à gagner, les tests à refaire.
