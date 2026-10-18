# ADR 0005 : Wazo Platform derrière OpenSIPS, à l'étape 11

Date : 2026-10-13. État : acceptée. Décidé dans le fil de discussion du projet du 13 octobre 2026 ; remplacé par : aucun ; précisé par l'ADR 0022 (messagerie, étape 11a).

## Contexte

Cinq exigences du CCTP CANUT §7.4.6.2 demandent un serveur média : messagerie vocale, SVI, files d'attente, enregistrement, supervision. OpenSIPS seul ne les couvre pas. Le responsable produit voulait Wazo seulement s'il est open source et sans licence : Wazo Platform est GPLv3 et gratuit.

## Décision

Wazo Platform est l'étape 11 du plan, obligatoire pour la recette, et non « si besoin ». Il se place derrière OpenSIPS, qui passe de `registrar` à `mid_registrar` ; `provider-wazo` (wazo-calld, wazo-confd, wazo-websocketd) remplace alors les règles `dialplan` d'OpenSIPS pour les renvois et les groupes.

Précisé par l'ADR 0022 (2026-10-18) : pas de `mid_registrar` pour la messagerie (11a), il vient avec 11c, quand Wazo devra faire sonner les navigateurs (files, groupes séquentiels) ; les renvois et les groupes simultanés restent à OpenSIPS, qui seul décide du chemin d'un appel (deux serveurs décideraient sinon du même appel).

## Conséquences

- Le MVP web (étapes 1 à 10) se fait sans IPBX.
- La messagerie vocale transcrite par LinTO et le bot Matrix arrivent avec Wazo.
- Wazo est québécois : la souveraineté vient de la licence, de l'hébergement et de la maîtrise du code, pas du pays de l'éditeur.

## Alternatives écartées

XiVO (même lignée, gouvernance désormais canadienne), Asterisk brut (pas d'API métier), FreeSWITCH + FusionPBX (changement de cœur), Yate (sans version stable depuis 2021).
