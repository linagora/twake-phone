# ADR 0002 : softphone dans le navigateur, Linphone desktop retiré

Date : 2026-10-13. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun.

## Contexte

Le mémoire LINAGORA prévoyait Linphone sur le poste (principe d'« étanchéité » : aucune pile SIP dans Twake). Le POC montre qu'un softphone WebRTC dans le navigateur fonctionne : enregistrement WSS, appel, attente, plusieurs fenêtres.

## Décision

- Le client sur le poste est le softphone de l'application TwakePhone, en WebRTC (`packages/softphone`, JsSIP, ADR 0003).
- Linphone desktop n'est plus livré ni provisionné.
- Rien à installer sur le poste ; provisioning par la session Twake.
- Même pile que le mobile à venir (`sip_ua`, port Dart de JsSIP).
- Linphone et tout client SIP standard restent utilisables sur OpenSIPS pour les postes qui exigent un client lourd (non vérifié ici).
- La réception d'appel sans onglet ouvert devient un sujet à part : Web Push (ADR 0015).
- L'écart avec le mémoire est à annoncer au bénéficiaire.

## Compromis

- Gagné : zéro déploiement sur le poste ; une seule pile web et mobile.
- Perdu / coût : sans onglet ouvert, pas de sonnerie sans Web Push ; dépendance aux règles des navigateurs (micro, WebRTC).
- Limite connue : l'écart avec le mémoire n'est pas encore accepté par écrit.

## Alternatives écartées

- Linphone desktop provisionné par XML : un client de plus à déployer, deux piles à maintenir.

## Code

`packages/softphone`, `apps/web`.
