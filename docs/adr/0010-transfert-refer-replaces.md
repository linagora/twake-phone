# ADR 0010 : transferts par REFER et Replaces de bout en bout, OpenSIPS reste un proxy

Date : 2026-10-14. État : acceptée. Décidée à la PR 3b (étape 3), dans le fil de discussion du projet, après le e2e à trois navigateurs ; remplacé par : aucun.

## Contexte

Le plan tenait le transfert supervisé en WebRTC pour le risque technique de l'étape 3 : un REFER avec `Replaces` doit traverser OpenSIPS (module `dialog`) et rtpengine, et le navigateur qui reçoit l'INVITE avec `Replaces` doit le rattacher au bon dialogue. Le repli envisagé était un transfert piloté par la passerelle (interface MI d'OpenSIPS, ou un B2BUA).

## Décision

Les transferts sont faits par les softphones eux-mêmes, en SIP standard, et OpenSIPS les relaie sans les comprendre :

- transfert direct : le transférant met son correspondant en attente, lui envoie un REFER (RFC 3515) vers le poste visé ; le correspondant appelle ce poste comme un appel à lui, rend compte par NOTIFY (100, 180, 200 ou l'échec), et le transférant raccroche quand l'appel est passé, ou reprend son correspondant si le poste visé n'a pas répondu ;
- transfert supervisé : le transférant consulte le poste visé par un second appel (le premier est mis en attente automatiquement), puis envoie à son premier correspondant un REFER dont le `Refer-To` porte `Replaces` avec le dialogue de la consultation (RFC 3891, RFC 5589). Le correspondant appelle le poste visé avec cet en-tête ; le navigateur visé reconnaît le dialogue à remplacer, répond sans sonner et raccroche la consultation.

Côté OpenSIPS : REFER et NOTIFY sont des requêtes en dialogue (`match_dialog()` les admet ; elles atteignent le bon WebSocket par le `Route` posé à l'INVITE et la cible distante du dialogue, `fix_nated_contact` ne corrigeant que le `Contact` qu'elles porteraient), l'INVITE avec `Replaces` est un appel initial comme un autre (authentifié, `lookup("location")`, rtpengine) : aucune logique de transfert dans la configuration. rtpengine ne voit que des appels ordinaires qui naissent et meurent.

Le e2e à trois navigateurs (`apps/web/test/sip.e2e.mjs`) joue les deux transferts, l'abandon d'une consultation (par le transférant, par le collègue, et vers un poste absent) et un transfert vers un poste absent (404 rendu au transférant, en français), avec des paquets RTP comptés des deux côtés après chaque transfert.

## Conséquences

- Un flux audio par appel dans le softphone (deux appels au plus : celui en cours et celui en attente) ; l'attente automatique à la consultation.
- Le navigateur qui reçoit un REFER le suit sans demander, à deux conditions qu'il vérifie lui-même : le `Refer-To` nomme un poste ou un numéro composable (mêmes caractères qu'au clavier) de son propre domaine SIP, et il n'a pas déjà deux appels ; sinon il refuse (NOTIFY 603). Il recopie le `Referred-By` reçu dans l'INVITE qu'il passe (RFC 3892), pour que le poste visé sache qui a demandé l'appel. Seul le correspondant d'un appel établi peut lui envoyer un REFER, et OpenSIPS ne relaie en dialogue que les dialogues qu'il a créés (Call-ID et les deux tags, aléatoires). À l'étape 6 (trunk), un `Refer-To` vers un numéro externe devra passer par la politique d'appel sortant de la passerelle (anti-fraude) avant d'être suivi : le domaine local seul ne suffira plus à le borner.
- Un transfert attend au plus 30 s le rapport du correspondant (NOTIFY final) ; passé ce délai, ou si le correspondant raccroche avant, le transférant reprend son appel et lit pourquoi. Raccrocher pendant un transfert reste possible (le correspondant poursuit vers le poste visé) ; raccrocher la consultation pendant un transfert supervisé ne l'est pas (c'est son dialogue que le poste visé remplace).
- Une consultation qui finit sans transfert (poste absent, refus, collègue qui raccroche, abandon) rend automatiquement l'appel mis en attente au transférant.
- Avec deux appels, pas de va-et-vient entre les deux (reprendre l'un pendant que l'autre est en communication) : la consultation est une parenthèse courte, on la termine ou on transfère. À revoir si le besoin remonte du pilote.
- Un transfert vers l'extérieur (trunk, étape 6) ou depuis un poste non SIP-standard (Wazo, étape 11) passera par le même REFER tant que l'autre bout le comprend ; un trunk qui ne l'accepte pas obligera OpenSIPS à le prendre en charge lui-même (B2BUA ou `uac_replace`), ce qui sera tranché à ce moment-là.
- Pas de « transfert aveugle sans attente » ni de transfert d'un appel qui sonne encore : la personne décroche d'abord.

## Alternatives écartées

- Transfert piloté par la passerelle (MI, B2BUA) : une pièce de plus, un état d'appel à maintenir côté serveur, pour un besoin que les navigateurs couvrent déjà en SIP standard ; gardé comme repli pour les trunks.
- Faire porter `Replaces` par OpenSIPS (`dialog` + `topology_hiding`) : masque les identités de dialogue aux navigateurs, sans intérêt sur une plateforme où tous les postes sont les siens.
