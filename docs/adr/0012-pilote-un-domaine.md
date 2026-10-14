# ADR 0012 : un pilote sur une machine, un seul domaine derrière Caddy, SIP sur WebSocket par le même port 443

Date : 2026-10-14. État : acceptée. Décidée à la PR du kit pilote, dans le fil de discussion du projet, quand le test réel a été demandé avant l'étape 4b ; remplacé par : aucun.

## Contexte

Le premier test réel se fait à quelques personnes, sur une machine louée, sans équipe d'exploitation. Il faut un TLS public (le navigateur refuse le micro et le WSS sans), le moins de ports et de noms possible, et un fournisseur d'identité et un annuaire même quand le bénéficiaire n'a pas encore donné les siens.

## Décision

`docker/pilot` : une seule machine, un seul nom de domaine. Caddy porte le TLS (Let's Encrypt, ou son autorité interne pour un test sans nom public) et route par chemin : `/api/*` vers la passerelle, `/sip` vers le WebSocket **en clair** d'OpenSIPS sur la boucle, `/auth/*` vers le Keycloak de démo, le reste vers l'app. OpenSIPS, la passerelle, l'app et PostgreSQL n'écoutent que sur la boucle ; seuls 80, 443 et la plage RTP de rtpengine sont publics. Le domaine SIP est le domaine public. Un profil `demo` ajoute Keycloak (mode dev) et OpenLDAP avec trois personnes ; sans lui, le kit se branche au SSO et à l'annuaire du bénéficiaire. `init.sh` écrit les secrets et déduit l'adresse du son ; `yarn e2e:pilot` vérifie un déploiement depuis un navigateur, et la CI le joue sur le kit construit.

## Conséquences

Un certificat, un port TCP public, la même origine pour l'app, l'API et le SIP : pas de CORS, une CSP qui n'ajoute rien. OpenSIPS voit toutes les connexions SIP venir de 127.0.0.1 : la limitation de débit et l'anti-fraude de l'étape 6 devront se fonder sur l'identité SIP, pas sur l'adresse source (ou Caddy devra filtrer avant OpenSIPS). OpenSIPS résout le domaine au démarrage : le DNS doit exister avant. Pas de TURN : pas de son derrière un réseau qui bloque l'UDP. Ce n'est pas le déploiement de production (redondance, supervision, images publiées, multi-tenant : étapes 7 et V1).

## Alternatives écartées

Le WSS d'OpenSIPS exposé directement sur un port à lui (8089) : un second certificat à tenir à jour dans OpenSIPS, un port de plus à ouvrir, et une origine de plus dans la CSP. Des sous-domaines par service : plus de DNS et de certificats pour rien à cette échelle. Traefik ou nginx : Caddy obtient et renouvelle le certificat sans configuration ni conteneur annexe.
