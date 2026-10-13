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

Gabarit : contexte, décision, conséquences, alternatives écartées. Dix lignes suffisent.
