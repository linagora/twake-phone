# ADR 0002 : softphone dans le navigateur, Linphone desktop retiré

Date : 2026-10-13. État : acceptée.

## Contexte

Le mémoire LINAGORA prévoyait Linphone sur le poste (principe d'« étanchéité » : aucune pile SIP dans Twake). Le POC montre qu'un softphone WebRTC dans le navigateur fonctionne (enregistrement WSS, appel, attente, plusieurs fenêtres).

## Décision

Le client sur le poste est le softphone de l'application TwakePhone, en WebRTC. Linphone desktop n'est plus livré ni provisionné.

## Conséquences

- Rien à installer sur le poste ; provisioning par la session Twake.
- Même pile que le mobile à venir (sip_ua, port Dart de JsSIP).
- Écart avec le mémoire à annoncer au bénéficiaire. Linphone et tout client SIP standard restent utilisables sur OpenSIPS pour les postes qui exigent un client lourd.
- La réception d'appel sans onglet ouvert devient un sujet à part (Web Push, étape 5).

## Alternatives écartées

Linphone desktop provisionné par XML : un client de plus à déployer, deux piles à maintenir.
