# ADR 0011 : la passerelle écoute OpenSIPS par son interface d'événements, le CDR fait foi

Date : 2026-10-14. État : acceptée. Décidée à la PR 4a (étape 4), dans le fil de discussion du projet, après une sonde sur la stack locale ; remplacé par : aucun.

## Contexte

Le softphone fait les appels tout seul (ADR 0002, 0010) : la passerelle ne les voit pas. Or la présence des collègues (libre, en communication, absent), l'historique des appels et, plus tard, le click-to-call, les renvois et la supervision demandent qu'elle sache ce qui se passe sur le serveur SIP. OpenSIPS offre plusieurs moyens : un `event_route` qui appelle un script, des requêtes HTTP vers un serveur (`event_http`... ou `rest_client` depuis le script), des notifications poussées (`event_datagram`, `event_rabbitmq`, `event_jsonrpc`), ou le polling de son interface de gestion (MI).

## Décision

OpenSIPS **pousse** ses événements à la passerelle, et la passerelle les lui **demande** par MI :

- **Événements** (`event_datagram`) : des notifications JSON-RPC sur UDP, vers l'adresse que la passerelle a donnée en s'abonnant (`event_subscribe` par MI, abonnement renouvelé à mi-vie). Les événements écoutés : les enregistrements du module `usrloc` (`E_UL_CONTACT_INSERT`, `E_UL_CONTACT_DELETE`, `E_UL_AOR_DELETE`), trois événements à nous levés par la configuration (`E_TWAKEPHONE_CALLING` à l'INVITE routé, `E_TWAKEPHONE_RINGING` au premier 180/183, `E_TWAKEPHONE_ANSWERED` au 200 de l'INVITE initial), et ceux du module `acc` (`E_ACC_CDR` à la fin d'un appel répondu, avec sa durée ; `E_ACC_MISSED_EVENT` pour un appel qui n'a pas abouti, avec le code SIP final). Chacun porte l'appelant et l'appelé **tels que composés** (`$fU`, `$rU` avant `lookup`), pas les contacts.
- **MI** (`mi_datagram`, JSON-RPC sur UDP, sur la boucle locale) : l'abonnement, puis à chaque (ré)abonnement la relecture de l'état (`ul_dump` pour les enregistrements, `dlg_list` pour les dialogues en cours) plutôt qu'une reconstruction à partir d'événements peut-être manqués.
- **CDR en base** (`acc`, tables `acc` et `missed_calls`, créées avec `subscriber` par `SUBSCRIBER_SCHEMA`) : la référence des appels passés, écrite par OpenSIPS lui-même, indépendante de la passerelle.
- Dans `provider-opensips`, un **suivi pur** (`CallTracker`, sans entrée-sortie, testé avec les événements tels qu'OpenSIPS les envoie) traduit tout cela en événements neutres du contrat de provider : `call.created`, `call.ringing`, `call.connected`, `call.ended` (ou `call.failed`) pour chacune des deux parties, et `presence.changed` par poste. La présence effective d'un poste : **en communication** dès qu'un appel le concerne (même si son enregistrement a expiré entre-temps), sinon **hors ligne** sans enregistrement, sinon ce que la personne a choisi (`PUT /me/presence` : absent, ne pas déranger…), sinon **disponible**. Un appel abandonné par l'appelant pendant la sonnerie (487) ou non répondu est **manqué** pour l'appelé ; refusé (486, 603) il est **refusé** pour les deux ; un poste sans contact (404) ou mort (477) ne l'apprend pas, seul l'appelant lit l'échec.
- Côté passerelle, la présence est l'affaire de **tout le tenant** : `GET /presence` la donne par poste, et `presence.changed` est diffusé à chaque WebSocket du tenant (avec le poste), quand un appel n'est dit qu'à ses deux parties.

## Conséquences

- Un socket UDP par passerelle, sur la boucle locale par défaut (`OPENSIPS_EVENTS_LISTEN` pour une autre adresse) : OpenSIPS et la passerelle tournent sur la même machine ou le même réseau hôte. Un déploiement qui les sépare ouvre ce port entre eux, en UDP, sans chiffrement : à garder sur un réseau interne. Les événements ne portent ni secret ni média.
- UDP perd parfois un datagramme : un appel dont la fin n'arrive pas reste « en communication » jusqu'à la relecture suivante (`dlg_list` à chaque réabonnement après une coupure) ou cinq heures (plus que le délai maximal d'un dialogue dans OpenSIPS). `E_ACC_CDR` donne la durée exacte, quoi qu'il soit arrivé aux événements intermédiaires.
- OpenSIPS oublie ses abonnés quand il redémarre : l'abonnement est renouvelé toutes les 60 s (vie de 120 s) et chaque retour relit l'état. Sans abonnement, `/ready` dit la passerelle `DEGRADED` ; les appels passent toujours (ils ne dépendent pas d'elle).
- L'historique (`call_history`) est désormais alimenté par ces événements, pour les deux parties de chaque appel, avec l'instant de la réponse. `acc` et `missed_calls` restent la référence brute, à consulter pour un audit ; une reprise de l'historique depuis ces tables (après une longue absence de la passerelle) n'est pas faite.
- Les événements et la présence ne distinguent pas les fenêtres d'une même personne (plusieurs contacts d'un poste) : « disponible » dès qu'une est enregistrée.
- Un seul consommateur par provider (`subscribe()`), celui de la passerelle ; plusieurs réplicas de passerelle s'abonneraient chacun et bâtiraient chacun leur présence, sans la partager : le bus d'événements Redis prévu pour l'exploitation multi-réplicas (ARCHITECTURE §3) devra aussi porter la présence.
- Les renvois, le NPD planifié (4b) et les groupes (4c) s'appuient sur la même mécanique : une règle en base lue par OpenSIPS, un événement vers la passerelle.

## Alternatives écartées

- `event_route` ou `rest_client` depuis le script OpenSIPS vers l'API de la passerelle : une requête HTTP (synchrone pour `rest_client`) par événement dans le chemin de signalisation, et une authentification à gérer côté OpenSIPS ; le datagramme ne bloque rien.
- `event_rabbitmq` ou `event_jsonrpc` (TCP) : une pièce de plus (un broker), ou une connexion TCP qu'OpenSIPS ouvre vers la passerelle et qu'il faut exposer ; à reconsidérer avec les réplicas, où un broker servirait aussi de bus.
- Lire `acc` en base plutôt que les événements : donne l'historique, pas la présence ni le temps réel.
- Faire porter la présence par le module `presence` d'OpenSIPS (SUBSCRIBE/NOTIFY, RFC 3856) et le softphone : la présence des collègues serait dans le navigateur, pas dans la passerelle, qui en a besoin pour les renvois et Twake Chat.
