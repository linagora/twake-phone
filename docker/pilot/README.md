# Kit pilote : TwakePhone sur une machine, pour un test réel

Tout le MVP web sur une seule machine Linux joignable depuis Internet, pour que quelques personnes s'appellent depuis leur navigateur : l'app, la passerelle, OpenSIPS et rtpengine, PostgreSQL, derrière Caddy qui sert le tout en HTTPS sur un seul nom de domaine. Le profil `demo` ajoute un fournisseur d'identité (Keycloak) et un annuaire (OpenLDAP) avec trois personnes de test, pour essayer sans rien brancher. Sans ce profil, le kit se raccorde à votre SSO et à votre annuaire.

Ce que le pilote permet : se connecter, trouver un collègue dans l'annuaire avec sa présence, l'appeler de navigateur à navigateur, le mettre en attente, le transférer, retrouver ses appels dans les Récents, être prévenu d'un appel quand aucune fenêtre de l'app n'est ouverte (notifications d'appel à activer dans Réglages, navigateur lancé ; la machine doit joindre en HTTPS les services de push des navigateurs, `PUSH_PROXY` pour passer par un proxy). Ce qu'il ne permet pas encore : appeler ou recevoir des numéros extérieurs (étape 6, trunk OVH), le mobile.

## Ce qu'il faut

- Une machine Linux **x86_64 (amd64)** : les images ne sont pas construites pour ARM. 2 vCPU et 4 Go de RAM suffisent pour un pilote.
- Docker Engine 25 ou plus avec le plugin Compose (`curl -fsSL https://get.docker.com | sh` l'installe ; le paquet `docker.io` de certaines distributions est trop ancien).
- Une adresse IPv4 publique, directe ou en NAT 1:1 (le cas de la plupart des clouds).
- Un nom de domaine qui pointe sur cette adresse (enregistrement A), avant le premier démarrage : Let's Encrypt le vérifie, et OpenSIPS le résout à son démarrage. Un enregistrement **DNS seul** : un proxy (le nuage orange de Cloudflare) cache l'adresse de la machine et le son ne passe pas.
- Ouverts depuis Internet : `80/tcp` et `443/tcp` (Caddy), `30000-30100/udp` (le son, rtpengine). Rien d'autre : tout le reste écoute sur la boucle locale, sauf les sockets d'où OpenSIPS envoie ses événements, sur un port éphémère de toutes les adresses, où il ne lit rien (« Ce qui tourne ») ; un pare-feu qui n'ouvre que ces ports les ferme aussi.
- Pour les testeurs : Chrome, Edge ou Firefox récent, un casque, un réseau qui laisse passer l'UDP sortant (pas de serveur TURN dans le pilote, voir « Limites »).

## Démarrer

```bash
git clone https://github.com/linagora/twake-phone.git && cd twake-phone/docker/pilot
./init.sh phone.example.org vous@example.org --demo          # écrit .env : domaine, TLS, adresse du son, secrets
docker compose up -d --build --wait --wait-timeout 600        # premier démarrage : construction des images, quelques minutes
```

Puis ouvrir `https://phone.example.org`, « Se connecter », et entrer avec `alice`, `bob` ou `carole` : leurs mots de passe sont `ALICE_PASSWORD`, `BOB_PASSWORD` et `CAROLE_PASSWORD` dans `.env`. Alice (101) administre la plateforme, Bob (102) et Carole (103) non. Deux personnes, deux navigateurs (ou une fenêtre privée), et Alice compose 102.

`init.sh` déduit l'adresse du son (`RTPENGINE_INTERFACE`) : l'adresse de la machine, et l'adresse publique que le domaine résout, sous la forme `privée!publique` quand elles diffèrent. Il s'arrête plutôt que de deviner : un domaine qui ne résout pas encore, une adresse privée ou de boucle, ou une adresse qui n'est pas celle par laquelle la machine sort sur Internet (demandée à `api.ipify.org` quand `curl` est installé). `--public-ip` donne l'adresse publique quand le DNS n'est pas encore à jour. Il ne réécrit jamais un `.env` existant, et refuse tant que les volumes du kit existent (« Repartir de zéro »).

Vérifier l'installation, avec le profil `demo` : deux personnes se connectent, se trouvent, s'appellent, s'entendent, retrouvent l'appel dans leurs Récents, et la console d'administration de Keycloak ne répond pas depuis Internet. Depuis un autre poste que la machine (depuis elle-même, le son vers sa propre adresse publique dépend de l'hébergeur), avec Node 22.13 ou plus, Yarn 1 et Chromium (`npx playwright-core install --with-deps chromium`) :

```bash
yarn install --frozen-lockfile
PILOT_URL=https://phone.example.org ALICE_PASSWORD=... BOB_PASSWORD=... yarn e2e:pilot
```

## Votre SSO et votre annuaire (sans le profil `demo`)

`./init.sh phone.example.org vous@example.org` (sans `--demo`) laisse à remplir dans `.env` :

- **Identité.** Un client OIDC public `twakephone-web` (code + PKCE S256, sans secret), URL de retour `https://<domaine>/callback`, URL après déconnexion `https://<domaine>/`, origine web `https://<domaine>`. Son jeton d'accès doit être un JWT dont l'audience est la passerelle (`twakephone-gateway` : un « audience mapper » sur Keycloak, ou `OIDC_RESOURCE` pour un fournisseur qui suit la RFC 8707). Dans `.env` : `OIDC_AUTHORITY` (l'émetteur), `JWT_ISSUER` (le même), `JWT_JWKS_URL` (ses clés), `JWT_AUDIENCE`. L'identifiant de la personne est `preferred_username` (`JWT_USER_CLAIM` pour un autre). Administrateurs : `ADMIN_USERS=alice,bob`, ou un rôle du jeton (`JWT_ROLES_CLAIM`, `ADMIN_ROLE`, `twakephone-admin` par défaut).
- **Annuaire.** `LDAP_URL` (`ldaps://` pour un serveur distant), `LDAP_BASE_DN`, `LDAP_BIND_DN` et `LDAP_BIND_PASSWORD` d'un compte en lecture seule, et `LDAP_ATTR_EXTENSION`, l'attribut qui porte le poste de chacun : la passerelle en fait les comptes SIP (ADR 0009). L'identifiant LDAP (`uid`, `LDAP_ATTR_ID` sinon) doit être celui du SSO.
- **Sans annuaire.** `USER_EXTENSIONS=alice:101,bob:102`, lu à chaque démarrage : une personne déjà dotée d'un poste le garde.

## Sans nom public (`TLS=internal`)

Pour un essai sur un réseau interne, sans Let's Encrypt : `./init.sh phone.test internal --demo --public-ip <adresse de la machine>`. Caddy signe alors avec sa propre autorité, que chaque navigateur doit accepter :

1. Le nom doit résoudre partout : sur la machine (OpenSIPS le résout au démarrage) et sur chaque poste de test, par le DNS interne ou une ligne `<adresse> phone.test` dans `/etc/hosts`.
2. Récupérer l'autorité après le premier démarrage : `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./twakephone-ca.crt`.
3. L'importer sur chaque poste comme autorité de confiance (Chrome et Edge : magasin du système ; Firefox : Paramètres, Certificats, Autorités).

## Exploiter

| Quoi | Comment |
|---|---|
| État et journaux | `docker compose ps`, `docker compose logs -f gateway opensips` (journaux limités à 30 Mo par service) |
| Mettre à jour | `git pull && docker compose build --pull && docker compose up -d --wait --wait-timeout 600` |
| Arrêter, redémarrer | `docker compose down`, `docker compose up -d --wait` (les données restent dans les volumes) |
| Sauvegarder | `.env` (sans `SECRETS_KEY`, les secrets SIP de la base sont illisibles), et `docker compose exec -e PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)" postgres pg_dump -U twake -h 127.0.0.1 -p 54320 twake > twakephone.sql` ; en démo, les volumes de Keycloak et d'OpenLDAP |
| Console de Keycloak (`demo`) | fermée depuis Internet ; par un tunnel : `ssh -L 8180:127.0.0.1:8180 <machine>`, puis `http://localhost:8180/auth/admin` (`admin` / `KEYCLOAK_ADMIN_PASSWORD`) |

### Repartir de zéro

Les volumes gardent les secrets du `.env` qui les a créés : la base est chiffrée avec `SECRETS_KEY`, l'annuaire de démo garde son mot de passe, Keycloak n'importe le royaume (et les mots de passe de démo) qu'au premier démarrage. Un nouveau `.env` sur d'anciens volumes casse donc le kit ; `init.sh` le refuse. Pour changer de domaine, ou tout recommencer :

```bash
docker compose down -v && rm .env
./init.sh <nouveau domaine> <email|internal> [--demo]
docker compose up -d --build --wait --wait-timeout 600
```

## Ce qui tourne

| Service | Écoute | Rôle |
|---|---|---|
| caddy | `:80/tcp`, `:443/tcp`, `:443/udp` (HTTP/3) | HTTPS (Let's Encrypt, ou sa propre autorité avec `TLS=internal`) ; `/api/*` vers la passerelle, `/sip` vers le WebSocket d'OpenSIPS, `/auth/*` vers Keycloak (sauf ses consoles), le reste vers l'app ; pas d'API d'administration |
| web | `127.0.0.1:8081` | l'app (fichiers, `config.json`, CSP) |
| gateway | `127.0.0.1:8080`, événements d'OpenSIPS sur un port UDP libre de la boucle | API, WebSocket des événements, comptes SIP |
| opensips | `127.0.0.1` : `8088` (WS), `8089` (WSS, certificat auto-signé, inutilisé ici), `5060/udp`, MI `8880/udp` ; et un port UDP éphémère sur toutes les adresses par processus qui a envoyé un événement à la passerelle (le socket d'envoi d'`event_datagram`, que le module ne lie pas et où OpenSIPS ne lit rien ; dès le démarrage, la passerelle en levant un pour s'assurer qu'elle entend OpenSIPS) | registrar et routage ; le navigateur le joint par `wss://<domaine>/sip` |
| rtpengine | `30000-30100/udp` sur `RTPENGINE_INTERFACE` ; contrôle `127.0.0.1:22222/udp`, CLI `127.0.0.1:9900` | le son (DTLS-SRTP, ICE) |
| postgres | `127.0.0.1:54320`, mot de passe exigé | comptes SIP (`subscriber`), CDR, données de la passerelle |
| keycloak (`demo`) | `127.0.0.1:8180` | royaume `twakephone`, client `twakephone-web`, trois personnes |
| openldap (`demo`) | `127.0.0.1:3890` | `ou=people,dc=twakephone,dc=demo`, poste dans `employeeNumber`, compte lecteur pour la passerelle |

Réseau hôte pour les services qui se parlent sur la boucle et pour rtpengine (les navigateurs envoient le son directement à ses ports), ports publiés sur la boucle pour Keycloak et OpenLDAP. Un de ces ports déjà pris sur la machine (un 8080 par exemple) empêche son service de démarrer : `docker compose logs <service>`. Le choix d'un seul domaine derrière Caddy est expliqué dans l'ADR 0012.

## En cas de souci

- **Pas de son.** Les ports `30000-30100/udp` ne sont pas ouverts (pare-feu de la machine et du cloud), ou `RTPENGINE_INTERFACE` ne donne pas l'adresse publique. Un réseau d'entreprise qui bloque l'UDP sortant empêche aussi le son (pas de TURN dans le pilote).
- **« Hors ligne » dans l'app, l'enregistrement SIP échoue.** `docker compose logs opensips` : le domaine doit résoudre au démarrage d'OpenSIPS (« could not resolve advertised name »).
- **Le certificat n'est pas émis.** Le domaine ne pointe pas sur la machine, ou le port 80 est fermé : `docker compose logs caddy`.
- **Connexion refusée par la passerelle (401).** Le jeton n'a pas la bonne audience ou le bon émetteur : `JWT_ISSUER` doit être exactement l'`issuer` du fournisseur, `JWT_AUDIENCE` dans le `aud` du jeton d'accès.
- **Personne dans l'annuaire, ou personne n'a de poste.** `LDAP_ATTR_EXTENSION` manque, ou l'identifiant LDAP diffère de celui du SSO ; l'écran d'administration montre la source de l'annuaire, la dernière synchronisation et ses conflits, et la relance.

## Limites du pilote

Il sert à essayer, pas à exploiter : une seule machine, sans redondance ni supervision ; un seul tenant ; une vingtaine d'appels simultanés au plus (101 ports RTP) ; pas de TURN, donc pas de son depuis un réseau qui bloque l'UDP ; OpenSIPS et la passerelle voient toutes les connexions venir de Caddy (127.0.0.1) ; Keycloak du profil `demo` en mode développement (base H2), jamais pour de vrais comptes ; images non publiées, construites sur la machine.
