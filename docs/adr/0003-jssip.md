# ADR 0003 : JsSIP remplace SIP.js

Date : 2026-10-13. État : acceptée.

## Contexte

Le POC utilise SIP.js 0.21.2, sans version depuis octobre 2022. JsSIP (MIT) est maintenu (3.13, mai 2026) et sip_ua, prévu pour le mobile, en est le port Dart.

## Décision

`packages/softphone` est réécrit avec JsSIP à l'étape 3. SIP.js disparaît du dépôt à cette étape.

## Conséquences

- Une seule sémantique SIP entre web et mobile.
- Les risques à valider à l'étape 3 (attente, transfert supervisé par REFER avec Replaces, DTMF, périphériques) le sont avec JsSIP.

## Alternatives écartées

Garder SIP.js : projet dormant. SDK Linphone (liblinphone) : GPLv3 et code natif, refusé pour le mobile par Clement.
