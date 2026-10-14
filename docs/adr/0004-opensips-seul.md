# ADR 0004 : OpenSIPS et rtpengine, seul serveur SIP du MVP web ; Flexisip retiré

Date : 2026-10-13. État : acceptée. Décidé dans le fil de discussion du projet du 13 octobre 2026 ; remplacé par : aucun.

## Contexte

Le POC branche le navigateur directement sur le PBX et déclare le trunk dans le PBX : aucun garde-fou (« un appel externe n'est pour l'instant limité par rien »). Le plan initial empilait Flexisip (frontal des clients) et un SBC.

## Décision

OpenSIPS 3.6 avec rtpengine est le seul serveur SIP du MVP web : registrar (`usrloc`), WSS des navigateurs, fourche multi-onglets, renvois et NPD (`dialplan`, `drouting`), groupes, trunk opérateur (`dispatcher`), anti-fraude (`fraud_detection`, `pike`, `ratelimit`), CDR (`acc`), événements vers la passerelle, HEP vers Homer. Flexisip est retiré. OpenSIPS 3.4 (LTS de mai 2023, trois ans de support) est en fin de vie depuis mai 2026 ([versions disponibles](https://opensips.org/about/available-versions/)), la 3.6 est la version de référence.

## Conséquences

- Un `provider-opensips` dans la passerelle (étape 4). `provider-asterisk` disparaît à ce moment.
- Pas de serveur média : messagerie vocale, SVI, files, enregistrement et supervision attendent Wazo (ADR 0005).
- Compétence OpenSIPS à acquérir ; Kamailio est le repli si l'équipe ne l'adopte pas.

## Alternatives écartées

Flexisip + IPBX dès le départ : un serveur SIP de plus pour rien dès que Linphone sort du jeu. Kamailio : pas d'interface d'administration des trunks maintenue.
