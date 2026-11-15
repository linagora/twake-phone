# ADR 0005 : Wazo Platform derrière OpenSIPS, pour la messagerie, le SVI, les files et l'enregistrement

Date : 2026-10-13. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun. Précisé par : ADR 0022 (messagerie, 11a), ADR 0027 (`mid_registrar` et lignes, 11c-1), ADR 0028 (parcours), ADR 0029 (enregistrement), ADR 0036 (un tenant Wazo par organisation en SaaS). Décidé dans le fil de discussion du projet du 13 octobre 2026.

## Contexte

Cinq exigences du CCTP CANUT §7.4.6.2 demandent un serveur média : messagerie vocale, SVI, files d'attente, enregistrement, supervision. OpenSIPS seul ne les couvre pas. Le responsable produit voulait Wazo seulement s'il est open source et sans licence : Wazo Platform est GPL-3.0 ([source](https://github.com/wazo-platform/wazo-platform)) et gratuit.

## Décision

- Wazo Platform est l'étape 11 du plan, obligatoire pour la recette, et non « si besoin ». Il se place derrière OpenSIPS.
- OpenSIPS passe de `registrar` à `mid_registrar` pour les extensions qui ont une ligne chez Wazo (ADR 0027, éteint sans `WAZO_LINES=1`). Pas de `mid_registrar` pour la messagerie seule (11a, ADR 0022) ; il vient avec 11c, quand Wazo fait sonner les navigateurs.
- `provider-wazo` (wazo-calld, wazo-confd, wazo-websocketd) tient les parcours et la messagerie.
- OpenSIPS seul décide du chemin d'un appel : les renvois et groupes simultanés restent chez lui (`call_rules`, `call_groups`, ADR 0013 et 0014). Deux serveurs décideraient sinon du même appel. Écart : l'ADR d'origine disait que `provider-wazo` remplaçait les règles `dialplan` d'OpenSIPS pour les renvois et groupes ; le code ne l'a pas fait (renvois et groupes lus dans `call_rules` et `call_groups`, `opensips.cfg.tpl`).
- Un seul tenant Wazo : Wazo sait le multi-tenant, notre configuration n'en crée qu'un (`TWAKE_TENANT`, variable `WAZO_TWAKEPHONE_TENANT`, défaut `twakephone`, `docker/wazo/bootstrap.py:25`).

## Compromis

- Gagné : les cinq exigences sans écrire de serveur média ; le MVP web (étapes 1 à 10) se fait sans IPBX ; la messagerie transcrite par LinTO et le bot Matrix arrivent avec Wazo.
- Perdu / coût : un second moteur d'appel à exploiter ; Wazo est québécois, la souveraineté vient de la licence, de l'hébergement et de la maîtrise du code, pas du pays de l'éditeur.
- Limite connue : un seul tenant Wazo ; un appel de personne à personne n'a aucun canal chez Wazo, donc ni enregistrement ni supervision (ADR 0029).

## Alternatives écartées

- XiVO : même lignée, gouvernance désormais canadienne.
- Asterisk brut : pas d'API métier.
- FreeSWITCH + FusionPBX : changement de cœur.
- Yate : sans version stable depuis 2021.

## Code

`docker/wazo/bootstrap.py`, `packages/provider-wazo`, `docker/opensips/opensips.cfg.tpl` (route `wazo-lines`).
