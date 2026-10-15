# Twake Phone : architecture et explication technique

Ce document décrit ce qui est réellement implémenté dans le dépôt (état à ce jour), pas seulement la cible du cahier des charges. Les écarts sont listés en §11, l'accès téléphonique aux salles Meet (Twake Visio) en §12 et le trunk SIP réel en §13. Le code du POC (app Phone Cozy, PBX de dev MiniPBX, `sip-media`, stack de dev) a été retiré à la PR 3c, son provider de référence (`provider-asterisk`, ARI) et le guide du PBX Asterisk externe qui l'accompagnait à la PR 4c ; ce que ce document en gardait est remplacé par ce que fait le MVP et par l'étape du plan qui refait chaque partie.

## 1. Vue d'ensemble

```mermaid
flowchart LR
  subgraph Browser["Poste de l'utilisateur"]
    Phone["App TwakePhone (apps/web)<br/>React, OIDC<br/>client de la passerelle + Softphone (JsSIP)"]
  end

  subgraph TWAKE["Déploiement Twake"]
    SSO["LemonLDAP::NG (OIDC), LDAP"]
    subgraph Tel["Couche téléphonie (ce dépôt)"]
      GW["Telephony Gateway<br/>Fastify, REST + WebSocket, PostgreSQL<br/>(neutre vis-à-vis du serveur SIP)"]
      Prov["provider-opensips<br/>seul code qui connaît OpenSIPS"]
      Conf["conference-livekit<br/>(API Meet, Twirp LiveKit) : étape 8"]
    end
    OS["OpenSIPS 3.6<br/>registrar, WSS, routage, dialog"]
    RTP["rtpengine<br/>DTLS-SRTP, ICE"]
    Meet["Meet, LiveKit, LiveKit SIP<br/>étape 8"]
  end

  Trunk["Opérateur SIP (trunk)<br/>étape 6"]

  Phone -- "OIDC (PKCE)" --> SSO
  Phone -- "HTTPS, WebSocket" --> GW
  GW -- "LDAP" --> SSO
  GW --> Prov
  GW --> Conf
  Prov -- "comptes et CDR dans PostgreSQL ; MI et événements (UDP, ADR 0011)" --> OS
  Conf -.-> Meet
  OS --- RTP
  OS -. "SIP" .-> Trunk
  OS -. "SIP" .-> Meet

  Phone -. "SIP sur WSS (signalisation)" .-> OS
  Phone == "RTP/SRTP, ICE (média)" ==> RTP
  RTP == "RTP" ==> Trunk
```

Trait plein : contrôle (REST, base de données). Pointillés : signalisation SIP. Double trait : audio.

**Deux zones.** La passerelle, ses providers et le serveur SIP sont déployés et exploités avec Twake (`docker/docker-compose.sip.yml` pour OpenSIPS, rtpengine et leur PostgreSQL). L'opérateur est **à l'extérieur** : joint par SIP et RTP, il peut être remplacé. Dans la zone Twake, seul `provider-opensips` connaît OpenSIPS ; c'est le seul provider de téléphonie depuis la PR 4c, qui a retiré `provider-asterisk`, le provider de référence du POC (ARI). Une ligne `asterisk` restée dans `provider_configs` est signalée au démarrage de la passerelle et son organisation n'a pas de provider : la supprimer, ou la remplacer par une configuration OpenSIPS.

**Deux plans séparés (cahier §25) :**

| Plan | Qui | Où |
|---|---|---|
| Contrôle : comptes, session média, présence, état des appels, événements, historique, renvois, groupes d'appel, noms affichés | Gateway et provider, via l'API REST/WebSocket du Gateway ; côté serveur SIP, les tables `subscriber`, `call_rules`, `call_groups` et `display_names`, les CDR du module `acc`, les événements (`event_datagram`) et l'interface MI (`mi_datagram`) d'OpenSIPS | `apps/gateway`, `packages/provider-opensips` |
| Média et signalisation d'appel : SIP, ICE, DTLS-SRTP, attente, DTMF, transferts | Le navigateur directement vers le serveur SIP | `packages/softphone` (JsSIP) |

Le Gateway ne voit jamais l'audio.

## 2. Organisation du dépôt

```mermaid
flowchart TB
  types["telephony-types<br/>modèle neutre"]
  sdk["provider-sdk<br/>interfaces TelephonyProvider,<br/>MediaProvider, ConferenceBridgeProvider"]
  os["provider-opensips<br/>session média, comptes, événements,<br/>renvois, groupes, noms"]
  lk["conference-livekit<br/>(API Meet, LiveKit SIP)"]
  plink["phone-link<br/>PhoneLink, intent CALL"]
  client["telephony-client<br/>REST, WS, E.164"]
  soft["softphone<br/>JsSIP"]
  widgetlib["phone-widget<br/>mountPhoneWidget"]
  gw["apps/gateway"]
  app["apps/web"]

  types --> sdk --> os
  sdk --> lk
  os --> gw
  lk --> gw
  types --> client
  types --> soft
  client --> app
  soft --> app
  widgetlib -. "monté par les apps hôtes Twake Workplace" .-> app
  plink -. "utilisé par les apps hôtes" .-> widgetlib
  client --> plink
```

| Paquet | Rôle | Dépend d'un fournisseur ? |
|---|---|---|
| `telephony-types` | `Call`, `CallState`, `Presence`, `Capabilities`, `TelephonyEvent`, `MediaSession`… | Non |
| `provider-sdk` | Contrat qu'un provider doit respecter (`originate`, `hangup`, `hold`, `subscribe`, `getCapabilities`…) | Non |
| `provider-opensips` | Session média `sip-webrtc` (URL WSS, domaine, poste, secret, ICE), comptes dans la table `subscriber` d'OpenSIPS (empreintes `ha1`), abonnement aux événements d'OpenSIPS par MI (`events.ts`) et suivi pur des appels et de la présence par poste (`tracker.ts`, ADR 0011), renvois et « ne pas déranger » dans la table `call_rules` (`call-rules.ts`, ADR 0013), groupes d'appel et noms de l'annuaire dans les tables `call_groups` et `display_names` (`call-groups.ts`, ADR 0014). Aucune notion OpenSIPS n'en sort. | Oui, c'est son rôle |
| `apps/gateway` | API publique `/api/v1`, annuaire LDAP, correspondances utilisateur↔poste, bus d'événements, registre des providers par tenant | Non |
| `telephony-client` | SDK front : REST (appels, historique, conférences), WebSocket avec reconnexion, normalisation et formatage E.164 | Non |
| `softphone` | Enveloppe JsSIP (§5) : enregistrement, appels, mute, hold, DTMF, transferts, compteurs RTP, reconnexion | Non |
| `phone-widget` | Monte le widget d'appel dans une app Twake Workplace (iframe d'intent) | Non |
| `phone-link` | `<PhoneLink>` et `requestCall` : rendre un numéro cliquable (intent `CALL`) | Non |
| `conference-livekit` | Accès téléphonique aux salles Meet : client de l'API externe de Meet, client Twirp de LiveKit (trunks SIP, participants, webhooks). Aucune notion LiveKit n'en sort. | Oui (LiveKit/Meet), c'est son rôle |
| `apps/web` | L'application TwakePhone (§6) | Non |

La règle d'architecture est tenue : tout ce qui touche à OpenSIPS (`subscriber`, `call_rules`, `call_groups`, `display_names`, realm, MI) reste dans `provider-opensips` (et dans la configuration d'OpenSIPS, `docker/opensips`), tout ce qui touche à LiveKit et Meet dans `conference-livekit`. Remplacer le serveur SIP revient à écrire un autre provider.

## 3. Le Gateway

Fastify, TypeScript. Routes principales sous `/api/v1` :

| Route | Rôle |
|---|---|
| `GET /me`, `/me/endpoints`, `/me/media-session` | Identité, endpoints, session média (identité SIP + URL WSS) |
| `GET /capabilities` | Ce que le provider sait faire ; l'UI s'adapte |
| `GET/PUT /me/presence` | Présence normalisée (`available`, `busy`, `away`, `dnd`, `offline`) ; `PUT` répond la présence effective (ce que les autres voient) ; `away` et `dnd` peuvent avoir une fin (`until`, un an au plus) et un message (`message`, 140 caractères, une ligne), `choice` dit ce que la personne a choisi (ADR 0013) |
| `GET/PUT /me/forwarding` | Renvois de la personne vers le poste d'un collègue : `always`, `busy`, `noAnswer` (`target`, `delaySec` de 2 à 120) ; une cible qui n'est pas un poste de l'organisation, ou le sien, est refusée (400 avec `code`) ; 501 si le provider ne renvoie pas (capacité `forwarding`) |
| `GET /presence` | Présence de tout le tenant, par poste, quand le provider la tient à jour (`realtime`) |
| `GET /admin/directory`, `POST /admin/directory/sync` | Source de l'annuaire, état et rapport de la synchronisation, synchronisation à la demande (administrateurs) |
| `GET/POST /admin/groups`, `PUT/DELETE /admin/groups/:number` | Groupes d'appel simultané de l'organisation (administrateurs, ADR 0014) : `GET` les liste avec leurs membres que personne ne tient (`vacant`) ; `POST` crée (`number`, `name`, `members` ; 409 `GROUP_EXISTS` si l'organisation a déjà ce numéro), `PUT` remplace un groupe existant (404 sinon) ; `name` une ligne de 64 caractères, `members` 1 à 12 postes de l'organisation (ou déjà membres), taille vérifiée avant toute recherche ; un numéro déjà pris (un poste, un compte de `subscriber`, le groupe d'une autre organisation) est refusé (409 `GROUP_NUMBER_TAKEN`, sans dire lequel), un membre qui n'est pas un poste aussi (400 `GROUP_MEMBER_NOT_EXTENSION`) ; vérification et écriture pendant qu'aucune synchronisation de l'annuaire ne tourne (10 s d'attente au plus, puis 503 `SYNC_RUNNING`, rien d'écrit) ; 501 si le provider n'a pas de groupes (capacité `groups`) |
| `POST /calls` (+ `Idempotency-Key`) | Crée un appel (click-to-call) |
| `GET /calls/history`, `DELETE /me/history` | Historique serveur de l'appelant (filtres, curseur) et effacement |
| `POST /calls/:id/{hangup,hold,resume,dtmf,transfer,answer,reject}` | Actions sur un appel, réservées à ses participants (voir ci-dessous) |
| `POST /ws-ticket`, `GET /ws` | Ticket à usage unique, puis flux d'événements temps réel : d'abord `{"type":"stream.ready"}` (la session est acceptée, le client peut relire l'état), puis ceux de l'utilisateur (appels) et ceux du tenant (`presence.changed`, avec le poste) |
| `POST /conferences`, `GET/DELETE /conferences/:id`, `POST /conferences/:id/participants`, `DELETE …/participants/:pid`, `POST …/participants/:pid/mute` | Accès téléphonique à une salle Meet (§12) |
| `POST /webhooks/livekit` | Webhooks LiveKit, authentifiés par signature (§12) |
| `/health`, `/ready`, `/docs`, `/openapi.json` | Exploitation |

Mécanismes :

- **Authentification** (`auth.ts`), choisie par `AUTH_MODE` (refus de démarrer si la configuration est incomplète) :
  - `cozy` (défaut) : le client envoie le jeton d'application Cozy qu'il a déjà et l'URL de son instance (`X-Cozy-Instance`). Le Gateway demande à **cette instance** (`GET /settings/instance`) à qui appartient le jeton : le stack fait autorité, il n'y a ni clé à partager ni seconde connexion. L'instance doit correspondre à `COZY_INSTANCE_PATTERN` (protection contre l'usage du Gateway pour joindre un hôte arbitraire). Un jeton inconnu donne 401, une panne du stack 503. Les jetons vérifiés sont mis en cache une minute.
  - `jwt` : jeton OIDC signé, vérifié sur le JWKS du SSO (émetteur, audience, expiration, algorithme).
  - Dans les deux cas l'identité porte aussi l'**e-mail** (attribut `email` de `/settings/instance`, revendication `email`), que §12 utilise pour agir chez Meet au nom de la personne.
  - `dev` : jeton `dev:<user>`, jamais en production (le Gateway refuse de démarrer avec `NODE_ENV=production`).
- **Ticket WebSocket** : un navigateur ne peut pas poser d'en-tête sur un WebSocket. Le client échange ses identifiants contre un ticket à usage unique valable 30 s (`POST /ws-ticket`), puis ouvre `/ws?ticket=…`. Aucun jeton durable ne circule dans une URL.
- **Persistance** (`store/`) : PostgreSQL (`provider_configs`, `user_mappings` avec service, source et date de synchronisation, `call_history`, `sip_credentials`, `conferences`, `favorites`, `user_presence`), migrations SQL appliquées au démarrage. Toute méthode du `Store` prend le tenant. Un contrat de tests identique tourne sur l'implémentation mémoire et sur PostgreSQL, dont l'isolation entre tenants.
- **Présence choisie et renvois** (ADR 0013) : ce que la personne choisit (absent, « ne pas déranger », sa fin, son message) est rangé par tenant et par personne (`user_presence`), oublié à sa date, et remis au provider à son démarrage avec le poste du jour, puis après chaque synchronisation de l'annuaire qui change une attribution. Le provider OpenSIPS écrit les renvois et le « ne pas déranger » dans `call_rules`, qu'OpenSIPS lit à chaque INVITE (sans bloquer, avec un `statement_timeout` court) : renvoi immédiat, puis, pendant un « ne pas déranger », renvoi sur non-réponse, sinon sur occupation, sinon refus 480 (`Twake-Dnd: 1`) avec le message (`Twake-Dnd-Message`) que le softphone montre à qui a composé ce poste, et à lui seul ; trois renvois au plus, jamais vers l'appelant ni un poste déjà traversé. Chaque ligne garde le titulaire du poste et celui de chaque cible : à chaque changement d'attribution que la passerelle voit (son démarrage, une synchronisation), la ligne d'un poste qui change de titulaire est supprimée avec son « ne pas déranger », et un renvoi dont la cible change de titulaire aussi ; un nouveau titulaire n'hérite de rien. Un changement fait à la main dans la base, hors synchronisation, attend le prochain démarrage. Les écritures de présence et de renvois d'un tenant passent l'une après l'autre avec la remise au provider, chacune bornée (requêtes de 5 s au plus, 10 s d'attente au plus derrière la précédente) et refusée (409) si la personne ne tient plus le poste résolu avec la requête ; une base OpenSIPS ne sert qu'un tenant. OpenSIPS ne lit rien en `failure_route` : les règles des cibles de renvoi sont lues avant la sonnerie.
- **Appartenance des appels** : le Gateway retient, pour chaque appel, les utilisateurs dont les événements l'ont porté (et celui qui l'a lancé). Toute action `/calls/:id/…` d'un autre utilisateur répond 404, comme pour un appel inexistant. La table est en mémoire.
- **Tenants** : l'identité authentifiée fixe le tenant et l'utilisateur, jamais la requête. Le provider est celui du tenant (`registry.ts`), la correspondance utilisateur/extension est par tenant.
- **Annuaire** (`contacts.ts`, `ldap-directory.ts`) : les personnes que l'on peut appeler viennent du LDAP de l'organisation (`LDAP_*`), jamais mises en cache ; `GET /directory?q=` cherche chaque mot par préfixe sur nom, prénom, courriel, service et identifiant, et un numéro tapé par ses derniers chiffres ; la réponse dit si elle est tronquée. Un annuaire ne sert qu'un tenant (`LDAP_TENANT`) : les autres reçoivent 501, comme un déploiement sans annuaire (`/me` l'annonce dans `features.directory`). Une connexion liée par requête, avec délai de connexion et d'opération ; une panne du LDAP répond 503 sans en dire la cause au client. Les recherches sont limitées à 30 par 10 secondes et par utilisateur. Les favoris (`favorites`, 100 par personne) sont des identifiants de l'annuaire, résolus à la lecture : une personne qui quitte l'annuaire disparaît des favoris.
- **Synchronisation des comptes** (`directory-sync.ts`) : quand l'annuaire sait quel attribut porte le poste (`LDAP_ATTR_EXTENSION`), ses personnes deviennent des correspondances utilisateur ↔ poste (`user_mappings`, avec le nom, le service, `source = ldap` et la date), toutes les `LDAP_SYNC_INTERVAL` et à la demande (`POST /admin/directory/sync`). Le numéro d'un groupe d'appel n'est donné à personne (un conflit dans le rapport ; ADR 0014), et une création ou une modification de groupe attend la fin d'une exécution en cours (10 s au plus, puis 503 `SYNC_RUNNING`), la suivante attendant la sienne (`exclusive`). Une seule exécution à la fois par processus (`POST` répond 202, l'écran suit `GET /admin/directory`) ; le rapport (vus, avec poste, créés, mis à jour, retirés, conflits) est gardé en mémoire. L'annuaire fait foi pour les personnes qu'il connaît ; une correspondance manuelle d'une personne inconnue de l'annuaire n'est ni retirée ni dépossédée de son poste ; un poste donné à deux personnes reste à celle qui l'a déjà, sinon à la première listée ; un conflit ne coûte jamais sa correspondance à la personne (tout est tranché avant la première écriture) ; un listing vide ne retire rien (filtre ou compte lecteur en cause) ; les lignes à réécrire sont retirées avant les écritures, pour que deux personnes puissent échanger leurs postes. Les écritures ne sont pas dans une transaction et le verrou est en mémoire : avec plusieurs réplicas, deux exécutions simultanées se signalent des conflits que l'exécution suivante répare ; un verrou en base viendra avec l'exploitation multi-réplicas (ADR 0009).
- **Administrateurs** (`admin.ts`) : le rôle `ADMIN_ROLE` dans la revendication `JWT_ROLES_CLAIM` du jeton (aucune revendication lue si la variable est absente), ou un utilisateur de `ADMIN_USERS`. `/me` le dit dans `features.admin` ; les routes `/admin/*` répondent 403 aux autres. Hors mode `dev` (où l'en-tête `x-dev-roles` est cru, comme `x-dev-user`), rien dans une requête ne peut se déclarer administrateur.
- **En-têtes de sécurité** (`security.ts`) : toute réponse porte `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` et `Cache-Control: no-store` (l'interface OpenAPI sous `/docs` garde une politique qui la laisse tourner) ; `Strict-Transport-Security` quand `HSTS_MAX_AGE` est renseigné (`0` le retire, `HSTS_INCLUDE_SUBDOMAINS=1` l'étend).
- **Historique** : chaque fin d'appel vue par le provider est enregistrée pour l'utilisateur concerné (`history.ts`, idempotent sur l'identifiant d'appel) ; avec OpenSIPS, les deux parties de l'appel reçoivent la leur (sortant, entrant, manqué, refusé), et l'app recharge les Récents à chaque fin d'appel reçue sur le WebSocket. `GET /calls/history` filtre par direction, statut (`missed`, `declined`, `answered`, `failed`), numéro, dates et pagine par curseur ; `DELETE /me/history` efface l'historique de l'appelant.
- **Secrets SIP** (`sip-secrets.ts`) : un secret aléatoire par utilisateur, généré par le Gateway, écrit sur le serveur SIP par le provider (empreintes `ha1` dans `subscriber` pour OpenSIPS) puis conservé chiffré (AES-256-GCM) en base. Rien n'est stocké dans le front : le navigateur ne le reçoit que par l'appel authentifié `media-session`. Si l'écriture échoue, rien n'est enregistré.
- **Secrets de configuration** : la configuration d'un provider ne contient que des références (`env:OPENSIPS_DB_URL`), résolues au démarrage.
- **Registre de providers par tenant** (`registry.ts`) : point d'extension multi-tenant et multi-provider. Une configuration d'un type que la passerelle ne construit plus (`asterisk`, d'avant la PR 4c) est signalée au démarrage et ignorée : son tenant n'a pas de provider (404 sur ce qui en demande un).
- **Bus d'événements** (`events.ts`) : diffuse chaque appel à ses seuls participants et chaque changement de présence à tout le tenant ; la passerelle garde la présence courante par poste pour `GET /presence`. Mémoire aujourd'hui, interface prévue pour Redis (qui devra aussi porter la présence entre réplicas).
- **Prêt à fonctionner** : `/ready` est vert tant que tous les providers sont `CONNECTED` ou `DEGRADED` (les appels passent ; le corps donne alors `degraded`, leur nombre, et `reasons`, leurs raisons en quelques mots sans adresse), 503 sinon ; `originate` refuse (503) si la liaison PBX est coupée.
- Les journaux masquent les en-têtes d'autorisation et les tickets.

## 4. Ce qu'OpenSIPS fait de chaque appel (`provider-opensips`, `docker/opensips`)

Le provider de référence du POC (`provider-asterisk`, ARI, avec son pont d'appels et ses états d'appareil `Stasis:`) a été retiré à la PR 4c : le click-to-call par le serveur, qu'il était seul à faire, attend un provider qui le fasse (le softphone compose lui-même). Avec OpenSIPS, la passerelle ne pilote pas les appels : elle écrit des tables que la configuration d'OpenSIPS lit à chaque INVITE, sans bloquer (`sqlops` en asynchrone, `statement_timeout` court, rien en `failure_route`), et entend ce qui se passe par ses événements (ADR 0011).

| Table | Écrite par la passerelle quand | Lue par OpenSIPS pour |
|---|---|---|
| `subscriber` | une personne reçoit ou change de secret (la ligne porte son titulaire, `holder`) ; à la réconciliation, un compte écrit pour quelqu'un qui ne tient plus le poste est supprimé, et ses fenêtres retirées d'OpenSIPS (MI `ul_rm`) ; jamais une ligne sans titulaire, rien sur une liste de correspondances vide ni au-delà de max(10, un quart des comptes écrits) | l'authentification digest (`ha1`), et savoir qu'un numéro est un poste |
| `call_rules` | une personne règle ses renvois ou son « ne pas déranger » (ADR 0013) | renvoyer ou refuser l'appel |
| `call_groups` | un administrateur crée, change ou supprime un groupe (un poste que plus personne ne tient reste membre) | faire sonner les membres d'un groupe (ADR 0014) |
| `display_names` | chaque réconciliation (démarrage, synchronisation de l'annuaire) | montrer à chaque partie le nom que l'annuaire donne à l'autre (ADR 0014) |

### 4.1 Groupes d'appel simultané

Un groupe est un numéro à lui (jamais celui d'un poste ni d'un compte de `subscriber` : la passerelle refuse les deux sens, et un poste l'emporterait dans OpenSIPS) et 1 à 12 postes membres. Composé, il fait sonner à la fois les fenêtres enregistrées des membres, sauf l'appelant et les membres en « ne pas déranger », 12 au plus (`MAX_BRANCHES` de l'image OpenSIPS) : la première fenêtre de chaque membre d'abord, dans leur ordre, puis les deuxièmes, et ainsi de suite ; une fenêtre laissée de côté est écrite dans le journal d'OpenSIPS. La première qui répond prend l'appel, tm annule les autres avec `Reason: SIP;cause=200`, que le softphone rend « pris sur un autre poste ». Les renvois des membres ne s'appliquent pas, et un groupe n'est pas une cible de renvoi. Un membre qui refuse ne coupe pas ses collègues (`disable_6xx_block`, le script annulant lui-même les autres fenêtres d'un appel direct refusé, sauf celles qui n'ont encore rien répondu : leur `fr_timeout`, 5 s, retient alors le refus). Personne à faire sonner : 480 et un appel manqué pour le groupe. Personne ne prend l'appel : le refus seulement si toutes les fenêtres ont refusé, sinon 480 (un membre refuse ou est occupé, les autres ne répondent pas). Un poste que personne ne tient reste membre (l'écran le marque « poste libre ») et sonne de nouveau dès qu'il a un titulaire.

```mermaid
sequenceDiagram
  autonumber
  participant D as Accueil 104
  participant O as OpenSIPS
  participant DB as PostgreSQL
  participant A as Alice 101
  participant J as Jean 102
  participant GW as Gateway

  D->>O: INVITE 200
  O->>DB: règles de 200, noms (async)
  DB-->>O: 200 est un groupe
  O->>DB: membres et leurs noms, sans l'appelant ni les « ne pas déranger » (async)
  DB-->>O: 101 Alice Martin, 102 Jean Dupont
  O->>A: INVITE (From "Accueil")
  O->>J: INVITE (From "Accueil")
  O-->>GW: E_TWAKEPHONE_RINGING (callee 101, group 200), puis 102
  J-->>O: 200 OK
  O-->>D: 200 OK (P-Asserted-Identity "Jean Dupont" 102)
  O->>A: CANCEL (Reason cause=200)
  O-->>GW: E_TWAKEPHONE_ANSWERED (callee 102), CDR 104 vers 102 via 200
```

L'appelant garde le numéro du groupe dans ses Récents ; le membre qui répond a l'appel entrant ; si personne ne répond, chaque membre qui a sonné a un appel manqué, et `missed_calls` en a un pour le groupe. Un membre est « en communication » le temps de la sonnerie.

### 4.2 Noms de l'annuaire

Le nom qu'un téléphone affiche pour son correspondant ne vient plus de l'autre téléphone. OpenSIPS remplace le nom affiché du `From` par celui que l'annuaire donne à l'appelant (`uac_replace_from` sur le nom seul : l'URI, les étiquettes, l'authentification, `Replaces` et les transferts n'en dépendent pas ; un appelant sans nom dans l'annuaire n'en a pas), et pose dans la réponse 2xx un `P-Asserted-Identity` avec le nom et le poste de qui a répondu (le poste composé, la cible d'un renvoi, le membre d'un groupe) ; ceux que les téléphones envoient (`P-Asserted-Identity`, `P-Preferred-Identity`, `Remote-Party-ID`) sont retirés de l'INVITE, des requêtes en dialogue et de toutes les réponses relayées. Quand les noms n'ont pas pu être lus (base en panne, tables absentes), le `From` reste celui du téléphone et la réponse n'affirme que le poste : un appel n'attend ni n'échoue jamais pour un nom. Les renvois et le « ne pas déranger » ne dépendent pas de ces tables : une lecture en échec est refaite une fois (une connexion que la base a fermée se rouvre), et seulement quand la base dit qu'une de ces tables manque (`to_regclass`), la lecture est refaite sans elles et OpenSIPS cesse de les nommer pendant 30 s. Un numéro dont les règles n'ont pas pu être lues deux fois peut être un groupe : sans personne enregistré, 480, jamais 404. Les noms sont nettoyés à l'écriture et à la lecture (une ligne, ni guillemet ni barre oblique inverse) : ils ne vont que dans un nom affiché entre guillemets.

## 5. Le softphone (`packages/softphone`)

Réécrit à l'étape 3 sur JsSIP (ADR 0003) : `UA` et `RTCSession`. Il ne fait que le **média et la signalisation SIP**, jamais le contrôle d'appel métier. L'app (`apps/web/src/softphone.tsx`, `SoftphoneProvider`) le monte une fois au-dessus du routeur, dès que la passerelle donne une session `sip-webrtc`, et affiche l'état d'enregistrement dans l'en-tête et le panneau d'appel (`CallPanel`) au-dessus des pages.

- Récupère à chaque démarrage `GET /me/media-session` : URL WSS, domaine SIP, poste, secret, serveurs ICE.
- Un `SoftCall` par appel (`new`, `ringing`, `connected`, `held`, `ended` avec sa raison : raccroché, refusé, occupé, sans réponse, injoignable, annulé, échec) : répondre, refuser (603), raccrocher, attente et reprise (re-INVITE), micro, DTMF (RFC 4733 par défaut, INFO sur demande ; les INFO reçus sont remontés), `stats()` (compteurs RTP, utilisés par les e2e pour prouver que l'audio circule).
- **Reconnexion** : JsSIP rouvre le WebSocket et se réenregistre seul quand le réseau ou le serveur tombe ; sur un enregistrement refusé (secret tourné, compte retiré), le softphone redémarre avec une session neuve de la passerelle, avec backoff.
- Se désinscrit à la déconnexion de l'app (prouvé par le e2e : 404 ensuite) et, au mieux, à la fermeture de la page (`pagehide`, le WebSocket se ferme en même temps) ; un contact mort (connexion partie sans désinscription) vaut 477 « Send failed » (émis par le module tm d'OpenSIPS) à l'appelant, rendu « injoignable » ; la déconnexion de l'app attend la confirmation de la désinscription avant de quitter la page.
- Un élément audio par appel, deux appels au plus : celui en cours et celui en attente. Un appel passé pendant un appel est une consultation (l'appel en cours est mis en attente d'abord) ; un second appel entrant reçoit 486 (pas de double appel pour l'instant).
- **Transferts** (ADR 0010) : direct par REFER (le correspondant appelle le poste visé et rend compte par NOTIFY ; échec, ou silence de 30 s, rendu au transférant, qui reprend son correspondant), supervisé par REFER avec `Replaces` après consultation ; un REFER reçu est suivi sans demander s'il vise un poste composable du domaine local (`Referred-By` recopié), un INVITE avec `Replaces` remplace l'appel visé sans sonner. Une consultation qui finit sans transfert rend l'appel en attente d'elle-même. Les erreurs du softphone sont des codes (`CallError`) que l'app traduit. L'app : bouton Transférer (direct ou consulter d'abord), puis « Transférer X à Y » ou « Annuler la consultation ».
- **Périphériques** : le softphone ouvre lui-même le micro de chaque appel (flux passé à JsSIP) : le micro choisi dans les réglages en `exact` (Chromium ignore `ideal`), le défaut s'il n'est pas là ; il relâche ce qu'il a ouvert à la fin de l'appel. Changement de micro pendant l'appel par `replaceTrack` (sans renégociation, mute conservé, bascules sérialisées) ; un casque débranché termine sa piste, l'appel repart sur le micro choisi ou le défaut, et reprend le micro choisi quand il revient (`devicechange`) ; sortie de la voix et de la sonnerie par `setSinkId` (Chromium, Edge, Firefox 116+ ; sinon la sortie système). Le choix reste dans le navigateur (`localStorage`), pas sur le serveur ; un périphérique choisi mais absent reste choisi et l'écran le dit. Avant la première autorisation du micro, les navigateurs ne listent rien d'utilisable : l'écran propose de l'autoriser.
- **Sonnerie** : deux brèves tonalités toutes les quatre secondes, faites en WebAudio (rien à charger, rien à autoriser dans la CSP) et jouées par un élément audio pour suivre la sortie choisie ; sonne tant qu'un appel entrant sonne (pas pour un INVITE avec `Replaces`, répondu d'emblée). Toutes les fenêtres enregistrées de la personne sonnent (fourche parallèle d'OpenSIPS) ; la première qui répond prend l'appel, les autres lisent « pris sur un autre poste ».
- **Son bloqué** : quand le navigateur exige un geste avant tout son (page rechargée sans clic), le softphone le détecte (`play()` refusé pour `NotAllowedError`, `AudioContext` qui ne démarre pas : les navigateurs laissent `resume()` en attente jusqu'au geste, le softphone n'attend que 500 ms), l'app affiche « Activer le son », et le premier clic ou la première touche n'importe où lève le blocage (réarmé tant que le geste n'a pas suffi). Une lecture interrompue par la fin d'un appel ou de la sonnerie n'est pas un blocage. Hors sonnerie, le contexte audio est suspendu. Les e2e ne le jouent pas (Chromium piloté par Playwright autorise le son sans geste) ; tests unitaires de la sonnerie sur un `AudioContext` factice et du softphone sur une sonnerie factice.
- Le nom affiché sur un appel entrant est celui du `From`, qu'OpenSIPS pose depuis l'annuaire (§4.2) ; sur un appel sortant, le nom et le numéro de qui a répondu viennent du `P-Asserted-Identity` de la réponse (un renvoi, un transfert ou un groupe disent qui a décroché). Un appel entrant annulé avec `Reason: SIP;cause=200` finit « pris sur un autre poste » (`answered-elsewhere`), pas manqué.
- Un seul tenant par serveur OpenSIPS pour l'instant : `subscriber` n'a pas de colonne de tenant (`use_domain 0`) et `lookup("location")` route entre tous les postes enregistrés. Le multi-tenant SIP viendra avec l'administration (étape 7).

## 6. L'application TwakePhone (`apps/web`)

L'application Phone du POC (`apps/phone`, app Cozy dans Twake Workplace : `PhoneProvider`, contacts par cozy-client, flags, cible `/intents` pour le widget et l'intent `CALL`) a été retirée à la PR 3c, conformément à l'ADR 0006 ; ses principes qui tiennent toujours (une seule source d'état, une interface qui suit les `capabilities`, l'historique lu depuis la passerelle) vivent dans `apps/web`, et son intégration dans une autre app (grille d'apps, liens `tel:`, widget) est refaite pour Twake Chat à l'étape 9.

Depuis l'étape 2, l'application cible est `apps/web` : React 18 construit par rsbuild sans dépendance Cozy, connexion OIDC (PKCE, jeton de rafraîchissement, `oidc-client-ts`), client de la passerelle (`telephony-client`), fr et en, socle RGAA. Sa configuration (`config.json` : passerelle, fournisseur d'identité, indicateur de ressource) est lue au démarrage, ce qui fait un seul build pour toutes les plateformes.

En production, `apps/web/server` (Node sans dépendance, `docker/Dockerfile.web`) sert le build, génère `config.json` depuis l'environnement et pose les en-têtes : une CSP qui ne connaît que les scripts et styles du build, la passerelle (REST et WebSocket) et le fournisseur d'identité, plus `CONNECT_SRC` (le WSS du serveur SIP à l'étape 3) ; `frame-ancestors` limité aux origines de `FRAME_ANCESTORS` (celles de Twake Chat à l'étape 9, `'none'` sinon, avec `X-Frame-Options: DENY`) ; `Permissions-Policy` qui n'ouvre que le micro, pour cette origine ; `Referrer-Policy: no-referrer` ; HSTS sur demande (`HSTS_MAX_AGE`, `HSTS_INCLUDE_SUBDOMAINS=1`). Les valeurs de `FRAME_ANCESTORS` et `CONNECT_SRC` sont vérifiées au démarrage (une source CSP chacune, rien qui puisse clore la directive) ; un chemin mal encodé répond 400 et une erreur interne 500, sans arrêter le serveur. La page construite embarque aussi une CSP en balise `meta`, plus large (elle ne connaît pas la passerelle), pour un hébergement statique qui ne poserait pas d'en-tête. Le navigateur applique les deux. L'e2e `yarn e2e:web` passe par ce serveur : la politique testée est celle livrée.

L'écran d'administration (`/admin`, visible aux seuls administrateurs annoncés par `/me`) montre la source de l'annuaire sans secret, l'état de la synchronisation et son dernier rapport (dont les personnes à qui l'annuaire donne le numéro d'un groupe), et la lance à la demande ; il liste, crée, modifie et supprime les groupes d'appel (`RingGroups.tsx`), et dit quand la plateforme n'en a pas. L'administration des trunks, SDA et routes arrive à l'étape 7.

## 7. Le widget dans les autres applications (`phone-widget`, `phone-link`)

Le problème : chaque app Twake Workplace tourne sur sa propre origine (`user1-drive`, `user1-mail`…). Il n'existe donc aucun contexte JavaScript partagé. Solution : l'application **hôte** embarque Phone dans une iframe via le mécanisme d'**intent** de Cozy. Les deux bibliothèques côté hôte restent dans le dépôt, utilisables par Twake Workplace (ADR 0006) ; le côté service (la cible `/intents` de l'app Phone du POC, qui portait le softphone et la carte d'appel) est parti avec le POC, et l'intégration dans Twake Chat est refaite à l'étape 9 (grille d'apps, liens `tel:`, widget Matrix, carte d'appel).

- **`@twake/phone-widget`** : `mountPhoneWidget({ client })` crée un conteneur fixe, `overflow: hidden`, de taille 0 au repos, crée l'intent `OPEN io.twake.phone.widget` par `cozy-interapp`, pose `allow="microphone; autoplay"` sur l'iframe **avant** son insertion (le navigateur le lit à ce moment ; l'autorisation du micro est celle de l'**origine de l'hôte**), et grandit à la demande du service (`resizeClient`). L'import de `cozy-interapp` est résolu quelle que soit la sémantique du bundler. Il s'enregistre sous un symbole global pour que `phone-link` le trouve.
- **`@twake/phone-link`** rend un numéro cliquable (`<PhoneLink number>`, ou `requestCall()` hors React). Le numéro est validé et normalisé (E.164) : un texte qui n'est pas un numéro n'est jamais composé. Trois chemins, du plus direct au plus lent : la page porte le widget, et `requestCall` lui parle directement (surtout **pas** un second intent : l'écouteur de `cozy-interapp` lève « Invalid event id » dès que deux intents répondent depuis la même origine, ce qui détruirait le widget) ; sinon l'intent `CALL`, relayé à une fenêtre Phone déjà ouverte ; sinon l'app Phone ouverte sur `#/dialer?dial=<numéro>`.

Leçons du POC, gardées pour l'étape 9 : dans une iframe sans hauteur, la feuille de style globale de l'app hôte écrase la racine à 0 (le service doit mesurer son contenu) ; chaque fenêtre qui porte le softphone est un contact SIP de la même extension, toutes sonnent et la première qui répond prend l'appel ; une demande d'appel n'est acceptée que d'une origine de la même instance.

## 8. Le serveur SIP de développement (`docker/`)

Le PBX de dev du POC (MiniPBX avec un overlay WebRTC et ARI, la stack Twake Workplace clonée et corrigée, LiveKit SIP) a été retiré à la PR 3c. Le MVP tourne sur `docker/docker-compose.sip.yml` : OpenSIPS 3.6 (registrar, WS et WSS, digest sur `subscriber`, routage entre postes, `dialog`), rtpengine (DTLS-SRTP, ICE) et un PostgreSQL ; la configuration et ses limites sont dans [docker/README.md](../docker/README.md). C'est la même stack que la CI (`yarn e2e:sip`). Depuis la PR 4a, la passerelle s'abonne aux événements d'OpenSIPS (`mi_datagram`, `event_datagram`) et OpenSIPS écrit les CDR (`acc`) : l'annuaire montre la présence des collègues, les Récents viennent du serveur SIP (ADR 0011) ; depuis la PR 4b, OpenSIPS lit les renvois dans `call_rules` (ADR 0013), et depuis la PR 4c les groupes d'appel et les noms de l'annuaire dans `call_groups` et `display_names` (ADR 0014). L'étape 6 ajoute le trunk et l'anti-fraude, l'étape 8 LiveKit SIP pour Meet.

## 9. Chemin des données, de bout en bout

| Étape | Protocole | Chemin |
|---|---|---|
| Connexion | OIDC (PKCE) | App, LemonLDAP::NG |
| Annuaire, favoris, capacités, session média, historique | HTTPS (REST) | App, Gateway (LDAP pour l'annuaire) |
| Événements temps réel | WebSocket | Gateway, App (`/api/v1/ws`) |
| Comptes SIP, CDR, renvois, groupes, noms affichés | SQL | Gateway/provider, tables `subscriber`, `acc`, `missed_calls`, `call_rules`, `call_groups` et `display_names` d'OpenSIPS (les trois dernières lues à chaque INVITE par `sqlops`) |
| Événements d'OpenSIPS, abonnement et relecture d'état | JSON-RPC sur UDP (`event_datagram`, `mi_datagram`), boucle locale | OpenSIPS, provider-opensips |
| Signalisation SIP : enregistrement, appels, attente, DTMF, transferts | SIP sur WSS | Navigateur, OpenSIPS |
| Audio | RTP/SRTP (DTLS), ICE | Navigateur, rtpengine |
| Appels de l'opérateur (étape 6) | SIP/UDP + RTP | Opérateur, OpenSIPS, rtpengine |
| Salles Meet, dial-in, dial-out (étape 8) | HTTPS (API externe de Meet), Twirp, webhooks signés, SIP | Gateway, Meet, LiveKit, LiveKit SIP, OpenSIPS |

## 10. Tests

| Commande | Ce qui est vérifié |
|---|---|
| `yarn test` | Unitaires (vitest) : types, client (E.164, backoff, lien Meet), softphone, provider OpenSIPS (`subscriber`, empreintes, `call_rules`, abonnement MI contre un faux OpenSIPS en UDP, suivi des appels, des renvois, des groupes et de la présence avec les événements tels qu'OpenSIPS les envoie, fin d'une présence choisie, `call_groups` et `display_names` avec isolation entre tenants, sections de la configuration d'OpenSIPS), Gateway (REST, WS, authentification, annuaire, synchronisation et numéros de groupe réservés, groupes réservés aux administrateurs, appartenance des appels, conférences, webhooks), `conference-livekit` (jetons, trunks, API Meet), `phone-link`, app web et son serveur |
| `TEST_DATABASE_URL=… yarn test` | Le même contrat de stockage contre PostgreSQL (isolation entre tenants, conférences, favoris) |
| `yarn e2e:web` | L'app web dans Chromium, servie par son serveur de production : OIDC, administration, annuaire, en-têtes de sécurité (sans Docker) |
| `yarn e2e:sip` | Trois personnes dans Chromium, Firefox ou Edge (`BROWSER`, deux moteurs : Edge est un Chromium) à travers OpenSIPS et rtpengine (Docker Compose) : enregistrement WSS, appel, RTP dans les deux sens, attente, DTMF, transferts, périphériques, sonnerie, seconde fenêtre, reconnexion après coupure, désinscription ; présence dans l'annuaire (en communication en moins de 3 s), Récents des deux côtés, CDR dans `acc`, appel abandonné rendu manqué ; renvois immédiat, sur non-réponse (aussi avec une fenêtre en communication et l'autre sans réponse) et sur occupation, abandon pendant la sonnerie du renvoi, transfert supervisé vers un poste qui renvoie, « ne pas déranger » avec et sans renvoi (message lu par l'appelant, jamais celui d'un collègue vers qui l'appel a été renvoyé), renvoi qui ne mène nulle part, sa fin à sa date par la passerelle, lignes d'`acc` et `missed_calls` d'un appel renvoyé, boucle de renvois arrêtée, navigateur dans un autre fuseau que la base ; noms de l'annuaire des deux côtés, préférés à celui du téléphone ; groupe d'appel créé dans Administration (403 pour les autres), trois membres qui sonnent, le premier qui répond prend l'appel, les autres « pris sur un autre poste », membre en « ne pas déranger » laissé de côté, appel abandonné (manqués des membres, `missed_calls` du groupe), groupe supprimé |

Les e2e du POC sur sa propre stack (`yarn e2e:live` contre MiniPBX par ARI, `yarn e2e:widget` dans un hôte `cozy-interapp`, `platform.e2e.mjs` pour Meet sur la plateforme) sont partis avec lui ; Meet par téléphone est rejoué sur OpenSIPS à l'étape 8.

**Enseignement.** Les tests qui simulent le réseau ne suffisent pas pour ce qui traverse plusieurs services : l'essai sur la plateforme a trouvé des défauts invisibles aux tests unitaires (voir §12 et §13). Une erreur `tsc` dans un fichier de test fait aussi échouer le build Docker du Gateway et laisse l'ancien conteneur : lire toute la sortie d'un `docker compose build`.

## 11. Écarts avec le cahier des charges et limites

Fait (dans le dépôt, ou par le POC avant son retrait) : abstraction fournisseur, capabilities, présence normalisée et bidirectionnelle (OpenSIPS depuis l'étape 4, Asterisk au POC), événements, renvois et « ne pas déranger », groupes d'appel simultané, noms affichés venus de l'annuaire, séparation contrôle/média, softphone WebRTC, click-to-call, widget inter-apps, authentification OIDC, secrets SIP par utilisateur, persistance PostgreSQL avec isolation par tenant, historique serveur, intent `CALL` et `PhoneLink`, appartenance des appels, accès téléphonique aux salles Meet (dial-in, dial-out, événements), appels entrants et sortants par un trunk SIP réel.

Pas encore fait :

- **Mode `jwt` non éprouvé en réel** : implémenté et testé avec une clé locale, mais aucun client OIDC n'est déclaré dans LemonLDAP ; le mode `cozy` était celui de la stack du POC ; `yarn e2e:web` joue le mode `jwt` avec un fournisseur OIDC de test.
- **Secrets SIP non éphémères** : un secret par utilisateur, pas un identifiant par session. La rotation existe (`rotate`) mais rien ne la déclenche encore. Un secret renouvelé est repris par le softphone, qui se ré-enregistre avec une session neuve.
- **Redis** (bus multi-réplica), administration des providers par une interface, tenants multiples hors bootstrap.
- **Renvois** : vers un poste seulement (l'extérieur vient avec le trunk, étape 6), pas de renvoi d'un appel déjà en cours, ni de messagerie vocale ou d'horaires ; les renvois restent au poste quand il change de titulaire (ADR 0013).
- **Groupes d'appel** : sonnerie simultanée seulement, 12 fenêtres et 12 membres au plus, sans débordement (renvoi du groupe sans réponse, messagerie), file d'attente ni sonnerie en cascade (étape 11) ; le CANCEL envoyé aux autres fenêtres garde le nom affiché d'origine du `From` ; le refus d'un appel direct attend jusqu'à 5 s une fenêtre muette (ADR 0014).
- **Appels** : transfert par l'API de la passerelle (le softphone transfère lui-même depuis l'étape 3), historique de présence, politiques de numérotation et quotas (un appel externe n'est pour l'instant limité par rien côté Gateway), enregistrement.
- **Appels externes** : aucun trunk sur la stack OpenSIPS avant l'étape 6 (`dispatcher`, `drouting`, `fraud_detection`, repli, urgences ; voir §13 pour ce que la ligne du POC a appris).
- **Meet** : le pont téléphonique du POC est retiré (voir §12) ; à l'étape 8 restent aussi à faire : transférer un appel en cours vers une salle, configuration LiveKit et Meet par tenant (un seul LiveKit et une seule application Meet par déploiement, via l'environnement), expliquer dans l'UI qu'une salle vide n'est pas joignable par téléphone.
- **Appartenance des appels en mémoire** : un redémarrage du Gateway en cours d'appel fait répondre 404 aux actions Gateway de cet appel (le softphone, lui, agit directement). À persister avec Redis.
- **Droits dans une salle** : l'API externe de Meet n'indique pas le rôle de la personne ; toute personne ayant accès à la salle peut ouvrir son panneau téléphone, inviter, couper un micro ou retirer quelqu'un.
- **Valeurs de développement** : les identifiants PostgreSQL de la stack SIP (`docker/`) et le certificat auto-signé d'OpenSIPS sont des valeurs de démonstration. Aucune ne doit servir en production ; la configuration réelle passe par l'environnement ou un coffre (`env:NOM` dans `provider_configs`).
- **Widget et `PhoneLink`** : les bibliothèques côté hôte restent, sans service côté Phone depuis le retrait du POC (§7, étape 9).
- **Réception hors fenêtre** : rien ne sonne si aucune fenêtre de l'app n'est ouverte (Web Push, étape 5).
- **Mode CTI sans audio navigateur** : le pont qui le permettait (`provider-asterisk`) est retiré ; `provider-opensips` ne lance pas d'appel par le serveur (`POST /calls` répond 501), le softphone compose lui-même.

## 12. Visio : accès téléphonique aux salles Meet

Le POC avait livré le dial-in par PIN et le dial-out sur sa propre stack (Asterisk ↔ LiveKit SIP, Meet comme serveur de Twake Visio), éprouvés par un e2e sur la plateforme ; ce pont et cet e2e sont partis avec le PBX de dev à la PR 3c. Ce qui reste et tient : `packages/conference-livekit` (client de l'API externe de Meet avec jeton délégué par e-mail, client Twirp de LiveKit pour les trunks SIP et les participants, webhooks signés), les routes `/conferences` et `/webhooks/livekit` de la passerelle, la table `conferences`, et leurs tests unitaires. Le MVP ne l'expose pas encore : l'étape 8 rebranche LiveKit SIP derrière OpenSIPS (numéro d'accès, PIN natif de Meet, dial-out, conférence audio, passage d'un appel à deux en visio) et refait l'e2e sur cette stack. Les principes gardés : Meet possède salles, droits, PIN et règles de dial-in, la passerelle est une *application* de Meet et ne duplique rien ; une salle n'est joignable par téléphone que tant qu'elle est ouverte ; le numéro affiché par Meet doit être un vrai numéro E.164.

## 13. Trunk SIP réel : ce que la ligne de développement du POC a appris

Le trunk du POC était branché sur MiniPBX (retiré à la PR 3c) ; le MVP n'a pas de trunk avant l'étape 6 (OVHcloud ou tout trunk SIP standard, sur OpenSIPS avec `dispatcher`, `drouting` et `fraud_detection`). Trois constats, mesurés derrière un NAT domestique sur une ligne freepro à deux serveurs d'appel, sont repris tels quels pour cette étape :

1. **Le port source 5060 est inutilisable derrière certains NAT.** Depuis ce port, aucun paquet SIP (OPTIONS ou REGISTER) n'obtenait de réponse de l'opérateur ; depuis n'importe quel autre port, la réponse était immédiate. Le trunk restait « Registered » puis tombait en « Rejected », et aucun appel n'arrivait. La couche responsable (box, NAT de Docker Desktop ou opérateur) n'a pas été identifiée : le serveur SIP doit pouvoir écouter ailleurs que sur 5060.
2. **Un NAT n'admet que les destinations à qui l'on a écrit récemment.** Avec deux serveurs d'appel, l'INVITE peut venir de celui auprès duquel on n'est pas enregistré : il faut un keepalive (OPTIONS toutes les 15 s) vers chaque serveur de l'opérateur pour garder les deux accès ouverts.
3. **Ne pas renseigner d'adresse externe.** Déclarer l'IP publique ou celle de la machine n'aide pas (l'opérateur répond sur la connexion de l'enregistrement) et a fait cesser les réponses à l'enregistrement.

Les enregistrements ne doivent pas être forcés à répétition pendant les essais : l'opérateur cesse de répondre à une adresse qui en envoie trop.
