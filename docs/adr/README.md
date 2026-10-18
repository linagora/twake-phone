# Décisions d'architecture (ADR)

Une décision, un fichier, numéroté dans l'ordre où elle a été prise. Un ADR n'est jamais modifié après coup : une décision qui change donne un nouvel ADR qui remplace l'ancien (« Remplacé par »).

| ADR | Décision | État |
|---|---|---|
| [0001](0001-reprendre-le-poc.md) | Partir du POC Twake Phone de Linagora | acceptée |
| [0002](0002-softphone-navigateur.md) | Softphone dans le navigateur, Linphone desktop retiré | acceptée |
| [0003](0003-jssip.md) | JsSIP remplace SIP.js | acceptée |
| [0004](0004-opensips-seul.md) | OpenSIPS et rtpengine, seul serveur SIP du MVP web ; Flexisip retiré | acceptée |
| [0005](0005-wazo-etape-11.md) | Wazo Platform derrière OpenSIPS, à l'étape 11 | acceptée |
| [0006](0006-app-autonome.md) | Application autonome, Twake Chat l'affiche sans pile SIP | acceptée |
| [0007](0007-fastify-postgresql.md) | Passerelle Fastify et PostgreSQL | acceptée |
| [0008](0008-plan-en-etapes.md) | Plan en étapes avec porte de sortie, PR par fonctionnalité, revue indépendante | acceptée |
| [0009](0009-comptes-depuis-l-annuaire.md) | Les postes viennent de l'annuaire LDAP, qui fait foi ; administrateurs par rôle du SSO | acceptée |
| [0010](0010-transfert-refer-replaces.md) | Transferts par REFER et Replaces de bout en bout entre softphones, OpenSIPS reste un proxy | acceptée |
| [0011](0011-evenements-opensips.md) | La passerelle écoute OpenSIPS par `event_datagram` et MI ; le CDR du module `acc` fait foi | acceptée |
| [0012](0012-pilote-un-domaine.md) | Pilote sur une machine, un seul domaine derrière Caddy, SIP sur WebSocket par le port 443 | acceptée |
| [0013](0013-renvois-et-ne-pas-deranger.md) | Renvois et « ne pas déranger » dans `call_rules`, lue par OpenSIPS à chaque appel ; la présence choisie rangée par personne | acceptée |
| [0014](0014-groupes-et-noms-de-l-annuaire.md) | Groupes d'appel simultané dans `call_groups`, lue par OpenSIPS à chaque appel ; le nom de chaque partie vient de l'annuaire (`display_names`), posé par OpenSIPS | acceptée |
| [0015](0015-reception-sans-onglet-web-push.md) | Sans fenêtre ouverte, OpenSIPS retient l'appel (`push_targets`) pendant que la passerelle réveille le navigateur par Web Push (VAPID) | acceptée |
| [0016](0016-trunk-dispatcher-dialplan.md) | Le trunk vers l'opérateur passe par `dispatcher`, `dialplan` et `uac_registrant` d'OpenSIPS, sur un socket à lui ; tout numéro non permis est refusé avant l'opérateur ; `drouting` attend plusieurs opérateurs | acceptée |
| [0017](0017-droits-plafonds-fraude-repli.md) | Droits d'appel, plafonds et seuils de volume décidés par OpenSIPS (`fraud_detection`, profils de dialogue, compteurs tenus à l'écriture des CDR), bornés par défaut, minutes partagées entre appels simultanés, dialogues gardés en base ; le repli d'un numéro direct sonne à l'intérieur (poste ou groupe), jamais de 302 ; les urgences hors de tout | acceptée |
| [0018](0018-meet-livekit-sip-derriere-opensips.md) | Meet par LiveKit SIP derrière OpenSIPS, sur un socket à lui qui n'entend que LiveKit SIP ; un numéro d'accès et le PIN de la salle ; les appels d'une salle sous défi, au nom du poste de qui les demande, avec ses droits et ses plafonds, jamais une urgence | acceptée |
| [0019](0019-appel-devient-conference.md) | « Ajouter un participant » : un appel entre deux postes devient une conférence dans une salle de LiveKit à lui ; la salle appelle la fenêtre de la personne (son jeton) puis l'autre poste à la place de l'appel (`Replaces` écrit par OpenSIPS d'après le dialogue qu'il tient), chacun sous l'autorisation de la passerelle ; pas d'appel avec l'opérateur (pas de B2BUA) | proposée |
| [0020](0020-hub-webhooks-signes.md) | Un hub de webhooks signés (HMAC-SHA256 de l'horodatage et du corps) dans la passerelle, livrés au moins une fois depuis une file en base (`SKIP LOCKED`, bail) avec 8 relances ; identifiants d'événement communs à toutes les passerelles ; seuls les domaines autorisés par l'organisation, résolus et vérifiés à chaque livraison contre les adresses privées, sans redirection ; `trunk.degraded` d'après ce qu'OpenSIPS dit du trunk | proposée |
| [0021](0021-messagerie-wazo-derriere-opensips.md) | La messagerie vocale sur Wazo Platform 26.10 derrière OpenSIPS, sur un socket à lui qui n'entend que l'Asterisk de Wazo (pas encore de `mid_registrar`) ; l'appel que rien d'autre ne prend va à la boîte de l'extension composée (`voicemail_boxes`, écrite par la passerelle), une boîte qui ne répond pas rend le refus d'origine ; une boîte par titulaire, supprimée avec ses messages quand l'extension change de main, lue pour lui seul (`provider-wazo`) | proposée |

Gabarit : date, état et « remplacé par », contexte, décision, conséquences, alternatives écartées. Dix lignes suffisent. Une décision cite le fil ou le compte rendu où elle a été prise, pas une personne.
