# ADR 0030 : Deux interfaces rtpengine, interne et externe, choisies par côté d'appel avec `in-iface=` et `out-iface=`

Date : 2026-10-20. État : proposée. Décidée à la PR `fix/rtpengine-interfaces`, après un appel réel sur un trunk OVHcloud (2026-10-20) ; précise l'ADR 0016 (trunk vers l'opérateur) et l'ADR 0018 (média vers LiveKit SIP) ; remplacé par : aucun.

## Contexte

rtpengine démarrait avec une seule interface, `RTPENGINE_INTERFACE`, par exemple `192.168.65.3!54.36.52.8` (adresse privée `!` adresse publique, derrière un NAT 1:1). Le script d'OpenSIPS n'indiquait jamais à rtpengine quelle interface faisait face à quel côté : **toutes les offres portaient l'adresse publique**, y compris celle d'un navigateur placé du même côté du NAT que la machine (réseau local, poste de test, même hôte).

Constaté sur un appel réel avec OVHcloud : le côté opérateur marchait (1219 paquets RTP reçus du serveur média d'OVH à travers le NAT), mais l'ICE vers le navigateur n'aboutissait jamais (« ICE/STUN response received, but source address didn't match remote candidate address ») : le navigateur envoyait ses contrôles à l'adresse publique, que le NAT ne lui rend pas, et rtpengine voyait une source qui n'était pas celle du candidat. Sans effet quand les navigateurs sont sur Internet (le pilote du README) : ils joignent l'adresse publique.

## Décision

### 1. Deux interfaces nommées, ou une seule comme avant

`RTPENGINE_INTERFACE_INTERNAL` et `RTPENGINE_INTERFACE_EXTERNAL`, chacune dans la forme de `RTPENGINE_INTERFACE` (`adresse` ou `privée!publique`), donnent deux interfaces rtpengine nommées `internal` et `external` (`--interface=internal/…`, `--interface=external/…`). **Les deux ou aucune** : une seule des deux arrête rtpengine et OpenSIPS au démarrage. Sans elles, rien ne change : `RTPENGINE_INTERFACE` seule, aucune interface dans les offres. Avec elles, `RTPENGINE_INTERFACE` est ignorée.

### 2. Le script dit, à chaque offre, quelle interface fait face à quel côté

Les côtés ont déjà un genre (`route[sides]`) : 0 un navigateur, 1 l'opérateur, 2 LiveKit SIP. `route[rtp_flags]` reçoit, en plus du genre du côté où va l'offre, celui du côté d'où elle vient, et ajoute `in-iface=<d'où> out-iface=<où>` (le module rtpengine d'OpenSIPS 3.6 en fait la clé `direction` du protocole ng ; `direction=a direction=b`, lui, envoie deux clés du même nom et rtpengine n'en lit qu'une : mesuré, les deux côtés restaient sur l'interface `internal`) : **`external` pour l'opérateur (genre 1), `internal` pour tout le reste** (navigateurs, LiveKit SIP, les postes et la messagerie de Wazo, qui sont du côté de la machine). Les quatre endroits qui font une offre le font : l'offre initiale, l'offre dans un 2xx (INVITE sans SDP, de l'appelant ou, en dialogue, de l'opérateur qui rafraîchit sa session : le 2xx vient alors du côté opposé à l'expéditeur) celle de la messagerie et celle d'un parcours d'appel Wazo (SVI, file, groupe ; ADR 0028). Un test exige que tout autre appel de `route[rtp_flags]` que celui de la réponse donne les deux genres. Une réponse ne le dit pas : rtpengine retient les interfaces de l'offre pour la réponse et les offres suivantes (documentation du protocole ng, clé `direction`).

### 3. Une seule variable partagée dans le script

`rtp_directions` (0 ou 1, `RTPENGINE_DIRECTIONS` calculée par `entrypoint.sh`) : à 0, `route[rtp_flags]` n'ajoute rien. Pas de route de plus (OpenSIPS 3.6 en plafonne le nombre à 99, un test le garde).

### 4. Les trois déploiements

- Navigateurs sur Internet (le pilote tel que `init.sh` l'écrit) : une interface, inchangé.
- Navigateurs sur le réseau local de la machine derrière un NAT, opérateur sur Internet : `RTPENGINE_INTERFACE_INTERNAL=<adresse privée>`, `RTPENGINE_INTERFACE_EXTERNAL=<privée>!<publique>`.
- La CI : `127.0.0.1` et `127.0.0.2` (deux adresses de la boucle locale), et `trunk.sip.mjs` prouve que le téléphone reçoit la première et l'opérateur la seconde, dans un appel vers lui et dans un appel de lui, et que LiveKit SIP et un navigateur sont sur la première.

## Conséquences

- Un navigateur du réseau local et l'opérateur sur Internet ont chacun l'adresse qu'ils joignent. C'est la seule façon, avec un seul rtpengine, de servir les deux côtés d'un NAT.
- Un navigateur qui est sur Internet **alors que** les deux interfaces sont données reçoit l'adresse interne et ne la joint pas : un déploiement mixte (des navigateurs des deux côtés) n'est pas couvert, il faudrait choisir l'interface par navigateur (adresse source du WebSocket). Pas fait.
- Les ports média viennent de la même plage pour les deux interfaces (`RTPENGINE_PORT_MIN` à `_MAX`) : le pare-feu ouvre la même plage sur les deux adresses.
- Le test de la CI ne prouve pas le NAT : il prouve que chaque côté reçoit l'adresse de son interface. Le NAT lui-même est vérifié par un appel réel.

## Alternatives écartées

- **`interface=` sur chaque offre, en une seule interface par appel** : rtpengine a besoin des deux côtés d'un appel avec deux réseaux différents ; `interface=` ne vise qu'un côté.
- **Deux rtpengine, un par réseau** : deux processus, deux plages, et le script doit en choisir un par appel avant de connaître l'autre côté.
- **Des candidats ICE de toutes les interfaces dans toutes les offres** : le navigateur essaierait l'adresse publique en premier ou en dernier selon son implémentation, et l'opérateur, sans ICE, n'en prend qu'une.
- **Rester en une interface et réécrire l'adresse dans le NAT (hairpin)** : dépend du routeur, hors de ce que le dépôt contrôle.
