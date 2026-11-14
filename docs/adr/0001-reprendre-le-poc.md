# ADR 0001 : partir du POC Twake Phone de Linagora

Date : 2026-10-13. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun. Décidé dans le fil de discussion du projet du 13 octobre 2026.

## Contexte

Le POC <https://ci.linagora.com/tdelobelle/poc-twake-phone> (AGPL-3.0) a prouvé une passerelle de téléphonie neutre vis-à-vis du PBX, un softphone navigateur, l'accès à Meet par téléphone avec dial-out, et une stack de dev avec de vrais appels SIP en e2e. Il diverge du besoin sur quatre points : PBX (Asterisk brut par ARI), pas de serveur SIP en bordure, cible (Twake Workplace, pas une app autonome), pile SIP navigateur (SIP.js).

## Décision

- Le dépôt TwakePhone est créé à partir du code du POC, importé tel quel à l'étape 1, tests compris. Les étapes suivantes le font évoluer paquet par paquet.
- Le README du POC est conservé dans `docs/POC.md`.
- Les règles d'architecture du POC restent : aucune notion d'un fournisseur hors de son `provider-*` (`provider-sdk`), aucune notion LiveKit ou Meet hors de `conference-livekit`.
- `provider-asterisk`, `softphone` (SIP.js) et l'app Cozy restaient dans le dépôt jusqu'à leur remplacement (étapes 2 à 4), pour garder les e2e verts. Écart : ils sont partis (`packages/` n'a plus `provider-asterisk`, `softphone` n'a plus SIP.js, `apps/` n'a plus `phone`).
- La licence reste AGPL-3.0.

## Compromis

- Gagné : les tests et les e2e du POC ne sont pas à refaire ; la neutralité vis-à-vis du PBX est acquise.
- Perdu / coût : on hérite de choix du POC (Fastify, `Store`, secrets chiffrés) sans les avoir discutés.
- Limite connue : l'AGPL-3.0 oblige à publier le code d'un service réseau modifié.

## Alternatives écartées

- Repartir de zéro : on aurait réécrit ce que le POC a déjà prouvé, sans ses tests.

## Code

`docs/POC.md`, `packages/provider-sdk`, `packages/conference-livekit`.
