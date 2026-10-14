# Serveur SIP du MVP : OpenSIPS 3.6 et rtpengine (`docker-compose.sip.yml`)

Le serveur SIP de TwakePhone depuis l'étape 3 : OpenSIPS (registrar, SIP sur WS et WSS, authentification digest, routage entre postes, `dialog`) et rtpengine (média, DTLS-SRTP des deux côtés, ICE), avec un PostgreSQL qui porte la table `subscriber` que la passerelle remplit. Les trois services sont en réseau hôte : les navigateurs de la machine joignent les ports RTP de rtpengine et les sockets d'OpenSIPS directement (les candidats ICE sont l'adresse de l'hôte). Linux, ou Docker Desktop ≥ 4.34 avec le réseau hôte activé.

```bash
docker compose -f docker/docker-compose.sip.yml up --build --wait
```

| Quoi | Où |
|---|---|
| SIP sur WebSocket | `ws://127.0.0.1:8088`, `wss://127.0.0.1:8089` (certificat auto-signé fait au démarrage, à faire accepter au navigateur ; `TLS_CERT` et `TLS_KEY` pour en fournir un) |
| SIP UDP (trunk à l'étape 6) | `127.0.0.1:5060` |
| rtpengine | contrôle `udp:127.0.0.1:22222`, RTP `30000-30100/udp`, rapport des DTMF détectés `127.0.0.1:22223/udp` |
| PostgreSQL | `postgres://twake:twake@127.0.0.1:54320/twake` (`subscriber` créée au premier démarrage par `opensips/subscriber.sql`, la copie de `SUBSCRIBER_SCHEMA` du provider) |
| Variables | `SIP_DOMAIN` (domaine SIP, realm et adresse annoncée dans Via et Record-Route ; `127.0.0.1` par défaut), `LISTEN_IP`, `OPENSIPS_LOG_LEVEL`, `RTPENGINE_INTERFACE` (`<privée>!<publique>` derrière un NAT) |

`opensips/opensips.cfg.tpl` est rendu par `opensips/entrypoint.sh` à partir de l'environnement, puis vérifié (`opensips -C`) avant le démarrage. Ce que fait la configuration :

- `REGISTER` : digest (`auth_db` sur `subscriber`, empreintes `ha1` écrites par la passerelle, jamais de mot de passe en clair), une personne n'enregistre que son propre poste, `fix_nated_register`, connexion WebSocket gardée ouverte le temps de l'enregistrement ; dix contacts par poste.
- `INVITE` : digest aussi (`proxy_authorize`, l'appelant appelle en son nom), `lookup("location")` vers tous les contacts enregistrés du poste appelé (fourche parallèle, le premier qui répond prend l'appel), rtpengine des deux côtés (`ICE=force`, `RTP/SAVPF`, `rtcp-mux`), `dialog` suit l'appel (les transferts de la PR 3b s'y appuient). Un poste sans contact répond 404 ; un contact dont la connexion est partie répond 480.
- En dialogue : `Record-Route`, les `Contact` des navigateurs (hôte `.invalid`, RFC 7118) sont remplacés par la connexion d'où ils viennent (`fix_nated_contact`) pour que re-INVITE (attente), INFO (DTMF), BYE et REFER suivent ; rtpengine libéré au `BYE`.
- `OPTIONS` : 200. Pas encore de `SUBSCRIBE`/`PUBLISH`/`MESSAGE` (503).

Sans Docker (poste de dev sans démon) : OpenSIPS se compile depuis GitHub (`make prefix=/opt/opensips include_modules="proto_ws proto_wss tls_mgm tls_openssl db_postgres" all install`), rtpengine s'installe depuis Ubuntu 24.04, et `entrypoint.sh` se lance avec `OPENSIPS_BIN`, `OPENSIPS_MPATH`, `CFG_TEMPLATE`, `CFG_OUT`, `TLS_CERT`, `TLS_KEY`, `MI_FIFO` pointés hors de `/etc`. C'est ainsi que la configuration a été mise au point ; la CI joue la stack Docker.

Le e2e : `yarn e2e:sip` (README, section « Vérifier »).

# PBX de dev du POC (MiniPBX + overlay), retiré à la PR 3c

MiniPBX sert uniquement d'infrastructure de test (cahier §4). Il est utilisé tel quel (`references/minipbx`, non modifié) ; l'overlay `minipbx-dev/` lui ajoute ce que son MVP exclut : WebRTC (WSS, DTLS-SRTP, Opus) et ARI. Le build échoue si une ancre du patch a bougé en amont.

```bash
docker build -f references/minipbx/docker/Dockerfile -t minipbx-base:local references/minipbx
docker compose -f docker/docker-compose.dev.yml up -d --build
NODE_TLS_REJECT_UNAUTHORIZED=0 node docker/minipbx-dev/smoke.mjs   # ARI + REGISTER SIP sur WSS
```

| Quoi | Où |
|---|---|
| Admin MiniPBX | http://127.0.0.1:18080 — `admin` / `admin-dev-password` |
| ARI (provider-asterisk) | http://127.0.0.1:8088 — `twake` / `twake-dev` |
| SIP/WSS (navigateurs) | `wss://pbx.twake.local:8089/ws` (cert auto-signé, à faire approuver) |
| Extensions | 101, 102, 103 (user1..3) pour les tests à la main ; 104, 105 (test1, test2) **réservées aux tests automatiques**, afin qu'ils ne volent pas la session de quelqu'un qui teste. Mot de passe SIP de dev `dev-sip-secret` |

Tous les secrets ci-dessus sont des valeurs de dev jetables.

## Limites connues

- Les migrations Alembic de MiniPBX 0.1.1 laissent le schéma incomplet sur l'image d'origine (arm64) : le compose force `MINIPBX_MIGRATIONS_ENABLED=false`.
- Toutes les extensions sont des endpoints WebRTC (pas de softphone UDP classique sur 101-103).
- Média depuis un navigateur : il faut renseigner `ASTERISK_EXTERNAL_ADDRESS` (IP de l'hôte) pour les candidats ICE ; non testé avec un vrai navigateur.
- Pas de trunk : « appel externe simulé » à ajouter (trunk vers 127.0.0.1 + route entrante).
- `pbx.twake.local` doit être ajouté à `/etc/hosts` pour les navigateurs.

## Test bout en bout

`yarn e2e:live` démarre le Gateway complet et deux agents SIP/WSS de test (`minipbx-dev/test-ua.mjs`, signalisation seule, sans média) sur 101 et 102, puis vérifie : capabilities, session média, appel user1→user2 (événements des deux côtés, présence BUSY), hold/resume, raccrochage, DND appliqué, idempotence.

## Conventions provider ↔ PBX

- Le DND est un état d'appareil ARI `Stasis:dnd<ext>` (ARI ne pilote que le préfixe `Stasis:`). Le dialplan de l'overlay le respecte pour les appels composés par un téléphone ; le provider le vérifie aussi avant un click-to-call, car ARI contourne le dialplan.
- Click-to-call : le endpoint de l'appelant sonne d'abord, la cible est ensuite appelée et ponte.
- Le hold demandé par l'API est signalé par le provider (ARI n'émet pas d'événement) ; avec l'audio navigateur, le hold réel est fait par le navigateur (re-INVITE).

## Test navigateur (audio réel)

`yarn e2e:browser` pilote deux Chrome installés localement (micro simulé) : enregistrement WSS, appel navigateur→navigateur avec paquets RTP dans les deux sens, hold/resume, puis click-to-call via le Gateway. Il faut démarrer le PBX avec l'IP vers laquelle Chrome joint les ports RTP publiés (ICE) :

```bash
ASTERISK_EXTERNAL_ADDRESS=127.0.0.1 docker compose -f docker/docker-compose.dev.yml up -d --build
yarn e2e:browser
```

## Plusieurs fenêtres par personne

Une extension accepte jusqu'à 5 contacts SIP (`max_contacts=5`, contacts déconnectés retirés) : chaque fenêtre Phone ouverte sonne, et la première qui répond prend l'appel. Le premier appel du click-to-call (celui qui fait sonner son propre poste) est décroché automatiquement par la fenêtre qui le reçoit.

## Aperçu visuel sans le stack Twake

`apps/phone/test/preview.mjs` lance l'app construite dans Chrome (contacts simulés, Gateway local) sur les extensions 104/105 et enregistre des captures dans `/tmp/phone-shots`.

## Une application ARI par Gateway

Le Gateway se déclare auprès d'Asterisk sous un nom d'application ARI (`twake` par défaut). Deux clients qui utilisent le même nom se gênent : quand l'un se déconnecte, Asterisk désactive l'application pour les deux (« Stasis app 'twake' not active ») et plus aucun appel lancé par le Gateway n'aboutit, alors que `/ready` reste vert. Tout script de test, et chaque réplica du Gateway, doit donc configurer son propre `ari.app` ; les scripts de ce dépôt utilisent `twake-<test>-<pid>`.

## Configuration locale (`docker/.env`)

Le Gateway chiffre les secrets SIP avec `SECRETS_KEY` et parle à l'API de provisionnement du PBX avec `TWAKE_PROVISION_TOKEN`. Ces valeurs ne sont jamais dans Git :

```bash
printf 'SECRETS_KEY=%s\nTWAKE_PROVISION_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > docker/.env && chmod 600 docker/.env
```

Perdre `SECRETS_KEY` rend les secrets SIP stockés illisibles : il suffit alors de vider la table `sip_credentials` ; chaque utilisateur en reçoit un neuf à sa prochaine connexion.

La base `telephony` (rôle `telephony`) se crée dans le PostgreSQL du stack :

```bash
docker exec postgres psql -U postgres -c "CREATE ROLE telephony LOGIN PASSWORD 'telephony-dev'" -c "CREATE DATABASE telephony OWNER telephony"
```

## Brancher un vrai trunk SIP

1. Ouvre l'administration de MiniPBX : http://127.0.0.1:18080 (`admin` / `admin-dev-password`, valeurs de dev) puis la page **Trunk** : hôte, identifiant, mot de passe, `from_user` / `from_domain` selon ton opérateur. Le trunk s'appelle `trunk-main`.
2. **Réseau.** Laissez l'adresse externe de MiniPBX **vide** et réglez le réseau local sur `172.27.0.0/16`. L'enregistrement part du conteneur et l'opérateur répond sur la même connexion (NAT) : renseigner une adresse externe (IP publique ou de la machine) n'a pas aidé et peut empêcher l'enregistrement. Le PBX écoute sur `5080/udp`, pas 5060 : voir la section « Trunk SIP » plus bas, qui explique pourquoi et comment vérifier que l'appel entrant peut arriver.
3. **Appels entrants.** Dans **Routes entrantes**, envoie le numéro de l'opérateur vers une extension : la sonnerie atteint toutes les fenêtres ouvertes de la personne.
4. **Appels sortants depuis Twake Phone.** Les numéros externes passent par le **plan d'appel de MiniPBX** (`minipbx-internal`), au format national qu'il attend (`+33612345678` devient `0612345678`) : tes règles sortantes s'appliquent donc (international bloqué par défaut, numéros d'urgence, contrôle de l'appelant). La configuration est dans `provider_configs.config.externalDial` (variables `ASTERISK_EXTERNAL_*` à l'amorçage). Un numéro d'un autre pays devient `00…` et suit la règle internationale de MiniPBX.

   Si tu autorises l'international dans MiniPBX, il n'y a pas de seconde barrière côté Gateway : le Gateway n'a pas encore ses propres politiques de numérotation ni de quotas.
5. **Entrant et fenêtres.** Les extensions sont des téléphones WebRTC : un appel entrant ne sonne que si une fenêtre de l'extension est ouverte et enregistrée (Phone ou widget). Sans fenêtre ouverte, personne ne décroche.

## Visio : accès téléphonique à Meet

Prérequis : la pile Twake avec Visio (`meet_app` : LiveKit, backend, frontend) et le PBX de dev.

1. Dans `meet_app/docker-compose.yml` (backend) : `ROOM_TELEPHONY_ENABLED`, `ROOM_TELEPHONY_PHONE_NUMBER=8000`, `EXTERNAL_API_ENABLED`, `APPLICATION_JWT_*`, `APPLICATION_ALLOW_USER_CREATION`, et `visio-frontend` dans `ALLOWED_HOSTS`. Dans `livekit.yaml.template` : le webhook vers le Gateway et vers Meet (par `visio-frontend:8080`).
2. Déclarer le Gateway comme application de Meet, avec les droits `rooms:create|list|retrieve` et le domaine `twake.local`, puis écrire `MEET_CLIENT_ID` et `MEET_CLIENT_SECRET` dans `docker/.env` :

```bash
docker exec visio-backend python manage.py shell -c '
from core import models, utils
app, _ = models.Application.objects.get_or_create(name="Twake Telephony Gateway", defaults={"scopes": ["rooms:create","rooms:list","rooms:retrieve"]})
secret = utils.generate_client_secret(); app.client_secret = secret; app.save()
models.ApplicationDomain.objects.get_or_create(application=app, domain="twake.local")
print(app.client_id, secret)'
```

3. Lancer LiveKit SIP et activer les routes du Gateway, puis tester :

```bash
docker compose -f docker-compose.dev.yml -f meet-sip/docker-compose.meet-sip.yml up -d --build
node meet-sip/platform.e2e.mjs   # sur la plateforme (après `yarn build` à la racine)
node meet-sip/smoke.mjs          # LiveKit seul, mode sans Meet
```

- Numéro affiché par Meet : un vrai numéro E.164 (`MEET_TELEPHONY_NUMBER=+33…` dans le `.env` de la stack, le numéro de la ligne du trunk ; `8000` par défaut), sinon Meet affiche « +33 8000 », qui n'est pas appelable. Réglez la route entrante de MiniPBX pour envoyer les appels de la ligne vers l'extension interne `8000` (LiveKit SIP) : l'extension 101 ne reçoit plus d'appels extérieurs.
- Le PBX gagne l'endpoint `livekit` (identifié par IP), le numéro d'accès `8000` (PIN) et `8888`, un correspondant de test qui décroche.
- Dans Phone, l'entrée « Visio » apparaît quand le Gateway a LiveKit : coller un lien Meet ou créer une salle, lire numéro et PIN, inviter un numéro.
- Sous Docker, relire la sortie complète du build du Gateway : une erreur TypeScript laisse l'ancien conteneur en place.

## Trunk SIP : pas de port source 5060, un keepalive par serveur de l'opérateur

Symptôme : le trunk est `Registered` mais l'opérateur n'envoie jamais l'appel entrant, puis les enregistrements restent sans réponse (`Rejected`). Mesuré sur la ligne freepro, derrière un NAT domestique et Docker Desktop (Mac) :

- depuis le **port source 5060**, aucun paquet SIP n'obtient de réponse de freepro (ni OPTIONS ni REGISTER), alors que **tous les autres ports sources répondent**, depuis l'hôte comme depuis un conteneur. Le PBX de dev écoute donc sur **5080** (`sip_port`, publié `5080:5080/udp`) ;
- freepro a deux serveurs d'appel (`85.31.193.197` et `.213`) et un NAT n'accepte que le trafic d'une destination à qui l'on a écrit récemment : le patch du template ajoute un contact par IP du serveur à l'AOR du trunk, avec `qualify_frequency=15`, pour garder les deux ouverts. Vérifier avec `pjsip show contacts` : les trois contacts doivent être `Avail`.

Si le PBX change de port, `MEET_OUTBOUND_ADDRESS` change aussi ; le Gateway remplace tout seul le trunk sortant LiveKit périmé.
