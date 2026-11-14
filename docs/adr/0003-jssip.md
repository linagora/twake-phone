# ADR 0003 : JsSIP remplace SIP.js dans le softphone

Date : 2026-10-13. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun.

## Contexte

Le POC utilisait SIP.js 0.21.2, sans version depuis octobre 2022. JsSIP est maintenu (3.13, mai 2026) et `sip_ua`, prévu pour le mobile, en est le port Dart.

## Décision

- `packages/softphone` est réécrit avec JsSIP (`jssip` 3.13.8 dans `packages/softphone/package.json`) à l'étape 3. SIP.js a disparu du dépôt.
- Les risques validés avec JsSIP : attente, transfert supervisé par REFER avec Replaces (ADR 0010), DTMF, périphériques.

## Compromis

- Gagné : une seule sémantique SIP entre web et mobile ; une bibliothèque maintenue, licence MIT ([LICENSE.md](https://raw.githubusercontent.com/versatica/JsSIP/master/LICENSE.md)).
- Perdu / coût : API de bas niveau, plus de code de notre côté que dans un kit complet.
- Limite connue : JsSIP n'est pas un client de conférence ; la salle est faite côté serveur (ADR 0019).

## Alternatives écartées

- Garder SIP.js : projet dormant.
- SDK Linphone (liblinphone) : GPLv3 et code natif, refusé pour le mobile par le responsable produit.

## Code

`packages/softphone`.
