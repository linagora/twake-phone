# ADR 0012 : un pilote sur une machine, un domaine derrière Caddy, SIP sur WebSocket par le port 443

Date : 2026-10-14. Révisé : 2026-11-14. État : acceptée. Remplacé par : aucun. Décidée à la PR du kit pilote, dans le fil de discussion du projet, quand le test réel a été demandé avant l'étape 4b.

## Contexte

Le premier test réel se fait à quelques personnes, sur une machine louée, sans équipe d'exploitation. Il faut un TLS public (le navigateur refuse micro et WSS sans), peu de ports et de noms, et un fournisseur d'identité et un annuaire même quand le bénéficiaire n'a pas les siens.

## Décision

- `docker/pilot` : une machine, un nom de domaine. Caddy porte le TLS (Let's Encrypt, ou son autorité interne pour un test sans nom public, `TLS=internal`) et route par chemin : `/api/*` vers la passerelle, `/sip` vers le WebSocket en clair d'OpenSIPS sur la boucle, `/auth/*` vers le Keycloak de démo, le reste vers l'app.
- OpenSIPS, passerelle, app et PostgreSQL n'écoutent que sur la boucle. Publics : 80 (défi ACME, redirection), 443, et la plage RTP de rtpengine.
- Le domaine SIP est le domaine public ; OpenSIPS le résout au démarrage, le DNS doit exister avant.
- Profil `demo` : Keycloak (mode dev) et OpenLDAP avec trois personnes. Sans lui, le kit se branche au SSO et à l'annuaire du bénéficiaire.
- `init.sh` écrit les secrets et déduit l'adresse du son ; `yarn e2e:pilot` vérifie un déploiement depuis un navigateur, la CI le joue sur le kit construit.

## Compromis

- Gagné : un certificat, la même origine pour l'app, l'API et le SIP (pas de CORS, une CSP qui n'ajoute rien).
- Perdu / coût : OpenSIPS voit toutes les connexions SIP venir de 127.0.0.1, et la passerelle toutes les requêtes : limitation de débit et anti-fraude doivent se fonder sur l'identité SIP, pas sur l'adresse source (ou Caddy filtre avant OpenSIPS).
- Limite connue : pas de TURN, donc pas de son derrière un réseau qui bloque l'UDP. Ce n'est pas la production (redondance, supervision, images publiées, multi-tenant : étapes 7 et V1).
- Écart : l'ADR disait « seuls 80, 443 et la plage RTP sont publics » ; avec un trunk, un socket SIP à part (`TRUNK_LISTEN_IP`, `TRUNK_PORT/udp` 5070) s'ouvre à l'opérateur seul (`docker/pilot/compose.yml:109`, `init.sh:146`, ADR 0016).

## Alternatives écartées

- WSS d'OpenSIPS exposé sur un port à lui (8089) : un second certificat à tenir, un port de plus, une origine de plus dans la CSP.
- Un sous-domaine par service : plus de DNS et de certificats pour rien à cette échelle.
- Traefik ou nginx : Caddy obtient et renouvelle le certificat sans configuration ni conteneur annexe.

## Code

`docker/pilot/Caddyfile`, `docker/pilot/compose.yml`, `docker/pilot/init.sh`, `apps/web/test/pilot.e2e.mjs`.
