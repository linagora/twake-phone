# Écosystème LINAGORA : ce que TwakePhone utilise et ce qu'il doit rejoindre

Relevé du 2026-11-02 sur <https://github.com/orgs/linagora/repositories> (API GitHub, dépôts publics) : 544 dépôts, dont 333 non archivés et 161 poussés depuis le 2025-11-01. Langages des dépôts actifs : JavaScript 87, TypeScript 61, Java 26, Dart 23, Python 18. Les plus suivis sont Twake (legacy, 1 920 étoiles), cozy-stack (1 268), Twake Drive (991), Twake Mail Flutter (666), LinShare (581) et OpenRAG (262).

Ce relevé sert de « recherche » BMAD (phase 1) : il situe TwakePhone parmi ce que LINAGORA propose, utilise et maintient.

## Ce que LINAGORA propose (produits Twake Workplace)

| Produit | Dépôts principaux | Lien avec TwakePhone |
|---|---|---|
| Socle Workplace (Cozy) | `cozy-stack` (Go), `cozy-client`, `cozy-libs`, `cozy-home`, `cozy-settings`, `cozy-apps-registry`, `twake-workplace-docker` | Coquille `apps/workplace` (ADR 0032), registre d'apps, intents `CALL`, flags. Le registre n'est pas publié par ce dépôt. |
| Twake Chat (Matrix) | `twake-on-matrix` (Flutter), `ToM-Server`, `ToM-Bridge`, `twake-chat-side-service`, `react-native-matrix-crypto` | Liens `tel:` et `/?dial=` (ADR 0031), bot Matrix des messages vocaux (ADR 0023). Carte d'appel et présence dans Chat : à faire. |
| Twake Mail | `tmail-flutter`, `tmail-backend`, `james-project`, `twake-mail-admin`, `twake-mail-side-service` | Click-to-call sur un numéro d'un mail (CANUT : « numéro affiché dans Mail »). Pas encore branché. |
| Calendrier et contacts | `twake-calendar-frontend`, `twake-calendar-side-service`, `esn-sabre`, `sabre-vobject`, `twake-contacts-frontend`, `twake-sync` | Contacts CardDAV de l'annuaire (étape 2) et contacts Workplace (PR #44). |
| Drive, Notes, Pages, Tasks, Space | `twake-drive`, `cozy-notes`, `twake-pages`, `twake-tasks`, `twake-space` | Hôtes du widget télécommande et de `PhoneLink` (ADR 0034). |
| Visio | `twake-visio` (mobile), `meet-side-service`, `meet2twake` | Accès téléphonique aux salles, passage en visio (ADR 0018, 0026). |
| Identité | `lemonldap-ng-plugins`, `lemonldap-ng.js`, `ldap-rest`, `ldap-rest-client`, `twake-directory-manager`, `linid-identity-manager`, `open-bastion` | OIDC de l'app (étape 2), comptes depuis l'annuaire (ADR 0009). `ldap-rest` et `twake-directory-manager` sont la voie naturelle du provisioning (SCIM absent ici). |
| IA et MCP | `openrag`, `ai-gateway`, `twake-harness`, `twake-assistant`, `mcp-twake-chat`, `mcp-twake-mail`, `mcp-twake-drive`, `mcp-twake-dav`, `mcp-twake-space`, `llng-mcp` | Pas de `mcp-twake-phone` : un serveur MCP (appeler, lire les messages vocaux, les récents) suivrait le modèle des autres. |
| UI | `twake-ui`, `linagora-design-flutter`, `lin-pulsar`, `twake-libs` | `apps/web` utilise cozy-ui et Twake MUI (`docs/twake-mui-gaps.md`). |
| Analytique | `twake-user-activity` (RabbitMQ vers Matomo ou PostHog) | Les événements d'appel pourraient y aller. Rien n'est branché. |

## Ce que LINAGORA utilise et maintient (forks, briques tierces)

- Matrix : forks `synapse`, `matrix-dart-sdk`, `matrix-js-sdk` côté Chat.
- Mail : `james-project` (miroir d'Apache James), `jmap-client`, `jmap-dart-client`.
- DAV : `esn-sabre`, `sabre-vobject`, `xml` (forks de sabre).
- Visio historique : `docker-jitsi-meet`, `jigasi`, `jitsi-meet-electron`, `docker-janus-gateway`. Archivés de fait (rien depuis 2021). Jigasi était la passerelle SIP de Jitsi ; LiveKit SIP la remplace ici (ADR 0018).
- Bureautique : `onlyoffice-twake`.

## Ce qui manque à l'organisation pour la téléphonie

Aucun dépôt LINAGORA ne porte XiVO, Wazo, Asterisk, OpenSIPS, Flexisip ou Linphone. La réponse au CCTP CANUT (§7.4.6.2) cite Linphone, Flexisip et XiVO. TwakePhone a choisi un softphone navigateur, OpenSIPS et Wazo Platform (ADR 0002, 0004, 0005). La pile téléphonique repose donc sur des projets amont non forkés : `twake-phone` est le seul dépôt téléphonie de l'organisation. LinTO (transcription, ADR 0023) vit dans l'organisation `linto-ai`, hors de ce relevé.

## Conséquences pour la spécification

1. TwakePhone doit s'intégrer à six hôtes Workplace (Chat, Mail, Contacts, Drive, Calendar, Space). Seuls Chat (liens) et la coquille Workplace (widget, intent) le sont aujourd'hui.
2. Le provisioning doit passer par l'annuaire LINAGORA (`ldap-rest`, Directory Manager) plutôt que par un SCIM écrit ici.
3. Un serveur `mcp-twake-phone` aligne TwakePhone sur la gamme des assistants.
4. L'écart avec le mémoire (Linphone, Flexisip, XiVO) est à annoncer au bénéficiaire : voir le PRD, section « Écarts avec la réponse au CCTP ».
