# ADR 0030 : deux interfaces rtpengine, interne et externe, choisies par côté d'appel

Date : 2026-10-20. Révisé : 2026-11-14. État : proposée. Remplacé par : aucun. Précise l'ADR 0016 (trunk) et l'ADR 0018 (média vers LiveKit SIP).

## Contexte

rtpengine démarrait avec une seule interface (`RTPENGINE_INTERFACE`, par exemple `192.168.65.3!54.36.52.8`, privée `!` publique, derrière un NAT 1:1) et le script ne disait jamais quel côté lui faisait face : toutes les offres portaient l'adresse publique. Sur un appel réel avec OVHcloud, le côté opérateur marchait, mais l'ICE vers un navigateur du même réseau local n'aboutissait jamais (le NAT ne rend pas l'adresse publique). Sans effet quand les navigateurs sont sur Internet (le pilote).

## Décision

- Deux interfaces nommées `internal` et `external` : `RTPENGINE_INTERFACE_INTERNAL` et `RTPENGINE_INTERFACE_EXTERNAL`, chacune sous la forme `adresse` ou `privée!publique`. Les deux ou aucune : une seule arrête rtpengine et OpenSIPS au démarrage. Avec elles, `RTPENGINE_INTERFACE` est ignorée ; sans elles, rien ne change.
- `route[rtp_flags]` reçoit le genre du côté d'où vient l'offre et celui du côté où elle va, et ajoute `in-iface=<d'où> out-iface=<où>` (clé `direction` du protocole ng ; `direction=a direction=b` envoie deux clés du même nom et rtpengine n'en lit qu'une, mesuré).
- `external` pour l'opérateur (genre 1), `internal` pour tout le reste : navigateurs (0), LiveKit SIP (2), postes et messagerie de Wazo.
- Sont couverts : l'offre initiale, l'offre dans un 2xx (INVITE sans SDP, ou re-INVITE de l'opérateur), celle de la messagerie et celle d'un parcours Wazo (ADR 0028). Une réponse ne le dit pas : rtpengine retient les interfaces de l'offre. Un test exige que tout appel de `route[rtp_flags]` autre que celui de la réponse donne les deux genres.
- Une seule variable partagée, `rtp_directions` (0 ou 1, `RTPENGINE_DIRECTIONS` calculée par `entrypoint.sh`) ; à 0, rien n'est ajouté. Pas de route de plus (OpenSIPS 3.6 en plafonne le nombre à 99).
- Trois déploiements : navigateurs sur Internet (une interface, inchangé) ; navigateurs du réseau local derrière un NAT et opérateur sur Internet (`INTERNAL=<privée>`, `EXTERNAL=<privée>!<publique>`) ; CI (`127.0.0.1` et `127.0.0.2`, vérifié par `trunk.sip.mjs`).

## Compromis

- Gagné : chaque côté reçoit l'adresse qu'il joint, avec un seul rtpengine.
- Perdu / coût : un navigateur sur Internet reçoit l'adresse interne et ne la joint pas quand les deux interfaces sont données ; les deux interfaces partagent la plage de ports (`RTPENGINE_PORT_MIN` à `_MAX`), à ouvrir sur les deux adresses.
- Limite connue : le déploiement mixte (navigateurs des deux côtés) n'est pas couvert, il faudrait choisir l'interface par navigateur ; pas fait. Le test de CI prouve l'adresse de chaque côté, pas le NAT, qui n'est vérifié que par un appel réel.

## Alternatives écartées

- `interface=` sur chaque offre : ne vise qu'un côté, il en faut deux.
- Deux rtpengine, un par réseau : deux processus, deux plages, et le choix se fait avant de connaître l'autre côté.
- Candidats ICE de toutes les interfaces dans toutes les offres : l'ordre dépend du navigateur et l'opérateur, sans ICE, n'en prend qu'une.
- Une interface et réécriture dans le NAT (hairpin) : dépend du routeur, hors du dépôt.

## Code

`docker/opensips/opensips.cfg.tpl` (`route[rtp_flags]`, `rtp_directions`), `docker/opensips/entrypoint.sh`, `apps/web/test/trunk.sip.mjs`.
