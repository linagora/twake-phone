# ADR 0035 : TwakePhone sur les clusters de la dev : images sur Harbor, pile SIP et média sur le cluster média

Date : 2026-11-02. Révisé : 2026-11-14, 2026-11-19. État : proposée. Remplacé par : aucun.

## Contexte

La dev a deux sortes de clusters Kubernetes :

- les clusters applicatifs (Chat, Mail, Meet, SSO LemonLDAP::NG) : nœuds non joignables en direct, entrée en TCP par un load balancer ;
- un cluster média, dont les nœuds sont joignables en direct et peuvent recevoir de l'UDP.

Le kit pilote (0012) tient parce que tout partage la boucle de la machine : MI d'OpenSIPS sans authentification, contrôle de rtpengine, et son annoncé aux navigateurs en UDP. Séparer ces services en pods ordinaires mettrait le MI sur le réseau du cluster.

## Décision

- Images : le job `pilot` de `.github/workflows/ci.yml` publie sur `harbor.linagora.com/twake-workplace/twake-phone-{web,gateway,opensips,rtpengine}` les images qu'il vient de jouer, taguées par le commit, `latest` sur main, jamais sur une PR. L'image d'OpenSIPS embarque `subscriber.sql`, rejouable.
- Sur le cluster média, un pod en réseau de l'hôte, épinglé à un nœud (rtpengine, OpenSIPS, passerelle, app) : MI et contrôle de rtpengine sur la boucle. Le trunk et la plage RTP sur l'adresse du nœud. L'app, la passerelle et le WebSocket d'OpenSIPS sur une adresse interne, jamais sur l'adresse publique du nœud ni sur `0.0.0.0`. Le pare-feu du nœud n'ouvre que le trunk, l'entrée TLS et la plage RTP.
- L'app ne sert que du HTTPS : elle pourrait aller sur un cluster applicatif. Le chart la garde dans le pod pour l'instant.
- Sans Wazo ni LiveKit SIP. SSO : client OIDC public avec PKCE, jeton JWT, `AUTH_MODE=jwt`.
- Écart avec la version du 2026-11-14 : ce pod visait le cluster de dev. Romain (infra) a dit le 2026-11-03 que ses nœuds ne sont pas joignables depuis Internet et que l'UDP ouvert sur un nœud est refusé, ce qui est cohérent avec ce que l'équipe d'exploitation dit des clusters applicatifs. Elle a indiqué le 2026-11-19 (message relayé) que le cluster média peut accepter ce trafic.
- À confirmer avec cette équipe : où le TLS de `/api` et `/sip` se termine (sur le nœud média ou au proxy d'un cluster applicatif) ; si les nœuds ont une adresse privée en plus de la publique ; comment le cluster média joint le LDAP et le SSO ; où vivent le chart, les secrets et PostgreSQL (leur plan le place sur le nœud média).

## Compromis

- Gagné : des images identiques à celles de l'e2e, publiées sans étape manuelle ; un chemin UDP direct pour le son, sans TURN.
- Coût : une réplique, un nœud fixe (sa perte coupe la téléphonie) ; ses ports ne doivent croiser aucun autre pod en réseau de l'hôte ; deux clusters à relier (deux origines, ou un proxy de l'un vers l'autre).
- Limite connue : rien n'est encore déployé ni testé sur le cluster média ; le mode `jwt` n'est pas joué contre le vrai SSO ; seul un appel par navigateur prouve le déploiement (`yarn e2e:pilot`).

## Alternatives écartées

- Le même pod sur un cluster applicatif : nœuds non joignables, UDP refusé.
- Pods ordinaires, rtpengine seul en réseau de l'hôte : le MI passerait sur le réseau du cluster.
- rtpengine derrière un Service LoadBalancer UDP : une plage de ports à déclarer, et une adresse vue par rtpengine qui n'est pas celle des navigateurs.
- Une VM avec le kit pilote : hors du SSO, de l'annuaire et du dépôt de la dev.

## Code

`.github/workflows/ci.yml` (publication Harbor), `docker/Dockerfile.web`, `docker/Dockerfile.gateway`, `docker/opensips/Dockerfile`, `docker/rtpengine/`, `docker/pilot/`.
