# Kit pilote : TwakePhone sur une machine, pour un test réel

Tout le MVP web sur une seule machine Linux joignable depuis Internet, pour que quelques personnes s'appellent depuis leur navigateur : l'app, la passerelle, OpenSIPS et rtpengine, PostgreSQL, derrière Caddy qui sert le tout en HTTPS sur un seul nom de domaine. Le profil `demo` ajoute un fournisseur d'identité (Keycloak) et un annuaire (OpenLDAP) avec trois personnes de test, pour essayer sans rien brancher. Sans ce profil, le kit se raccorde à votre SSO et à votre annuaire.

Ce que le pilote permet : se connecter, trouver un collègue dans l'annuaire avec sa présence, l'appeler de navigateur à navigateur, le mettre en attente, le transférer, retrouver ses appels dans les Récents. Ce qu'il ne permet pas encore : appeler ou recevoir des numéros extérieurs (étape 6, trunk OVH), sonner quand aucun onglet n'est ouvert (étape 5, Web Push), le mobile.

## Ce qu'il faut

- Une machine Linux (2 vCPU, 4 Go de RAM suffisent pour un pilote) avec Docker Engine 25 ou plus et le plugin Compose 2.20 ou plus.
- Une adresse IPv4 publique, directe ou en NAT 1:1 (le cas de la plupart des clouds).
- Un nom de domaine qui pointe sur cette adresse (enregistrement A), avant le premier démarrage : Let's Encrypt le vérifie, et OpenSIPS le résout à son démarrage.
- Ouverts depuis Internet : `80/tcp` et `443/tcp` (Caddy), `30000-30100/udp` (le son, rtpengine). Rien d'autre : tout le reste écoute sur la boucle locale.
- Pour les testeurs : Chrome, Edge ou Firefox récent, un casque, un réseau qui laisse passer l'UDP sortant (pas de serveur TURN dans le pilote, voir « Limites »).

## Démarrer

```bash
git clone https://github.com/linagora/twake-phone.git && cd twake-phone/docker/pilot
./init.sh phone.example.org vous@example.org --demo      # écrit .env : domaine, TLS, adresse du son, secrets
docker compose up -d --build --wait                       # premier démarrage : construction des images, quelques minutes
```

Puis ouvrir `https://phone.example.org`, « Se connecter », et entrer avec `alice`, `bob` ou `carole` : le mot de passe commun est `DEMO_PASSWORD` dans `.env`. Alice (101) administre la plateforme, Bob (102) et Carole (103) non. Deux personnes, deux navigateurs (ou une fenêtre privée), et Alice compose 102.

`init.sh` déduit l'adresse du son (`RTPENGINE_INTERFACE`) : l'adresse de la machine, et l'adresse publique que le domaine résout, sous la forme `privée!publique` quand elles diffèrent. `--public-ip` la donne quand le domaine ne résout pas encore. Il ne réécrit jamais un `.env` existant ; `.env` contient les secrets, il reste sur la machine.

Vérifier l'installation depuis la machine (ou tout poste qui la joint), avec le profil `demo` : deux personnes se connectent, se trouvent, s'appellent, s'entendent et retrouvent l'appel dans leurs Récents.

```bash
cd ../.. && yarn install --frozen-lockfile
PILOT_URL=https://phone.example.org DEMO_PASSWORD=... yarn e2e:pilot
```

## Votre SSO et votre annuaire (sans le profil `demo`)

`./init.sh phone.example.org vous@example.org` (sans `--demo`) laisse à remplir dans `.env` :

- **Identité.** Un client OIDC public `twakephone-web` (code + PKCE S256, sans secret), URL de retour `https://<domaine>/callback`, URL après déconnexion `https://<domaine>/`, origine web `https://<domaine>`. Son jeton d'accès doit être un JWT dont l'audience est la passerelle (`twakephone-gateway` : un « audience mapper » sur Keycloak, ou `OIDC_RESOURCE` pour un fournisseur qui suit la RFC 8707). Dans `.env` : `OIDC_AUTHORITY` (l'émetteur), `JWT_ISSUER` (le même), `JWT_JWKS_URL` (ses clés), `JWT_AUDIENCE`. L'identifiant de la personne est `preferred_username` (`JWT_USER_CLAIM` pour un autre). Administrateurs : `ADMIN_USERS=alice,bob`, ou un rôle du jeton (`JWT_ROLES_CLAIM`, `ADMIN_ROLE`, `twakephone-admin` par défaut).
- **Annuaire.** `LDAP_URL` (`ldaps://` pour un serveur distant), `LDAP_BASE_DN`, `LDAP_BIND_DN` et `LDAP_BIND_PASSWORD` d'un compte en lecture seule, et `LDAP_ATTR_EXTENSION`, l'attribut qui porte le poste de chacun : la passerelle en fait les comptes SIP (ADR 0009). L'identifiant LDAP (`uid`, `LDAP_ATTR_ID` sinon) doit être celui du SSO.
- **Sans annuaire.** `USER_EXTENSIONS=alice:101,bob:102`, lu à chaque démarrage : une personne déjà dotée d'un poste le garde.

## Exploiter

| Quoi | Comment |
|---|---|
| État et journaux | `docker compose ps`, `docker compose logs -f gateway opensips` |
| Mettre à jour | `git pull && docker compose up -d --build --wait` |
| Arrêter | `docker compose down` (les données restent dans les volumes) |
| Tout effacer | `docker compose down -v`, puis supprimer `.env` |
| Sauvegarder | `docker compose exec postgres pg_dump -U twake -h 127.0.0.1 -p 54320 twake > twakephone.sql` |

La configuration SIP (domaine, URL WebSocket) est écrite en base au premier démarrage de la passerelle : changer de domaine ensuite demande de repartir d'une base vide (`docker compose down -v`).

## Ce qui tourne

| Service | Écoute | Rôle |
|---|---|---|
| caddy | `:80`, `:443` | HTTPS (Let's Encrypt, ou sa propre autorité avec `TLS=internal`) ; `/api/*` vers la passerelle, `/sip` vers le WebSocket d'OpenSIPS, `/auth/*` vers Keycloak, le reste vers l'app |
| web | `127.0.0.1:8081` | l'app (fichiers, `config.json`, CSP) |
| gateway | `127.0.0.1:8080` | API, WebSocket des événements, comptes SIP |
| opensips | `127.0.0.1:8088` (WS), MI `127.0.0.1:8880/udp` | registrar et routage ; le navigateur le joint par `wss://<domaine>/sip` |
| rtpengine | `30000-30100/udp` sur `RTPENGINE_INTERFACE` | le son (DTLS-SRTP, ICE) |
| postgres | `127.0.0.1:54320` | comptes SIP (`subscriber`), CDR, données de la passerelle |
| keycloak (`demo`) | `127.0.0.1:8180` | royaume `twakephone`, client `twakephone-web`, trois personnes ; console d'administration sur `https://<domaine>/auth/admin` (`admin` / `KEYCLOAK_ADMIN_PASSWORD`) |
| openldap (`demo`) | `127.0.0.1:3890` | `ou=people,dc=twakephone,dc=demo`, poste dans `employeeNumber` |

Réseau hôte pour les services qui se parlent sur la boucle et pour rtpengine (les navigateurs envoient le son directement à ses ports), ports publiés sur la boucle pour Keycloak et OpenLDAP. Le choix d'un seul domaine derrière Caddy est expliqué dans l'ADR 0012.

## En cas de souci

- **Pas de son.** Les ports `30000-30100/udp` ne sont pas ouverts (pare-feu de la machine et du cloud), ou `RTPENGINE_INTERFACE` ne donne pas l'adresse publique. Un réseau d'entreprise qui bloque l'UDP sortant empêche aussi le son (pas de TURN dans le pilote).
- **« Hors ligne » dans l'app, l'enregistrement SIP échoue.** `docker compose logs opensips` : le domaine doit résoudre au démarrage d'OpenSIPS (« could not resolve advertised name »).
- **Le certificat n'est pas émis.** Le domaine ne pointe pas sur la machine, ou le port 80 est fermé : `docker compose logs caddy`.
- **Connexion refusée par la passerelle (401).** Le jeton n'a pas la bonne audience ou le bon émetteur : `JWT_ISSUER` doit être exactement l'`issuer` du fournisseur, `JWT_AUDIENCE` dans le `aud` du jeton d'accès.
- **Personne dans l'annuaire, ou personne n'a de poste.** `LDAP_ATTR_EXTENSION` manque, ou l'identifiant LDAP diffère de celui du SSO ; l'écran d'administration montre la source de l'annuaire, la dernière synchronisation et ses conflits, et la relance.

## Limites du pilote

Il sert à essayer, pas à exploiter : une seule machine, sans redondance ni supervision ; un seul tenant ; pas de TURN, donc pas de son depuis un réseau qui bloque l'UDP ; OpenSIPS voit toutes les connexions venir de Caddy (127.0.0.1), ce que l'anti-fraude de l'étape 6 devra prendre en compte ; Keycloak du profil `demo` en mode développement (base H2), jamais pour de vrais comptes ; images non publiées, construites sur la machine.
