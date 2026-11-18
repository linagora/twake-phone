<div align="center">

# TwakePhone

**La téléphonie souveraine de Twake : un softphone dans le navigateur, un serveur SIP libre, un trunk opérateur, et zéro licence par utilisateur.**

[![CI](https://github.com/linagora/twake-phone/actions/workflows/ci.yml/badge.svg)](https://github.com/linagora/twake-phone/actions/workflows/ci.yml)
[![Licence AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](#licence)
[![Statut](https://img.shields.io/badge/statut-%C3%A9tape%209%20en%20cours-orange.svg)](#o%C3%B9-on-en-est)
[![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20JsSIP%20%C2%B7%20Fastify%20%C2%B7%20OpenSIPS-informational.svg)](#la-pile)
[![POC](https://img.shields.io/badge/origine-POC%20Linagora-lightgrey.svg)](https://ci.linagora.com/tdelobelle/poc-twake-phone)

*TwakePhone is Twake's sovereign telephony: a browser softphone, a free SIP server, a carrier trunk, no per-seat licence. Docs are in French for now.*

</div>

---

---

## En bref

- **Rien à installer.** Le softphone tourne dans le navigateur (WebRTC), connecté par la session Twake.
- **Un serveur SIP libre.** OpenSIPS et rtpengine portent les appels, l'anti-fraude et le trunk. Wazo ajoute la messagerie, le SVI, les files et l'enregistrement.
- **Une passerelle neutre.** L'app ne connaît aucun PBX : elle parle à la Twake Telephony Gateway.
- **Meet au bout du fil.** Un numéro et un PIN pour rejoindre une salle depuis n'importe quel téléphone.
- **Zéro licence par utilisateur.** Tout est libre, hébergé chez le client.

**Pourquoi.** Les administrations qui passent à Twake gardent un PABX déconnecté de leur outil, ou prennent Teams Phone ou Zoom Phone, américains et facturés par utilisateur. Le marché CANUT (CCTP §7.4.6.2) demande une softphonie intégrée et auto-hébergée.

## Ce que ça fait

| Domaine | Fonctions |
|---|---|
| Appels | Émettre, recevoir, attente, transfert direct et supervisé, DTMF, réception sans onglet ouvert (Web Push), click-to-call vers le téléphone de bureau |
| Annuaire | LDAP avec photos, présence téléphonique en temps réel, « ne pas déranger » planifié |
| Règles d'appel | Renvois (immédiat, occupé, non-réponse), groupes à sonnerie simultanée, numéro de repli |
| Opérateur | Trunk OVHcloud ou tout trunk SIP, numéros directs, urgences par site, international bloqué par défaut, plafonds, détection de fraude |
| Wazo | Messagerie vocale transcrite (LinTO) avec avis dans Twake Chat, SVI, files, groupes séquentiels, enregistrement et supervision |
| Visio | Rejoindre une salle Meet par téléphone, appeler un numéro depuis une salle, passer un appel à deux en conférence |
| Administration | Trunks, numéros, routes, droits, plafonds, webhooks, sans console |
| Intégration | Webhooks signés (HMAC), CDR rapprochés avec OVHcloud, TwakePhone dans Twake Workplace (intent CALL, widget) |

Pas encore : QoS (Homer, MOS), haute disponibilité, mobile, transcription des appels, SaaS multi-tenant (décidé, [ADR 0036](docs/adr/0036-saas-pile-partagee.md)).

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

La voix suit le chemin **navigateur → OpenSIPS (WSS) → rtpengine → trunk**. La passerelle ne transporte aucun son : elle relie les événements d'OpenSIPS, de Meet et d'OVHcloud à l'app et aux webhooks.

Trois règles, non négociables :

1. Aucune notion OpenSIPS hors de `provider-opensips`, Wazo hors de `provider-wazo`, LiveKit ou Meet hors de `conference-livekit`.
2. L'app et la passerelle ne connaissent que le contrat `provider-sdk`.
3. Aucun secret dans le code ni la configuration : des références `env:NOM`.

Pour aller plus loin : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (le détail, avec schémas) et [docs/adr/](docs/adr/README.md) (une décision par fichier, avec ses compromis).

## La pile

| Couche | Choix | Pourquoi |
|---|---|---|
| Application | React, OIDC (PKCE) sur LemonLDAP::NG | Autonome, intégrable ensuite dans Twake Chat (grille d'apps, widget Matrix) |
| Softphone | [JsSIP](https://jssip.net) (MIT) | Maintenu (3.13, mai 2026) ; [sip_ua](https://pub.dev/packages/sip_ua), son port Dart, servira le mobile |
| Passerelle | Fastify 5, TypeScript, PostgreSQL, OpenAPI, WebSocket | Reprise du POC : auth OIDC, secrets SIP par utilisateur chiffrés, historique, multi-tenant, tests de contrat |
| Serveur SIP | [OpenSIPS](https://opensips.org) 3.6 (GPLv2) + [rtpengine](https://github.com/sipwise/rtpengine) (GPLv3) | Registrar, WSS, `dispatcher`, `drouting`, `dialplan`, `fraud_detection`, `acc`, `dialog`, HEP ; `mid_registrar` pour les extensions qui ont une ligne chez Wazo (étape 11c-1, ADR 0027) |
| IPBX (étape 11) | [Wazo Platform](https://wazo-platform.org) (GPLv3, gratuit) | Seul moyen libre et complet d'avoir messagerie, SVI, files, enregistrement, supervision |
| Visio | [LiveKit SIP](https://docs.livekit.io/sip/) (Apache 2.0) + La Suite Meet | Déjà fonctionnel dans le POC : dial-in par PIN, dial-out |
| Transcription | [LinTO](https://linto.ai) STT (AGPL) | Souverain, maîtrisé par LINAGORA |
| QoS | Homer 7, Prometheus, Grafana | MOS par appel, traces SIP, alertes |
| Opérateur | Trunk SIP OVHcloud par défaut, tout trunk standard accepté | SDA, repli, urgences |

Retirés le 13 octobre 2026 : Linphone desktop, Flexisip, SIP.js, Asterisk brut par ARI, Cozy comme hôte de l'application.

## Où on en est

Le développement avance par étapes, chacune fermée par des tests verts et une démo écrite avant de coder. Détail PR par PR : [docs/PLAN.md](docs/PLAN.md).

| # | Étape | État |
|---|---|---|
| 1 | Monorepo, import du POC | ✅ |
| 2 | App React autonome : SSO, annuaire LDAP, synchronisation des comptes | ✅ (CardDAV non fait) |
| 3 | OpenSIPS et JsSIP : appels, attente, transferts, trois navigateurs | ✅ |
| 4 | Événements, présence, historique, renvois, groupes | ✅ |
| 5 | Réception sans onglet ouvert (Web Push) | ✅ |
| 6 | Trunk, anti-fraude, plafonds, urgences par site | ✅ |
| 7 | Administration sans console | ✅ |
| 8 | Meet par téléphone, conférence, passage en visio | ✅ |
| 9 | TwakePhone dans Twake Workplace : liens `tel:`, intent CALL, widget | 🟡 reste la présence dans Chat et la publication sur le registre Cozy |
| 10 | Webhooks signés et OVHcloud *(fin du MVP web)* | ✅ contre un faux OVH, à essayer contre le vrai |
| 11 | Wazo : messagerie transcrite, SVI, files, enregistrement, supervision, click-to-call | ✅ |

Décidé, pas encore dans le code :

- **Meet par sa propre téléphonie.** Meet tient le PIN et les règles de LiveKit SIP ; notre passerelle ne le fait plus ([ADR 0018](docs/adr/0018-meet-livekit-sip-derriere-opensips.md)).
- **SaaS sur une pile partagée.** Un domaine SIP et un tenant Wazo par organisation ([ADR 0036](docs/adr/0036-saas-pile-partagee.md)).

Ensuite : QoS, exploitation et haute disponibilité, pilote de 30 à 50 utilisateurs, mobile, transcription des appels.

## Démarrer

**Essayer à plusieurs** sur une machine joignable depuis Internet : le kit pilote, [docker/pilot/README.md](docker/pilot/README.md) (Linux avec Docker, un nom de domaine, trois commandes).

**Développer.** Prérequis : Node 24 et plus (`.nvmrc`), Yarn 1, Docker.

```bash
yarn install && yarn build && yarn test        # paquets, passerelle et app web, aucun service externe
yarn dev:gateway                               # passerelle sur http://localhost:8080, OpenAPI sur /docs
yarn dev:web                                   # app TwakePhone sur http://localhost:4173 (config dans apps/web/public/config.json)
```

Avec de vrais appels, sur la stack SIP locale :

```bash
docker compose -f docker/docker-compose.sip.yml up --build --wait     # OpenSIPS 3.6 (WS 8088, WSS 8089), rtpengine, PostgreSQL 54320
OPENSIPS_WS_URL=wss://127.0.0.1:8089 OPENSIPS_DB_URL=postgres://twake:twake@127.0.0.1:54320/twake OPENSIPS_MI_URL=udp:127.0.0.1:8880 \
  DATABASE_URL=postgres://twake:twake@127.0.0.1:54320/twake SECRETS_KEY=$(openssl rand -hex 32) yarn dev:gateway
```

Toutes les variables (annuaire, comptes, téléphonie, webhooks, OVHcloud, messagerie, parcours d'appel, transcription, enregistrement) : [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Tests

| Commande | Vérifie |
|---|---|
| `yarn test` | les tests unitaires de tous les paquets et de la passerelle |
| `yarn e2e:web` | l'app dans Chromium : connexion, annuaire, administration, réglages |
| `yarn e2e:sip` | de vrais appels entre navigateurs à travers OpenSIPS et rtpengine (`BROWSER=chromium`, `firefox` ou `msedge`) ; demande la stack SIP |
| `node apps/web/test/trunk.sip.mjs` | le trunk, l'anti-fraude et les urgences, sans navigateur, sur la même stack |
| `yarn e2e:pilot` | un kit pilote déployé, depuis un navigateur |

La CI joue `yarn test`, `yarn e2e:web`, l'e2e de Twake Workplace et `yarn e2e:sip` sur trois navigateurs à chaque PR, et monte le kit pilote sur le runner. Détail de chaque commande : [docs/TESTS.md](docs/TESTS.md).

## Organisation du dépôt

```
apps/web                     l'app TwakePhone (React, twake-mui, OIDC, softphone)
apps/gateway                 la Twake Telephony Gateway (Fastify, PostgreSQL, OpenAPI sur /docs)
apps/workplace               la coquille Cozy dans Twake Workplace (intent CALL)
packages/telephony-types     modèle neutre : Call, Presence, Capabilities, MediaSession
packages/provider-sdk        le contrat que chaque fournisseur implémente
packages/telephony-client    SDK front : REST, WebSocket, E.164, conférences
packages/softphone           softphone JsSIP : appels, attente, transferts, audio, DTMF
packages/provider-opensips   OpenSIPS : comptes, événements, présence, renvois, groupes
packages/provider-wazo       Wazo : messagerie, lignes, enregistrement, supervision
packages/provider-ovh        OVHcloud : renvoi de repli, CDR
packages/conference-livekit  Meet et LiveKit SIP
packages/transcription-linto transcription des messages par LinTO STT
packages/phone-link          numéro cliquable (intent CALL) pour Twake Workplace
packages/phone-widget        widget d'appel pour les autres apps Twake Workplace
docker/                      stack SIP de dev : OpenSIPS, rtpengine, PostgreSQL, LiveKit, Wazo, LinTO, Synapse
docker/pilot/                kit pilote : tout le MVP sur une machine, HTTPS par Caddy
docs/                        architecture, configuration, tests, plan ; docs/adr/ : une décision par fichier
```

## Origine : le POC

Ce dépôt part du [POC Twake Phone](https://ci.linagora.com/tdelobelle/poc-twake-phone) de Linagora (AGPL-3.0). Le POC a prouvé le cœur : la passerelle et son contrat de fournisseur, le softphone navigateur, Meet par téléphone, des appels SIP réels en e2e. Son README d'origine est dans [docs/POC.md](docs/POC.md).

<details>
<summary>Ce que TwakePhone a changé par rapport au POC</summary>

| POC | TwakePhone |
|---|---|
| Application Cozy dans Twake Workplace | Application React autonome, OIDC |
| SIP.js | JsSIP |
| Asterisk piloté par ARI, navigateur connecté directement au PBX | OpenSIPS seul, puis Wazo derrière OpenSIPS |
| Trunk sans garde-fou (« un appel externe n'est pour l'instant limité par rien ») | Anti-fraude, plafonds, routes, repli |
| Spike Web Push | Réception d'appel sans onglet ouvert, en production |
| Appartenance des appels en mémoire | PostgreSQL, puis Redis pour plusieurs réplicas |

Les leçons du POC sur un trunk réel derrière NAT (pas de port 5060, un contact par serveur de l'opérateur, aucune adresse externe déclarée) sont reprises telles quelles.

Le code du POC (app Phone Cozy, PBX de dev MiniPBX, `sip-media`, stack de dev) a été retiré à la PR 3c, son provider de référence (`provider-asterisk`, ARI) à la PR 4c : l'historique Git les conserve.

</details>

## Décisions

Chaque décision est un ADR dans [docs/adr/](docs/adr/README.md), avec son contexte, ses compromis et le code qui la porte.

<details>
<summary>Les choix de départ (13 octobre 2026)</summary>

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

</details>

## Contribuer

- Une branche, une PR, une revue indépendante qui cherche ce qui casse. Voir [CONTRIBUTING.md](CONTRIBUTING.md).
- Une notion de fournisseur hors de son `provider-*` est refusée.
- Un test n'est jamais désactivé pour passer.
- Aucun secret dans le dépôt ni dans un `.env` commité.

## Licence

AGPL-3.0, voir [LICENSE](LICENSE), comme le POC dont ce dépôt est issu.

---

<div align="center">

Un projet [LINAGORA](https://linagora.com) pour [Twake](https://twake.app) · Logiciel libre, hébergé chez vous.

</div>
