# ADR 0010 : transferts par REFER et Replaces de bout en bout, OpenSIPS reste un proxy

Date : 2026-10-14. État : acceptée. Décidée à la PR 3b (étape 3), dans le fil de discussion du projet, après le e2e à trois navigateurs ; remplacé par : aucun.

## Contexte

Le plan tenait le transfert supervisé en WebRTC pour le risque technique de l'étape 3 : un REFER avec `Replaces` doit traverser OpenSIPS (module `dialog`) et rtpengine, et le navigateur qui reçoit l'INVITE avec `Replaces` doit le rattacher au bon dialogue. Le repli envisagé était un transfert piloté par la passerelle (interface MI d'OpenSIPS, ou un B2BUA).

## Décision

Les transferts sont faits par les softphones eux-mêmes, en SIP standard, et OpenSIPS les relaie sans les comprendre :

- transfert direct : le transférant met son correspondant en attente, lui envoie un REFER (RFC 3515) vers le poste visé ; le correspondant appelle ce poste comme un appel à lui, rend compte par NOTIFY (100, 180, 200 ou l'échec), et le transférant raccroche quand l'appel est passé, ou reprend son correspondant si le poste visé n'a pas répondu ;
- transfert supervisé : le transférant consulte le poste visé par un second appel (le premier est mis en attente automatiquement), puis envoie à son premier correspondant un REFER dont le `Refer-To` porte `Replaces` avec le dialogue de la consultation (RFC 3891, RFC 5589). Le correspondant appelle le poste visé avec cet en-tête ; le navigateur visé reconnaît le dialogue à remplacer, répond sans sonner et raccroche la consultation.

Côté OpenSIPS : REFER et NOTIFY sont des requêtes en dialogue (`match_dialog()` les admet, `fix_nated_contact` les fait suivre au bon WebSocket), l'INVITE avec `Replaces` est un appel initial comme un autre (authentifié, `lookup("location")`, rtpengine) : aucune logique de transfert dans la configuration. rtpengine ne voit que des appels ordinaires qui naissent et meurent.

Le e2e à trois navigateurs (`apps/web/test/sip.e2e.mjs`) joue les deux transferts, l'abandon d'une consultation et un transfert vers un poste absent (404 rendu au transférant), avec des paquets RTP comptés des deux côtés après chaque transfert.

## Conséquences

- Un flux audio par appel dans le softphone (deux appels au plus : celui en cours et celui en attente) ; l'attente automatique à la consultation.
- Le navigateur qui reçoit un REFER le suit sans demander : seul le correspondant d'un appel établi peut le lui envoyer, et OpenSIPS ne relaie en dialogue que les dialogues qu'il a créés.
- Un transfert vers l'extérieur (trunk, étape 6) ou depuis un poste non SIP-standard (Wazo, étape 11) passera par le même REFER tant que l'autre bout le comprend ; un trunk qui ne l'accepte pas obligera OpenSIPS à le prendre en charge lui-même (B2BUA ou `uac_replace`), ce qui sera tranché à ce moment-là.
- Pas de « transfert aveugle sans attente » ni de transfert d'un appel qui sonne encore : la personne décroche d'abord.

## Alternatives écartées

- Transfert piloté par la passerelle (MI, B2BUA) : une pièce de plus, un état d'appel à maintenir côté serveur, pour un besoin que les navigateurs couvrent déjà en SIP standard ; gardé comme repli pour les trunks.
- Faire porter `Replaces` par OpenSIPS (`dialog` + `topology_hiding`) : masque les identités de dialogue aux navigateurs, sans intérêt sur une plateforme où tous les postes sont les siens.
