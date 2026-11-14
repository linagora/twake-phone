# Décisions d'architecture (ADR)

Une décision, un fichier, numéroté dans l'ordre où elle a été prise. Un ADR se tient à jour : on le corrige en place quand le code ou une décision change, avec sa date de révision. Une décision abandonnée donne un nouvel ADR qui remplace l'ancien (« Remplacé par »). Chaque ADR suit le gabarit en fin de page.

## La stack et ses compromis

| Techno | Rôle | Pourquoi elle | Compromis | Licence | ADR |
|---|---|---|---|---|---|
| Navigateur + JsSIP | softphone WebRTC, enregistré en WSS | rien à installer, même pile que le mobile (`sip_ua`) | dépend des règles du navigateur ; sonnerie sans onglet par Web Push | MIT ([source](https://raw.githubusercontent.com/versatica/JsSIP/master/LICENSE.md)) | [0002](0002-softphone-navigateur.md), [0003](0003-jssip.md) |
| OpenSIPS 3.6 | serveur SIP : registrar, appels entre navigateurs, push, droits avant l'opérateur, trunk, CDR | les appels internes et les refus ne dépendent pas de Wazo | un serveur de plus ; pour une organisation de quelques centaines de postes, Wazo seul aurait suffi pour les bases ; `pike`, `ratelimit`, HEP annoncés mais non chargés | GPL ([source](https://github.com/OpenSIPS/opensips/blob/master/COPYING)) | [0004](0004-opensips-seul.md), [0016](0016-trunk-dispatcher-dialplan.md) |
| rtpengine | seul chemin du média (ICE, DTLS-SRTP, RTP simple) | pont entre navigateur et opérateur | pas de transcodage ; deux interfaces à régler derrière un NAT | GPL-3.0 ([source](https://github.com/sipwise/rtpengine)) | [0004](0004-opensips-seul.md), [0030](0030-deux-interfaces-rtpengine.md) |
| Wazo Platform / Asterisk | messagerie, SVI, files, enregistrement, supervision | le CCTP exige un serveur média, libre et sans licence | second moteur d'appel ; un seul tenant Wazo créé | Wazo GPL-3.0 ([source](https://github.com/wazo-platform/wazo-platform)), Asterisk GPL-2 ([source](https://github.com/asterisk/asterisk/blob/master/COPYING)) | [0005](0005-wazo-etape-11.md) |
| Passerelle Fastify, Node, TypeScript | API, WebSocket d'événements, administration, synchronisation de l'annuaire | passerelle du POC, un seul langage jusqu'au navigateur | un processus, état d'appel en mémoire | Fastify MIT ([source](https://github.com/fastify/fastify)), TypeScript Apache-2.0 ([source](https://github.com/microsoft/TypeScript)), Node non vérifié | [0007](0007-fastify-postgresql.md), [0009](0009-comptes-depuis-l-annuaire.md) |
| PostgreSQL | seul stockage, partagé avec OpenSIPS | contrat de stockage testé contre lui | pas de redondance en place | licence PostgreSQL ([source](https://github.com/postgres/postgres/blob/master/COPYRIGHT)) | [0007](0007-fastify-postgresql.md) |
| LiveKit SIP + Meet | entrée des téléphones dans les salles de Meet | Meet est l'outil de visio de Twake ; décision du 2026-11-13 : téléphonie de Meet upstream | code pas encore aligné ; plus de dial-out | LiveKit et LiveKit SIP Apache-2.0 ([livekit](https://github.com/livekit/livekit), [sip](https://github.com/livekit/sip)), Meet MIT ([source](https://github.com/suitenumerique/meet)) | [0018](0018-meet-livekit-sip-derriere-opensips.md) |
| Web Push (VAPID) | réveille un navigateur fermé pendant qu'OpenSIPS retient l'appel | seul moyen de sonner sans onglet | dépend du service push du navigateur | norme RFC 8292 (licence sans objet) ; bibliothèque `web-push` MPL-2.0 ([source](https://raw.githubusercontent.com/web-push-libs/web-push/master/LICENSE)) | [0015](0015-reception-sans-onglet-web-push.md) |
| Caddy (pilote) | TLS et routage par chemin d'un domaine unique | une machine, un nom, WSS par le port 443 | pilote seulement, une machine | Apache-2.0 ([source](https://github.com/caddyserver/caddy)) | [0012](0012-pilote-un-domaine.md) |
| LinTO | transcription des messages vocaux | solution libre de Linagora | message transcrit, texte lu par le titulaire seul | AGPL-3.0 ([source](https://github.com/linto-ai/linto-stt)) | [0023](0023-transcription-linto-bot-matrix.md) |
| API OVH | renvoi de repli des lignes, relevé des CDR | l'opérateur du pilote | non vérifié contre le vrai OVH | service commercial, sans objet | [0021](0021-provider-ovh.md) |
| Coquille Cozy | TwakePhone dans Twake Workplace | l'app tourne dans Workplace sans second écran | encadrée dans un cadre, connexion par fenêtre | AGPL-3.0 du dépôt ; cozy-stack non vérifié | [0032](0032-twakephone-dans-twake-workplace.md) |

Limites communes aujourd'hui : un seul tenant dans le chemin d'appel (`use_domain 0` d'`auth_db`, un seul tenant de trunks par base OpenSIPS, un seul tenant créé chez Wazo). Pas de redondance : un OpenSIPS, un rtpengine, une passerelle, une base ; les enregistrements `usrloc` sont en mémoire. Pas de mesure de charge : aucune capacité n'est annoncée. Un modèle multi-tenant est en discussion (une pile par client, ou une pile partagée) ; rien n'est décidé.

| ADR | Décision | État |
|---|---|---|
| [0001](0001-reprendre-le-poc.md) | Partir du POC Twake Phone de Linagora, importé tel quel ; `provider-asterisk`, SIP.js et `apps/phone` sont partis depuis | acceptée |
| [0002](0002-softphone-navigateur.md) | Softphone WebRTC dans le navigateur ; Linphone desktop retiré | acceptée |
| [0003](0003-jssip.md) | JsSIP remplace SIP.js ; même sémantique SIP que `sip_ua` pour le mobile | acceptée |
| [0004](0004-opensips-seul.md) | OpenSIPS 3.6 et rtpengine tiennent les appels devant l'IPBX : pourquoi pas Asterisk ou Wazo seul ; `pike`, `ratelimit` et HEP pas en service | acceptée |
| [0005](0005-wazo-etape-11.md) | Wazo Platform derrière OpenSIPS pour messagerie, SVI, files, enregistrement ; un seul tenant Wazo | acceptée |
| [0006](0006-app-autonome.md) | Application web autonome sur OIDC ; Twake Chat l'intègre sans pile SIP | acceptée |
| [0007](0007-fastify-postgresql.md) | Passerelle Fastify/TypeScript et PostgreSQL, seul stockage | acceptée |
| [0008](0008-plan-en-etapes.md) | Plan en étapes avec porte de sortie, une PR par changement, revue indépendante | acceptée |
| [0009](0009-comptes-depuis-l-annuaire.md) | Les postes viennent de l'annuaire LDAP, qui fait foi ; administrateurs par rôle du SSO | acceptée |
| [0010](0010-transfert-refer-replaces.md) | Les softphones transfèrent par REFER et Replaces ; OpenSIPS relaie en proxy | acceptée |
| [0011](0011-evenements-opensips.md) | OpenSIPS pousse ses événements à la passerelle (`event_datagram`), qui l'interroge par MI ; le CDR de `acc` fait foi | acceptée |
| [0012](0012-pilote-un-domaine.md) | Pilote sur une machine, un domaine derrière Caddy, SIP sur WebSocket par le port 443 | acceptée |
| [0013](0013-renvois-et-ne-pas-deranger.md) | Renvois et « ne pas déranger » dans `call_rules`, lue par OpenSIPS à chaque appel | acceptée |
| [0014](0014-groupes-et-noms-de-l-annuaire.md) | Groupes d'appel dans `call_groups` ; le nom de chaque partie vient de l'annuaire (`display_names`) | acceptée |
| [0015](0015-reception-sans-onglet-web-push.md) | Sans fenêtre ouverte, OpenSIPS retient l'appel pendant que la passerelle réveille le navigateur par Web Push | acceptée |
| [0016](0016-trunk-dispatcher-dialplan.md) | Le trunk passe par OpenSIPS, tout numéro non permis est refusé avant l'opérateur ; trunk vers le PABX d'un client possible, jamais essayé | acceptée |
| [0017](0017-droits-plafonds-fraude-repli.md) | Droits, plafonds et seuils de fraude décidés par OpenSIPS avant l'opérateur ; le repli d'un numéro direct sonne à l'intérieur | acceptée |
| [0018](0018-meet-livekit-sip-derriere-opensips.md) | Meet entre par la téléphonie de Meet upstream (décision du 2026-11-13) ; code pas encore aligné | acceptée, code pas encore aligné |
| [0019](0019-appel-devient-conference.md) | « Ajouter un participant » : la salle LiveKit appelle la fenêtre puis l'autre poste (`Replaces`), sous l'autorisation de la passerelle ; code Meet pas encore aligné | proposée |
| [0020](0020-hub-webhooks-signes.md) | Hub de webhooks signés HMAC, livrés au moins une fois depuis une file PostgreSQL, vers les seuls domaines autorisés ; `trunk.degraded` | proposée |
| [0021](0021-provider-ovh.md) | `provider-ovh` tient le renvoi de repli des lignes et relève les CDR pour les rapprocher de l'historique ; non vérifié contre OVH | proposée |
| [0022](0022-messagerie-wazo-derriere-opensips.md) | Messagerie vocale Wazo derrière OpenSIPS : boîte de l'extension composée, une boîte par titulaire, un seul écrivain sous bail | proposée |
| [0023](0023-transcription-linto-bot-matrix.md) | Transcription par LinTO STT et avis par un bot Matrix ; texte lu par le seul titulaire | proposée |
| [0024](0024-sites-localisation-urgences.md) | Un appel d'urgence présente le numéro du site de l'appelant, lu par OpenSIPS, avec repli en mémoire ; aucun `Geolocation` | proposée |
| [0025](0025-conference-avec-l-operateur.md) | Un appel avec l'opérateur devient une conférence en rappelant son numéro ; l'appel d'origine est gardé jusqu'à la confirmation de la personne | proposée |
| [0026](0026-conference-en-visio.md) | « Passer en visio » : salle Meet restreinte, chaque participant rappelé, aucun appel déplacé | proposée |
| [0027](0027-wazo-fait-sonner-les-navigateurs.md) | Wazo fait sonner les navigateurs par `mid_registrar` et un socket de lignes à part ; aucun appel interne par Wazo | proposée |
| [0028](0028-svi-files-groupes-sequentiels.md) | Parcours d'appel (groupe séquentiel, file, SVI) réglés dans la passerelle, exécutés par Wazo, atteints par OpenSIPS (`call_flows`) | proposée |
| [0029](0029-enregistrement-supervision-wazo.md) | Enregistrement et supervision des appels qui ont un canal Wazo, par l'AMI (`MixMonitor`, `ChanSpy`) | proposée |
| [0030](0030-deux-interfaces-rtpengine.md) | Deux interfaces rtpengine, `internal` et `external`, choisies à chaque offre | proposée |
| [0031](0031-integration-twake-chat-liens-tel.md) | Twake Chat ouvre TwakePhone sur `/?dial=` : numéro rempli, jamais composé par le lien seul | proposée |
| [0032](0032-twakephone-dans-twake-workplace.md) | TwakePhone dans Workplace par une coquille Cozy ; intent `CALL` qui remplit le clavier ; contacts de Workplace | proposée |
| [0033](0033-click-to-call-par-wazo.md) | Click-to-call : Wazo sonne la ligne (`Originate`), puis `Dial` vers la cible sous l'autorisation d'OpenSIPS | proposée |
| [0034](0034-widget-telecommande.md) | Le widget est une télécommande de la fenêtre Twake Phone, relayée par la coquille ; pas de softphone | proposée |
| [0035](0035-cluster-de-dev.md) | Cluster de dev : images publiées sur Harbor par la CI ; pod en réseau de l'hôte refusé par l'infra, chemin du son à décider | proposée |

Gabarit : date, révision, état et « remplacé par » ; contexte (2 à 4 phrases) ; décision (3 à 8 puces) ; séquence Mermaid quand un flux est la décision ; compromis (gagné, perdu, limite) ; alternatives écartées ; code. Un écart entre l'ADR et le code s'écrit « Écart : … » avec le fichier et la ligne. Une décision cite le fil ou le compte rendu où elle a été prise, pas une personne.
