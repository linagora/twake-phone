<div align="center">

# TwakePhone

**La téléphonie souveraine de Twake : un softphone dans le navigateur, un serveur SIP libre, un trunk opérateur, et zéro licence par utilisateur.**

[![CI](https://github.com/linagora/twake-phone/actions/workflows/ci.yml/badge.svg)](https://github.com/linagora/twake-phone/actions/workflows/ci.yml)
[![Licence AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](#licence)
[![Statut](https://img.shields.io/badge/statut-%C3%A9tape%201%20%2F%2011-orange.svg)](#le-plan-en-11-%C3%A9tapes)
[![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20JsSIP%20%C2%B7%20Fastify%20%C2%B7%20OpenSIPS-informational.svg)](#la-pile)
[![POC](https://img.shields.io/badge/origine-POC%20Linagora-lightgrey.svg)](https://ci.linagora.com/tdelobelle/poc-twake-phone)

*TwakePhone is Twake's sovereign telephony: a browser softphone, a free SIP server, a carrier trunk, no per-seat licence. Docs are in French for now.*

</div>

---

## Pourquoi

Les administrations qui passent à Twake gardent un PABX propriétaire déconnecté de leur outil collaboratif, ou cèdent à Teams Phone et Zoom Phone : américains, facturés par utilisateur. Le marché CANUT (CCTP §7.4.6.2) demande une softphonie intégrée, auto-hébergée, à parité avec ces offres.

TwakePhone y répond avec du logiciel libre, déployé chez le bénéficiaire :

- **Rien à installer sur le poste.** Le softphone tourne dans le navigateur, en WebRTC, provisionné par la session Twake.
- **Un seul serveur SIP pour commencer.** OpenSIPS et rtpengine font l'enregistrement, le routage, l'anti-fraude et le trunk. Wazo n'arrive que pour la messagerie vocale, le SVI et les files.
- **Une passerelle neutre.** L'application ne connaît aucun PBX : elle parle à la Twake Telephony Gateway, qui isole chaque fournisseur derrière un contrat.
- **Twake sans pile SIP.** TwakePhone est une application autonome. Twake Chat l'affichera plus tard dans un widget, sans embarquer de SIP.
- **La visio au bout du fil.** Un numéro et un PIN pour rejoindre une salle Meet depuis n'importe quel téléphone.

## Ce que fait le MVP web

| Domaine | Fonctions |
|---|---|
| Appels | Émettre, recevoir, mettre en attente, transférer (direct et supervisé), DTMF, sonnerie dans tous les onglets, réception sans onglet ouvert (Web Push) |
| Annuaire et présence | Annuaire LDAP et CardDAV, favoris, présence téléphonique en temps réel, NPD planifié avec message |
| Règles d'appel | Renvois immédiat, sur occupation, sur non-réponse ; groupes à sonnerie simultanée ; numéro de repli |
| Opérateur | Trunk SIP OVHcloud ou tout trunk SIP standard, SDA, appels d'urgence, international bloqué par défaut, plafonds, détection de fraude |
| Visio | Rejoindre une salle Meet par téléphone (PIN natif), appeler un numéro depuis une salle, passer un appel à deux en conférence à plusieurs |
| Administration | Trunks, SDA, routes, limites, profils de droits, abonnements webhooks, sans console |
| Intégration | Webhooks signés (HMAC) pour chaque événement d'appel, CDR rapprochés avec OVHcloud, historique unifié |

Après le MVP web : **Wazo** (messagerie vocale transcrite par LinTO, SVI, files, enregistrement, supervision), **QoS** (Homer, MOS par appel, Grafana), **haute disponibilité**, **mobile** (Twake mobile, sip_ua, CallKit et ConnectionService), **transcription des appels**.

## Architecture

```mermaid
flowchart LR
  subgraph Poste
    APP[App TwakePhone<br/>React · JsSIP]
  end
  subgraph Plateforme
    GW[Twake Telephony Gateway<br/>Fastify · PostgreSQL]
    OS[OpenSIPS 3.6<br/>registrar · WSS · routage · anti-fraude]
    RTP[rtpengine]
    LK[LiveKit SIP · La Suite Meet]
    WAZO[Wazo Platform<br/>étape 11]
    IDP[LemonLDAP::NG · LDAP]
  end
  OVH[Trunk SIP OVHcloud]
  APP -- OIDC --> IDP
  APP -- HTTPS · WebSocket --> GW
  APP -- SIP sur WSS --> OS
  APP -- DTLS-SRTP --> RTP
  OS <-- événements · MI --> GW
  OS --- RTP
  OS -- SIP --> OVH
  RTP -- RTP --> OVH
  OS -- SIP --> LK
  OS -. SIP .-> WAZO
  GW --> LK
  GW -.-> WAZO
```

La voix suit le chemin **navigateur → OpenSIPS (WSS) → rtpengine → trunk**. La passerelle ne transporte aucun média : elle relie les événements d'OpenSIPS, de Meet et d'OVHcloud à l'application et aux abonnés webhooks.

Trois règles d'architecture, héritées du POC et non négociables :

1. Aucune notion OpenSIPS hors de `provider-opensips`, aucune notion Wazo hors de `provider-wazo`, aucune notion LiveKit ou Meet hors de `conference-livekit`.
2. L'application et la passerelle ne connaissent que le contrat `provider-sdk` (`TelephonyProvider`, `MediaProvider`, `ConferenceBridgeProvider`).
3. Les secrets ne sont jamais dans le code ni dans la configuration : références `env:NOM`.

## La pile

| Couche | Choix | Pourquoi |
|---|---|---|
| Application | React, OIDC (PKCE) sur LemonLDAP::NG | Autonome, intégrable ensuite dans Twake Chat (grille d'apps, widget Matrix) |
| Softphone | [JsSIP](https://jssip.net) (MIT) | Maintenu (3.13, mai 2026) ; [sip_ua](https://pub.dev/packages/sip_ua), son port Dart, servira le mobile |
| Passerelle | Fastify 5, TypeScript, PostgreSQL, OpenAPI, WebSocket | Reprise du POC : auth OIDC, secrets SIP par utilisateur chiffrés, historique, multi-tenant, tests de contrat |
| Serveur SIP | [OpenSIPS](https://opensips.org) 3.6 (GPLv2) + [rtpengine](https://github.com/sipwise/rtpengine) (GPLv3) | Registrar, WSS, `dispatcher`, `drouting`, `dialplan`, `fraud_detection`, `acc`, `dialog`, HEP ; `mid_registrar` quand Wazo arrive |
| IPBX (étape 11) | [Wazo Platform](https://wazo-platform.org) (GPLv3, gratuit) | Seul moyen libre et complet d'avoir messagerie, SVI, files, enregistrement, supervision |
| Visio | [LiveKit SIP](https://docs.livekit.io/sip/) (Apache 2.0) + La Suite Meet | Déjà fonctionnel dans le POC : dial-in par PIN, dial-out |
| Transcription | [LinTO](https://linto.ai) STT (AGPL) | Souverain, maîtrisé par LINAGORA |
| QoS | Homer 7, Prometheus, Grafana | MOS par appel, traces SIP, alertes |
| Opérateur | Trunk SIP OVHcloud par défaut, tout trunk standard accepté | SDA, repli, urgences |

Retirés par décision du 13 octobre 2026 : Linphone desktop, Flexisip, SIP.js, Asterisk brut par ARI, Cozy comme hôte de l'application.

## Origine : le POC

Ce dépôt part du **POC Twake Phone** de Linagora : <https://ci.linagora.com/tdelobelle/poc-twake-phone> (AGPL-3.0). Son README d'origine est conservé dans [docs/POC.md](docs/POC.md), sa documentation dans [docs/](docs/).

Le POC a prouvé le cœur : la Twake Telephony Gateway et son contrat de provider, le softphone navigateur, l'accès à Meet par téléphone avec dial-out, et une stack de dev complète avec de vrais appels SIP en e2e. TwakePhone reprend ce code et le pousse vers l'architecture ci-dessus :

| POC | TwakePhone |
|---|---|
| Application Cozy dans Twake Workplace | Application React autonome, OIDC |
| SIP.js | JsSIP |
| Asterisk piloté par ARI, navigateur connecté directement au PBX | OpenSIPS seul, puis Wazo derrière OpenSIPS |
| Trunk sans garde-fou (« un appel externe n'est pour l'instant limité par rien ») | Anti-fraude, plafonds, routes, repli |
| Spike Web Push | Réception d'appel sans onglet ouvert, en production |
| Appartenance des appels en mémoire | PostgreSQL, puis Redis pour plusieurs réplicas |

Les leçons du POC sur un trunk réel derrière NAT (pas de port 5060, un contact par serveur de l'opérateur, aucune adresse externe déclarée) sont reprises telles quelles.

## Le plan en 11 étapes

Pas de calendrier en semaines : le développement avance par étapes ordonnées, chacune fermée par une **porte de sortie** (tests verts, e2e du POC conservés, scénario de démo écrit avant de coder).

| # | Étape | Démo de sortie | État |
|---|---|---|---|
| 1 | **Monorepo** : import du POC avec tous ses tests, ADR, CI | `yarn test` vert, ADR relus | Fusionnée le 14 octobre 2026 |
| 2 | **App React autonome** : OIDC, annuaire LDAP et CardDAV, synchronisation des comptes, CSP, socle RGAA | Connexion SSO, recherche d'un collègue | Fusionnée le 14 octobre 2026 : PR 2a (coquille et SSO), PR 2b (annuaire LDAP, favoris), PR 2c (synchronisation des comptes, CSP, administration). CardDAV non fait (hors besoin immédiat) |
| 3 | **OpenSIPS et JsSIP** : Docker OpenSIPS + rtpengine, softphone réécrit, attente, transfert direct et supervisé, DTMF, trois navigateurs | Deux utilisateurs s'appellent, s'attendent, se transfèrent | Fusionnée le 14 octobre 2026 : PR 3a (serveur SIP, softphone JsSIP, premier appel, attente, DTMF), PR 3b (transferts direct et supervisé, ADR 0010), PR 3c (Chromium, Firefox et Edge en CI, soit deux moteurs, périphériques audio, sonnerie, seconde fenêtre, retrait du POC) |
| 4 | **provider-opensips** : événements, présence, CDR, renvois, NPD planifié, groupes | La pastille change pendant un appel, un renvoi est appliqué | Terminée avec la PR 4c : PR 4a (événements d'OpenSIPS vers la passerelle, présence dans l'annuaire, historique depuis les CDR, ADR 0011), PR 4b (renvois immédiat, sur occupation et sur non-réponse vers un poste, « ne pas déranger » jusqu'à une date avec un message lu par l'appelant, présence choisie gardée par personne, ADR 0013), PR 4c (groupes d'appel simultané administrés dans l'app, nom de l'annuaire posé par OpenSIPS des deux côtés de l'appel, retrait de `provider-asterisk`, ADR 0014) |
| 5 | **Réception sans onglet** : service worker, Web Push, renvoi après délai | Navigateur fermé, la notification ouvre l'app sur l'appel | |
| 6 | **Trunk OVH et anti-fraude** : `dispatcher`, `drouting`, `fraud_detection`, repli, urgences | Appel sortant vers un mobile, entrant sur la SDA, appel interdit refusé | |
| 7 | **Administration** : trunks, SDA, routes, limites, droits, webhooks | Un admin ajoute une SDA et sa route sans console | |
| 8 | **Meet et conférence** : LiveKit SIP derrière OpenSIPS, PIN, dial-out, conférence audio, passage en visio | Rejoindre une salle par téléphone ; un appel à deux devient une conférence à trois | |
| 9 | **Intégration Twake Chat** (secondaire) : grille d'apps, liens `tel:`, widget, carte d'appel, présence, bot | Un numéro cliqué dans Chat lance l'appel | |
| 10 | **Webhooks et OVH** : hub signé, `provider-ovh`, historique unifié. *Fin du MVP web.* | Un abonné reçoit `call.missed` signé, les CDR OVH sont rapprochés | |
| 11 | **Wazo** : `mid_registrar`, `provider-wazo`, messagerie transcrite, SVI, files, enregistrement, supervision | Un appel en NPD tombe sur la messagerie, le message transcrit arrive | |

Ensuite : QoS, exploitation et haute disponibilité, pilote de 30 à 50 utilisateurs, mobile, transcription des appels.

## Organisation du dépôt

```
apps/web                     application TwakePhone (React 18, OIDC PKCE, client de la passerelle, softphone) : étapes 2 et 3
apps/gateway                 Twake Telephony Gateway (Fastify, PostgreSQL, OpenAPI sur /docs)
packages/telephony-types     modèle neutre : Call, Presence, Capabilities, MediaSession
packages/provider-sdk        contrat TelephonyProvider / MediaProvider / ConferenceBridgeProvider / SecretProvisioner
packages/telephony-client    SDK front : REST, WebSocket, E.164, conférences
packages/provider-opensips   provider OpenSIPS : session média (WSS, poste, secret), comptes dans `subscriber`, événements, présence et historique (MI et event_datagram, ADR 0011), renvois et « ne pas déranger » (`call_rules`, ADR 0013), groupes d'appel et noms de l'annuaire (`call_groups`, `display_names`, ADR 0014)
packages/softphone           softphone JsSIP : enregistrement, appels, attente, transferts, micro, sortie et sonnerie (setSinkId), DTMF, compteurs RTP, reconnexion
packages/phone-link          <PhoneLink> et requestCall : numéro cliquable (intent CALL) pour Twake Workplace
packages/phone-widget        widget d'appel à monter dans les autres apps Twake Workplace
packages/conference-livekit  Meet : API externe, LiveKit SIP, dial-in, dial-out ; rebranché sur OpenSIPS à l'étape 8
docker/                      serveur SIP du MVP (docker-compose.sip.yml) : OpenSIPS 3.6, rtpengine, PostgreSQL ; images de la passerelle et de l'app
docker/pilot/                kit pilote : tout le MVP sur une machine, HTTPS par Caddy, Keycloak et LDAP de démo (ADR 0012)
docs/                        architecture, widget ; docs/POC.md, README d'origine du POC ; docs/adr/ : une décision, un fichier
```

Le code du POC (app Phone Cozy, PBX de dev MiniPBX, `sip-media`, stack de dev) a été retiré à la PR 3c, son provider de référence (`provider-asterisk`, ARI) à la PR 4c : l'historique Git les conserve.

À venir : `packages/provider-ovh` (étape 10), `packages/provider-wazo` (étape 11).

## Démarrer

Pour essayer TwakePhone à plusieurs, sur une machine joignable depuis Internet : le kit pilote, [docker/pilot/README.md](docker/pilot/README.md) (une machine Linux avec Docker, un nom de domaine, trois commandes). Ce qui suit est pour développer.

Prérequis : Node 22 ou plus récent (24 dans `.nvmrc`), Yarn 1, Docker.

```bash
yarn install && yarn build && yarn test        # paquets, passerelle et app web, aucun service externe
yarn dev:gateway                               # passerelle sur http://localhost:8080, OpenAPI sur /docs
yarn dev:web                                   # app TwakePhone sur http://localhost:4173 (config dans apps/web/public/config.json)
```

Annuaire : la passerelle interroge un LDAP quand `LDAP_URL` est renseigné (`ldaps://` dès que le serveur n'est pas local ; `LDAP_BASE_DN` obligatoire ; `LDAP_BIND_DN` et `LDAP_BIND_PASSWORD` pour un compte lecteur ; `LDAP_USER_FILTER`, par défaut `(objectClass=inetOrgPerson)` ; `LDAP_ATTR_ID`, `_NAME`, `_SURNAME`, `_GIVENNAME`, `_EMAIL`, `_PHONE`, `_MOBILE`, `_EXTENSION`, `_DEPARTMENT`, `_TITLE` pour un schéma qui s'écarte d'inetOrgPerson ; `LDAP_TLS_CA_FILE` pour une autorité interne). Un seul annuaire par déploiement pour l'instant, servi au tenant `LDAP_TENANT` (par défaut `DEFAULT_TENANT`) : les autres tenants n'ont pas d'annuaire, la configuration par tenant viendra avec l'écran d'administration (étape 7). Sans `LDAP_URL`, l'app affiche que la plateforme n'a pas d'annuaire. Les favoris (100 au plus par personne) sont dans PostgreSQL.

Comptes : quand `LDAP_ATTR_EXTENSION` dit quel attribut porte le poste (`ipPhone` sur un Active Directory, un attribut maison sur OpenLDAP), la passerelle copie les comptes de l'annuaire dans ses correspondances utilisateur ↔ poste toutes les `LDAP_SYNC_INTERVAL` (`1h` par défaut, `0` pour désactiver) et à la demande depuis l'écran d'administration de l'app. L'identifiant LDAP (`LDAP_ATTR_ID`, `uid` par défaut) doit être celui que le SSO met dans le jeton (`JWT_USER_CLAIM`). L'annuaire fait foi pour les personnes qu'il connaît ; les postes attribués à la main à des personnes qu'il ne connaît pas sont conservés ; un poste donné à deux personnes est signalé, la première le garde. Administrateurs : les personnes dont le jeton porte le rôle `ADMIN_ROLE` (`twakephone-admin` par défaut) dans la revendication `JWT_ROLES_CLAIM` (à renseigner, par exemple `groups` sur LemonLDAP::NG ; sans elle aucun rôle n'est lu), ou nommées dans `ADMIN_USERS` (`alice,acme:bob`). La synchronisation lancée depuis l'écran tourne en arrière-plan ; l'écran la suit jusqu'au rapport. Un listing vide ne retire aucun poste.

App web en production : `yarn workspace @twake/phone-web start` (ou `docker/Dockerfile.web`) sert `apps/web/dist` avec son `config.json` et ses en-têtes de sécurité, à partir de `GATEWAY_URL`, `OIDC_AUTHORITY`, `OIDC_CLIENT_ID`, `OIDC_RESOURCE` (et `OIDC_SCOPE`, `OIDC_PROMPT`), `FRAME_ANCESTORS` (origines autorisées à encadrer l'app, par exemple celles de Twake Chat ; `'none'` sinon), `CONNECT_SRC` (origines supplémentaires : le WSS d'OpenSIPS quand il n'est pas sur l'origine de la passerelle), `HSTS_MAX_AGE` une fois derrière TLS (`HSTS_INCLUDE_SUBDOMAINS=1` pour l'étendre). La CSP n'autorise que les scripts et styles du build, la passerelle (REST et WebSocket) et le fournisseur d'identité. La passerelle pose des en-têtes de même nature sur ses réponses (CSP sans source, `nosniff`, `no-store`, HSTS avec les mêmes variables).

Téléphonie : la passerelle configure le provider OpenSIPS du tenant par défaut quand `OPENSIPS_WS_URL` est renseigné (l'URL WSS publique d'OpenSIPS ; `SIP_DOMAIN`, domaine SIP et realm, par défaut l'hôte de cette URL ; `OPENSIPS_DB_URL`, la base où OpenSIPS lit ses comptes, par défaut celle de la passerelle ; `ICE_SERVERS`, liste de STUN/TURN séparés par des virgules ; `SECRETS_KEY` obligatoire ; `SIP_DOMAIN` doit être le même que celui de la stack OpenSIPS, c'est le realm des empreintes ; `OPENSIPS_MI_URL`, le socket MI d'OpenSIPS, `udp:127.0.0.1:8880` sur la stack Docker, où la passerelle s'abonne à ses événements, livrés sur `OPENSIPS_EVENTS_LISTEN`, la boucle locale et un port libre par défaut, ou à l'adresse `OPENSIPS_EVENTS_ADVERTISE` quand OpenSIPS doit en viser une autre ; seuls les datagrammes venus de l'hôte du MI, ou d'une adresse d'`OPENSIPS_EVENTS_FROM` (liste séparée par des virgules : OpenSIPS envoie depuis l'adresse que son noyau choisit pour la route, pas forcément celle du MI), sont lus, et ce port reste sur un réseau de confiance). Ces variables ne font qu'**amorcer** la configuration du provider, au premier démarrage sur une base qui n'en a pas pour ce tenant (`DEFAULT_TENANT`) : une configuration déjà en base n'est pas relue. Pour en changer, supprimer sa ligne de `provider_configs` (`DELETE FROM provider_configs WHERE tenant_id = 'default'`) puis redémarrer la passerelle avec les nouvelles variables ; le stockage en mémoire (sans `DATABASE_URL`) repart de l'environnement à chaque démarrage. Si les événements ne marchent pas (adresse invalide, OpenSIPS muet, datagrammes d'une adresse non acceptée), les appels passent quand même : `/ready` répond 200 avec `degraded` et `reasons`, et le journal dit pourquoi. Chaque personne qui a un poste reçoit un secret SIP généré par la passerelle, gardé chiffré chez elle et écrit en empreintes (`ha1`) dans la table `subscriber` d'OpenSIPS : le navigateur s'enregistre avec son poste et ce secret, obtenus par `GET /me/media-session`, et appelle directement par le softphone. Avec `OPENSIPS_MI_URL`, la passerelle entend aussi ce qui se passe sur OpenSIPS (enregistrements, appels, CDR : ADR 0011) : l'annuaire montre qui est disponible, en communication ou hors ligne, et les Récents listent les appels des deux côtés. Dans Réglages, chacun choisit sa disponibilité (absent ou « ne pas déranger », jusqu'à une date s'il le veut, avec un message pour ses correspondants : `PUT /me/presence`) et ses renvois vers le poste d'un collègue (tous les appels, en ligne ou refusé, sans réponse après un délai : `GET/PUT /me/forwarding`) ; la passerelle les écrit dans la table `call_rules`, qu'OpenSIPS lit à chaque appel (ADR 0013). Dans Administration, un administrateur crée des groupes d'appel : un numéro à lui (qui n'est pas un poste) fait sonner en même temps les fenêtres des postes membres (12 membres et 12 fenêtres au plus, une de chaque membre d'abord), le premier qui répond prend l'appel (`GET/POST /admin/groups`, `PUT/DELETE /admin/groups/:number`, table `call_groups`) ; OpenSIPS montre à chaque partie le nom que l'annuaire donne à l'autre, quel que soit celui que son téléphone annonce (table `display_names`, ADR 0014). Le serveur SIP du MVP tourne en Docker Compose ([docker/README.md](docker/README.md)) :

```bash
docker compose -f docker/docker-compose.sip.yml up --build --wait     # OpenSIPS 3.6 (WS 8088, WSS 8089), rtpengine, PostgreSQL 54320
OPENSIPS_WS_URL=wss://127.0.0.1:8089 OPENSIPS_DB_URL=postgres://twake:twake@127.0.0.1:54320/twake OPENSIPS_MI_URL=udp:127.0.0.1:8880 \
  DATABASE_URL=postgres://twake:twake@127.0.0.1:54320/twake SECRETS_KEY=$(openssl rand -hex 32) yarn dev:gateway
```

| Commande | Vérifie |
|---|---|
| `yarn test` | unitaires de tous les paquets et de la passerelle (vitest), contrat de stockage mémoire et, avec `TEST_DATABASE_URL`, PostgreSQL |
| `yarn e2e:web` | app TwakePhone dans Chromium, servie par son serveur de production : connexion OIDC (fournisseur de test en Node, rôle d'administrateur dans le jeton), synchronisation des comptes depuis l'écran d'administration (LDAP de test en Node) puis poste affiché, clavier, annuaire et favoris, réglages sans disponibilité ni renvois quand la plateforme n'a pas de téléphonie, langue, déconnexion, en-têtes de sécurité de l'app et de la passerelle, encadrement par un autre site refusé, CSP. Sans Docker ; Chromium s'installe une fois avec `npx playwright-core install chromium` (ou `PLAYWRIGHT_CHROMIUM=/chemin/vers/chromium`) |
| `yarn e2e:sip` | trois personnes s'appellent et se transfèrent depuis trois fenêtres du même navigateur (`BROWSER=chromium`, `firefox` ou `msedge`, micro simulé) à travers OpenSIPS et rtpengine (`docker compose -f docker/docker-compose.sip.yml up --build --wait` d'abord) : enregistrement WSS, empreintes dans `subscriber`, poste injoignable, refus, réponse, paquets RTP dans les deux sens, attente et reprise, micro, DTMF vus par rtpengine (RFC 4733), raccrochage, choix du micro et des sorties dans les réglages (appliqué à l'appel suivant, sonnerie testée), seconde fenêtre de la même personne (les deux sonnent, celle qui répond prend l'appel, l'autre est prévenue), transfert vers un poste absent (404 rendu en français), transfert direct (REFER, raccrocher reste possible pendant), consultation abandonnée par le transférant, vers un poste absent ou par le collègue (reprise automatique), transfert supervisé (REFER avec Replaces) avec RTP compté après chaque transfert, inscription sur une connexion morte (477 rendu comme injoignable, un appel manqué ; avec un renvoi sur non-réponse, le collègue sonne tout de suite), coupure des WebSockets et retour en ligne, déconnexion qui désinscrit ; et ce que la passerelle en entend (étape 4) : Récents des deux côtés et CDR dans `acc`, présence des collègues dans l'annuaire (disponible, en communication en moins de 3 s, hors ligne après la déconnexion), appel refusé rendu « Refusé » chez l'appelé, appel abandonné pendant la sonnerie rendu manqué, ou pendant la lecture des règles (`call_rules` verrouillée : 487, un manqué dans `missed_calls`, l'appelant redevient disponible) ; et les renvois (étape 4b), réglés depuis l'écran Réglages : transfert supervisé vers un poste qui renvoie (l'INVITE avec Replaces rejoint le collègue qui a répondu), renvoi immédiat (l'appelé ne sonne pas, `call_rules` écrite puis vidée, le CDR d'`acc` nomme le poste qui a répondu), sur non-réponse après environ 5 s (l'appelé sonne, puis le collègue ; un appel manqué pour l'appelé, aucune ligne dans `missed_calls`), abandon pendant la sonnerie du collègue (un manqué pour chacun, 487 pour le collègue dans `missed_calls`), sur occupation (un second appel pendant une communication), sur non-réponse quand une fenêtre est en communication et l'autre ne répond pas, renvoi vers un collègue en « ne pas déranger » (l'appelant lit « injoignable », jamais le message du collègue), « ne pas déranger » jusqu'à une date avec un message, saisi dans un navigateur à l'heure de Paris, qui suit le renvoi sur non-réponse (le collègue refuse : l'appelant lit le message du poste composé), puis sans renvoi refuse l'appel (480) et montre le message à l'appelant (appel manqué chez l'appelé et dans `missed_calls`), et le montre encore quand son renvoi ne mène nulle part, fin du « ne pas déranger » à sa date par le minuteur de la passerelle (annuaire, `user_presence`, puis l'appel sonne), renvoi vers soi-même ou vers l'extérieur refusé en clair, boucle 102 → 103 → 102 arrêtée ; les noms de l'annuaire affichés des deux côtés de chaque appel (renvoi et transfert compris) ; et les groupes d'appel (étape 4c) : un administrateur crée le groupe 200 (101, 102, 103) dans Administration (un poste, ou un compte laissé dans `subscriber`, refusé comme numéro de groupe ; « Nouveau groupe » sur un numéro existant refusé sans rien remplacer ; un groupe refusé comme cible de renvoi, 403 pour les autres), l'accueil appelle 200, les trois sonnent, le premier qui répond prend l'appel et les autres lisent « pris sur un autre poste » (CDR d'`acc` au nom du membre, aucun appel manqué), un membre refuse pendant que les deux autres sont occupés (l'accueil lit « injoignable », 480, pas « refusé »), un membre refuse pendant que les autres sonnent (Jean sur deux fenêtres, qui sonnent toutes deux, répond sur la seconde), une fenêtre refuse pendant que l'autre sonne avec un renvoi sur occupation (le renvoi part, là où l'étape 4b répondait 500), un membre en « ne pas déranger » ne sonne pas (vérifié une fois la transaction finie), appel abandonné (un manqué dans les Récents de chaque membre qui a sonné, un dans `missed_calls` pour le groupe), un nom changé dans l'annuaire puis synchronisé depuis Administration (`POST /admin/directory/sync`) préféré à celui du téléphone, une personne qui se déconnecte garde son compte et le perd en quittant l'annuaire (son ancien poste devient un groupe que l'accueil fait sonner), groupes supprimés après confirmation ; seuls les CDR écrits depuis le début du test sont lus (ceux des exécutions précédentes sont écartés ; deux exécutions à la fois sur la même base se verraient l'une l'autre). `SIP_WSS_URL`, `OPENSIPS_DB_URL`, `OPENSIPS_MI_URL`, `SIP_E2E_PRESENCE_MS` (délai d'affichage d'une présence, 3000 ms par défaut, à relever sur une machine chargée), `RTPENGINE_DTMF_LOG` (`off` sur une machine sans IPv6, où rtpengine ne peut pas ouvrir ce socket), `SIP_E2E_DEBUG=1` pour les messages SIP |
| `yarn e2e:pilot` | un kit pilote déployé (profil `demo`), depuis un navigateur seulement : Alice et Bob se connectent par Keycloak, s'enregistrent par `wss://<domaine>/sip`, se trouvent dans l'annuaire LDAP avec leur présence, s'appellent et s'entendent à travers rtpengine, retrouvent l'appel dans les Récents, Alice administre et Bob non, consoles de Keycloak fermées depuis Internet, déconnexion. `PILOT_URL`, `ALICE_PASSWORD` et `BOB_PASSWORD` (dans `.env`), `PILOT_RESOLVE` (adresse à utiliser pour le domaine), `PILOT_INSECURE=1` (certificat de `TLS=internal`), `BROWSER` |

La CI joue `yarn test`, `yarn e2e:web` et `yarn e2e:sip` (stack SIP en Docker Compose sur le runner, une fois par navigateur : Chromium, Firefox, Edge) sur chaque PR, et `yarn e2e:pilot` sur le kit pilote construit et démarré sur le runner (images Docker comprises, `TLS=internal`), avec un contrôle que seuls 80, 443 et la plage RTP écoutent hors de la boucle, puis rejoué après un arrêt et un second démarrage. Les e2e du POC sur sa propre stack (passerelle ↔ MiniPBX, widget, Meet sur la plateforme) sont partis avec lui ; Meet par téléphone est rejoué sur OpenSIPS à l'étape 8.

## Décisions

Chaque décision est un ADR dans [docs/adr/](docs/adr/README.md). Celles déjà prises, le 13 octobre 2026 :

| Décision | Choix | Alternative écartée |
|---|---|---|
| Client sur le poste | Softphone dans le navigateur | Linphone desktop (rien à installer, même pile que le mobile) |
| Pile SIP navigateur | JsSIP | SIP.js (plus de version depuis octobre 2022) |
| Serveur SIP du MVP | OpenSIPS seul | Flexisip + IPBX dès le départ |
| IPBX | Wazo à l'étape 11, derrière OpenSIPS | XiVO, Asterisk brut, FreeSWITCH |
| Passerelle | Fastify + PostgreSQL du POC | Réécriture |
| Visio | LiveKit SIP + La Suite Meet | Pile média unique LiveKit pour la téléphonie |
| Chiffrement | DTLS-SRTP, puis SRTP ou TLS saut par saut | ZRTP de bout en bout |
| Mobile | Twake mobile, sip_ua et flutter_webrtc, après le web | SDK Linphone |
| Planning | Étapes avec portes de sortie | Semaines |

## Contribuer

- Une fonctionnalité ou un correctif, une branche, une PR, une revue indépendante qui cherche ce qui casse. Voir [CONTRIBUTING.md](CONTRIBUTING.md).
- Une PR qui ajoute une notion de fournisseur hors de son `provider-*` est refusée.
- Les tests du POC restent verts à chaque étape ; un test n'est jamais désactivé pour passer.
- Secrets : jamais dans le dépôt, jamais dans un `.env` commité. Références `env:NOM`.

## Licence

AGPL-3.0, voir [LICENSE](LICENSE), comme le POC dont ce dépôt est issu.

---

<div align="center">

Un projet [LINAGORA](https://linagora.com) pour [Twake](https://twake.app) · Logiciel libre, hébergé chez vous.

</div>
