# ADR 0001 : partir du POC Twake Phone de Linagora

Date : 2026-10-13. État : acceptée.

## Contexte

Le POC <https://ci.linagora.com/tdelobelle/poc-twake-phone> (AGPL-3.0) a prouvé une passerelle de téléphonie neutre vis-à-vis du PBX (`provider-sdk`), un softphone navigateur, l'accès à Meet par téléphone avec dial-out, et une stack de dev avec de vrais appels SIP en e2e. Il diverge du besoin sur le PBX (Asterisk brut par ARI), l'absence de serveur SIP en bordure, la cible (Twake Workplace et non une app autonome) et la pile SIP navigateur (SIP.js).

## Décision

Le dépôt TwakePhone est créé à partir du code du POC, importé tel quel à l'étape 1, tests compris. Les étapes suivantes le font évoluer paquet par paquet. Le README du POC est conservé dans [docs/POC.md](../POC.md).

## Conséquences

- Les règles d'architecture du POC restent : aucune notion d'un fournisseur hors de son `provider-*`, aucune notion LiveKit ou Meet hors de `conference-livekit`.
- `provider-asterisk`, `softphone` (SIP.js) et l'app Cozy restent dans le dépôt jusqu'à leur remplacement (étapes 2 à 4), pour garder les e2e verts entre-temps.
- La licence reste AGPL-3.0.

## Alternatives écartées

Repartir de zéro : on aurait réécrit ce que le POC a déjà prouvé, sans ses tests.
